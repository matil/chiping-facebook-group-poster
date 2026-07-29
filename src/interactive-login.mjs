import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { restoreEncryptedActionState, saveEncryptedActionState } from './action-state.mjs';
import {
  findFacebookGroupComposer,
  readLoginCredentials,
  verifyFacebookGroupAccess,
} from './facebook.mjs';
import { JobStore } from './store.mjs';

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

function positiveInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

async function fileExists(file) {
  if (!file) return false;
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function visible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function firstVisible(page, selector) {
  const candidates = page.locator(selector);
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

export async function fillLoginForm(page, config) {
  if (!await visible(page, 'input[name="email"], input[type="email"]')) return false;
  const credentials = await readLoginCredentials(config);
  if (!credentials) throw new Error('Facebook login credentials are not configured');

  const password = page.locator('input[name="pass"], input[type="password"]').first();
  await page.locator('input[name="email"], input[type="email"]').first().fill(credentials.email);
  await password.fill(credentials.password);
  const submit = await firstVisible(
    page,
    'form:has(input[name="pass"]) button[type="submit"], '
    + 'form:has(input[name="pass"]) input[type="submit"], '
    + 'button[name="login"], input[name="login"], '
    + '[role="button"][aria-label="Log In"], [role="button"]:has-text("Log in"), '
    + '[role="button"][aria-label="התחברות"], [role="button"]:has-text("התחבר")'
  );
  if (submit) {
    try {
      await submit.click({ timeout: 3000 });
      return true;
    } catch {
      // Facebook occasionally replaces the visible control during hydration.
    }
  }
  await password.press('Enter');
  return true;
}

export async function loginCompleted(page, groupUrl) {
  if (await visible(page, 'input[name="email"], input[type="email"]')) return false;
  const url = page.url();
  if (/\/(?:checkpoint|recover|two_step_verification|security)\//i.test(url)) return false;
  if (!url.startsWith(groupUrl)) return false;
  return Boolean(await findFacebookGroupComposer(page));
}

export async function runInteractiveLogin(env = process.env, options = {}) {
  const config = loadConfig(env);
  const encryptedFile = String(env.FACEBOOK_ACTION_STATE_FILE || '').trim();
  const stateSecret = String(env.FACEBOOK_STATE_ENCRYPTION_KEY || '');
  if (!encryptedFile || stateSecret.length < 32) {
    throw new Error('GitHub Action encrypted state is not configured');
  }

  await mkdir(config.dataDir, { recursive: true });
  await restoreEncryptedActionState({
    encryptedFile,
    secret: stateSecret,
    dataDir: config.dataDir,
    storageStateFile: config.storageStateFile,
  });
  const store = new JobStore(config.dataDir);
  await store.init();

  const playwright = options.playwright || await import('playwright');
  const browser = await playwright.chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    storageState: await fileExists(config.storageStateFile) ? config.storageStateFile : undefined,
  });
  const page = context.pages()[0] || await context.newPage();
  const timeoutMs = positiveInteger(
    env.FACEBOOK_INTERACTIVE_LOGIN_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    60_000,
    30 * 60 * 1000
  );

  try {
    await page.goto(config.groupUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await fillLoginForm(page, config);
    console.log('Remote Facebook browser is ready. Complete any Facebook security check in the noVNC window.');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await loginCompleted(page, config.groupUrl)) {
        await context.storageState({ path: config.storageStateFile });
        await context.close();
        await browser.close();

        // Preserve a successful login even if Facebook changes a later UI selector.
        await saveEncryptedActionState({
          encryptedFile,
          secret: stateSecret,
          dataDir: config.dataDir,
          storageStateFile: config.storageStateFile,
        });
        await verifyFacebookGroupAccess(config, { playwright });
        await store.persist();
        await saveEncryptedActionState({
          encryptedFile,
          secret: stateSecret,
          dataDir: config.dataDir,
          storageStateFile: config.storageStateFile,
        });
        console.log('Facebook group session verified and encrypted.');
        return { verified: true };
      }
      await page.waitForTimeout(POLL_INTERVAL_MS);
    }
    throw new Error('Timed out waiting for Facebook verification');
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInteractiveLogin().catch((error) => {
    console.error(error.message || 'Interactive Facebook login failed');
    process.exitCode = 1;
  });
}
