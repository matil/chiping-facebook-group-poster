import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { signPayload } from '../src/auth.mjs';
import { loadConfig, normalizeGroupUrl } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { readLoginCredentials } from '../src/facebook.mjs';
import { JobStore } from '../src/store.mjs';

const secret = 'facebook-group-poster-test-secret-with-at-least-32-characters';

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

test('Chiping group URL is fixed to the intended Facebook group', () => {
  assert.equal(normalizeGroupUrl('https://www.facebook.com/groups/chiping/'), 'https://www.facebook.com/groups/chiping');
  assert.throws(() => normalizeGroupUrl('https://www.facebook.com/groups/other'), /Chiping Facebook group/);
  assert.throws(() => normalizeGroupUrl('http://www.facebook.com/groups/chiping'), /https/);
});

test('posting profile selection is opt-in and read from configuration', () => {
  assert.equal(loadConfig({ FACEBOOK_POSTING_PROFILE_NAME: 'Chiping Deals' }).facebookPostingProfileName, 'Chiping Deals');
  assert.equal(loadConfig({}).facebookPostingProfileName, '');
});

test('automatic login reads credentials only from configured secret files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const emailFile = path.join(directory, 'email');
    const passwordFile = path.join(directory, 'password');
    await writeFile(emailFile, 'admin@example.test\n');
    await writeFile(passwordFile, 'secret-password\n');
    assert.deepEqual(await readLoginCredentials({ facebookLoginEmailFile: emailFile, facebookLoginPasswordFile: passwordFile }), {
      email: 'admin@example.test',
      password: 'secret-password',
    });
    assert.equal(await readLoginCredentials({ facebookLoginEmailFile: emailFile, facebookLoginPasswordFile: '' }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('job store is durable and idempotent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    const first = await store.enqueue(payload());
    const second = await store.enqueue(payload());
    assert.equal(first.accepted, true);
    assert.equal(second.deduplicated, true);
    const claimed = await store.claimNext();
    assert.equal(claimed.id, first.job.id);
    await store.markPosted(claimed.id, 'https://www.facebook.com/groups/chiping');

    const reopened = new JobStore(directory);
    await reopened.init();
    assert.deepEqual(reopened.summary(), { pending: 0, retry: 0, processing: 0, blocked: 0, posted: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('poster accepts only signed Chiping jobs and acknowledges duplicates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  const config = {
    host: '127.0.0.1',
    port: 0,
    dataDir: directory,
    profileDir: path.join(directory, 'profile'),
    groupUrl: 'https://www.facebook.com/groups/chiping',
    sharedSecret: secret,
    dryRun: false,
    headless: true,
    maxAttempts: 5,
    retryIntervalMs: 3600000,
    facebookLoginEmailFile: '',
    facebookLoginPasswordFile: '',
    alertWebhookUrl: '',
  };
  const app = await createServer({ config, postJob: async () => ({ postUrl: config.groupUrl }) });
  await new Promise((resolve) => app.server.listen(0, config.host, resolve));
  const port = app.server.address().port;
  const body = JSON.stringify(payload());
  const timestamp = String(Date.now());
  try {
    const rejected = await fetch(`http://127.0.0.1:${port}/v1/jobs`, { method: 'POST', body });
    assert.equal(rejected.status, 401);

    const request = () => fetch(`http://127.0.0.1:${port}/v1/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-chiping-timestamp': timestamp,
        'x-chiping-signature': signPayload(secret, timestamp, body),
      },
      body,
    });
    const first = await request();
    const second = await request();
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal((await second.json()).deduplicated, true);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
      if (health.queue.posted === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(app.store.summary().posted, 1);
  } finally {
    app.runner.stop();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
