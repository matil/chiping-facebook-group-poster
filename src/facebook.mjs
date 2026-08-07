import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertValidChipingFacebookPayload,
  chipingFacebookTarget,
} from './payload.mjs';

const LOGIN_URL_RE = /\/login/i;
const SECURITY_URL_RE = /\/(?:checkpoint|recover|two_step_verification|security)/i;
const SECURITY_TEXT_RE = /(?:security check|checkpoint|two-factor|approve your login|בדיקת אבטחה|(?:^|[^\u0590-\u05ff])אימות(?:$|[^\u0590-\u05ff]))/i;

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

const POST_SELECTORS = [
  '[role="dialog"] [role="button"][aria-label="Post"]',
  '[role="dialog"] [role="button"][aria-label="פרסום"]',
  '[role="dialog"] [role="button"]:has-text("Post")',
  '[role="dialog"] [role="button"]:has-text("פרסום")',
];

const FACEBOOK_COMPOSER_LINK_PREVIEW_TIMEOUT_MS = 90_000;

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

export async function findFacebookComposerTextBox(page, timeoutMs = 15000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 15000);
  while (Date.now() < deadline) {
    const candidates = page.locator(
      '[role="dialog"] [contenteditable="true"][role="textbox"]'
    );
    const count = Math.min(await candidates.count().catch(() => 0), 10);
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const label = String(await candidate.getAttribute('aria-label').catch(() => '') || '');
      if (/(?:^|\b)comment(?:\b|$)|\u05ea\u05d2\u05d5\u05d1\u05d4/i.test(label)) continue;
      return candidate;
    }
    await page.waitForTimeout(250);
  }
  return null;
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

export function isFacebookSecurityChallengeText(value) {
  return SECURITY_TEXT_RE.test(String(value || ''));
}

async function isSecurityChallenge(page) {
  if (SECURITY_URL_RE.test(page.url())) return true;
  const text = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  return isFacebookSecurityChallengeText(text);
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
    const groupRoot = url.pathname.match(/^\/groups\/(chiping|\d+)\/?$/i)?.[1];
    const queryPostId = url.searchParams.get('multi_permalinks')
      || url.searchParams.get('story_fbid');
    if (groupRoot && /^\d+$/.test(String(queryPostId || ''))) {
      return `https://www.facebook.com/groups/${groupRoot}/posts/${queryPostId}/`;
    }
    if (!/^\/groups\/(?:chiping|\d+)\/(?:posts|permalink)\/(?:\d+|pfbid[a-z0-9]+)\/?$/i.test(url.pathname)) return '';
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

async function recoverBlankFacebookPage(page, targetUrl) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForTimeout(attempt === 0 ? 3000 : 5000);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const visibleControls = await page.locator('[role="button"], [role="main"], form').count().catch(() => 0);
    if (bodyText.trim().length >= 40 || visibleControls > 2) return true;
    if (attempt < 2) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
  }
  return false;
}

export class FacebookPostMediaRequiredError extends Error {
  constructor(
    message = 'Facebook published the Chiping post without its product image link card',
    options = {}
  ) {
    super(message);
    this.name = 'FacebookPostMediaRequiredError';
    this.postUrl = String(options.postUrl || '').trim();
  }
}

export class FacebookPostPreparationRequiredError extends Error {
  constructor(message = 'Facebook post preparation is incomplete') {
    const detail = String(message || 'Facebook post preparation is incomplete')
      .replace(/^Facebook preparation incomplete:\s*/i, '');
    super(`Facebook preparation incomplete: ${detail}`);
    this.name = 'FacebookPostPreparationRequiredError';
  }
}

export class FacebookPostUnavailableError extends Error {
  constructor(message = 'Chiping item is no longer available for Facebook posting') {
    super(message);
    this.name = 'FacebookPostUnavailableError';
  }
}

function normalizedFacebookText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u034f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('he');
}

function referencesExactChipingItem(value, productId) {
  const decoded = decodedUrl(value);
  const references = [
    `www.chiping.co.il/?item=${productId}`,
    `chiping.co.il/?item=${productId}`,
    `www.chiping.co.il/items/${productId}/`,
    `chiping.co.il/items/${productId}/`,
    `www.chiping.co.il/items/${productId}`,
    `chiping.co.il/items/${productId}`,
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

function referencesExactChipingTarget(value, target) {
  if (target?.type === 'item') return referencesExactChipingItem(value, target.value);
  if (target?.type !== 'coupons') return false;
  const decoded = decodedUrl(value);
  const references = [
    'www.chiping.co.il/?coupons=1',
    'chiping.co.il/?coupons=1',
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
  const target = chipingFacebookTarget(itemUrl);
  if (!target) throw new Error('Facebook post verification requires a supported Chiping URL');

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
      .some((value) => referencesExactChipingTarget(value, target));
    if (!matchesItem) continue;

    for (const href of hrefs) {
      const postUrl = normalizeFacebookGroupPostUrl(href);
      if (postUrl) return { found: true, postUrl };
    }
    return { found: true, postUrl: '' };
  }
  return { found: false, postUrl: '' };
}

export async function findFacebookGroupPostViaTargetAnchor(page, itemUrl) {
  const target = chipingFacebookTarget(itemUrl);
  if (!target) throw new Error('Facebook post verification requires a supported Chiping URL');

  let result = { targetFound: false, hrefs: [] };
  try {
    result = await page.locator('a[href], [data-lynx-uri]').evaluateAll((nodes, expectedTargetValue) => {
    const expectedTarget = typeof expectedTargetValue === 'string'
      ? { type: 'item', value: expectedTargetValue }
      : expectedTargetValue;
    const decode = (value) => {
      let output = String(value || '');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const next = decodeURIComponent(output);
          if (next === output) break;
          output = next;
        } catch {
          break;
        }
      }
      return output;
    };
    const referencesItem = (value) => {
      const decoded = decode(value);
      const references = expectedTarget.type === 'item'
          ? [
            `www.chiping.co.il/?item=${expectedTarget.value}`,
            `chiping.co.il/?item=${expectedTarget.value}`,
            `www.chiping.co.il/items/${expectedTarget.value}/`,
            `chiping.co.il/items/${expectedTarget.value}/`,
            `www.chiping.co.il/items/${expectedTarget.value}`,
            `chiping.co.il/items/${expectedTarget.value}`,
          ]
        : [
            'www.chiping.co.il/?coupons=1',
            'chiping.co.il/?coupons=1',
          ];
      return references.some((reference) => {
        const offset = decoded.indexOf(reference);
        if (offset < 0) return false;
        const nextCharacter = decoded[offset + reference.length] || '';
        return !nextCharacter || /[&#\s"'<>]/.test(nextCharacter);
      });
    };
    const valuesForNode = (node) => [
      node?.href,
      node?.getAttribute?.('href'),
      node?.getAttribute?.('data-lynx-uri'),
    ].map((value) => String(value || '')).filter(Boolean);
    const isConcretePostUrl = (value) => {
      try {
        const url = new URL(String(value || ''), 'https://www.facebook.com');
        if (!['facebook.com', 'www.facebook.com'].includes(url.hostname)) return false;
        if (/^\/groups\/(?:chiping|\d+)\/(?:posts|permalink)\/(?:\d+|pfbid[a-z0-9]+)\/?$/i.test(url.pathname)) return true;
        if (/^\/photo(?:\.php)?\/?$/i.test(url.pathname)
          && /^gm\.\d+$/i.test(String(url.searchParams.get('set') || ''))) {
          return true;
        }
        return /^\/groups\/(?:chiping|\d+)\/?$/i.test(url.pathname)
          && /^\d+$/.test(String(
            url.searchParams.get('multi_permalinks')
            || url.searchParams.get('story_fbid')
            || ''
          ));
      } catch {
        return false;
      }
    };

    let targetFound = false;
    for (const node of nodes) {
      if (!valuesForNode(node).some(referencesItem)) continue;
      targetFound = true;
      let scope = node;
      for (let depth = 0; scope && depth < 16; depth += 1) {
        const links = [
          ...(scope.matches?.('a[href], [data-lynx-uri]') ? [scope] : []),
          ...scope.querySelectorAll('a[href], [data-lynx-uri]'),
        ];
        const hrefs = links.flatMap(valuesForNode);
        const postUrl = hrefs.find(isConcretePostUrl);
        if (postUrl) return { targetFound: true, hrefs: [postUrl] };
        scope = scope.parentElement;
      }
    }
    return { targetFound, hrefs: [] };
    }, target.type === 'item' ? target.value : target);
  } catch {
    return { found: false, postUrl: '' };
  }

  const postUrl = (Array.isArray(result?.hrefs) ? result.hrefs : [])
    .map(normalizeFacebookGroupPostUrl)
    .find(Boolean) || '';
  return {
    found: Boolean(result?.targetFound),
    postUrl,
  };
}

export async function findFacebookGroupPostViaLinkCardTitle(page, expectedTitle, options = {}) {
  const normalizedTitle = normalizedFacebookText(expectedTitle);
  if (normalizedTitle.length < 8) return { found: false, postUrl: '' };
  const requireLoadedLinkImage = options.requireLoadedLinkImage === true;
  const requiredTarget = chipingFacebookTarget(options.requiredItemUrl);
  const titleTokens = [...new Set(
    normalizedTitle.match(/[\p{L}\p{N}%]+/gu) || []
  )];
  const diagnosticsEnabled = /^(?:1|true|yes|on)$/i.test(
    String(process.env.FACEBOOK_VERIFIER_DIAGNOSTICS || '')
  );

  const articles = page.locator('[role="article"]');
  const count = Math.min(await articles.count().catch(() => 0), 50);
  let articleMatchFound = false;
  if (diagnosticsEnabled) {
    console.log(`[facebook-verifier] link-card scan: ${JSON.stringify({
      expectedTitle: normalizedTitle,
      articleCount: count,
    })}`);
  }
  for (let index = 0; index < count; index += 1) {
    const article = articles.nth(index);
    if (!await article.isVisible().catch(() => false)) continue;
    const [text, hrefs, mediaMetrics] = await Promise.all([
      article.innerText().catch(() => ''),
      article.locator('a[href], [data-lynx-uri]').evaluateAll((links) => links.flatMap((link) => [
        link.href,
        link.getAttribute('href'),
        link.getAttribute('data-lynx-uri'),
      ].filter(Boolean))).catch(() => []),
      requireLoadedLinkImage
        ? article.locator([
            'img',
            '[role="img"]',
            '[data-visualcompletion="media-vc-image"]',
            '[style*="background-image"]',
          ].join(', ')).evaluateAll((nodes) => nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            const link = node.closest('a[href], [data-lynx-uri], [role="link"]');
            return {
              width: rect.width,
              height: rect.height,
              visible: rect.width > 0 && rect.height > 0,
              imageLoaded: (
                node.tagName === 'IMG'
                && Number(node.naturalWidth) >= 180
                && Number(node.naturalHeight) >= 120
                && !/^data:/i.test(String(node.currentSrc || node.src || ''))
              ) || /url\(["']?https?:\/\//i.test(style.backgroundImage || ''),
              clickable: Boolean(link),
              clickTargets: link ? [
                link.href,
                link.getAttribute('href'),
                link.getAttribute('data-lynx-uri'),
              ].map((value) => String(value || '')).filter(Boolean) : [],
            };
          })).catch(() => [])
        : Promise.resolve([]),
    ]);
    const normalizedText = normalizedFacebookText(text);
    const matchesTitle = normalizedTitle.length >= 8 && (
      normalizedText.includes(normalizedTitle)
      || (titleTokens.length >= 3 && titleTokens.every((token) => normalizedText.includes(token)))
    );
    const hasChipingMarker = normalizedText.includes('chiping.co.il');
    const hasLoadedLinkImage = !requireLoadedLinkImage
      || hasLoadedFacebookPostLinkImage(mediaMetrics, requiredTarget);
    if (diagnosticsEnabled && (hasChipingMarker || matchesTitle)) {
      console.log(`[facebook-verifier] link-card candidate: ${JSON.stringify({
        index,
        hasChipingMarker,
        hasLoadedLinkImage,
        missingTitleTokens: titleTokens.filter((token) => !normalizedText.includes(token)),
        postUrls: hrefs.map(normalizeFacebookGroupPostUrl).filter(Boolean),
      })}`);
    }
    if (!matchesTitle || !hasChipingMarker || !hasLoadedLinkImage) {
      continue;
    }
    articleMatchFound = true;
    const postUrl = hrefs
      .map(normalizeFacebookGroupPostUrl)
      .find(Boolean) || '';
    if (postUrl) return { found: true, postUrl };
  }

  const domResult = await page.locator('body').evaluate((body, input) => {
    const expectedTokens = Array.isArray(input) ? input : input.tokens;
    const requireImage = !Array.isArray(input) && input.requireLoadedLinkImage === true;
    const requiredTarget = !Array.isArray(input) ? input.requiredTarget : null;
    const normalize = (value) => String(value || '')
      .normalize('NFKC')
      .replace(/[\u034f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('he');
    const hasEveryToken = (value) => {
      const text = normalize(value);
      return expectedTokens.every((token) => text.includes(token));
    };
    const valuesForNode = (node) => [
      node?.href,
      node?.getAttribute?.('href'),
      node?.getAttribute?.('data-lynx-uri'),
    ].map((value) => String(value || '')).filter(Boolean);
    const isConcretePostUrl = (value) => {
      try {
        const url = new URL(String(value || ''), 'https://www.facebook.com');
        if (!['facebook.com', 'www.facebook.com'].includes(url.hostname)) return false;
        if (/^\/groups\/(?:chiping|\d+)\/(?:posts|permalink)\/(?:\d+|pfbid[a-z0-9]+)\/?$/i.test(url.pathname)) return true;
        if (/^\/photo(?:\.php)?\/?$/i.test(url.pathname)
          && /^gm\.\d+$/i.test(String(url.searchParams.get('set') || ''))) {
          return true;
        }
        return /^\/groups\/(?:chiping|\d+)\/?$/i.test(url.pathname)
          && /^\d+$/.test(String(
            url.searchParams.get('multi_permalinks')
            || url.searchParams.get('story_fbid')
            || ''
          ));
      } catch {
        return false;
      }
    };
    const decode = (value) => {
      let output = String(value || '');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const next = decodeURIComponent(output);
          if (next === output) break;
          output = next;
        } catch {
          break;
        }
      }
      return output;
    };
    const referencesTarget = (value) => {
      if (!requiredTarget) return true;
      const decoded = decode(value);
      const references = requiredTarget.type === 'item'
        ? [
            `www.chiping.co.il/?item=${requiredTarget.value}`,
            `chiping.co.il/?item=${requiredTarget.value}`,
            `www.chiping.co.il/items/${requiredTarget.value}/`,
            `chiping.co.il/items/${requiredTarget.value}/`,
            `www.chiping.co.il/items/${requiredTarget.value}`,
            `chiping.co.il/items/${requiredTarget.value}`,
          ]
        : ['www.chiping.co.il/?coupons=1', 'chiping.co.il/?coupons=1'];
      return references.some((reference) => {
        const offset = decoded.indexOf(reference);
        if (offset < 0) return false;
        const nextCharacter = decoded[offset + reference.length] || '';
        return !nextCharacter || /[&#\s"'<>]/.test(nextCharacter);
      });
    };
    const hasLoadedLinkImage = (scope) => [...scope.querySelectorAll([
      'img',
      '[role="img"]',
      '[data-visualcompletion="media-vc-image"]',
      '[style*="background-image"]',
    ].join(', '))].some((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 120) return false;
      const style = getComputedStyle(node);
      const imageLoaded = (
        node.tagName === 'IMG'
        && Number(node.naturalWidth) >= 180
        && Number(node.naturalHeight) >= 120
        && !/^data:/i.test(String(node.currentSrc || node.src || ''))
      ) || /url\(["']?https?:\/\//i.test(style.backgroundImage || '');
      const link = node.closest('a[href], [data-lynx-uri], [role="link"]');
      if (!imageLoaded || !link) return false;
      return [link.href, link.getAttribute('href'), link.getAttribute('data-lynx-uri')]
        .some(referencesTarget);
    });
    const diagnosticLinks = [];
    const diagnosticControls = [];
    const recordDiagnosticLinks = (hrefs) => {
      for (const href of hrefs) {
        try {
          const url = new URL(String(href || ''), 'https://www.facebook.com');
          if (!['facebook.com', 'www.facebook.com'].includes(url.hostname)) continue;
          const safeParams = new URLSearchParams();
          for (const key of ['fbid', 'set', 'story_fbid', 'multi_permalinks', 'id']) {
            if (url.searchParams.has(key)) safeParams.set(key, url.searchParams.get(key));
          }
          const summarized = `${url.pathname}${safeParams.size ? `?${safeParams}` : ''}`;
          if (!diagnosticLinks.includes(summarized)) diagnosticLinks.push(summarized);
        } catch {
          // Ignore malformed links in diagnostics.
        }
      }
    };
    const recordDiagnosticControls = (scope) => {
      const controls = scope.querySelectorAll('a, button, [role], [tabindex], abbr, time, [data-utime]');
      for (const control of controls) {
        const text = normalize(control.textContent);
        const ariaLabel = normalize(control.getAttribute('aria-label'));
        const dateValue = String(
          control.getAttribute('data-utime')
          || control.getAttribute('datetime')
          || control.getAttribute('title')
          || ''
        ).slice(0, 80);
        if (!/\d/.test(`${text}${ariaLabel}${dateValue}`)
          || (text.length > 40 && ariaLabel.length > 80 && !dateValue)) {
          continue;
        }
        const summary = {
          tag: String(control.tagName || '').toLowerCase(),
          role: String(control.getAttribute('role') || ''),
          text: text.slice(0, 40),
          ariaLabel: ariaLabel.slice(0, 80),
          dateValue,
        };
        const serialized = JSON.stringify(summary);
        if (!diagnosticControls.some((entry) => JSON.stringify(entry) === serialized)) {
          diagnosticControls.push(summary);
        }
        if (diagnosticControls.length >= 30) break;
      }
    };

    let timestampMarked = false;
    let qualifiedTitleFound = false;
    const candidates = [...body.querySelectorAll('a, span, div')]
      .filter((node) => hasEveryToken(node.textContent))
      .filter((node) => ![...node.children].some((child) => hasEveryToken(child.textContent)));
    for (const candidate of candidates) {
      let scope = candidate;
      for (let depth = 0; scope && depth < 24; depth += 1, scope = scope.parentElement) {
        if (!normalize(scope.textContent).includes('chiping.co.il')) continue;
        if (requireImage && !hasLoadedLinkImage(scope)) continue;
        qualifiedTitleFound = true;
        const links = [
          ...(scope.matches?.('a[href], [data-lynx-uri]') ? [scope] : []),
          ...scope.querySelectorAll('a[href], [data-lynx-uri]'),
        ];
        const hrefs = links.flatMap(valuesForNode);
        recordDiagnosticLinks(hrefs);
        recordDiagnosticControls(scope);
        if (!timestampMarked) {
          const controls = scope.querySelectorAll('a, [role="link"], button, [role="button"]');
          for (const control of controls) {
            const rawText = String(control.textContent || '');
            const text = normalize(rawText);
            const ariaLabel = normalize(control.getAttribute('aria-label'));
            let facebookRootLink = false;
            try {
              const controlUrl = new URL(
                String(control.getAttribute('href') || ''),
                'https://www.facebook.com'
              );
              facebookRootLink = ['facebook.com', 'www.facebook.com'].includes(controlUrl.hostname)
                && controlUrl.pathname === '/';
            } catch {
              facebookRootLink = false;
            }
            const timestampLike = /^(?:just now|\d+\s*(?:m|min|h|hr|d|w))$/i.test(text)
              || /^\d+\s*(?:\u05d3\u05e7(?:\u05d5\u05ea)?|\u05e9\u05e2(?:\u05d5\u05ea)?|\u05d9\u05de\u05d9\u05dd?)$/u.test(text)
              || /\b\d+\s+(?:minute|hour|day)s?\b/i.test(ariaLabel)
              || (rawText.includes('\u034f')
                && control.matches('a, [role="link"]')
                && (
                  facebookRootLink
                  || /\d+\s*(?:m|min|h|hr|d|w)/i.test(text)
                ));
            if (!timestampLike) continue;
            control.setAttribute('data-chiping-post-timestamp-probe', 'true');
            timestampMarked = true;
            break;
          }
        }
        const postUrl = hrefs.find(isConcretePostUrl);
        if (postUrl) {
          return {
            titleFound: true,
            hrefs: [postUrl],
            timestampMarked,
            diagnosticLinks: diagnosticLinks.slice(0, 30),
            diagnosticControls: diagnosticControls.slice(0, 30),
          };
        }
      }
    }
    return {
      titleFound: qualifiedTitleFound,
      hrefs: [],
      timestampMarked,
      diagnosticLinks: diagnosticLinks.slice(0, 30),
      diagnosticControls: diagnosticControls.slice(0, 30),
    };
  }, requireLoadedLinkImage ? {
    tokens: titleTokens,
    requireLoadedLinkImage: true,
    requiredTarget,
  } : titleTokens).catch(() => ({
    titleFound: false,
    hrefs: [],
    timestampMarked: false,
    diagnosticLinks: [],
    diagnosticControls: [],
  }));
  let domPostUrl = (Array.isArray(domResult?.hrefs) ? domResult.hrefs : [])
    .map(normalizeFacebookGroupPostUrl)
    .find(Boolean) || '';
  if (!domPostUrl && domResult?.timestampMarked === true) {
    const timestamp = page.locator('[data-chiping-post-timestamp-probe="true"]').first();
    await timestamp.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000).catch(() => {});
    const context = typeof page.context === 'function' ? page.context() : null;
    const pages = context?.pages?.() || [page];
    const openedCandidates = [];
    for (const candidate of pages) {
      openedCandidates.push(candidate.url?.());
      const hrefs = await candidate.locator('a[href]').evaluateAll((links) => (
        links.map((link) => link.href)
      )).catch(() => []);
      openedCandidates.push(...hrefs);
    }
    domPostUrl = openedCandidates
      .map(normalizeFacebookGroupPostUrl)
      .find(Boolean) || '';
  }
  if (diagnosticsEnabled) {
    console.log(`[facebook-verifier] link-card DOM fallback: ${JSON.stringify({
      titleFound: domResult?.titleFound === true,
      timestampMarked: domResult?.timestampMarked === true,
      postUrl: domPostUrl,
      candidateLinks: domResult?.diagnosticLinks || [],
      candidateControls: domResult?.diagnosticControls || [],
    })}`);
  }
  return {
    found: articleMatchFound || domResult?.titleFound === true,
    postUrl: domPostUrl,
  };
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
  searchTerm = '',
} = {}) {
  const waitBudgetMs = Math.max(5000, Math.min(Number(timeoutMs) || 30000, 60000));
  const target = chipingFacebookTarget(itemUrl);
  if (!target) throw new Error('Facebook post verification requires a supported Chiping URL');
  const groupSearchTerm = target.type === 'item'
    ? (String(searchTerm || '').trim() || target.value)
    : 'קופוני AliExpress';
  const destinations = [
    `${groupUrl}/search/?q=${encodeURIComponent(groupSearchTerm)}`,
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
      const target = chipingFacebookTarget(itemUrl);
      if (target && [bodyText, ...hrefs].some((value) => referencesExactChipingTarget(value, target))) {
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
  expectedTitle = '',
  expectedMessage = '',
  timeoutMs = 30000,
  currentPageOnly = false,
  mediaCandidateLimit = 12,
  requireLoadedLinkImage = false,
} = {}) {
  if (requireLoadedLinkImage) {
    const completeCurrent = await findFacebookGroupPostViaLinkCardTitle(
      page,
      expectedTitle,
      { requireLoadedLinkImage: true, requiredItemUrl: itemUrl }
    );
    if (completeCurrent.found) return completeCurrent;
    const completeMessageCurrent = String(expectedMessage || '').trim()
      ? await findFacebookGroupPostViaLinkCardTitle(page, expectedMessage, {
          requireLoadedLinkImage: true,
        })
      : { found: false, postUrl: '' };
    if (completeMessageCurrent.found) return completeMessageCurrent;
    const incompleteCurrent = await findFacebookGroupPostViaLinkCardTitle(page, expectedTitle);
    if (currentPageOnly) {
      return {
        found: false,
        postUrl: incompleteCurrent.postUrl || '',
        incomplete: incompleteCurrent.found === true,
      };
    }

    let completeSearch = { found: false, postUrl: '' };
    let incompleteSearch = { found: false, postUrl: '' };
    if (String(expectedTitle || '').trim()) {
      const searchUrl = `${groupUrl}/search/?q=${encodeURIComponent(String(expectedTitle).trim())}`;
      page = await navigateFacebookForVerification(page, searchUrl);
      await page.waitForTimeout(2000);
      completeSearch = await findFacebookGroupPostViaLinkCardTitle(
        page,
        expectedTitle,
        { requireLoadedLinkImage: true, requiredItemUrl: itemUrl }
      );
      if (completeSearch.found) return completeSearch;
      incompleteSearch = await findFacebookGroupPostViaLinkCardTitle(page, expectedTitle);
    }
    if (String(expectedMessage || '').trim()) {
      const messageSearchUrl = `${groupUrl}/search/?q=${encodeURIComponent(String(expectedMessage).trim())}`;
      page = await navigateFacebookForVerification(page, messageSearchUrl);
      await page.waitForTimeout(2000);
      const completeMessageSearch = await findFacebookGroupPostViaLinkCardTitle(
        page,
        expectedMessage,
        { requireLoadedLinkImage: true }
      );
      if (completeMessageSearch.found) return completeMessageSearch;
    }
    const incompleteResult = incompleteCurrent.found ? incompleteCurrent : incompleteSearch;
    return {
      found: false,
      postUrl: incompleteResult.postUrl || '',
      incomplete: incompleteResult.found === true,
    };
  }
  const result = await findFacebookGroupPostOnPage(page, {
    groupUrl,
    itemUrl,
    timeoutMs,
    currentPageOnly,
    searchTerm: expectedTitle,
  });
  if (result.postUrl) return result;
  const targetAnchorResult = await findFacebookGroupPostViaTargetAnchor(page, itemUrl);
  if (targetAnchorResult.postUrl) return targetAnchorResult;
  const titleResult = await findFacebookGroupPostViaLinkCardTitle(page, expectedTitle);
  if (titleResult.postUrl) return titleResult;
  const normalizedExpectedMessage = String(expectedMessage || '').trim();
  let messageResult = normalizedExpectedMessage
    ? await findFacebookGroupPostViaLinkCardTitle(page, normalizedExpectedMessage)
    : { found: false, postUrl: '' };
  if (normalizedExpectedMessage && !messageResult.postUrl && !currentPageOnly) {
    const messageSearchUrl = `${groupUrl}/search/?q=${encodeURIComponent(normalizedExpectedMessage)}`;
    page = await navigateFacebookForVerification(page, messageSearchUrl);
    await page.waitForTimeout(2000);
    messageResult = await findFacebookGroupPostViaLinkCardTitle(page, normalizedExpectedMessage);
  }
  if (messageResult.postUrl) return messageResult;
  if (result.found || targetAnchorResult.found || titleResult.found || messageResult.found) {
    return { found: true, postUrl: '' };
  }
  return findFacebookGroupPostViaMedia(page, itemUrl, {
    maxCandidates: mediaCandidateLimit,
  });
}

export async function findFacebookGroupPost(config, itemUrl, options = {}) {
  const playwright = options.playwright || await import('playwright');
  const expectedTitle = String(options.expectedTitle || '').trim()
    || await fetchChipingLinkPreviewTitle(itemUrl, options.fetchImpl || fetch).catch(() => '');
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
      expectedTitle,
      expectedMessage: String(options.expectedMessage || '').trim(),
      timeoutMs: options.timeoutMs,
      currentPageOnly: options.currentPageOnly === true,
      mediaCandidateLimit: options.mediaCandidateLimit,
      requireLoadedLinkImage: options.requireLoadedLinkImage === true,
    });
    if (options.screenshotPath) {
      await page.screenshot({ path: options.screenshotPath, fullPage: true }).catch(() => {});
    }
    if (result.found && options.verifyImageDestination === true) {
      const destination = await verifyFacebookPostImageDestination(page, {
        expectedTitle,
        itemUrl,
      });
      if (options.screenshotPath) {
        const extension = path.extname(options.screenshotPath);
        const clickedPath = extension
          ? `${options.screenshotPath.slice(0, -extension.length)}-after-click${extension}`
          : `${options.screenshotPath}-after-click.png`;
        await page.screenshot({ path: clickedPath, fullPage: true }).catch(() => {});
      }
      return {
        ...result,
        found: destination.verified === true,
        imageDestinationVerified: destination.verified === true,
        imageDestinationUrl: destination.destinationUrl || '',
      };
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

export async function validateFacebookPreparedImageAsset(imageUrl, fetchImpl = fetch) {
  const image = await downloadImage(imageUrl, fetchImpl);
  if (image.bytes.length < 10 * 1024) {
    throw new Error('Prepared Facebook image is unexpectedly small');
  }
  const jpeg = image.mimeType === 'image/jpeg' || image.mimeType === 'image/jpg';
  const png = image.mimeType === 'image/png';
  if (jpeg && !(image.bytes[0] === 0xff && image.bytes[1] === 0xd8)) {
    throw new Error('Prepared Facebook JPEG is invalid');
  }
  if (png && !image.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Prepared Facebook PNG is invalid');
  }
  return { bytes: image.bytes.length, mimeType: image.mimeType };
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

async function fetchChipingLinkPreviewTitle(itemUrl, fetchImpl = fetch) {
  const response = await fetchImpl(String(itemUrl || ''), {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'User-Agent': 'facebookexternalhit/1.1 (+https://www.facebook.com/externalhit_uatext.php)',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) return '';
  return readHtmlMetaContent(await response.text(), 'og:title');
}

export async function validateChipingLinkPreviewMetadata(
  itemUrl,
  expectedImageUrl,
  fetchImpl = fetch
) {
  const response = await fetchImpl(String(itemUrl || ''), {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'User-Agent': 'facebookexternalhit/1.1 (+https://www.facebook.com/externalhit_uatext.php)',
    },
    signal: AbortSignal.timeout(30000),
  });
  if ([404, 410].includes(response.status)) throw new FacebookPostUnavailableError();
  if (!response.ok) {
    throw new Error(`Chiping link preview returned HTTP ${response.status}`);
  }
  const html = await response.text();
  const canonicalUrl = readHtmlMetaContent(html, 'og:url');
  const linkTitle = readHtmlMetaContent(html, 'og:title');
  const imageUrl = readHtmlMetaContent(html, 'og:image');
  const imageWidth = Number(readHtmlMetaContent(html, 'og:image:width'));
  const imageHeight = Number(readHtmlMetaContent(html, 'og:image:height'));
  if (new URL(canonicalUrl).href !== new URL(String(itemUrl || '')).href) {
    throw new Error('Chiping link preview has the wrong destination URL');
  }
  const previewTarget = chipingFacebookTarget(itemUrl);
  if (!linkTitle || /^\s*(?:www\.)?chiping\.co\.il\s*$/i.test(linkTitle)) {
    throw new Error('Chiping link preview has no meaningful link title');
  }
  if (previewTarget?.type === 'item' && linkTitle !== '\u05dc\u05e4\u05e8\u05d8\u05d9 \u05d4\u05d3\u05d9\u05dc') {
    throw new Error('Chiping item link preview has the wrong link title');
  }
  const actualImage = new URL(imageUrl);
  const expectedImage = new URL(String(expectedImageUrl || ''));
  const itemId = previewTarget?.type === 'item' ? previewTarget.value : '';
  const currentPreparedImage = /^\d+$/.test(itemId)
    && actualImage.protocol === 'https:'
    && actualImage.hostname === 'www.chiping.co.il'
    && actualImage.pathname === `/facebook-images/${itemId}.jpg`;
  if (actualImage.href !== expectedImage.href && !currentPreparedImage) {
    const error = new Error('Chiping link preview has not exposed the prepared Facebook image');
    error.previewMetadata = {
      expectedImageUrl: expectedImage.href,
      imageUrl: actualImage.href,
    };
    throw error;
  }
  if (imageWidth !== 1200 || imageHeight !== 630) {
    throw new Error('Chiping link preview image must be 1200x630');
  }
  return { canonicalUrl, linkTitle, imageUrl, imageWidth, imageHeight };
}

export async function validateFacebookJobReadiness(job, options = {}) {
  validatePayload(job?.payload);
  const fetchImpl = options.fetchImpl || fetch;
  const shareUrl = buildFacebookPreviewShareUrl(
    job.payload.itemUrl,
    job.payload.imageUrl,
    job.attempts
  );
  const metadata = await waitForChipingLinkPreviewMetadata(
    shareUrl,
    job.payload.imageUrl,
    fetchImpl,
    {
      attempts: options.attempts || 2,
      delayMs: options.delayMs || 1000,
      sleep: options.sleep,
    }
  );
  const image = await validateFacebookPreparedImageAsset(metadata.imageUrl, fetchImpl);
  return { shareUrl, metadata, image };
}

export async function waitForChipingLinkPreviewMetadata(
  itemUrl,
  expectedImageUrl,
  fetchImpl = fetch,
  options = {}
) {
  const attempts = Math.max(1, Math.min(Number(options.attempts) || 4, 8));
  const delayMs = Math.max(0, Number(options.delayMs) || 2000);
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await validateChipingLinkPreviewMetadata(itemUrl, expectedImageUrl, fetchImpl);
    } catch (error) {
      lastError = error;
      if (error instanceof FacebookPostUnavailableError) throw error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError || new Error('Chiping link preview metadata verification failed');
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
    return normalizedExpected.length > 0 && normalizedActual.includes(normalizedExpected);
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

function cleanFacebookComposerMessage(message, itemUrl) {
  const url = String(itemUrl || '').trim();
  let cleaned = String(message || '').replace(/\r\n?/g, '\n');
  const removableUrls = new Set(url ? [url] : []);
  try {
    const canonicalUrl = new URL(url);
    canonicalUrl.searchParams.delete('fb_preview');
    removableUrls.add(canonicalUrl.href);
    const target = chipingFacebookTarget(url);
    if (target?.type === 'item') {
      removableUrls.add(`https://www.chiping.co.il/?item=${target.value}`);
      removableUrls.add(`https://www.chiping.co.il/items/${target.value}`);
    }
  } catch {
    // The caller validates supported Chiping URLs before this helper runs.
  }
  for (const removableUrl of removableUrls) {
    cleaned = cleaned.split(removableUrl).join('');
  }
  return cleaned
    .split('\n')
    .map((line) => line.replace(/^\s*\u{1f517}\ufe0f?\s*$/u, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function selectFacebookComposerText(textBox, text) {
  const target = String(text || '');
  if (!target) return false;
  return textBox.evaluate((editor, needle) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let combined = '';
    while (walker.nextNode()) {
      const node = walker.currentNode;
      nodes.push({ node, start: combined.length, end: combined.length + node.data.length });
      combined += node.data;
    }
    const offset = combined.lastIndexOf(needle);
    if (offset < 0) return false;
    const endOffset = offset + needle.length;
    const startNode = nodes.find((entry) => entry.start <= offset && entry.end >= offset);
    const endNode = nodes.find((entry) => entry.start <= endOffset && entry.end >= endOffset)
      || nodes.at(-1);
    if (!startNode || !endNode) return false;
    const range = document.createRange();
    range.setStart(startNode.node, offset - startNode.start);
    range.setEnd(endNode.node, Math.min(endNode.node.data.length, endOffset - endNode.start));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
    return !selection.isCollapsed;
  }, target).catch(() => false);
}

export async function waitForFacebookLinkPreview(
  page,
  itemUrl,
  timeoutMs = 30000,
  composerTextBox = null
) {
  const target = new URL(String(itemUrl || ''));
  const chipingTarget = chipingFacebookTarget(itemUrl);
  if (!chipingTarget) throw new Error('Facebook link preview requires a supported Chiping URL');
  const host = target.hostname.replace(/^www\./i, '').toLowerCase();
  const dialog = composerTextBox?.locator
    ? composerTextBox.locator('xpath=ancestor::*[@role="dialog"][1]')
    : page.locator('[role="dialog"]').last();
  const visualSelector = [
    'a[href]',
    '[role="link"]',
    'img',
    '[role="img"]',
    '[data-visualcompletion="media-vc-image"]',
    '[style*="background-image"]',
  ].join(', ');
  const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 30000);
  let lastProbe = null;
  while (Date.now() < deadline) {
    const [dialogText, hrefs, visualMetrics] = await Promise.all([
      dialog.innerText().catch(() => ''),
      dialog.locator('a[href]').evaluateAll((links) => links.map((link) => link.href)).catch(() => []),
      dialog.locator(visualSelector).evaluateAll((nodes) => (
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          const link = node.closest('a[href], [data-lynx-uri], [role="link"]');
          return {
            width: rect.width,
            height: rect.height,
            visible: rect.width > 0 && rect.height > 0,
            tagName: node.tagName,
            role: node.getAttribute('role') || '',
            imageLoaded: (
              node.tagName === 'IMG'
              && Number(node.naturalWidth) >= 180
              && Number(node.naturalHeight) >= 120
              && !/^data:/i.test(String(node.currentSrc || node.src || ''))
            ) || /url\(["']?https?:\/\//i.test(getComputedStyle(node).backgroundImage || ''),
            clickTargets: link ? [
              link.href,
              link.getAttribute('href'),
              link.getAttribute('data-lynx-uri'),
            ].map((value) => String(value || '')).filter(Boolean) : [],
          };
        })
      )).catch(() => []),
    ]);
    const hasTargetAnchor = hrefs.some((href) => referencesExactChipingTarget(href, chipingTarget));
    const hostOccurrences = String(dialogText || '').toLowerCase().split(host).length - 1;
    const hasLargePreviewVisual = hasLoadedFacebookPreviewVisual(visualMetrics, chipingTarget);
    lastProbe = {
      hasTargetAnchor,
      hostOccurrences,
      hrefs: hrefs.slice(0, 20),
      visualMetrics: visualMetrics.slice(0, 30),
    };
    if (hasLargePreviewVisual && hasTargetAnchor) {
      return { hasTargetAnchor, hostOccurrences, visualMetrics };
    }
    await page.waitForTimeout(500);
  }
  const cardCandidates = await dialog.locator('*').evaluateAll((nodes, expectedHost) => (
    nodes
      .map((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 40) return null;
        const style = getComputedStyle(node);
        const text = String(node.innerText || node.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 180);
        const href = String(node.href || node.getAttribute('href') || '');
        const hasMedia = node.matches(
          'img, [role="img"], [data-visualcompletion="media-vc-image"]'
        ) || style.backgroundImage !== 'none'
          || Boolean(node.querySelector(
            'img, [role="img"], [data-visualcompletion="media-vc-image"], [style*="background-image"]'
          ));
        if (!hasMedia && !text.toLowerCase().includes(expectedHost) && !href.includes(expectedHost)) {
          return null;
        }
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          tagName: node.tagName,
          role: node.getAttribute('role') || '',
          ariaLabel: String(node.getAttribute('aria-label') || '').slice(0, 100),
          dataVisualCompletion: node.getAttribute('data-visualcompletion') || '',
          backgroundImage: style.backgroundImage !== 'none',
          hasMedia,
          href: href.slice(0, 240),
          text,
        };
      })
      .filter(Boolean)
      .sort((left, right) => (left.width * left.height) - (right.width * right.height))
      .slice(0, 40)
  ), host).catch(() => []);
  const error = new Error('Facebook did not render the Chiping link preview');
  error.previewProbe = {
    ...lastProbe,
    cardCandidates,
  };
  throw error;
}

export function hasLoadedFacebookPreviewVisual(visualMetrics = [], requiredTarget = null) {
  return (Array.isArray(visualMetrics) ? visualMetrics : []).some((metric) => (
    metric?.visible === true
    && Number(metric.width) >= 180
    && Number(metric.height) >= 120
    && metric.imageLoaded !== false
    && (!requiredTarget || (Array.isArray(metric.clickTargets) ? metric.clickTargets : [])
      .some((value) => referencesExactChipingTarget(value, requiredTarget)))
  ));
}

export function hasLoadedFacebookPostLinkImage(mediaMetrics = [], requiredTarget = null) {
  return (Array.isArray(mediaMetrics) ? mediaMetrics : []).some((metric) => (
    metric?.visible === true
    && Number(metric.width) >= 180
    && Number(metric.height) >= 120
    && metric.imageLoaded === true
    && metric.clickable === true
    && (!requiredTarget || (Array.isArray(metric.clickTargets) ? metric.clickTargets : [])
      .some((value) => referencesExactChipingTarget(value, requiredTarget)))
  ));
}

export async function verifyFacebookPostImageDestination(page, {
  expectedTitle = '',
  expectedMessage = '',
  itemUrl = '',
  timeoutMs = 10000,
} = {}) {
  const target = chipingFacebookTarget(itemUrl);
  const normalizedTitle = normalizedFacebookText(expectedTitle);
  const normalizedMessage = normalizedFacebookText(expectedMessage);
  if (!target || (normalizedTitle.length < 8 && normalizedMessage.length < 8)) {
    return { verified: false, destinationUrl: '' };
  }
  const titleTokens = [...new Set(normalizedTitle.match(/[\p{L}\p{N}%]+/gu) || [])];
  const messageTokens = [...new Set(normalizedMessage.match(/[\p{L}\p{N}%]+/gu) || [])];
  const observedUrls = new Set();
  const waitForDestination = async () => {
    const deadline = Date.now() + Math.max(3000, Math.min(Number(timeoutMs) || 10000, 20000));
    while (Date.now() < deadline) {
      const context = typeof page.context === 'function' ? page.context() : null;
      const pages = context?.pages?.() || [page];
      for (const candidatePage of pages) {
        const destinationUrl = String(candidatePage?.url?.() || '');
        if (destinationUrl) observedUrls.add(destinationUrl);
        if (referencesExactChipingTarget(destinationUrl, target)) {
          return { verified: true, destinationUrl, observedUrls: [...observedUrls] };
        }
      }
      await page.waitForTimeout(250).catch(() => new Promise((resolve) => setTimeout(resolve, 250)));
    }
    return {
      verified: false,
      destinationUrl: [...observedUrls].at(-1) || '',
      observedUrls: [...observedUrls],
    };
  };
  const mediaSelector = [
    'img',
    '[role="img"]',
    '[data-visualcompletion="media-vc-image"]',
    '[style*="background-image"]',
  ].join(', ');
  const articles = page.locator('[role="article"]');
  const articleCount = Math.min(await articles.count().catch(() => 0), 50);
  for (let articleIndex = 0; articleIndex < articleCount; articleIndex += 1) {
    const article = articles.nth(articleIndex);
    if (!await article.isVisible().catch(() => false)) continue;
    const normalizedText = normalizedFacebookText(await article.innerText().catch(() => ''));
    const hrefs = await article.locator('a[href], [data-lynx-uri]').evaluateAll((links) => links.flatMap((link) => [
      link.href,
      link.getAttribute('href'),
      link.getAttribute('data-lynx-uri'),
    ].filter(Boolean))).catch(() => []);
    const matchesTarget = hrefs.some((value) => referencesExactChipingTarget(value, target));
    const matchesTitle = normalizedTitle.length >= 8 && (
      normalizedText.includes(normalizedTitle)
      || (titleTokens.length >= 3 && titleTokens.every((token) => normalizedText.includes(token)))
    );
    const matchesMessage = normalizedMessage.length >= 8 && (
      normalizedText.includes(normalizedMessage)
      || (messageTokens.length >= 3 && messageTokens.every((token) => normalizedText.includes(token)))
    );
    if ((!matchesTarget && !matchesTitle && !matchesMessage)
      || !normalizedText.includes('chiping.co.il')) continue;

    const media = article.locator(mediaSelector);
    const candidates = await media.evaluateAll((nodes) => nodes.map((node, index) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const imageLoaded = (
        node.tagName === 'IMG'
        && Number(node.naturalWidth) >= 180
        && Number(node.naturalHeight) >= 120
        && !/^data:/i.test(String(node.currentSrc || node.src || ''))
      ) || /url\(["']?https?:\/\//i.test(style.backgroundImage || '');
      return {
        index,
        area: rect.width * rect.height,
        loaded: imageLoaded && rect.width >= 180 && rect.height >= 120,
        clickable: Boolean(node.closest('a[href], [data-lynx-uri], [role="link"]')),
      };
    })).catch(() => []);
    const candidate = candidates
      .filter((entry) => entry?.loaded === true && entry?.clickable === true)
      .sort((left, right) => Number(right.area || 0) - Number(left.area || 0))[0];
    if (!candidate) continue;

    const image = media.nth(candidate.index);
    const box = typeof image.boundingBox === 'function'
      ? await image.boundingBox().catch(() => null)
      : null;
    let clicked = box && page.mouse?.click
      ? await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        .then(() => true)
        .catch(() => false)
      : false;
    if (!clicked && typeof image.evaluate === 'function') {
      clicked = await image.evaluate((node) => {
        const link = node.closest('a[href], [data-lynx-uri], [role="link"]');
        if (!link) return false;
        link.click();
        return true;
      }).catch(() => true);
    }
    if (!clicked) {
      clicked = await image.click({ timeout: 10000, force: true })
        .then(() => true)
        .catch(() => false);
    }
    if (!clicked) continue;
    return waitForDestination();
  }

  const dialogs = page.locator('[role="dialog"]');
  const dialogCount = Math.min(await dialogs.count().catch(() => 0), 10);
  for (let dialogIndex = 0; dialogIndex < dialogCount; dialogIndex += 1) {
    const dialog = dialogs.nth(dialogIndex);
    if (!await dialog.isVisible().catch(() => false)) continue;
    const normalizedText = normalizedFacebookText(await dialog.innerText().catch(() => ''));
    const hrefs = await dialog.locator('a[href], [data-lynx-uri]').evaluateAll((links) => links.flatMap((link) => [
      link.href,
      link.getAttribute('href'),
      link.getAttribute('data-lynx-uri'),
    ].filter(Boolean))).catch(() => []);
    const matchesTarget = hrefs.some((value) => referencesExactChipingTarget(value, target));
    const matchesTitle = normalizedTitle.length >= 8 && (
      normalizedText.includes(normalizedTitle)
      || (titleTokens.length >= 3 && titleTokens.every((token) => normalizedText.includes(token)))
    );
    const matchesMessage = normalizedMessage.length >= 8 && (
      normalizedText.includes(normalizedMessage)
      || (messageTokens.length >= 3 && messageTokens.every((token) => normalizedText.includes(token)))
    );
    if ((!matchesTarget && !matchesTitle && !matchesMessage)
      || !normalizedText.includes('chiping.co.il')) continue;
    const media = dialog.locator(mediaSelector);
    const candidates = await media.evaluateAll((nodes) => nodes.map((node, index) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const imageLoaded = (
        node.tagName === 'IMG'
        && Number(node.naturalWidth) >= 180
        && Number(node.naturalHeight) >= 120
        && !/^data:/i.test(String(node.currentSrc || node.src || ''))
      ) || /url\(["']?https?:\/\//i.test(style.backgroundImage || '');
      return {
        index,
        area: rect.width * rect.height,
        loaded: imageLoaded && rect.width >= 180 && rect.height >= 120,
        clickable: Boolean(node.closest('a[href], [data-lynx-uri], [role="link"]')),
      };
    })).catch(() => []);
    const candidate = candidates
      .filter((entry) => entry?.loaded === true && entry?.clickable === true)
      .sort((left, right) => Number(right.area || 0) - Number(left.area || 0))[0];
    if (!candidate) continue;
    const image = media.nth(candidate.index);
    const box = await image.boundingBox().catch(() => null);
    if (!box || !page.mouse?.click) continue;
    const clicked = await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      .then(() => true)
      .catch(() => false);
    if (clicked) return waitForDestination();
  }

  const modalMatchTokens = messageTokens.length >= 3 ? messageTokens : titleTokens;
  const modalImagePoint = await page.locator('body').evaluate((body, tokens) => {
    const normalize = (value) => String(value || '')
      .normalize('NFKC')
      .replace(/[\u034f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('he');
    const hasEveryToken = (value) => {
      const text = normalize(value);
      return tokens.every((token) => text.includes(token));
    };
    const candidates = [...body.querySelectorAll('a, span, div')]
      .filter((node) => hasEveryToken(node.textContent))
      .filter((node) => ![...node.children].some((child) => hasEveryToken(child.textContent)));
    for (const candidate of candidates) {
      let scope = candidate;
      for (let depth = 0; scope && depth < 24; depth += 1, scope = scope.parentElement) {
        if (!normalize(scope.textContent).includes('chiping.co.il')) continue;
        const mediaNodes = scope.querySelectorAll([
          'img',
          '[role="img"]',
          '[data-visualcompletion="media-vc-image"]',
          '[style*="background-image"]',
        ].join(', '));
        const loadedMedia = [];
        for (const node of mediaNodes) {
          const rect = node.getBoundingClientRect();
          if (rect.width < 180 || rect.height < 120) continue;
          const style = getComputedStyle(node);
          const imageLoaded = (
            node.tagName === 'IMG'
            && Number(node.naturalWidth) >= 180
            && Number(node.naturalHeight) >= 120
            && !/^data:/i.test(String(node.currentSrc || node.src || ''))
          ) || /url\(["']?https?:\/\//i.test(style.backgroundImage || '');
          const link = node.closest('a[href], [data-lynx-uri], [role="link"]');
          if (!imageLoaded || !link) continue;
          loadedMedia.push({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            area: rect.width * rect.height,
          });
        }
        loadedMedia.sort((left, right) => right.area - left.area);
        if (loadedMedia.length) return loadedMedia[0];
      }
    }
    return null;
  }, modalMatchTokens).catch(() => null);
  if (modalImagePoint && page.mouse?.click) {
    const clickedFromModal = await page.mouse.click(modalImagePoint.x, modalImagePoint.y)
      .then(() => true)
      .catch(() => false);
    if (clickedFromModal) return waitForDestination();
  }
  return { verified: false, destinationUrl: '', observedUrls: [] };
}

export function buildFacebookPreviewShareUrl(itemUrl, imageUrl, retryAttempt = 0) {
  try {
    const target = new URL(String(itemUrl || ''));
    if (
      target.hostname === 'www.chiping.co.il'
      && /^\d+$/.test(String(target.searchParams.get('item') || ''))
    ) {
      return `https://www.chiping.co.il/items/${target.searchParams.get('item')}`;
    }
    return target.href;
  } catch {
    return String(itemUrl || '').trim();
  }
}

export async function prepareFacebookComposerLinkPreview(
  page,
  textBox,
  message,
  itemUrl,
  timeoutMs = 30000
) {
  const cleanMessage = cleanFacebookComposerMessage(message, itemUrl);
  if (!cleanMessage) throw new Error('Facebook post text is empty after removing the preview URL');
  const cleanItemUrl = new URL(itemUrl);
  cleanItemUrl.searchParams.delete('fb_preview');
  const retainedItemUrl = cleanItemUrl.href;

  await fillFacebookComposerText(page, textBox, `${cleanMessage}\n\n${retainedItemUrl}`);
  const stagedPreview = await waitForFacebookLinkPreview(
    page,
    retainedItemUrl,
    timeoutMs,
    textBox
  );
  // Mutating the URL after Facebook creates the card can leave a visual shell
  // that is discarded when the post is submitted. Let the original card settle.
  await page.waitForTimeout(3000);
  const visibleText = String(await textBox.innerText().catch(() => ''));
  const target = chipingFacebookTarget(retainedItemUrl);
  if (!target || !referencesExactChipingTarget(visibleText, target)) {
    throw new Error('Facebook composer did not retain the clean Chiping item URL');
  }
  if (!normalizedFacebookText(visibleText).includes(normalizedFacebookText(cleanMessage))) {
    throw new Error('Facebook composer did not retain the complete post description');
  }
  if (visibleText.includes('fb_preview=')) {
    throw new Error('Facebook composer retained the preview cache key');
  }

  const retainedPreview = await waitForFacebookLinkPreview(
    page,
    retainedItemUrl,
    Math.min(Math.max(5000, Number(timeoutMs) || 30000), 10000),
    textBox
  );
  return {
    ...retainedPreview,
    stagedPreview,
    visibleUrlRemoved: false,
    visibleUrlRetained: retainedItemUrl,
  };
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
    const textBox = await findFacebookComposerTextBox(page);
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
  assertValidChipingFacebookPayload(payload);
}

export async function previewFacebookGroupLinkJob(payload, config, options = {}) {
  validatePayload(payload);
  const playwright = options.playwright || await import('playwright');
  const fetchImpl = options.fetchImpl || fetch;
  const session = await createFacebookContext(playwright.chromium, config);
  const { context } = session;
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(config.groupUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page, config);
    await selectPostingProfile(page, config);
    const shareUrl = buildFacebookPreviewShareUrl(payload.itemUrl, payload.imageUrl);
    const previewMetadata = await waitForChipingLinkPreviewMetadata(
      shareUrl,
      payload.imageUrl,
      fetchImpl
    );
    const composer = await findFacebookGroupComposer(page);
    if (!composer) throw new Error('Facebook group composer was not found');
    await composer.click();
    try {
      const textBox = await findFacebookComposerTextBox(page);
      if (!textBox) throw new Error('Facebook group post text box was not found');
      const linkPreview = await prepareFacebookComposerLinkPreview(
        page,
        textBox,
        String(payload.message),
        shareUrl,
        30000
      );
      await captureFacebookDebug(page, config, 'link-preview-dry-run', {
        previewMetadata,
        linkPreview,
      });
      if (options.screenshotPath) {
        await page.screenshot({ path: options.screenshotPath, fullPage: true });
      }
      return { ready: true, previewMetadata, linkPreview };
    } catch (error) {
      await captureFacebookDebug(page, config, 'link-preview-dry-run-failed', {
        error: String(error?.message || 'Facebook link preview failed').slice(0, 500),
        previewProbe: error?.previewProbe || null,
      });
      if (options.screenshotPath) {
        await page.screenshot({ path: options.screenshotPath, fullPage: true }).catch(() => {});
      }
      throw error;
    }
  } finally {
    if (session.stateFile) await context.storageState({ path: session.stateFile }).catch(() => {});
    await context.close();
    if (session.browser) await session.browser.close();
  }
}

export async function postFacebookGroupJob(job, config, options = {}) {
  let readiness;
  try {
    readiness = await validateFacebookJobReadiness(job, options);
  } catch (error) {
    if (error instanceof FacebookPostUnavailableError) throw error;
    throw new FacebookPostPreparationRequiredError(
      String(error?.message || 'Facebook post readiness verification failed').slice(0, 500)
    );
  }
  const playwright = options.playwright || await import('playwright');
  const chromium = playwright.chromium;
  const fetchImpl = options.fetchImpl || fetch;
  const session = await createFacebookContext(chromium, config);
  const { context } = session;
  let page = null;
  let submitted = false;
  try {
    page = context.pages()[0] || await context.newPage();
    await page.goto(config.groupUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page, config);
    await selectPostingProfile(page, config);
    await recoverBlankFacebookPage(page, config.groupUrl);
    await sortFacebookGroupFeedNewest(page);
    // The post body intentionally contains only the description. Existing-post
    // verification must use the product/link-card title, not that body text.
    const expectedTitle = String(job.payload.title || '').trim() || await fetchChipingLinkPreviewTitle(
      job.payload.itemUrl,
      fetchImpl
    ).catch(() => '');
    const existing = await findFacebookGroupPostWithMediaFallback(page, {
      groupUrl: config.groupUrl,
      itemUrl: job.payload.itemUrl,
      expectedTitle,
      expectedMessage: job.payload.message,
      timeoutMs: 60000,
      currentPageOnly: false,
      requireLoadedLinkImage: true,
    });
    if (existing.found) {
      const destination = await verifyFacebookPostImageDestination(page, {
        expectedTitle,
        expectedMessage: job.payload.message,
        itemUrl: job.payload.itemUrl,
      });
      if (!destination.verified) {
        throw new FacebookPostMediaRequiredError(
          'Facebook product image does not open the exact Chiping item',
          { postUrl: existing.postUrl }
        );
      }
      return { published: true, postUrl: existing.postUrl || '' };
    }
    if (existing.incomplete) {
      throw new FacebookPostMediaRequiredError(undefined, { postUrl: existing.postUrl });
    }

    // Verification may leave the active tab on Facebook's group-search route.
    // Return to the group feed before looking for the composer.
    page = await navigateFacebookForVerification(page, config.groupUrl);
    await loginIfNeeded(page, config);
    await selectPostingProfile(page, config);
    await recoverBlankFacebookPage(page, config.groupUrl);
    await sortFacebookGroupFeedNewest(page);

    const composer = await findFacebookGroupComposer(page);
    if (!composer) throw new Error('Facebook group composer was not found');
    await composer.click();

    const textBox = await findFacebookComposerTextBox(page);
    if (!textBox) throw new Error('Facebook group post text box was not found');
    await captureFacebookDebug(page, config, 'composer-open');

    const shareUrl = buildFacebookPreviewShareUrl(
      job.payload.itemUrl,
      job.payload.imageUrl,
      job.attempts
    );
    const previewMetadata = readiness.metadata;
    await captureFacebookDebug(page, config, 'link-metadata-verified', previewMetadata);
    let linkPreview;
    try {
      linkPreview = await prepareFacebookComposerLinkPreview(
        page,
        textBox,
        String(job.payload.message),
        shareUrl,
        FACEBOOK_COMPOSER_LINK_PREVIEW_TIMEOUT_MS
      );
    } catch (error) {
      await captureFacebookDebug(page, config, 'link-preview-setup-failed', {
        error: String(error?.message || 'Facebook link preview setup failed').slice(0, 500),
        previewProbe: error?.previewProbe || null,
      });
      throw error;
    }
    await captureFacebookDebug(page, config, 'text-and-link-preview-ready', linkPreview);
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
    submitted = true;
    await page.waitForTimeout(2000);
    await captureFacebookDebug(page, config, 'posting');
    await waitForFacebookComposerToClose(page, textBox);
    if (await isSecurityChallenge(page)) throw new FacebookSessionRequiredError();
    await captureFacebookDebug(page, config, 'after-submit');

    const published = await findFacebookGroupPostWithMediaFallback(page, {
      groupUrl: config.groupUrl,
      itemUrl: job.payload.itemUrl,
      expectedTitle,
      expectedMessage: job.payload.message,
      timeoutMs: 60000,
      currentPageOnly: false,
      requireLoadedLinkImage: true,
    });
    await captureFacebookDebug(page, config, 'after-verification');
    if (!published.found) {
      if (published.incomplete) {
        throw new FacebookPostMediaRequiredError(undefined, { postUrl: published.postUrl });
      }
      throw new Error('Facebook did not expose the published group post');
    }
    const destination = await verifyFacebookPostImageDestination(page, {
      expectedTitle,
      expectedMessage: job.payload.message,
      itemUrl: job.payload.itemUrl,
    });
    if (!destination.verified) {
      throw new FacebookPostMediaRequiredError(
        'Facebook product image does not open the exact Chiping item',
        { postUrl: published.postUrl }
      );
    }
    return { published: true, postUrl: published.postUrl || '' };
  } catch (error) {
    if (page) {
      await captureFacebookDebug(page, config, 'post-failed', {
        errorName: String(error?.name || 'Error').slice(0, 120),
        error: String(error?.message || 'Facebook group post failed').slice(0, 500),
        previewProbe: error?.previewProbe || null,
      });
    }
    if (
      !submitted
      && !(error instanceof FacebookSessionRequiredError)
      && !(error instanceof FacebookPostUnavailableError)
      && !(error instanceof FacebookPostMediaRequiredError)
      && !(error instanceof FacebookPostPreparationRequiredError)
    ) {
      throw new FacebookPostPreparationRequiredError(
        String(error?.message || 'Facebook post preparation failed').slice(0, 500)
      );
    }
    throw error;
  } finally {
    if (session.stateFile) await context.storageState({ path: session.stateFile }).catch(() => {});
    await context.close();
    if (session.browser) await session.browser.close();
  }
}

export async function deleteFacebookGroupPostByMessage(job, config, options = {}) {
  const expectedMessage = String(job?.payload?.message || '').trim();
  if (normalizedFacebookText(expectedMessage).length < 20) {
    throw new Error('Facebook exact-message deletion requires the full queued description');
  }
  const playwright = options.playwright || await import('playwright');
  const session = await createFacebookContext(playwright.chromium, config);
  const { context } = session;
  let page = null;
  try {
    page = context.pages()[0] || await context.newPage();
    const searchUrl = `${config.groupUrl}/search/?q=${encodeURIComponent(expectedMessage)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page, config);
    await selectPostingProfile(page, config);
    await page.waitForTimeout(2500);

    const marked = await page.locator('body').evaluate((body, message) => {
      const normalize = (value) => String(value || '')
        .normalize('NFKC')
        .replace(/[\u034f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase('he');
      const tokens = [...new Set(normalize(message).match(/[\p{L}\p{N}%]+/gu) || [])];
      const matchesMessage = (value) => {
        const text = normalize(value);
        return tokens.length >= 3 && tokens.every((token) => text.includes(token));
      };
      const menuLabel = /(?:actions for this post|\u05e4\u05e2\u05d5\u05dc\u05d5\u05ea \u05e2\u05d1\u05d5\u05e8 \u05e4\u05d5\u05e1\u05d8)/i;
      body.querySelectorAll('[data-chiping-malformed-post-scope], [data-chiping-malformed-post-menu]')
        .forEach((node) => {
          node.removeAttribute('data-chiping-malformed-post-scope');
          node.removeAttribute('data-chiping-malformed-post-menu');
        });
      const candidates = [...body.querySelectorAll('a, span, div')]
        .filter((node) => matchesMessage(node.textContent))
        .filter((node) => ![...node.children].some((child) => matchesMessage(child.textContent)));
      for (const candidate of candidates) {
        let scope = candidate;
        for (let depth = 0; scope && depth < 24; depth += 1, scope = scope.parentElement) {
          if (!normalize(scope.textContent).includes('chiping.co.il')) continue;
          const menu = [...scope.querySelectorAll('button, [role="button"]')]
            .find((control) => menuLabel.test(normalize(control.getAttribute('aria-label'))));
          if (!menu) continue;
          scope.setAttribute('data-chiping-malformed-post-scope', 'true');
          menu.setAttribute('data-chiping-malformed-post-menu', 'true');
          return true;
        }
      }
      return false;
    }, expectedMessage).catch(() => false);
    if (!marked) throw new Error('Facebook exact malformed post container was not found');

    const menuButton = page.locator('[data-chiping-malformed-post-menu="true"]').first();
    if (!await menuButton.isVisible().catch(() => false)) {
      throw new Error('Facebook exact malformed post actions menu was not visible');
    }
    await captureFacebookDebug(page, config, 'before-exact-message-delete-menu');
    await menuButton.click({ timeout: 10000 });
    await page.waitForTimeout(5000);
    const visibleMenuLabels = await page.locator([
      '[role="menuitem"]',
      '[role="menu"] [role="button"]',
      '[role="dialog"] [role="button"]',
    ].join(', ')).evaluateAll((controls) => controls
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((control) => String(control.textContent || control.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80))
      .filter(Boolean)
      .slice(0, 30)).catch(() => []);
    console.log(`[facebook-status] exact-post menu labels: ${JSON.stringify(visibleMenuLabels)}`);
    const deleteItem = await firstVisibleLocator(page, [
      '[role="menuitem"]:has-text("Delete post")',
      '[role="menuitem"]:has-text("Remove post")',
      '[role="menuitem"]:has-text("Move to Trash")',
      '[role="menuitem"]:has-text("Move to trash")',
      '[role="menuitem"]:has-text("Move to bin")',
      '[role="menuitem"]:has-text("\u05de\u05d7\u05d9\u05e7\u05ea \u05d4\u05e4\u05d5\u05e1\u05d8")',
      '[role="menuitem"]:has-text("\u05d4\u05e1\u05e8\u05ea \u05d4\u05e4\u05d5\u05e1\u05d8")',
      '[role="menuitem"]:has-text("\u05d4\u05e2\u05d1\u05e8\u05d4 \u05dc\u05d0\u05e9\u05e4\u05d4")',
      '[role="menuitem"]:has-text("\u05de\u05d7\u05d9\u05e7\u05d4")',
      '[role="menu"] [role="button"]:has-text("Delete post")',
      '[role="menu"] [role="button"]:has-text("Remove post")',
      '[role="menu"] [role="button"]:has-text("Move to Trash")',
      '[role="menu"] [role="button"]:has-text("Move to bin")',
    ]);
    if (!deleteItem) throw new Error('Facebook exact malformed post delete action was not found');
    await deleteItem.click({ timeout: 10000 });
    const confirmButton = await firstVisibleLocator(page, [
      '[role="dialog"] [role="button"]:has-text("Delete")',
      '[role="dialog"] [role="button"]:has-text("Move")',
      '[role="dialog"] [role="button"]:has-text("\u05de\u05d7\u05d9\u05e7\u05d4")',
      '[role="dialog"] [role="button"]:has-text("\u05d4\u05e2\u05d1\u05e8\u05d4")',
    ]);
    if (!confirmButton) throw new Error('Facebook exact malformed post delete confirmation was not found');
    await captureFacebookDebug(page, config, 'before-exact-message-delete');
    await confirmButton.click({ timeout: 10000 });
    await page.waitForTimeout(2500);
    await captureFacebookDebug(page, config, 'after-exact-message-delete');
    return { deleted: true, postUrl: '' };
  } catch (error) {
    if (page) {
      await captureFacebookDebug(page, config, 'exact-message-delete-failed', {
        error: String(error?.message || error || 'Facebook exact-message delete failed').slice(0, 500),
      });
    }
    throw error;
  } finally {
    if (session.stateFile) await context.storageState({ path: session.stateFile }).catch(() => {});
    await context.close();
    if (session.browser) await session.browser.close();
  }
}

export async function deleteFacebookGroupPost(postUrl, config, options = {}) {
  const targetUrl = new URL(String(postUrl || '').trim());
  if (!['facebook.com', 'www.facebook.com'].includes(targetUrl.hostname)) {
    throw new Error('Facebook delete URL is invalid');
  }
  const playwright = options.playwright || await import('playwright');
  const session = await createFacebookContext(playwright.chromium, config);
  const { context } = session;
  let page = null;
  try {
    page = context.pages()[0] || await context.newPage();
    await page.goto(targetUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page, config);
    await selectPostingProfile(page, config);
    await page.waitForTimeout(2500);

    const pageText = await page.locator('body').innerText().catch(() => '');
    if (/(?:this content isn['’]t available|this content is not available|\u05d4\u05ea\u05d5\u05db\u05df \u05d4\u05d6\u05d4 \u05d0\u05d9\u05e0\u05d5 \u05d6\u05de\u05d9\u05df|\u05d4\u05ea\u05d5\u05db\u05df \u05d0\u05d9\u05e0\u05d5 \u05d6\u05de\u05d9\u05df)/i.test(pageText)) {
      await captureFacebookDebug(page, config, 'already-deleted');
      return { deleted: true, alreadyMissing: true, postUrl: targetUrl.toString() };
    }

    const menuButton = await firstVisibleLocator(page, [
      '[role="dialog"] [role="button"][aria-label="Actions for this post"]',
      '[role="dialog"] [role="button"][aria-label*="Actions for this post"]',
      '[role="dialog"] [role="button"][aria-label*="More actions"]',
      '[role="dialog"] [role="button"][aria-label="More"]',
      '[role="dialog"] [role="button"][aria-label*="\u05e4\u05e2\u05d5\u05dc\u05d5\u05ea \u05e2\u05d1\u05d5\u05e8 \u05e4\u05d5\u05e1\u05d8"]',
      '[role="dialog"] [role="button"][aria-label*="\u05d0\u05e4\u05e9\u05e8\u05d5\u05d9\u05d5\u05ea"]',
      '[role="main"] [role="article"] [role="button"][aria-label="Actions for this post"]',
      '[role="main"] [role="article"] [role="button"][aria-label*="Actions for this post"]',
      '[role="main"] [role="article"] [role="button"][aria-label*="More actions"]',
      '[role="main"] [role="article"] [role="button"][aria-label="More"]',
      '[role="main"] [role="article"] [role="button"][aria-label*="\u05e4\u05e2\u05d5\u05dc\u05d5\u05ea \u05e2\u05d1\u05d5\u05e8 \u05e4\u05d5\u05e1\u05d8"]',
      '[role="main"] [role="article"] [role="button"][aria-label*="\u05d0\u05e4\u05e9\u05e8\u05d5\u05d9\u05d5\u05ea"]',
    ]);
    if (!menuButton) throw new Error('Facebook post actions menu was not found');
    await menuButton.click({ timeout: 10000 });
    await page.waitForTimeout(5000);

    const deleteItem = await firstVisibleLocator(page, [
      '[role="menuitem"]:has-text("Delete post")',
      '[role="menuitem"]:has-text("Move to Trash")',
      '[role="menuitem"]:has-text("\u05de\u05d7\u05d9\u05e7\u05ea \u05d4\u05e4\u05d5\u05e1\u05d8")',
      '[role="menuitem"]:has-text("\u05d4\u05e2\u05d1\u05e8\u05d4 \u05dc\u05d0\u05e9\u05e4\u05d4")',
      '[role="menuitem"]:has-text("\u05de\u05d7\u05d9\u05e7\u05d4")',
    ]);
    if (!deleteItem) throw new Error('Facebook delete-post action was not found');
    await deleteItem.click({ timeout: 10000 });

    const confirmButton = await firstVisibleLocator(page, [
      '[role="dialog"] [role="button"]:has-text("Delete")',
      '[role="dialog"] [role="button"]:has-text("Move")',
      '[role="dialog"] [role="button"]:has-text("\u05de\u05d7\u05d9\u05e7\u05d4")',
      '[role="dialog"] [role="button"]:has-text("\u05d4\u05e2\u05d1\u05e8\u05d4")',
    ]);
    if (!confirmButton) throw new Error('Facebook delete confirmation was not found');
    await captureFacebookDebug(page, config, 'before-delete');
    await confirmButton.click({ timeout: 10000 });
    await page.waitForTimeout(2500);
    await captureFacebookDebug(page, config, 'after-delete');
    return { deleted: true, postUrl: targetUrl.toString() };
  } catch (error) {
    if (page) {
      await captureFacebookDebug(page, config, 'delete-failed', {
        error: String(error?.message || error || 'Facebook delete failed').slice(0, 500),
      });
    }
    throw error;
  } finally {
    if (session.stateFile) await context.storageState({ path: session.stateFile }).catch(() => {});
    await context.close();
    if (session.browser) await session.browser.close();
  }
}
