import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isValidSignature } from './auth.mjs';
import { loadConfig, productionReady, publicConfig } from './config.mjs';
import { JobRunner } from './runner.mjs';
import { JobStore } from './store.mjs';
import { validChipingFacebookPayload } from './payload.mjs';

const MAX_BODY_BYTES = 128 * 1024;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isAuthorized(request, rawBody, config) {
  return isValidSignature(
    config.sharedSecret,
    request.headers['x-chiping-timestamp'],
    rawBody,
    request.headers['x-chiping-signature']
  );
}

export async function createServer(options = {}) {
  const config = options.config || loadConfig(options.env);
  await mkdir(config.dataDir, { recursive: true });
  const store = options.store || new JobStore(config.dataDir);
  await store.init();
  const runner = options.runner || new JobRunner(store, config, options);
  await runner.start();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, {
        ok: true,
        ...publicConfig(config),
        queue: store.summary(),
      });
    }

    if (request.method !== 'POST') return sendJson(response, 404, { ok: false, error: 'not_found' });
    let rawBody;
    try {
      rawBody = await readBody(request);
    } catch (error) {
      return sendJson(response, 413, { ok: false, error: error.message });
    }
    if (!isAuthorized(request, rawBody, config)) return sendJson(response, 401, { ok: false, error: 'invalid_signature' });

    if (url.pathname === '/v1/session/resume') {
      const resumed = await store.resumeBlocked();
      void runner.kick();
      return sendJson(response, 200, { ok: true, resumed });
    }

    if (url.pathname !== '/v1/jobs') return sendJson(response, 404, { ok: false, error: 'not_found' });
    if (!productionReady(config)) {
      return sendJson(response, 409, { ok: false, error: 'poster_not_live' });
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return sendJson(response, 400, { ok: false, error: 'invalid_json' });
    }
    if (!validChipingFacebookPayload(payload)) return sendJson(response, 400, { ok: false, error: 'invalid_payload' });

    const result = await store.enqueue(payload);
    void runner.kick();
    return sendJson(response, 202, {
      ok: true,
      accepted: true,
      deduplicated: result.deduplicated,
      job_id: result.job.id,
      status: result.job.status,
    });
  });

  return { server, store, runner, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer().then(({ server, config }) => {
    server.listen(config.port, config.host, () => {
      console.log(`[facebook-group-poster] listening on ${config.host}:${config.port}`);
    });
  }).catch((error) => {
    console.error('[facebook-group-poster] failed to start:', error);
    process.exitCode = 1;
  });
}
