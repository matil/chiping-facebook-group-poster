import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOGIN_URL_RE = /\/login/i;
const SECURITY_URL_RE = /\/(?:checkpoint|recover|two_step_verification|security)/i;
const SECURITY_TEXT_RE = /(?:security check|checkpoint|two-factor|approve your login|בדיקת אבטחה|אימות)/i;

const COMPOSER_SELECTORS = [
  '[role="button"][aria-label*="Write something"]',
  '[role="button"][aria-label*="Create public post"]',
  '[role="button"][aria-label*="כתוב משהו"]',
  '[role="button"][aria-label*="צור פוסט"]',
  'text=/^Write something(?:\\.\\.\\.|…)?$/',
  'text=/^Create post$/',
  'text=/^כתוב משהו(?:\\.\\.\\.|…)?$/',
  'text=/^צור פוסט$/',
  '[role="button"]:has-text("Write something")',
  '[role="button"]:has-text("Create post")',
  '[role="button"]:has-text("כתוב משהו")',
  '[role="button"]:has-text("צור פוסט")',
  '[role="dialog"] [contenteditable="true"][role="textbox"]',
];

const TEXTBOX_SELECTORS = [
  '[role="dialog"] [contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
];

const POST_SELECTORS = [
  '[role="dialog"] [role="button"][aria-label="Post"]',
  '[role="dialog"] [role="button"][aria-label="פרסום"]',
  '[role="dialog"] [role="button"]:has-text("Post")',
  '[role="dialog"] [role="button"]:has-text("פרסום")',
];

export class FacebookSessionRequiredError extends Error {
  constructor(message = 'Facebook session needs an interactive login or security verification') {
    super(message);
    this.name = 'FacebookSessionRequiredError';
  }
}

function firstVisibleLocator(page, selectors) {
  return (async () => {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    return null;
  })();
}

export async function findFacebookGroupComposer(page) {
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(500);
  return firstVisibleLocator(page, COMPOSER_SELECTORS);
}

export async function sortFacebookGroupFeedNewest(page) {
  const alreadyRecent = await firstVisibleLocator(page, [
    '[role="button"]:has-text("Recent posts")',
    '[role="button"]:has-text("New posts")',
    '[role="button"]:has-text("\u05e4\u05d5\u05e1\u05d8\u05d9\u05dd \u05d0\u05d7\u05e8\u05d5\u05e0\u05d9\u05dd")',
    '[role="button"]:has-text("\u05e4\u05d5\u05e1\u05d8\u05d9\u05dd \u05d7\u05d3\u05e9\u05d9\u05dd")',
  ]);
  if (alreadyRecent) return true;

  const sortControl = await firstVisibleLocator(page, [
    '[role="button"]:has-text("Most relevant")',
    '[role="button"]:has-text("New activity")',
    '[role="button"]:has-text("\u05d4\u05e8\u05dc\u05d5\u05d5\u05e0\u05d8\u05d9\u05d9\u05dd \u05d1\u05d9\u05d5\u05ea\u05e8")',
    '[role="button"]:has-text("\u05e4\u05e2\u05d9\u05dc\u05d5\u05ea \u05d7\u05d3\u05e9\u05d4")',
  ]);
  if (!sortControl) return false;
  await sortControl.click({ timeout: 10000 });
  await page.waitForTimeout(500);

  const recentOption = await firstVisibleLocator(page, [
    '[role="menuitem"]:has-text("Recent posts")',
    '[role="menuitemradio"]:has-text("Recent posts")',
    '[role="menuitem"]:has-text("\u05e4\u05d5\u05e1\u05d8\u05d9\u05dd \u05d0\u05d7\u05e8\u05d5\u05e0\u05d9\u05dd")',
    '[role="menuitemradio"]:has-text("\u05e4\u05d5\u05e1\u05d8\u05d9\u05dd \u05d0\u05d7\u05e8\u05d5\u05e0\u05d9\u05dd")',
    'text=/^Recent posts$/',
    'text=/^\u05e4\u05d5\u05e1\u05d8\u05d9\u05dd \u05d0\u05d7\u05e8\u05d5\u05e0\u05d9\u05dd$/',
  ]);
  if (!recentOption) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await recentOption.click({ timeout: 10000 });
  await page.waitForTimeout(3000);
  return true;
}

async function isSecurityChallenge(page) {
  if (SECURITY_URL_RE.test(page.url())) return true;
  const text = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  return SECURITY_TEXT_RE.test(text);
}

export async function readLoginCredentials(config) {
  const emailFile = String(config.facebookLoginEmailFile || '').trim();
  const passwordFile = String(config.facebookLoginPasswordFile || '').trim();
  if (!emailFile || !passwordFile) return null;
  try {
    const [email, password] = await Promise.all([
      readFile(emailFile, 'utf8'),
      readFile(passwordFile, 'utf8'),
    ]);
    const normalizedEmail = email.trim();
    // Keep intentional password spaces; secret files conventionally add one final newline.
    const normalizedPassword = password.replace(/\r?\n$/, '');
    return normalizedEmail && normalizedPassword ? { email: normalizedEmail, password: normalizedPassword } : null;
  } catch {
    return null;
  }
}

async function hasLoginForm(page) {
  if (LOGIN_URL_RE.test(page.url())) return true;
  return page.locator('input[name="email"], input[type="email"]').first().isVisible().catch(() => false);
}

async function encryptedProfileMarkerMatches(config, profileName) {
  if (!config.trustVerifiedPostingProfile || !config.storageStateFile) return false;
  try {
    const marker = JSON.parse(
      await readFile(path.join(config.dataDir, 'verified-profile.json'), 'utf8')
    );
    return String(marker?.name || '').trim() === profileName
      && await fileExists(config.storageStateFile);
  } catch {
    return false;
  }
}

async function fileExists(file) {
  if (!file) return false;
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function createFacebookContext(chromium, config) {
  const contextOptions = {
    viewport: { width: 1365, height: 900 },
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
  };
  const stateFile = String(config.storageStateFile || '').trim();
  if (!stateFile) {
    const context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      ...contextOptions,
    });
    return { context, browser: null, stateFile: '' };
  }

  await mkdir(path.dirname(stateFile), { recursive: true });
  const browser = await chromium.launch({ headless: config.headless });
  const storageState = await fileExists(stateFile) ? stateFile : undefined;
  const context = await browser.newContext({ ...contextOptions, storageState });
  return { context, browser, stateFile };
}

export async function loginIfNeeded(page, config) {
  if (await isSecurityChallenge(page)) throw new FacebookSessionRequiredError();
  if (!await hasLoginForm(page)) return;
  const credentials = await readLoginCredentials(config);
  if (!credentials) {
    throw new FacebookSessionRequiredError('Facebook session expired and automatic login secrets are not configured');
  }
  const email = page.locator('input[name="email"], input[type="email"]').first();
  const password = page.locator('input[name="pass"], input[type="password"]').first();
  if (!await email.isVisible().catch(() => false) || !await password.isVisible().catch(() => false)) {
    throw new FacebookSessionRequiredError('Facebook login form is incomplete');
  }
  await email.fill(credentials.email);
  await password.fill(credentials.password);
  const submit = page.locator('button[name="login"], input[name="login"], [role="button"]:has-text("Log in"), [role="button"]:has-text("התחבר")').first();
  await submit.click({ timeout: 10000 });
  await page.waitForTimeout(3000);
  if (await isSecurityChallenge(page)) {
    throw new FacebookSessionRequiredError('Facebook requires a security check');
  }
  await page.goto(config.groupUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (await isSecurityChallenge(page)) throw new FacebookSessionRequiredError('Facebook requires a security check');
  if (await hasLoginForm(page)) throw new FacebookSessionRequiredError('Facebook did not accept the configured login credentials');
}

export async function selectPostingProfile(page, config) {
  const profileName = String(config.facebookPostingProfileName || '').trim();
  if (!profileName) return;
  if (await isSecurityChallenge(page)) throw new FacebookSessionRequiredError();
  if (config.trustVerifiedPostingProfile) {
    if (await encryptedProfileMarkerMatches(config, profileName)) return;
    throw new FacebookSessionRequiredError('Encrypted Facebook session has no verified posting profile');
  }

  const accountMenu = await firstVisibleLocator(page, [
    '[aria-label="Your profile"]',
    '[aria-label*="Your profile"]',
    '[aria-label*="\u05d4\u05e4\u05e8\u05d5\u05e4\u05d9\u05dc \u05e9\u05dc\u05da"]',
  ]);
  if (!accountMenu) {
    throw new FacebookSessionRequiredError('Facebook could not open the profile switcher');
  }
  await accountMenu.click();
  await page.waitForTimeout(500);

  const selectProfile = async () => {
    const option = page.getByText(profileName, { exact: true }).last();
    return await option.isVisible().catch(() => false) ? option : null;
  };
  let option = await selectProfile();
  if (!option) {
    const allProfiles = await firstVisibleLocator(page, [
      '[role="menuitem"]:has-text("See all profiles")',
      '[role="menuitem"]:has-text("Switch profile")',
      '[role="menuitem"]:has-text("\u05db\u05dc \u05d4\u05e4\u05e8\u05d5\u05e4\u05d9\u05dc\u05d9\u05dd")',
      '[role="menuitem"]:has-text("\u05d4\u05d7\u05dc\u05e4\u05ea \u05e4\u05e8\u05d5\u05e4\u05d9\u05dc")',
    ]);
    if (allProfiles) {
      await allProfiles.click();
      await page.waitForTimeout(500);
      option = await selectProfile();
    }
  }
  if (!option) {
    throw new FacebookSessionRequiredError('Configured Facebook posting profile is not available');
  }
  await option.click();
  await page.waitForTimeout(1200);
  if (await isSecurityChallenge(page) || await hasLoginForm(page)) {
    throw new FacebookSessionRequiredError('Facebook rejected the configured posting profile');
  }
  await page.goto(config.groupUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
}

export function normalizeFacebookGroupPostUrl(value) {
  try {
    const url = new URL(String(value || ''), 'https://www.facebook.com');
    if (!['facebook.com', 'www.facebook.com'].includes(url.hostname)) return '';
    const mediaPostId = String(url.searchParams.get('set') || '').match(/^gm\.(\d+)$/i)?.[1];
    if (/^\/photo(?:\.php)?\/?$/i.test(url.pathname) && mediaPostId) {
      return `https://www.facebook.com/groups/chiping/posts/${mediaPostId}/`;
    }
    if (!/^\/groups\/(?:chiping|\d+)\/(?:posts|permalink)\/\d+\/?$/i.test(url.pathname)) return '';
    return `https://www.facebook.com${url.pathname.replace(/\/?$/, '/')}`;
  } catch {
    return '';
  }
}

function decodedUrl(value) {
  let result = String(value || '');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const decoded = decodeURIComponent(result);
      if (decoded === result) break;
      result = decoded;
    } catch {
      break;
    }
  }
  return result;
}

function referencesExactChipingItem(value, productId) {
  const decoded = decodedUrl(value);
  const references = [
    `www.chiping.co.il/?item=${productId}`,
    `chiping.co.il/?item=${productId}`,
  ];
  return references.some((reference) => {
    let offset = decoded.indexOf(reference);
    while (offset >= 0) {
      const nextCharacter = decoded[offset + reference.length] || '';
      if (!nextCharacter || /[&#\s"'<>]/.test(nextCharacter)) return true;
      offset = decoded.indexOf(reference, offset + reference.length);
    }
    return false;
  });
}

async function scanFacebookGroupArticles(page, itemUrl) {
  const target = new URL(String(itemUrl || ''));
  const productId = target.searchParams.get('item');
  if (target.hostname !== 'www.chiping.co.il' || !/^\d+$/.test(String(productId || ''))) {
    throw new Error('Facebook post verification requires a Chiping item URL');
  }

  const articles = page.locator('[role="article"]');
  const count = Math.min(await articles.count(), 50);
  for (let index = 0; index < count; index += 1) {
    const article = articles.nth(index);
    if (!await article.isVisible().catch(() => false)) continue;
    const expanders = article.locator([
      '[role="button"]:has-text("See more")',
      '[role="button"]:has-text("\u05d4\u05e6\u05d2 \u05e2\u05d5\u05d3")',
      '[role="button"]:has-text("\u05e8\u05d0\u05d4 \u05e2\u05d5\u05d3")',
    ].join(', '));
    let expanderCount = 0;
    try {
      expanderCount = Math.min(await expanders.count(), 3);
    } catch {
      expanderCount = 0;
    }
    for (let expanderIndex = 0; expanderIndex < expanderCount; expanderIndex += 1) {
      const expander = expanders.nth(expanderIndex);
      if (!await expander.isVisible().catch(() => false)) continue;
      await expander.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(200);
      break;
    }
    const [text, hrefs] = await Promise.all([
      article.innerText().catch(() => ''),
      article.locator('a[href]').evaluateAll((links) => links.map((link) => link.href)).catch(() => []),
    ]);
    const matchesItem = [text, ...hrefs]
      .some((value) => referencesExactChipingItem(value, productId));
    if (!matchesItem) continue;

    for (const href of hrefs) {
      const postUrl = normalizeFacebookGroupPostUrl(href);
      if (postUrl) return { found: true, postUrl };
    }
    return { found: true, postUrl: '' };
  }
  return { found: false, postUrl: '' };
}

async function navigateFacebookForVerification(page, destination) {
  try {
    await page.goto(destination, { waitUntil: 'commit', timeout: 45000 });
    await page.waitForTimeout(1000);
    return page;
  } catch (error) {
    const message = String(error?.message || '');
    const currentUrl = String(page.url?.() || '');
    if (!/ERR_ABORTED|frame was detached|Target page, context or browser has been closed/i.test(message)
      || !/^https:\/\/(?:www\.)?facebook\.com\//i.test(currentUrl)) {
      throw error;
    }

    const context = typeof page.context === 'function' ? page.context() : null;
    const replacement = context?.pages()
      .filter((candidate) => !candidate.isClosed())
      .at(-1);
    if (replacement && replacement !== page) {
      await replacement.waitForTimeout(1000);
      return replacement;
    }
    if (!page.isClosed?.()) {
      await page.waitForTimeout(1000);
      return page;
    }
    if (!context) throw error;

    const freshPage = await context.newPage();
    await freshPage.goto(destination, { waitUntil: 'commit', timeout: 45000 });
    await freshPage.waitForTimeout(1000);
    return freshPage;
  }
}

export async function findFacebookGroupPostOnPage(page, {
  groupUrl,
  itemUrl,
  timeoutMs = 30000,
  currentPageOnly = false,
} = {}) {
  const waitBudgetMs = Math.max(5000, Math.min(Number(timeoutMs) || 30000, 60000));
  const target = new URL(String(itemUrl || ''));
  const productId = target.searchParams.get('item');
  const destinations = [
    `${groupUrl}/search/?q=${encodeURIComponent(productId || itemUrl)}`,
    `${groupUrl}?sorting_setting=CHRONOLOGICAL`,
  ];
  const attemptsPerDestination = Math.max(
    2,
    Math.floor(waitBudgetMs / destinations.length / 2000)
  );
  const currentPageAttempts = currentPageOnly
    ? Math.max(2, Math.floor(waitBudgetMs / 2000))
    : 2;
  for (let attempt = 0; attempt < currentPageAttempts; attempt += 1) {
    const currentPageMatch = await scanFacebookGroupArticles(page, itemUrl);
    if (currentPageMatch.postUrl) return currentPageMatch;
    if (attempt + 1 < currentPageAttempts) {
      if (typeof page.evaluate === 'function') {
        await page.evaluate(() => {
          window.scrollBy(0, Math.min(700, Math.max(400, window.innerHeight * 0.7)));
        }).catch(() => {});
      }
      await page.waitForTimeout(2000);
    }
  }
  if (currentPageOnly) return { found: false, postUrl: '' };

  for (const destination of destinations) {
    page = await navigateFacebookForVerification(page, destination);
    for (let attempt = 0; attempt < attemptsPerDestination; attempt += 1) {
      const match = await scanFacebookGroupArticles(page, itemUrl);
      if (match.postUrl) return match;
      if (attempt + 1 < attemptsPerDestination) await page.waitForTimeout(2000);
    }
  }
  return { found: false, postUrl: '' };
}

export async function findFacebookGroupPostViaMedia(page, itemUrl, {
  maxCandidates = 12,
} = {}) {
  const candidates = await page.locator('a[href]:has(img)').evaluateAll((links) => (
    links.map((link) => link.href)
  )).catch(() => []);
  const diagnosticCandidates = candidates
    .filter((href) => /(?:\/photo|set=gm\.|\/posts\/)/i.test(String(href || '')))
    .slice(0, 20);
  console.log(`[facebook-verifier] media candidates: ${JSON.stringify(diagnosticCandidates)}`);
  const mediaByPhotoId = new Map();
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const photoId = url.searchParams.get('fbid');
      if (!['facebook.com', 'www.facebook.com'].includes(url.hostname)
        || !/^\/photo(?:\.php)?\/?$/i.test(url.pathname)
        || !/^\d+$/.test(String(photoId || ''))) {
        continue;
      }
      const existing = mediaByPhotoId.get(photoId);
      const groupScoped = /^g\.\d+$/i.test(String(url.searchParams.get('set') || ''));
      if (!existing || groupScoped) {
        mediaByPhotoId.set(photoId, {
          url: `https://www.facebook.com/photo/?fbid=${photoId}`
            + (url.searchParams.get('set') ? `&set=${encodeURIComponent(url.searchParams.get('set'))}` : ''),
          groupScoped,
        });
      }
    } catch {
      // Ignore malformed media hrefs.
    }
  }
  const candidateLimit = Math.max(1, Math.min(Number(maxCandidates) || 12, 20));
  const mediaUrls = [...mediaByPhotoId.values()]
    .slice(0, candidateLimit)
    .map((entry) => entry.url);
  const context = typeof page.context === 'function' ? page.context() : null;
  if (!context) return { found: false, postUrl: '' };

  for (const mediaUrl of mediaUrls) {
    const candidatePage = await context.newPage();
    try {
      await candidatePage.goto(mediaUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await candidatePage.waitForTimeout(2000);
      const match = await scanFacebookGroupArticles(candidatePage, itemUrl);
      if (match.found) return { found: true, postUrl: match.postUrl || mediaUrl };

      const [bodyText, hrefs] = await Promise.all([
        candidatePage.locator('body').innerText().catch(() => ''),
        candidatePage.locator('a[href]').evaluateAll((links) => links.map((link) => link.href)).catch(() => []),
      ]);
      const target = new URL(String(itemUrl || ''));
      const productId = target.searchParams.get('item');
      if ([bodyText, ...hrefs].some((value) => referencesExactChipingItem(value, productId))) {
        const groupPostUrl = hrefs.map(normalizeFacebookGroupPostUrl).find(Boolean);
        return { found: true, postUrl: groupPostUrl || mediaUrl };
      }
    } catch {
      // Ignore unrelated or unavailable media entries.
    } finally {
      await candidatePage.close().catch(() => {});
    }
  }
  return { found: false, postUrl: '' };
}

export async function findFacebookGroupPostWithMediaFallback(page, {
  groupUrl,
  itemUrl,
  timeoutMs = 30000,
  currentPageOnly = false,
  mediaCandidateLimit = 12,
} = {}) {
  const result = await findFacebookGroupPostOnPage(page, {
    groupUrl,
    itemUrl,
    timeoutMs,
    currentPageOnly,
  });
  if (result.postUrl) return result;
  return findFacebookGroupPostViaMedia(page, itemUrl, {
    maxCandidates: mediaCandidateLimit,
  });
}

export async function findFacebookGroupPost(config, itemUrl, options = {}) {
  const playwright = options.playwright || await import('playwright');
  const session = await createFacebookContext(playwright.chromium, config);
  const { context } = session;
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(config.groupUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page, config);
    await selectPostingProfile(page, config);
    if (options.sortNewest === true) await sortFacebookGroupFeedNewest(page);
    const findPost = options.mediaFallback === true
      ? findFacebookGroupPostWithMediaFallback
      : findFacebookGroupPostOnPage;
    const result = await findPost(page, {
      groupUrl: config.groupUrl,
      itemUrl,
      timeoutMs: options.timeoutMs,
      currentPageOnly: options.currentPageOnly === true,
      mediaCandidateLimit: options.mediaCandidateLimit,
    });
    if (options.screenshotPath) {
      await page.screenshot({ path: options.screenshotPath, fullPage: true }).catch(() => {});
    }
    return result;
  } finally {
    if (session.stateFile) await context.storageState({ path: session.stateFile }).catch(() => {});
    await context.close();
    if (session.browser) await session.browser.close();
  }
}

async function downloadImage(imageUrl, fetchImpl = fetch) {
  const url = new URL(String(imageUrl || ''));
  if (url.protocol !== 'https:') throw new Error('Only HTTPS image URLs are allowed');
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > 10 * 1024 * 1024) throw new Error('Image is larger than 10 MB');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('Image payload is invalid or too large');
  const mimeType = String(response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!/^image\/(?:avif|gif|jpe?g|png|webp)$/i.test(mimeType)) throw new Error('Image response is not a supported image');
  const extension = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  return { bytes, mimeType, filename: `chiping-deal.${extension}` };
}

function readHtmlMetaContent(html, key) {
  const normalizedKey = String(key || '').trim().toLowerCase();
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attributes = {};
    for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gi)) {
      attributes[match[1].toLowerCase()] = match[3]
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'");
    }
    if (String(attributes.property || attributes.name || '').toLowerCase() === normalizedKey) {
      return String(attributes.content || '').trim();
    }
  }
  return '';
}

export async function validateChipingLinkPreviewMetadata(
  itemUrl,
  expectedImageUrl,
  fetchImpl = fetch
) {
  const response = await fetchImpl(String(itemUrl || ''), {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'facebookexternalhit/1.1 (+https://www.facebook.com/externalhit_uatext.php)',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`Chiping link preview returned HTTP ${response.status}`);
  }
  const html = await response.text();
  const canonicalUrl = readHtmlMetaContent(html, 'og:url');
  const imageUrl = readHtmlMetaContent(html, 'og:image');
  const imageWidth = Number(readHtmlMetaContent(html, 'og:image:width'));
  const imageHeight = Number(readHtmlMetaContent(html, 'og:image:height'));
  if (new URL(canonicalUrl).href !== new URL(String(itemUrl || '')).href) {
    throw new Error('Chiping link preview has the wrong destination URL');
  }
  if (new URL(imageUrl).href !== new URL(String(expectedImageUrl || '')).href) {
    throw new Error('Chiping link preview has not exposed the prepared Facebook image');
  }
  if (imageWidth !== 1200 || imageHeight !== 630) {
    throw new Error('Chiping link preview image must be 1200x630');
  }
  return { canonicalUrl, imageUrl, imageWidth, imageHeight };
}

export async function attachFacebookComposerImage(page, image, options = {}) {
  const dialog = page.locator('[role="dialog"]').last();
  const previewImages = dialog.locator('img');
  const initialPreviewCount = await previewImages.count();
  let attached = false;
  const photoButton = await firstVisibleLocator(page, [
    '[role="dialog"] [role="button"][aria-label*="Photo/video"]',
    '[role="dialog"] [role="button"][aria-label*="Photo"]',
    '[role="dialog"] [role="button"][aria-label*="\u05ea\u05de\u05d5\u05e0\u05d4"]',
    '[role="dialog"] [aria-label*="Photo/video"]',
  ]);
  if (photoButton) {
    try {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10000 }),
        photoButton.click({ timeout: 10000 }),
      ]);
      await fileChooser.setFiles({
        name: image.filename,
        mimeType: image.mimeType,
        buffer: image.bytes,
      });
      attached = true;
    } catch {
      // Facebook can reveal an input instead of emitting a chooser event.
    }
  }
  if (!attached) {
    const scopedInputs = dialog.locator('input[type="file"]');
    if (!await scopedInputs.count()) throw new Error('Facebook composer image input was not found');
    await scopedInputs.first().setInputFiles({
      name: image.filename,
      mimeType: image.mimeType,
      buffer: image.bytes,
    });
  }

  await page.waitForTimeout(1500);
  if (typeof options.onFileSelected === 'function') {
    await options.onFileSelected({
      initialPreviewCount,
      currentPreviewCount: await previewImages.count(),
    });
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await previewImages.count() > initialPreviewCount) return;
    const previewControl = await firstVisibleLocator(page, [
      '[role="dialog"] [role="button"]:has-text("Edit")',
      '[role="dialog"] [role="button"][aria-label*="Remove photo"]',
      '[role="dialog"] [role="button"][aria-label*="Remove image"]',
      '[role="dialog"] [role="button"]:has-text("\u05e2\u05e8\u05d9\u05db\u05d4")',
      '[role="dialog"] [role="button"][aria-label*="\u05d4\u05e1\u05e8\u05ea \u05ea\u05de\u05d5\u05e0\u05d4"]',
    ]);
    if (previewControl) return;
    await page.waitForTimeout(500);
  }
  throw new Error('Facebook did not attach the image preview');
}

export async function fillFacebookComposerText(page, textBox, message) {
  const expected = String(message || '').trim();
  const normalizedExpected = expected
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const retained = (value) => {
    const normalizedActual = String(value || '')
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return normalizedActual.includes(
      normalizedExpected.slice(0, Math.min(12, normalizedExpected.length))
    );
  };
  await textBox.click({ timeout: 10000 });
  await textBox.fill(expected).catch(() => {});
  await page.waitForTimeout(300);
  let actual = String(await textBox.innerText().catch(() => '')).trim();
  if (!retained(actual)) {
    await textBox.click({ timeout: 10000 });
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.insertText(expected);
    await page.waitForTimeout(300);
    actual = String(await textBox.innerText().catch(() => '')).trim();
  }
  if (!retained(actual) && typeof textBox.pressSequentially === 'function') {
    await textBox.click({ timeout: 10000 });
    await page.keyboard.press('Control+A').catch(() => {});
    await textBox.pressSequentially(expected, { delay: 1 });
    await page.waitForTimeout(300);
    actual = String(await textBox.innerText().catch(() => '')).trim();
  }
  if (!retained(actual)) {
    throw new Error('Facebook composer did not retain the post text');
  }
}

export async function waitForFacebookLinkPreview(page, itemUrl, timeoutMs = 30000) {
  const target = new URL(String(itemUrl || ''));
  const host = target.hostname.replace(/^www\./i, '').toLowerCase();
  const dialog = page.locator('[role="dialog"]').last();
  const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 30000);
  while (Date.now() < deadline) {
    const [dialogText, hrefs, visualMetrics] = await Promise.all([
      dialog.innerText().catch(() => ''),
      dialog.locator('a[href]').evaluateAll((links) => links.map((link) => link.href)).catch(() => []),
      dialog.locator('img, [style*="background-image"]').evaluateAll((nodes) => (
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            visible: rect.width > 0 && rect.height > 0,
          };
        })
      )).catch(() => []),
    ]);
    const hasTargetAnchor = hrefs.some((href) => {
      try {
        const candidate = new URL(String(href || ''));
        return candidate.hostname.replace(/^www\./i, '').toLowerCase() === host
          && candidate.searchParams.get('item') === target.searchParams.get('item');
      } catch {
        return false;
      }
    });
    const hostOccurrences = String(dialogText || '').toLowerCase().split(host).length - 1;
    const hasLargePreviewVisual = visualMetrics.some((metric) => (
      metric.visible && metric.width >= 180 && metric.height >= 120
    ));
    if (hasLargePreviewVisual && (hasTargetAnchor || hostOccurrences >= 2)) {
      return { hasTargetAnchor, hostOccurrences, visualMetrics };
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Facebook did not render the Chiping link preview');
}

async function waitForEnabledFacebookControl(page, control, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await control.isEnabled().catch(() => false)) return;
    await page.waitForTimeout(500);
  }
  throw new Error('Facebook group publish button stayed disabled');
}

export async function waitForFacebookComposerToClose(page, textBox, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await textBox.isVisible().catch(() => false)) return;
    await page.waitForTimeout(1000);
  }
  throw new Error('Facebook group post did not finish publishing');
}

async function captureFacebookDebug(page, config, name, metadata = null) {
  const directory = String(config.facebookDebugDir || '').trim();
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    fullPage: true,
  }).catch(() => {});
  if (metadata) {
    await writeFile(
      path.join(directory, `${name}.json`),
      JSON.stringify(metadata, null, 2),
      'utf8'
    ).catch(() => {});
  }
}

export async function verifyFacebookGroupAccess(config, options = {}) {
  const playwright = options.playwright || await import('playwright');
  const session = await createFacebookContext(playwright.chromium, config);
  const { context } = session;
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(config.groupUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page, config);
    await selectPostingProfile(page, config);
    const composer = await findFacebookGroupComposer(page);
    if (!composer) throw new FacebookSessionRequiredError('Facebook group posting is not available to the configured profile');
    try {
      await composer.click({ timeout: 10000 });
    } catch {
      throw new FacebookSessionRequiredError('Facebook group composer could not be opened');
    }
    const textBox = await firstVisibleLocator(page, TEXTBOX_SELECTORS);
    if (!textBox) throw new FacebookSessionRequiredError('Facebook group post text box is not available');
    await page.keyboard.press('Escape').catch(() => {});
    return { groupUrl: config.groupUrl };
  } finally {
    if (session.stateFile) await context.storageState({ path: session.stateFile }).catch(() => {});
    await context.close();
    if (session.browser) await session.browser.close();
  }
}

function validatePayload(payload) {
  if (payload?.site !== 'chiping' || payload?.channel !== 'facebook' || payload?.language !== 'he') {
    throw new Error('Unexpected social payload');
  }
  if (!/^chiping-facebook:v1:\d+$/.test(String(payload?.idempotency_key || payload?.idempotencyKey || ''))) {
    throw new Error('Invalid idempotency key');
  }
  if (!String(payload?.message || '').trim() || !String(payload?.imageUrl || '').trim()) {
    throw new Error('Payload is missing post text or image');
  }
  const itemUrl = new URL(String(payload.itemUrl || ''));
  if (itemUrl.protocol !== 'https:' || itemUrl.hostname !== 'www.chiping.co.il') {
    throw new Error('Payload item URL must target Chiping');
  }
}

export async function postFacebookGroupJob(job, config, options = {}) {
  validatePayload(job.payload);
  const playwright = options.playwright || await import('playwright');
  const chromium = playwright.chromium;
  const fetchImpl = options.fetchImpl || fetch;
  const session = await createFacebookContext(chromium, config);
  const { context } = session;
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(config.groupUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page, config);
    await selectPostingProfile(page, config);
    await sortFacebookGroupFeedNewest(page);
    const existing = await findFacebookGroupPostWithMediaFallback(page, {
      groupUrl: config.groupUrl,
      itemUrl: job.payload.itemUrl,
      timeoutMs: 5000,
      currentPageOnly: true,
    });
    if (existing.postUrl) return { postUrl: existing.postUrl };

    const composer = await findFacebookGroupComposer(page);
    if (!composer) throw new Error('Facebook group composer was not found');
    await composer.click();

    let textBox = await firstVisibleLocator(page, TEXTBOX_SELECTORS);
    if (!textBox) throw new Error('Facebook group post text box was not found');
    await captureFacebookDebug(page, config, 'composer-open');

    const previewMetadata = await validateChipingLinkPreviewMetadata(
      job.payload.itemUrl,
      job.payload.imageUrl,
      fetchImpl
    );
    await captureFacebookDebug(page, config, 'link-metadata-verified', previewMetadata);
    try {
      await fillFacebookComposerText(page, textBox, String(job.payload.message));
    } catch (error) {
      await captureFacebookDebug(page, config, 'text-entry-failed');
      throw error;
    }
    await captureFacebookDebug(page, config, 'text-entered');
    const linkPreview = await waitForFacebookLinkPreview(page, job.payload.itemUrl);
    await captureFacebookDebug(page, config, 'link-preview-ready', linkPreview);
    if (await isSecurityChallenge(page)) throw new FacebookSessionRequiredError();

    const postButton = await firstVisibleLocator(page, POST_SELECTORS);
    if (!postButton) throw new Error('Facebook group publish button was not found');
    await waitForEnabledFacebookControl(page, postButton);
    await captureFacebookDebug(page, config, 'before-submit');
    await captureFacebookDebug(page, config, 'publish-control', {
      text: await postButton.innerText().catch(() => ''),
      ariaLabel: await postButton.getAttribute('aria-label').catch(() => ''),
      enabled: await postButton.isEnabled().catch(() => false),
    });
    await postButton.click();
    await page.waitForTimeout(2000);
    await captureFacebookDebug(page, config, 'posting');
    await waitForFacebookComposerToClose(page, textBox);
    if (await isSecurityChallenge(page)) throw new FacebookSessionRequiredError();
    await captureFacebookDebug(page, config, 'after-submit');

    const published = await findFacebookGroupPostWithMediaFallback(page, {
      groupUrl: config.groupUrl,
      itemUrl: job.payload.itemUrl,
      timeoutMs: 30000,
      currentPageOnly: true,
    });
    await captureFacebookDebug(page, config, 'after-verification');
    if (!published.found || !published.postUrl) {
      throw new Error('Facebook did not expose the published group post');
    }
    return { postUrl: published.postUrl };
  } finally {
    if (session.stateFile) await context.storageState({ path: session.stateFile }).catch(() => {});
    await context.close();
    if (session.browser) await session.browser.close();
  }
}
