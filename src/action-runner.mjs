import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FacebookSessionRequiredError, postFacebookGroupJob, verifyFacebookGroupAccess } from './facebook.mjs';
import { loadConfig } from './config.mjs';
import { restoreEncryptedActionState, saveEncryptedActionState } from './action-state.mjs';
import { JobStore } from './store.mjs';

const POST_INTERVAL_MS = 20 * 60 * 60 * 1000;

function enabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

function nextRetryAt(attempts) {
  const delay = Math.min(6 * 60 * 60 * 1000, 30 * 60 * 1000 * (2 ** Math.max(0, attempts)));
  return new Date(Date.now() + delay).toISOString();
}

function payloadFromEvent(event) {
  const candidate = event?.client_payload?.payload || event?.client_payload;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
}

async function readEventPayload(file) {
  if (!file) return null;
  try {
    return payloadFromEvent(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return null;
  }
}

function validPayload(payload) {
  const key = String(payload?.idempotency_key || payload?.idempotencyKey || '');
  return payload?.site === 'chiping'
    && payload?.channel === 'facebook'
    && payload?.language === 'he'
    && /^chiping-facebook:v1:\d+$/.test(key)
    && /^\d+$/.test(String(payload?.productId || ''))
    && typeof payload?.message === 'string'
    && payload.message.trim().length > 0
    && typeof payload?.imageUrl === 'string'
    && payload.imageUrl.startsWith('https://')
    && typeof payload?.itemUrl === 'string'
    && /^https:\/\/www\.chiping\.co\.il\/\?item=\d+/.test(payload.itemUrl);
}

function lastPostedAt(store) {
  return Math.max(...Object.values(store.state.jobs)
    .filter((job) => job?.status === 'posted')
    .map((job) => Date.parse(job.posted_at || ''))
    .filter(Number.isFinite), 0);
}

function prunePosted(store) {
  const posted = store.state.order
    .map((id) => store.state.jobs[id])
    .filter((job) => job?.status === 'posted')
    .sort((left, right) => Date.parse(right.posted_at || '') - Date.parse(left.posted_at || ''));
  for (const job of posted.slice(100)) {
    delete store.state.jobs[job.id];
    store.state.order = store.state.order.filter((id) => id !== job.id);
  }
}

async function writeOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) return;
  const body = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}\n`).join('');
  await appendFile(process.env.GITHUB_OUTPUT, body, 'utf8');
}

export async function runGitHubAction(env = process.env, options = {}) {
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
  let changed = false;
  let alert = false;
  let outcome = 'idle';
  let verificationReason = '';
  let postUrl = '';
  const payload = await readEventPayload(String(env.FACEBOOK_EVENT_PATH || '').trim());
  if (payload && validPayload(payload)) {
    const queued = await store.enqueue(payload);
    changed ||= queued.accepted;
    outcome = queued.deduplicated ? 'deduplicated' : 'queued';
  } else if (payload) {
    outcome = 'invalid_payload';
  }
  if (enabled(env.FACEBOOK_ACTION_RESUME)) {
    const resumed = await store.resumeBlocked();
    changed ||= resumed > 0;
    if (resumed) outcome = 'resumed';
  }
  const resetProductId = String(env.FACEBOOK_ACTION_RESET_PRODUCT_ID || '').trim();
  if (resetProductId) {
    if (!/^\d+$/.test(resetProductId)) throw new Error('FACEBOOK_ACTION_RESET_PRODUCT_ID must be numeric');
    const reset = await store.resetProduct(resetProductId);
    changed ||= reset > 0;
    if (reset) outcome = 'reset';
  }

  const summary = store.summary();
  if (enabled(env.FACEBOOK_ACTION_VERIFY_GROUP_ACCESS)) {
    changed = true;
    try {
      await (options.verifyGroupAccess || verifyFacebookGroupAccess)(config, options);
      outcome = 'verified';
    } catch (error) {
      outcome = 'verification_failed';
      alert = true;
      verificationReason = error instanceof FacebookSessionRequiredError
        ? String(error.message || 'facebook_session_required').slice(0, 160)
        : 'facebook_access_check_failed';
    }
  } else if (store.summary().blocked > 0) {
    outcome = 'blocked';
  } else if (!enabled(env.FACEBOOK_ACTION_POSTING_ENABLED)) {
    if (summary.pending || summary.retry) outcome = 'dry_run';
  } else if (Date.now() - lastPostedAt(store) < POST_INTERVAL_MS) {
    outcome = 'cooldown';
  } else {
    const job = await store.claimNext();
    if (job) {
      changed = true;
      try {
        const result = await (options.postJob || postFacebookGroupJob)(job, config, options);
        postUrl = String(result?.postUrl || '');
        if (!postUrl) throw new Error('Facebook post did not return a permalink');
        await store.markPosted(job.id, postUrl);
        prunePosted(store);
        await store.persist();
        outcome = 'posted';
      } catch (error) {
        const attempts = job.attempts + 1;
        const message = error instanceof FacebookSessionRequiredError
          ? error.message
          : 'Facebook group post failed';
        if (error instanceof FacebookSessionRequiredError || attempts >= config.maxAttempts) {
          await store.markBlocked(job.id, message);
          outcome = 'blocked';
          alert = true;
        } else {
          await store.markRetry(job.id, message, nextRetryAt(job.attempts));
          outcome = 'retry';
        }
      }
    }
  }
  if (changed) {
    await store.persist();
    await saveEncryptedActionState({
      encryptedFile,
      secret: stateSecret,
      dataDir: config.dataDir,
      storageStateFile: config.storageStateFile,
    });
  }
  await writeOutputs({
    outcome,
    state_changed: changed,
    alert,
    verification_reason: verificationReason,
    post_url: postUrl,
  });
  return { outcome, stateChanged: changed, alert, verificationReason, postUrl, summary: store.summary() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGitHubAction().catch(async () => {
    await writeOutputs({ outcome: 'error', state_changed: false, alert: true, verification_reason: 'action_runner_failed' });
    process.exitCode = 1;
  });
}
