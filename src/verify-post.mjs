import { appendFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { restoreEncryptedActionState } from './action-state.mjs';
import { loadConfig } from './config.mjs';
import { findFacebookGroupPost } from './facebook.mjs';

async function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value)}\n`)
    .join('');
  await appendFile(process.env.GITHUB_OUTPUT, body, 'utf8');
}

export async function verifyFacebookPost(env = process.env, options = {}) {
  const productId = String(env.FACEBOOK_VERIFY_PRODUCT_ID || '').trim();
  if (!/^\d+$/.test(productId)) throw new Error('FACEBOOK_VERIFY_PRODUCT_ID must be numeric');
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
  const result = await (options.findPost || findFacebookGroupPost)(
    config,
    `https://www.chiping.co.il/?item=${productId}`,
    {
      ...options,
      currentPageOnly: /^(?:1|true|yes|on)$/i.test(String(env.FACEBOOK_VERIFY_CURRENT_PAGE_ONLY || '')),
      screenshotPath: String(env.FACEBOOK_VERIFY_SCREENSHOT_PATH || '').trim() || undefined,
    }
  );
  await writeOutputs({
    found: result.found === true,
    post_url: result.postUrl || '',
    product_id: productId,
  });
  return { productId, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyFacebookPost().catch(async (error) => {
    await writeOutputs({ found: false, post_url: '', product_id: '' });
    console.error(error.message || 'Facebook post verification failed');
    process.exitCode = 1;
  });
}
