import { appendFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import {
  restoreEncryptedActionState,
  saveEncryptedActionState,
} from './action-state.mjs';
import {
  FacebookSessionRequiredError,
  verifyFacebookGroupAccess,
} from './facebook.mjs';
import { JobStore } from './store.mjs';

const SESSION_BLOCK_RE = /(?:facebook session|interactive login|security verification|security check|session expired|login credentials|posting profile|group posting is not available|composer could not be opened|post text box is not available)/i;
const MEDIA_BLOCK_RE = /(?:product image|media|link card|clickable image|published[^.]*without)/i;

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
  const reason = String(job.last_error || '');
  return Boolean(reason)
    && !MEDIA_BLOCK_RE.test(reason)
    && SESSION_BLOCK_RE.test(reason);
}

export function inspectFacebookStatus(store) {
  const blocked = blockedJobs(store);
  const recoverable = blocked.filter(isAutoRecoverableFacebookBlock);
  const unresolved = blocked.filter((job) => !isAutoRecoverableFacebookBlock(job));
  return {
    outcome: recoverable.length
      ? 'blocked_recoverable'
      : (unresolved.length ? 'blocked_unresolved' : 'healthy'),
    needsRepair: recoverable.length > 0,
    blockedIds: joinJobIds(blocked),
    recoverableIds: joinJobIds(recoverable),
    unresolvedIds: joinJobIds(unresolved),
    summary: store.summary(),
  };
}

export async function repairFacebookBlockedJobs(store, verifyAccess) {
  const inspection = inspectFacebookStatus(store);
  if (!inspection.needsRepair) return inspection;

  try {
    await verifyAccess();
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

  const recoverableIds = new Set(
    blockedJobs(store).filter(isAutoRecoverableFacebookBlock).map((job) => job.id)
  );
  const resumed = await store.resumeBlocked((job) => recoverableIds.has(job.id));
  const repaired = inspectFacebookStatus(store);
  return {
    ...repaired,
    outcome: repaired.unresolvedIds ? 'partially_repaired' : 'repaired',
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
      () => (options.verifyGroupAccess || verifyFacebookGroupAccess)(config, options)
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
    state_changed: stateChanged,
    blocked_product_ids: result.blockedIds,
    recoverable_product_ids: result.recoverableIds,
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
