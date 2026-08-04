import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { postIntervalMsForJob, runGitHubAction } from '../src/action-runner.mjs';
import { previewFacebookLink } from '../src/preview-link.mjs';
import { isFacebookQuietHours } from '../src/quiet-hours.mjs';
import {
  markVerifiedPostingProfile,
  restoreEncryptedActionState,
  saveEncryptedActionState,
} from '../src/action-state.mjs';
import {
  FacebookPostMediaRequiredError,
  FacebookSessionRequiredError,
} from '../src/facebook.mjs';

const stateKey = 'github-action-state-key-that-is-longer-than-thirty-two-characters';

function payload(overrides = {}) {
  return {
    idempotency_key: 'chiping-facebook:v1:9301',
    productId: '9301',
    site: 'chiping',
    channel: 'facebook',
    language: 'he',
    message: '\u05d3\u05d9\u05dc \u05d1\u05d3\u05d9\u05e7\u05d4',
    imageUrl: 'https://cdn.example.test/deal.jpg',
    itemUrl: 'https://www.chiping.co.il/?item=9301',
    ...overrides,
  };
}

function couponPayload(overrides = {}) {
  const fingerprint = 'a'.repeat(32);
  return {
    idempotency_key: `chiping-facebook:coupons:v1:${fingerprint}`,
    contentId: fingerprint,
    site: 'chiping',
    channel: 'facebook',
    language: 'he',
    post_type: 'coupon_announcement',
    posting_policy: 'coupon-announcement',
    message: '\u05e7\u05d5\u05e4\u05d5\u05e0\u05d9\u05dd \u05d7\u05d3\u05e9\u05d9\u05dd \u05dc-AliExpress',
    imageUrl: 'https://www.chiping.co.il/images/fb-coupons-aliexpress-v2.png',
    itemUrl: 'https://www.chiping.co.il/?coupons=1',
    ...overrides,
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

test('encrypted state preserves the verified Facebook posting profile', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const dataDir = path.join(directory, 'data');
    const encryptedFile = path.join(directory, 'state', 'facebook-agent.enc');
    const storageStateFile = path.join(dataDir, 'storage.json');
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'queue.json'), '{}');
    await writeFile(storageStateFile, JSON.stringify({ cookies: [], origins: [] }));
    await markVerifiedPostingProfile(dataDir, 'Chi Ping');
    await saveEncryptedActionState({
      encryptedFile,
      secret: stateKey,
      dataDir,
      storageStateFile,
    });

    const restoredDir = path.join(directory, 'restored');
    await restoreEncryptedActionState({
      encryptedFile,
      secret: stateKey,
      dataDir: restoredDir,
      storageStateFile: path.join(restoredDir, 'storage.json'),
    });
    const marker = JSON.parse(
      await readFile(path.join(restoredDir, 'verified-profile.json'), 'utf8')
    );
    assert.deepEqual(marker, { name: 'Chi Ping' });
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

test('GitHub Action keeps queued posts pending during Israel quiet hours', async () => {
  assert.equal(isFacebookQuietHours(Date.parse('2026-08-04T21:30:00.000Z')), true);
  assert.equal(isFacebookQuietHours(Date.parse('2026-08-05T03:00:00.000Z')), false);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory, { client_payload: { payload: payload() } });
    env.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    let sends = 0;
    const result = await runGitHubAction(env, {
      nowMs: Date.parse('2026-08-04T22:00:00.000Z'),
      postJob: async () => {
        sends += 1;
        return { postUrl: 'https://www.facebook.com/groups/chiping/posts/111/' };
      },
    });

    assert.equal(result.outcome, 'quiet_hours');
    assert.equal(result.summary.pending, 1);
    assert.equal(sends, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action rejects coupon announcements with a non-popup destination', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory, {
      client_payload: { payload: couponPayload({ itemUrl: 'https://www.chiping.co.il/' }) },
    });
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

test('GitHub Action returns only a safe reason when access verification is blocked', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory);
    env.FACEBOOK_ACTION_VERIFY_GROUP_ACCESS = 'true';
    const result = await runGitHubAction(env, {
      verifyGroupAccess: async () => {
        throw new FacebookSessionRequiredError('Configured Facebook posting profile is not available');
      },
    });
    assert.equal(result.outcome, 'verification_failed');
    assert.equal(result.verificationReason, 'Configured Facebook posting profile is not available');
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

test('Amazon Deals Facebook jobs use a five-minute interval instead of curated daily cadence', async () => {
  assert.equal(postIntervalMsForJob({ payload: payload() }), 20 * 60 * 60 * 1000);
  assert.equal(postIntervalMsForJob({
    payload: payload({ posting_policy: 'amazon-deals-all' }),
  }), 5 * 60 * 1000);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const sourcePayload = payload({ posting_policy: 'amazon-deals-all' });
    const firstEnv = await actionEnvironment(directory, {
      client_payload: { payload: sourcePayload },
    });
    firstEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    const sent = [];
    const first = await runGitHubAction(firstEnv, {
      postJob: async (job) => {
        sent.push(job.payload.productId);
        return { postUrl: 'https://www.facebook.com/groups/chiping/posts/111/' };
      },
    });
    assert.equal(first.outcome, 'posted');

    const secondEnv = await actionEnvironment(directory, {
      client_payload: {
        payload: payload({
          posting_policy: 'amazon-deals-all',
          idempotency_key: 'chiping-facebook:v1:9302',
          productId: '9302',
          itemUrl: 'https://www.chiping.co.il/?item=9302',
        }),
      },
    });
    secondEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    const second = await runGitHubAction(secondEnv, {
      nowMs: Date.now() + 6 * 60 * 1000,
      postJob: async (job) => {
        sent.push(job.payload.productId);
        return { postUrl: 'https://www.facebook.com/groups/chiping/posts/222/' };
      },
    });

    assert.equal(second.outcome, 'posted');
    assert.deepEqual(sent, ['9301', '9302']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action finalizes an exact Facebook post even when its permalink is hidden', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory, {
      client_payload: { payload: payload({ posting_policy: 'amazon-deals-all' }) },
    });
    env.FACEBOOK_ACTION_POSTING_ENABLED = 'true';

    const result = await runGitHubAction(env, {
      postJob: async () => ({ published: true, postUrl: '' }),
    });

    assert.equal(result.outcome, 'posted_unlinked');
    assert.equal(result.summary.posted, 1);
    assert.equal(result.summary.retry, 0);
    assert.equal(result.postUrl, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action syncs verified product posts to the permanent ledger', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory, { client_payload: { payload: payload() } });
    env.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    env.FACEBOOK_POSTED_LEDGER_ENDPOINT = 'https://ledger.example.test/v1/facebook-posted-ledger';
    env.FACEBOOK_POSTED_LEDGER_SECRET = 'ledger-test-secret';
    const requests = [];
    const postUrl = 'https://www.facebook.com/groups/chiping/posts/111/';
    const result = await runGitHubAction(env, {
      postJob: async () => ({ postUrl }),
      ledgerFetch: async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    assert.equal(result.outcome, 'posted');
    assert.equal(result.postedProductId, '9301');
    assert.equal(result.postedLedgerCount, 1);
    assert.equal(result.ledgerSyncError, '');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, env.FACEBOOK_POSTED_LEDGER_ENDPOINT);
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(
      requests[0].options.headers['X-Chiping-Facebook-Ledger-Secret'],
      env.FACEBOOK_POSTED_LEDGER_SECRET
    );
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.posts.map(({ product_id, post_url }) => ({ product_id, post_url })), [{
      product_id: '9301',
      post_url: postUrl,
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action permanently saves a migrated legacy posted-product ledger', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory);
    await mkdir(env.POSTER_DATA_DIR, { recursive: true });
    const postedAt = '2026-08-01T12:00:00.000Z';
    const postUrl = 'https://www.facebook.com/groups/chiping/posts/110/';
    await writeFile(path.join(env.POSTER_DATA_DIR, 'queue.json'), JSON.stringify({
      version: 1,
      jobs: {
        legacy: {
          id: 'legacy',
          idempotency_key: 'chiping-facebook:v1:9301',
          product_id: '9301',
          content_id: '9301',
          payload: payload(),
          status: 'posted',
          post_url: postUrl,
          posted_at: postedAt,
          updated_at: postedAt,
        },
      },
      order: ['legacy'],
    }));
    await saveEncryptedActionState({
      encryptedFile: env.FACEBOOK_ACTION_STATE_FILE,
      secret: stateKey,
      dataDir: env.POSTER_DATA_DIR,
      storageStateFile: env.FACEBOOK_STORAGE_STATE_FILE,
    });
    env.FACEBOOK_POSTED_LEDGER_ENDPOINT = 'https://ledger.example.test/v1/facebook-posted-ledger';
    env.FACEBOOK_POSTED_LEDGER_SECRET = 'ledger-test-secret';

    const result = await runGitHubAction(env, {
      ledgerFetch: async () => new Response('{}', { status: 200 }),
    });
    assert.equal(result.outcome, 'idle');
    assert.equal(result.stateChanged, true);
    assert.equal(result.postedLedgerCount, 1);

    const restoredDir = path.join(directory, 'restored-ledger');
    await restoreEncryptedActionState({
      encryptedFile: env.FACEBOOK_ACTION_STATE_FILE,
      secret: stateKey,
      dataDir: restoredDir,
      storageStateFile: path.join(restoredDir, 'storage.json'),
    });
    const restored = JSON.parse(await readFile(path.join(restoredDir, 'queue.json'), 'utf8'));
    assert.deepEqual(restored.posted_products['9301'], {
      product_id: '9301',
      post_url: postUrl,
      posted_at: postedAt,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action blocks instead of duplicating a published post with no product image', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory, {
      client_payload: { payload: payload({ posting_policy: 'amazon-deals-all' }) },
    });
    env.FACEBOOK_ACTION_POSTING_ENABLED = 'true';

    const result = await runGitHubAction(env, {
      postJob: async () => {
        throw new FacebookPostMediaRequiredError();
      },
    });

    assert.equal(result.outcome, 'blocked');
    assert.match(result.blockedReason, /without its product image link card/);
    assert.equal(result.summary.blocked, 1);
    assert.equal(result.summary.retry, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reviewed unlinked finalization survives the next workflow run', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory, {
      client_payload: { payload: payload({ posting_policy: 'amazon-deals-all' }) },
    });
    env.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    const blocked = await runGitHubAction(env, {
      postJob: async () => { throw new FacebookPostMediaRequiredError(); },
    });
    assert.equal(blocked.summary.blocked, 1);

    const finalizeEnv = await actionEnvironment(directory);
    finalizeEnv.FACEBOOK_ACTION_FINALIZE_UNLINKED_PRODUCT_ID = '9301';
    const finalized = await runGitHubAction(finalizeEnv);
    assert.equal(finalized.outcome, 'finalized_unlinked');
    assert.equal(finalized.summary.blocked, 0);
    assert.equal(finalized.summary.posted, 1);

    const restartEnv = await actionEnvironment(directory);
    restartEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    const restarted = await runGitHubAction(restartEnv, {
      postJob: async () => { throw new Error('a finalized item must not be posted again'); },
    });
    assert.equal(restarted.summary.blocked, 0);
    assert.equal(restarted.summary.posted, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('coupon announcements post through the popup link on the fast interval', async () => {
  assert.equal(postIntervalMsForJob({ payload: couponPayload() }), 5 * 60 * 1000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory, {
      client_payload: { payload: couponPayload() },
    });
    env.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    let received = null;
    const result = await runGitHubAction(env, {
      postJob: async (job) => {
        received = job.payload;
        return { postUrl: 'https://www.facebook.com/groups/chiping/posts/333/' };
      },
    });

    assert.equal(result.outcome, 'posted');
    assert.equal(received.itemUrl, 'https://www.chiping.co.il/?coupons=1');
    assert.equal(received.productId, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a duplicate coupon event immediately retries a transiently failed announcement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const firstNow = Date.now() + 1000;
    const firstEnv = await actionEnvironment(directory, {
      client_payload: { payload: couponPayload() },
    });
    firstEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    const first = await runGitHubAction(firstEnv, {
      nowMs: firstNow,
      postJob: async () => { throw new Error('temporary Facebook preview failure'); },
    });
    assert.equal(first.outcome, 'retry');

    const secondEnv = await actionEnvironment(directory, {
      client_payload: { payload: couponPayload() },
    });
    secondEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    let attempts = 0;
    const second = await runGitHubAction(secondEnv, {
      nowMs: firstNow + 1000,
      postJob: async () => {
        attempts += 1;
        return { postUrl: 'https://www.facebook.com/groups/chiping/posts/444/' };
      },
    });

    assert.equal(second.outcome, 'posted');
    assert.equal(second.postUrl, 'https://www.facebook.com/groups/chiping/posts/444/');
    assert.equal(attempts, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a duplicate fast product event refreshes its image and retries immediately', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const firstNow = Date.now() + 1000;
    const oldPayload = payload({
      posting_policy: 'amazon-deals-all',
      imageUrl: 'https://cdn.example.test/old.jpg',
    });
    const firstEnv = await actionEnvironment(directory, { client_payload: { payload: oldPayload } });
    firstEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    const first = await runGitHubAction(firstEnv, {
      nowMs: firstNow,
      postJob: async () => { throw new Error('temporary Facebook preview failure'); },
    });
    assert.equal(first.outcome, 'retry');

    const newPayload = {
      ...oldPayload,
      imageUrl: 'https://www.chiping.co.il/facebook-images/9301.jpg?v=new',
    };
    const secondEnv = await actionEnvironment(directory, { client_payload: { payload: newPayload } });
    secondEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    let receivedImage = '';
    const second = await runGitHubAction(secondEnv, {
      nowMs: firstNow + 1000,
      postJob: async (job) => {
        receivedImage = job.payload.imageUrl;
        return { postUrl: 'https://www.facebook.com/groups/chiping/posts/445/' };
      },
    });

    assert.equal(second.outcome, 'posted');
    assert.equal(receivedImage, newPayload.imageUrl);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action can reset and repost one falsely completed product', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const firstNow = Date.now();
    const env = await actionEnvironment(directory, { client_payload: { payload: payload() } });
    env.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    await runGitHubAction(env, {
      nowMs: firstNow + 1000,
      postJob: async () => ({
        postUrl: 'https://www.facebook.com/groups/chiping/posts/111/',
      }),
    });

    const recentPayload = payload({
      idempotency_key: 'chiping-facebook:v1:9302',
      productId: '9302',
      itemUrl: 'https://www.chiping.co.il/?item=9302',
    });
    const recentEnv = await actionEnvironment(directory, { client_payload: { payload: recentPayload } });
    recentEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    const recentResult = await runGitHubAction(recentEnv, {
      nowMs: firstNow + 21 * 60 * 60 * 1000,
      postJob: async () => ({
        postUrl: 'https://www.facebook.com/groups/chiping/posts/112/',
      }),
    });
    assert.equal(recentResult.outcome, 'posted');
    assert.equal(recentResult.summary.posted, 2);

    const resetEnv = await actionEnvironment(directory);
    resetEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    resetEnv.FACEBOOK_ACTION_RESET_PRODUCT_ID = '9301';
    let repostedProductId = '';
    const result = await runGitHubAction(resetEnv, {
      nowMs: firstNow + 21 * 60 * 60 * 1000 + 1000,
      postJob: async (job) => {
        repostedProductId = job.product_id;
        return { postUrl: 'https://www.facebook.com/groups/chiping/posts/222/' };
      },
    });
    assert.equal(result.outcome, 'posted');
    assert.equal(result.postUrl, 'https://www.facebook.com/groups/chiping/posts/222/');
    assert.equal(repostedProductId, '9301');
    assert.equal(result.summary.posted, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action deletes an incorrect post and resets it without reposting in the same run', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const firstEnv = await actionEnvironment(directory, { client_payload: { payload: payload() } });
    firstEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    await runGitHubAction(firstEnv, {
      postJob: async () => ({ postUrl: 'https://www.facebook.com/groups/chiping/posts/111/' }),
    });

    const deleteEnv = await actionEnvironment(directory);
    deleteEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    deleteEnv.FACEBOOK_ACTION_DELETE_PRODUCT_ID = '9301';
    deleteEnv.FACEBOOK_ACTION_DELETE_POST_URL = 'https://www.facebook.com/groups/chiping/posts/111/';
    let deletedUrl = '';
    const result = await runGitHubAction(deleteEnv, {
      deletePost: async (postUrl) => { deletedUrl = postUrl; return { deleted: true }; },
      postJob: async () => { throw new Error('deletion must not repost in the same run'); },
    });

    assert.equal(result.outcome, 'deleted');
    assert.equal(deletedUrl, deleteEnv.FACEBOOK_ACTION_DELETE_POST_URL);
    assert.equal(result.summary.posted, 0);
    assert.equal(result.summary.pending, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action confirms a recovered permalink without launching the poster', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-action-'));
  try {
    const env = await actionEnvironment(directory, { client_payload: { payload: payload() } });
    await runGitHubAction(env);

    const confirmEnv = await actionEnvironment(directory);
    confirmEnv.FACEBOOK_ACTION_POSTING_ENABLED = 'true';
    confirmEnv.FACEBOOK_ACTION_CONFIRM_PRODUCT_ID = '9301';
    confirmEnv.FACEBOOK_ACTION_CONFIRM_POST_URL = 'https://www.facebook.com/photo/?fbid=111&set=g.222';
    const result = await runGitHubAction(confirmEnv, {
      postJob: async () => {
        throw new Error('confirmation must never launch Facebook posting');
      },
    });
    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.postUrl, confirmEnv.FACEBOOK_ACTION_CONFIRM_POST_URL);
    assert.equal(result.summary.posted, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub Action can render a link-card preview without posting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-preview-'));
  try {
    const seedDir = path.join(directory, 'seed');
    const dataDir = path.join(directory, 'data');
    const encryptedFile = path.join(directory, 'state', 'facebook-agent.enc');
    const seedStorage = path.join(seedDir, 'storage.json');
    await mkdir(seedDir, { recursive: true });
    await writeFile(path.join(seedDir, 'queue.json'), '{}');
    await writeFile(seedStorage, JSON.stringify({ cookies: [], origins: [] }));
    await saveEncryptedActionState({
      encryptedFile,
      secret: stateKey,
      dataDir: seedDir,
      storageStateFile: seedStorage,
    });

    const itemUrl = 'https://www.chiping.co.il/?item=9301';
    const message = `\u05d3\u05d9\u05dc \u05d1\u05d3\u05d9\u05e7\u05d4\n${itemUrl}`;
    const env = {
      POSTER_DATA_DIR: dataDir,
      FACEBOOK_STORAGE_STATE_FILE: path.join(dataDir, 'storage.json'),
      FACEBOOK_ACTION_STATE_FILE: encryptedFile,
      FACEBOOK_STATE_ENCRYPTION_KEY: stateKey,
      FACEBOOK_PREVIEW_PRODUCT_ID: '9301',
      FACEBOOK_PREVIEW_IMAGE_URL: 'https://cdn.example.test/facebook-link-9301.jpg',
      FACEBOOK_PREVIEW_MESSAGE_BASE64: Buffer.from(message).toString('base64'),
      FACEBOOK_PREVIEW_SCREENSHOT_PATH: path.join(directory, 'preview.png'),
      POSTER_HEADLESS: 'true',
    };
    let received = null;
    const result = await previewFacebookLink(env, {
      previewJob: async (payloadValue, config, options) => {
        received = { payload: payloadValue, config, options };
        return { ready: true };
      },
    });

    assert.equal(result.ready, true);
    assert.equal(received.payload.itemUrl, itemUrl);
    assert.equal(received.payload.message, message);
    assert.equal(received.options.screenshotPath, env.FACEBOOK_PREVIEW_SCREENSHOT_PATH);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('remote login workflow uses protected VNC and encrypts the resulting session', async () => {
  const workflow = await readFile(
    path.join(process.cwd(), '.github', 'workflows', 'facebook-interactive-login.yml'),
    'utf8'
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /FACEBOOK_VNC_PASSWORD/);
  assert.match(workflow, /trycloudflare\\\.com/);
  assert.match(workflow, /Remote browser URL:/);
  assert.match(workflow, /::notice title=Temporary Facebook browser::/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /fb-login\.chiping\.co\.il/);
  assert.match(workflow, /wrangler@4\.75\.0 pages deploy/);
  assert.match(workflow, /--project-name chiping-fb-login/);
  assert.match(workflow, /cp -R \/usr\/share\/novnc/);
  assert.match(workflow, /fb-login\.chiping\.co\.il\/vnc\?/);
  assert.match(workflow, /host=\$\{remote_host\}/);
  assert.doesNotMatch(workflow, /remote-login-proxy/);
  assert.match(workflow, /facebook-remote-login-\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(workflow, /FACEBOOK_CLOUDFLARE_TUNNEL_TOKEN/);
  assert.match(workflow, /x11vnc/);
  assert.match(workflow, /node src\/interactive-login\.mjs/);
  assert.match(workflow, /Save encrypted Facebook state/);
  assert.match(workflow, /always\(\) && hashFiles\('\.facebook-state\/facebook-agent\.enc'\) != ''/);
  assert.doesNotMatch(workflow, /FACEBOOK_ACTION_POSTING_ENABLED/);

  const postingWorkflow = await readFile(
    path.join(process.cwd(), '.github', 'workflows', 'facebook-group-post.yml'),
    'utf8'
  );
  assert.match(postingWorkflow, /FACEBOOK_TRUST_VERIFIED_PROFILE: 'true'/);
  assert.match(postingWorkflow, /FACEBOOK_POSTED_LEDGER_ENDPOINT:/);
  assert.match(postingWorkflow, /FACEBOOK_POSTED_LEDGER_SECRET:/);
  assert.match(postingWorkflow, /FACEBOOK_ACTION_RESET_PRODUCT_ID:/);
  assert.match(postingWorkflow, /FACEBOOK_ACTION_CONFIRM_PRODUCT_ID:/);
  assert.match(postingWorkflow, /Post URL:/);
  assert.match(postingWorkflow, /Facebook outcome=%s pending=%s blocked=%s/);
  assert.match(postingWorkflow, /FACEBOOK_DEBUG_DIR:/);
  assert.match(postingWorkflow, /facebook-post-debug-\$\{\{ github\.run_id \}\}/);

  const verificationWorkflow = await readFile(
    path.join(process.cwd(), '.github', 'workflows', 'facebook-verify-post.yml'),
    'utf8'
  );
  assert.match(verificationWorkflow, /node src\/verify-post\.mjs/);
  assert.match(verificationWorkflow, /FACEBOOK_VERIFY_EXPECTED_TITLE: \$\{\{ inputs\.expected_title \}\}/);
  assert.match(verificationWorkflow, /FACEBOOK_VERIFY_PRODUCT_ID:/);
  assert.match(verificationWorkflow, /FACEBOOK_VERIFY_CURRENT_PAGE_ONLY: 'false'/);
  assert.match(verificationWorkflow, /FACEBOOK_VERIFY_SORT_NEWEST: 'true'/);
  assert.match(verificationWorkflow, /FACEBOOK_VERIFY_MEDIA_FALLBACK: 'true'/);
  assert.match(verificationWorkflow, /FACEBOOK_VERIFY_REQUIRE_IMAGE: \$\{\{ inputs\.require_image \}\}/);
  assert.match(verificationWorkflow, /Image destination:/);
  assert.match(verificationWorkflow, /actions\/upload-artifact@v4/);
  assert.match(verificationWorkflow, /Post URL:/);
  assert.doesNotMatch(verificationWorkflow, /FACEBOOK_ACTION_POSTING_ENABLED/);

  const linkPreviewWorkflow = await readFile(
    path.join(process.cwd(), '.github', 'workflows', 'facebook-preview-link.yml'),
    'utf8'
  );
  assert.match(linkPreviewWorkflow, /node src\/preview-link\.mjs/);
  assert.match(linkPreviewWorkflow, /FACEBOOK_PREVIEW_MESSAGE_BASE64:/);
  assert.match(linkPreviewWorkflow, /Render link card without posting/);
  assert.match(linkPreviewWorkflow, /facebook-link-preview-\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(linkPreviewWorkflow, /FACEBOOK_ACTION_POSTING_ENABLED/);
});
