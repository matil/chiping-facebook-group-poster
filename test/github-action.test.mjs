import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGitHubAction } from '../src/action-runner.mjs';
import { restoreEncryptedActionState } from '../src/action-state.mjs';

const stateKey = 'github-action-state-key-that-is-longer-than-thirty-two-characters';

function payload() {
  return {
    idempotency_key: 'chiping-facebook:v1:9301',
    productId: '9301',
    site: 'chiping',
    channel: 'facebook',
    language: 'he',
    message: '\u05d3\u05d9\u05dc \u05d1\u05d3\u05d9\u05e7\u05d4',
    imageUrl: 'https://cdn.example.test/deal.jpg',
    itemUrl: 'https://www.chiping.co.il/?item=9301',
  };
}

async function actionEnvironment(directory, event = null) {
  const eventFile = path.join(directory, 'event.json');
  if (event) await writeFile(eventFile, JSON.stringify(event));
  return {
    POSTER_DATA_DIR: path.join(directory, 'data'),
    FACEBOOK_STORAGE_STATE_FILE: path.join(directory, 'data', 'facebook-storage-state.json'),
    FACEBOOK_ACTION_STATE_FILE: path.join(directory, 'state', 'facebook-agent.enc'),
    FACEBOOK_STATE_ENCRYPTION_KEY: stateKey,
    FACEBOOK_EVENT_PATH: event ? eventFile : '',
    POSTER_HEADLESS: 'true',
    POSTER_MAX_ATTEMPTS: '5',
  };
}

test('GitHub Action encrypts a queued payload while posting stays disabled', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory, { client_payload: { payload: payload() } });
    const result = await runGitHubAction(env);
    assert.equal(result.outcome, 'dry_run');
    assert.equal(result.stateChanged, true);

    const encrypted = await readFile(env.FACEBOOK_ACTION_STATE_FILE, 'utf8');
    assert.doesNotMatch(encrypted, /\u05d3\u05d9\u05dc \u05d1\u05d3\u05d9\u05e7\u05d4/);
    const restoredDir = path.join(directory, 'restored');
    await restoreEncryptedActionState({
      encryptedFile: env.FACEBOOK_ACTION_STATE_FILE,
      secret: stateKey,
      dataDir: restoredDir,
      storageStateFile: path.join(restoredDir, 'storage.json'),
    });
    const queue = JSON.parse(await readFile(path.join(restoredDir, 'queue.json'), 'utf8'));
    assert.equal(Object.values(queue.jobs)[0].payload.productId, '9301');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action ignores malformed repository-dispatch payloads', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory, { client_payload: {} });
    const result = await runGitHubAction(env);
    assert.equal(result.outcome, 'invalid_payload');
    assert.equal(result.stateChanged, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action can verify Group access without posting or a queued item', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory);
    env.FACEBOOK_ACTION_VERIFY_GROUP_ACCESS = 'true';
    let verified = false;
    const result = await runGitHubAction(env, {
      verifyGroupAccess: async () => { verified = true; },
      postJob: async () => { throw new Error('verification must never post'); },
    });
    assert.equal(verified, true);
    assert.equal(result.outcome, 'verified');
    assert.equal(result.stateChanged, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action posts one queued item and respects the daily interval', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory, { client_payload: { payload: payload() } });
    env.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    const sent = [];
    const first = await runGitHubAction(env, {
      postJob: async (job) => {
        sent.push(job.payload.productId);
        return { postUrl: 'https://www.facebook.com/groups/chiping' };
      },
    });
    assert.equal(first.outcome, 'posted');
    assert.deepEqual(sent, ['9301']);

    const secondEnv = await actionEnvironment(directory);
    secondEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    const second = await runGitHubAction(secondEnv, {
      postJob: async () => {
        throw new Error('a cooldown must prevent another browser launch');
      },
    });
    assert.equal(second.outcome, 'cooldown');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
