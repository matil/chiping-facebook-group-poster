import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FacebookPostMediaRequiredError,
  FacebookPostPreparationRequiredError,
  FacebookPostUnavailableError,
  FacebookSessionRequiredError,
  deleteFacebookGroupPost,
  postFacebookGroupJob,
  verifyFacebookGroupAccess,
} from './facebook.mjs';
import { loadConfig } from './config.mjs';
import { restoreEncryptedActionState, saveEncryptedActionState } from './action-state.mjs';
import { JobStore } from './store.mjs';
import {
  AMAZON_DEALS_POSTING_POLICY,
  COUPON_ANNOUNCEMENT_POSTING_POLICY,
  validChipingFacebookPayload,
} from './payload.mjs';
import { isFacebookQuietHours } from './quiet-hours.mjs';
import { blocksFacebookQueue } from './block-policy.mjs';

const CURATED_POST_INTERVAL_MS = 20 * 60 * 60 * 1000;
const AMAZON_DEALS_POST_INTERVAL_MS = 5 * 60 * 1000;

function enabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

function nextRetryAt(attempts, nowMs = Date.now()) {
  const delay = Math.min(6 * 60 * 60 * 1000, 30 * 60 * 1000 * (2 ** Math.max(0, attempts)));
  return new Date(nowMs + delay).toISOString();
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

function validFacebookPostUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['facebook.com', 'www.facebook.com'].includes(url.hostname)) return false;
    if (/^\/groups\/(?:chiping|\d+)\/(?:posts|permalink)\/\d+\/?$/i.test(url.pathname)) return true;
    return /^\/photo(?:\.php)?\/?$/i.test(url.pathname)
      && /^\d+$/.test(String(url.searchParams.get('fbid') || ''))
      && /^g\.\d+$/i.test(String(url.searchParams.get('set') || ''));
  } catch {
    return false;
  }
}

function postingPolicy(job) {
  return String(job?.payload?.posting_policy || '').trim().toLowerCase() || 'curated';
}

export function postIntervalMsForJob(job = null) {
  return [AMAZON_DEALS_POSTING_POLICY, COUPON_ANNOUNCEMENT_POSTING_POLICY].includes(postingPolicy(job))
    ? AMAZON_DEALS_POST_INTERVAL_MS
    : CURATED_POST_INTERVAL_MS;
}

function lastPostedAt(store, predicate = null) {
  return Math.max(...Object.values(store.state.jobs)
    .filter((job) => job?.status === 'posted' && (!predicate || predicate(job)))
    .map((job) => Date.parse(job.posted_at || ''))
    .filter(Number.isFinite), 0);
}

function nextEligiblePostAt(store, nextJob) {
  const latestPostAt = lastPostedAt(store);
  if (!nextJob) return latestPostAt + CURATED_POST_INTERVAL_MS;
  if ([AMAZON_DEALS_POSTING_POLICY, COUPON_ANNOUNCEMENT_POSTING_POLICY].includes(postingPolicy(nextJob))) {
    return latestPostAt + AMAZON_DEALS_POST_INTERVAL_MS;
  }
  const latestCuratedPostAt = lastPostedAt(
    store,
    (job) => ![AMAZON_DEALS_POSTING_POLICY, COUPON_ANNOUNCEMENT_POSTING_POLICY].includes(postingPolicy(job))
  );
  return Math.max(
    latestPostAt + AMAZON_DEALS_POST_INTERVAL_MS,
    latestCuratedPostAt + CURATED_POST_INTERVAL_MS
  );
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

async function syncPostedLedger(store, env = {}, options = {}) {
  const endpoint = String(env.FACEBOOK_POSTED_LEDGER_ENDPOINT || '').trim();
  const secret = String(env.FACEBOOK_POSTED_LEDGER_SECRET || '').trim();
  if (!endpoint || !secret) return { configured: false, synced: 0 };
  const posts = store.postedLedgerEntries();
  const fetchImpl = options.ledgerFetch || fetch;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Chiping-Facebook-Ledger-Secret': secret,
    },
    body: JSON.stringify({ posts }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`Facebook posted ledger sync failed: ${response.status} ${text.slice(0, 160)}`);
  }
  return { configured: true, synced: posts.length };
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
  let changed = await store.init();
  let alert = false;
  let outcome = 'idle';
  let verificationReason = '';
  let postUrl = '';
  let postedProductId = '';
  let confirmed = false;
  let deleted = false;
  const payload = await readEventPayload(String(env.FACEBOOK_EVENT_PATH || '').trim());
  if (payload && validChipingFacebookPayload(payload)) {
    const queued = await store.enqueue(payload);
    changed ||= queued.accepted;
    outcome = queued.deduplicated ? 'deduplicated' : 'queued';
    if (queued.deduplicated
      && [AMAZON_DEALS_POSTING_POLICY, COUPON_ANNOUNCEMENT_POSTING_POLICY].includes(postingPolicy(queued.job))
      && queued.job.status === 'retry') {
      const expedited = await store.expediteRetry(queued.job.idempotency_key, options.nowMs);
      changed ||= Boolean(expedited);
      if (expedited) outcome = 'retry_expedited';
    }
  } else if (payload) {
    outcome = 'invalid_payload';
  }
  if (enabled(env.FACEBOOK_ACTION_RESUME)) {
    const resumed = await store.resumeBlocked();
    changed ||= resumed > 0;
    if (resumed) outcome = 'resumed';
  }
  const resetProductId = String(env.FACEBOOK_ACTION_RESET_PRODUCT_ID || '').trim();
  let resetRequested = false;
  if (resetProductId) {
    if (!/^\d+$/.test(resetProductId)) throw new Error('FACEBOOK_ACTION_RESET_PRODUCT_ID must be numeric');
    const reset = await store.resetProduct(resetProductId);
    changed ||= reset > 0;
    if (reset) {
      outcome = 'reset';
      resetRequested = true;
    }
  }
  const confirmProductId = String(env.FACEBOOK_ACTION_CONFIRM_PRODUCT_ID || '').trim();
  const confirmPostUrl = String(env.FACEBOOK_ACTION_CONFIRM_POST_URL || '').trim();
  const finalizeUnlinkedProductId = String(
    env.FACEBOOK_ACTION_FINALIZE_UNLINKED_PRODUCT_ID || ''
  ).trim();
  if (confirmProductId || confirmPostUrl) {
    if (!/^\d+$/.test(confirmProductId) || !validFacebookPostUrl(confirmPostUrl)) {
      throw new Error('Facebook post confirmation is invalid');
    }
    const confirmedCount = await store.confirmProductPosted(confirmProductId, confirmPostUrl);
    changed ||= confirmedCount > 0;
    confirmed = confirmedCount > 0;
    if (confirmed) {
      postUrl = confirmPostUrl;
      postedProductId = confirmProductId;
      outcome = 'confirmed';
    }
  }
  if (finalizeUnlinkedProductId) {
    if (!/^\d+$/.test(finalizeUnlinkedProductId)) {
      throw new Error('FACEBOOK_ACTION_FINALIZE_UNLINKED_PRODUCT_ID must be numeric');
    }
    const finalizedCount = await store.finalizeProductPostedUnlinked(finalizeUnlinkedProductId);
    changed ||= finalizedCount > 0;
    confirmed = finalizedCount > 0;
    if (confirmed) {
      postedProductId = finalizeUnlinkedProductId;
      outcome = 'finalized_unlinked';
    }
  }

  const deleteProductId = String(env.FACEBOOK_ACTION_DELETE_PRODUCT_ID || '').trim();
  const deletePostUrl = String(env.FACEBOOK_ACTION_DELETE_POST_URL || '').trim();
  if (deleteProductId || deletePostUrl) {
    if (!/^\d+$/.test(deleteProductId) || !validFacebookPostUrl(deletePostUrl)) {
      throw new Error('Facebook post deletion is invalid');
    }
    await (options.deletePost || deleteFacebookGroupPost)(deletePostUrl, config, options);
    const reset = await store.resetProduct(deleteProductId);
    changed ||= reset > 0;
    deleted = true;
    outcome = 'deleted';
  }

  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const summary = store.summary();
  const nextJob = store.peekNext(nowMs);
  if (confirmed || deleted) {
    // A separately verified permalink is final; never submit the product again.
  } else if (enabled(env.FACEBOOK_ACTION_VERIFY_GROUP_ACCESS)) {
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
  } else if (Object.values(store.state.jobs).some(blocksFacebookQueue)) {
    outcome = 'blocked';
  } else if (!enabled(env.FACEBOOK_ACTION_POSTING_ENABLED)) {
    if (summary.pending || summary.retry) outcome = 'dry_run';
  } else if (isFacebookQuietHours(nowMs)) {
    outcome = 'quiet_hours';
  } else if (!resetRequested && nowMs < nextEligiblePostAt(store, nextJob)) {
    outcome = 'cooldown';
  } else {
    const job = await store.claimNext(nowMs);
    if (job) {
      changed = true;
      try {
        const result = await (options.postJob || postFacebookGroupJob)(job, config, options);
        postUrl = String(result?.postUrl || '');
        if (!postUrl && result?.published !== true) {
          throw new Error('Facebook post did not return a permalink');
        }
        await store.markPosted(job.id, postUrl);
        postedProductId = String(job.product_id || '').trim();
        prunePosted(store);
        await store.persist();
        outcome = postUrl ? 'posted' : 'posted_unlinked';
      } catch (error) {
        const attempts = job.attempts + 1;
        if (error instanceof FacebookPostUnavailableError) {
          await store.markSkipped(job.id, error.message);
          outcome = 'skipped_unavailable';
        } else {
          const terminalError = error instanceof FacebookSessionRequiredError
            || error instanceof FacebookPostMediaRequiredError
            || error instanceof FacebookPostPreparationRequiredError;
          const message = terminalError ? error.message : 'Facebook group post failed';
          if (terminalError || attempts >= config.maxAttempts) {
            await store.markBlocked(job.id, message, {
              failedPostUrl: error instanceof FacebookPostMediaRequiredError ? error.postUrl : '',
            });
            outcome = 'blocked';
            alert = true;
          } else {
            await store.markRetry(job.id, message, nextRetryAt(job.attempts, nowMs));
            outcome = 'retry';
          }
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
  let ledgerSyncError = '';
  let ledgerSynced = 0;
  try {
    const ledgerSync = await syncPostedLedger(store, env, options);
    ledgerSynced = Number(ledgerSync.synced) || 0;
  } catch (error) {
    ledgerSyncError = String(error.message || error).slice(0, 240);
    alert = true;
  }
  const blockedJob = [...store.state.order]
    .reverse()
    .map((id) => store.state.jobs[id])
    .find((job) => job?.status === 'blocked');
  const blockedReason = String(blockedJob?.last_error || '').slice(0, 160);
  const pendingProductIds = store.state.order
    .map((id) => store.state.jobs[id])
    .filter((job) => job && ['pending', 'retry', 'processing'].includes(job.status))
    .map((job) => String(job.product_id || job.content_id || '').trim())
    .filter(Boolean)
    .join(',');
  const blockedProductIds = store.state.order
    .map((id) => store.state.jobs[id])
    .filter((job) => job?.status === 'blocked')
    .map((job) => String(job.product_id || job.content_id || '').trim())
    .filter(Boolean)
    .join(',');
  await writeOutputs({
    outcome,
    state_changed: changed,
    alert,
    verification_reason: verificationReason,
    blocked_reason: blockedReason,
    pending_product_ids: pendingProductIds,
    blocked_product_ids: blockedProductIds,
    post_url: postUrl,
    posted_product_id: postedProductId,
    posted_ledger_count: ledgerSynced,
    ledger_sync_error: ledgerSyncError,
  });
  return {
    outcome,
    stateChanged: changed,
    alert,
    verificationReason,
    blockedReason,
    pendingProductIds,
    blockedProductIds,
    postUrl,
    postedProductId,
    postedLedgerCount: ledgerSynced,
    ledgerSyncError,
    summary: store.summary(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGitHubAction().catch(async () => {
    await writeOutputs({ outcome: 'error', state_changed: false, alert: true, verification_reason: 'action_runner_failed' });
    process.exitCode = 1;
  });
}
