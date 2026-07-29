import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const LOGIN_URL_RE = /\/login/i;
const SECURITY_URL_RE = /\/(?:checkpoint|recover|two_step_verification|security)/i;
const SECURITY_TEXT_RE = /(?:security check|checkpoint|two-factor|approve your login|בדיקת אבטחה|אימות)/i;

const COMPOSER_SELECTORS = [
  '[role="button"][aria-label*="Write something"]',
  '[role="button"][aria-label*="Create public post"]',
  '[role="button"][aria-label*="כתוב משהו"]',
  '[role="button"][aria-label*="צור פוסט"]',
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

async function selectPostingProfile(page, config) {
  const profileName = String(config.facebookPostingProfileName || '').trim();
  if (!profileName) return;
  if (await isSecurityChallenge(page)) throw new FacebookSessionRequiredError();

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

    const composer = await findFacebookGroupComposer(page);
    if (!composer) throw new Error('Facebook group composer was not found');
    await composer.click();

    const textBox = await firstVisibleLocator(page, TEXTBOX_SELECTORS);
    if (!textBox) throw new Error('Facebook group post text box was not found');
    await textBox.fill(String(job.payload.message));

    const image = await downloadImage(job.payload.imageUrl, fetchImpl);
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 10000 });
    await fileInput.setInputFiles({ name: image.filename, mimeType: image.mimeType, buffer: image.bytes });
    await page.waitForTimeout(1500);
    if (await isSecurityChallenge(page)) throw new FacebookSessionRequiredError();

    const postButton = await firstVisibleLocator(page, POST_SELECTORS);
    if (!postButton) throw new Error('Facebook group publish button was not found');
    await postButton.click();
    await page.waitForTimeout(4000);
    if (await isSecurityChallenge(page)) throw new FacebookSessionRequiredError();

    const composerStillVisible = await textBox.isVisible().catch(() => false);
    if (composerStillVisible) throw new Error('Facebook did not confirm the group post');
    return { postUrl: config.groupUrl };
  } finally {
    if (session.stateFile) await context.storageState({ path: session.stateFile }).catch(() => {});
    await context.close();
    if (session.browser) await session.browser.close();
  }
}
