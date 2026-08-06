import { appendFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import {
  restoreEncryptedActionState,
  saveEncryptedActionState,
} from './action-state.mjs';
import {
  deleteFacebookGroupPost,
  deleteFacebookGroupPostByMessage,
  FacebookSessionRequiredError,
  findFacebookGroupPost,
  validateFacebookJobReadiness,
  verifyFacebookGroupAccess,
} from './facebook.mjs';
import { JobStore } from './store.mjs';
import {
  isFacebookMediaBlock,
  isFacebookPreparationBlock,
  isFacebookSessionBlock,
} from './block-policy.mjs';

function blockedJobs(store) {
  return store.state.order
    .map((id) => store.state.jobs[id])
    .filter((job) => job?.status === 'blocked');
}

function jobIdentifier(job = {}) {
  return String(job.product_id || job.content_id || job.id || '').trim();
}

function joinJobIds(jobs = []) {
  return jobs.map(jobIdentifier).filter(Boolean).join(',');
}

async function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value ?? '')}\n`)
    .join('');
  await appendFile(process.env.GITHUB_OUTPUT, body, 'utf8');
}

export function isAutoRecoverableFacebookBlock(job = {}) {
  return isFacebookSessionBlock(job)
    || isFacebookMediaBlock(job)
    || isFacebookPreparationBlock(job);
}

export function inspectFacebookStatus(store) {
  const blocked = blockedJobs(store);
  const sessionRecoverable = blocked.filter(isFacebookSessionBlock);
  const mediaRecoverable = blocked.filter(isFacebookMediaBlock);
  const preparationRecoverable = blocked.filter(isFacebookPreparationBlock);
  const recoverable = blocked.filter(isAutoRecoverableFacebookBlock);
  const unresolved = blocked.filter((job) => !isAutoRecoverableFacebookBlock(job));
  return {
    outcome: recoverable.length
      ? 'blocked_recoverable'
      : (unresolved.length ? 'blocked_unresolved' : 'healthy'),
    needsRepair: recoverable.length > 0,
    needsBrowserRepair: sessionRecoverable.length > 0 || mediaRecoverable.length > 0,
    blockedIds: joinJobIds(blocked),
    recoverableIds: joinJobIds(recoverable),
    sessionRecoverableIds: joinJobIds(sessionRecoverable),
    mediaRecoverableIds: joinJobIds(mediaRecoverable),
    preparationRecoverableIds: joinJobIds(preparationRecoverable),
    unresolvedIds: joinJobIds(unresolved),
    summary: store.summary(),
  };
}

function validFacebookPostUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['facebook.com', 'www.facebook.com'].includes(url.hostname)) return false;
    return /^\/groups\/(?:chiping|\d+)\/(?:posts|permalink)\/(?:\d+|pfbid[a-z0-9]+)\/?$/i.test(url.pathname)
      || (/^\/photo(?:\.php)?\/?$/i.test(url.pathname)
        && /^gm\.\d+$/i.test(String(url.searchParams.get('set') || '')));
  } catch {
    return false;
  }
}

export async function repairFacebookMediaBlock(job, config, options = {}) {
  let postUrl = String(job.failed_post_url || '').trim();
  if (!validFacebookPostUrl(postUrl)) {
    const result = await (options.findPost || findFacebookGroupPost)(
      config,
      String(job?.payload?.itemUrl || ''),
      {
        ...options,
        expectedTitle: String(job?.payload?.title || '').trim(),
        expectedMessage: String(job?.payload?.message || '').trim(),
        currentPageOnly: false,
        sortNewest: true,
        mediaFallback: true,
        requireLoadedLinkImage: false,
      }
    );
    postUrl = String(result?.postUrl || '').trim();
  }
  if (!validFacebookPostUrl(postUrl)) {
    console.warn(`[facebook-status] permalink unavailable; using exact-message cleanup for ${jobIdentifier(job)}`);
    const result = await (options.deletePostByMessage || deleteFacebookGroupPostByMessage)(
      job,
      config,
      options
    );
    return { repaired: result?.deleted === true, postUrl: '' };
  }
  await (options.deletePost || deleteFacebookGroupPost)(postUrl, config, options);
  return { repaired: true, postUrl };
}

export async function repairFacebookBlockedJobs(store, verifyAccess, options = {}) {
  const inspection = inspectFacebookStatus(store);
  if (!inspection.needsRepair) return inspection;

  const repairedIds = new Set();
  for (const job of blockedJobs(store).filter(isFacebookPreparationBlock)) {
    try {
      await (options.validateReadiness || validateFacebookJobReadiness)(job, {
        ...options,
        attempts: 2,
        delayMs: 1000,
      });
      repairedIds.add(job.id);
    } catch (error) {
      console.warn(
        `[facebook-status] preparation still incomplete for ${jobIdentifier(job)}: ${String(error?.message || 'unknown').slice(0, 160)}`
      );
    }
  }
  const sessionJobs = blockedJobs(store).filter(isFacebookSessionBlock);
  if (sessionJobs.length) {
    try {
      await verifyAccess();
      sessionJobs.forEach((job) => repairedIds.add(job.id));
    } catch (error) {
      return {
        ...inspection,
        outcome: error instanceof FacebookSessionRequiredError
          ? 'verification_required'
          : 'repair_failed',
        error: error instanceof FacebookSessionRequiredError
          ? String(error.message || 'facebook_verification_required').slice(0, 160)
          : 'facebook_access_check_failed',
      };
    }
  }

  for (const job of blockedJobs(store).filter(isFacebookMediaBlock)) {
    try {
      const result = await (options.repairMediaBlock || repairFacebookMediaBlock)(
        job,
        options.config,
        options
      );
      if (result?.repaired === true) repairedIds.add(job.id);
    } catch (error) {
      console.warn(
        `[facebook-status] media repair failed for ${jobIdentifier(job)}: ${String(error?.message || 'unknown').slice(0, 160)}`
      );
      // Keep only this item quarantined; it must not hold unrelated posts.
    }
  }

  const resumed = await store.resumeBlocked((job) => repairedIds.has(job.id));
  const repaired = inspectFacebookStatus(store);
  return {
    ...repaired,
    outcome: repaired.blockedIds
      ? (resumed ? 'partially_repaired' : 'repair_failed')
      : 'repaired',
    resumed,
  };
}

export async function runFacebookStatus(env = process.env, options = {}) {
  const config = loadConfig(env);
  const encryptedFile = String(env.FACEBOOK_ACTION_STATE_FILE || '').trim();
  const stateSecret = String(env.FACEBOOK_STATE_ENCRYPTION_KEY || '');
  if (!encryptedFile || stateSecret.length < 32) {
    throw new Error('GitHub Action encrypted state is not configured');
  }

  await mkdir(config.dataDir, { recursive: true });
  const restored = await restoreEncryptedActionState({
    encryptedFile,
    secret: stateSecret,
    dataDir: config.dataDir,
    storageStateFile: config.storageStateFile,
  });
  if (!restored) throw new Error('Encrypted Facebook state is missing');
  const store = new JobStore(config.dataDir);
  let stateChanged = await store.init();
  const mode = String(env.FACEBOOK_STATUS_MODE || options.mode || 'inspect').trim().toLowerCase();
  let result;

  if (mode === 'repair') {
    result = await repairFacebookBlockedJobs(
      store,
      () => (options.verifyGroupAccess || verifyFacebookGroupAccess)(config, options),
      { ...options, config }
    );
    // Verification can refresh cookies even when no queue row changes.
    stateChanged = true;
  } else {
    result = inspectFacebookStatus(store);
  }

  if (stateChanged) {
    await store.persist();
    await saveEncryptedActionState({
      encryptedFile,
      secret: stateSecret,
      dataDir: config.dataDir,
      storageStateFile: config.storageStateFile,
    });
  }

  const outputs = {
    outcome: result.outcome,
    needs_repair: result.needsRepair,
    needs_browser_repair: result.needsBrowserRepair,
    state_changed: stateChanged,
    blocked_product_ids: result.blockedIds,
    recoverable_product_ids: result.recoverableIds,
    media_recoverable_product_ids: result.mediaRecoverableIds,
    preparation_recoverable_product_ids: result.preparationRecoverableIds,
    unresolved_product_ids: result.unresolvedIds,
    resumed: Number(result.resumed) || 0,
    error: result.error || '',
  };
  await writeOutputs(outputs);
  return { ...result, stateChanged };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFacebookStatus().catch(async () => {
    await writeOutputs({
      outcome: 'status_failed',
      needs_repair: false,
      state_changed: false,
      error: 'facebook_status_runner_failed',
    });
    process.exitCode = 1;
  });
}
