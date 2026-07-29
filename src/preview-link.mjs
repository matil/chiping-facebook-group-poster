import { appendFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { restoreEncryptedActionState } from './action-state.mjs';
import { loadConfig } from './config.mjs';
import { previewFacebookGroupLinkJob } from './facebook.mjs';

async function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value)}\n`)
    .join('');
  await appendFile(process.env.GITHUB_OUTPUT, body, 'utf8');
}

export async function previewFacebookLink(env = process.env, options = {}) {
  const productId = String(env.FACEBOOK_PREVIEW_PRODUCT_ID || '').trim();
  if (!/^\d+$/.test(productId)) throw new Error('FACEBOOK_PREVIEW_PRODUCT_ID must be numeric');
  const imageUrl = String(env.FACEBOOK_PREVIEW_IMAGE_URL || '').trim();
  const message = Buffer.from(
    String(env.FACEBOOK_PREVIEW_MESSAGE_BASE64 || '').trim(),
    'base64'
  ).toString('utf8').trim();
  const itemUrl = `https://www.chiping.co.il/?item=${productId}`;
  if (!imageUrl.startsWith('https://') || !message || !message.includes(itemUrl)) {
    throw new Error('Facebook preview payload is incomplete');
  }

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

  const result = await (options.previewJob || previewFacebookGroupLinkJob)({
    idempotency_key: `chiping-facebook:v1:${productId}`,
    productId,
    site: 'chiping',
    channel: 'facebook',
    language: 'he',
    message,
    imageUrl,
    itemUrl,
  }, config, {
    ...options,
    screenshotPath: String(env.FACEBOOK_PREVIEW_SCREENSHOT_PATH || '').trim() || undefined,
  });
  await writeOutputs({ ready: result.ready === true, product_id: productId });
  return { productId, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  previewFacebookLink().catch(async (error) => {
    await writeOutputs({ ready: false, product_id: '' });
    console.error(error.message || 'Facebook link preview failed');
    process.exitCode = 1;
  });
}
