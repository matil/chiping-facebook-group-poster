import { appendFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { restoreEncryptedActionState } from './action-state.mjs';
import { loadConfig } from './config.mjs';
import {
  previewFacebookGroupLinkJob,
  previewFacebookShareDialogJob,
} from './facebook.mjs';
import { JobStore } from './store.mjs';

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
  const itemUrl = `https://www.chiping.co.il/?item=${productId}`;
  if (!imageUrl.startsWith('https://')) {
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

  const store = new JobStore(config.dataDir);
  await store.init();
  const queuedJob = Object.values(store.state.jobs)
    .find((job) => String(job?.product_id || '') === productId);
  if (!queuedJob?.payload) {
    throw new Error('Facebook preview product is not present in the durable queue');
  }
  const queuedMessage = String(queuedJob.payload.message || '').trim();
  if (!queuedMessage) throw new Error('Facebook preview product has no queued description');
  const message = `${queuedMessage}\n\n${itemUrl}`;

  const previewFlow = String(env.FACEBOOK_PREVIEW_FLOW || 'composer').trim().toLowerCase();
  const defaultPreviewJob = previewFlow === 'share_dialog'
    ? previewFacebookShareDialogJob
    : previewFacebookGroupLinkJob;
  const result = await (options.previewJob || defaultPreviewJob)({
    ...queuedJob.payload,
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
