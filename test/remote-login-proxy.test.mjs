import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyRemoteLogin } from '../src/remote-login-proxy.mjs';

test('remote login proxy forwards only to the configured quick tunnel', async () => {
  let forwardedUrl = '';
  const response = await proxyRemoteLogin(
    new Request('https://fb-login.chiping.co.il/app/ui.js?version=1'),
    { REMOTE_UPSTREAM: 'https://temporary-name.trycloudflare.com' },
    async (request) => {
      forwardedUrl = request.url;
      return new Response('asset', { headers: { 'Content-Type': 'text/javascript' } });
    }
  );

  assert.equal(forwardedUrl, 'https://temporary-name.trycloudflare.com/app/ui.js?version=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
});

test('remote login proxy rejects invalid upstreams and write methods', async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return new Response('unexpected');
  };

  const invalid = await proxyRemoteLogin(
    new Request('https://fb-login.chiping.co.il/vnc.html'),
    { REMOTE_UPSTREAM: 'https://example.com' },
    fetchImpl
  );
  const write = await proxyRemoteLogin(
    new Request('https://fb-login.chiping.co.il/vnc.html', { method: 'POST' }),
    { REMOTE_UPSTREAM: 'https://temporary-name.trycloudflare.com' },
    fetchImpl
  );

  assert.equal(invalid.status, 503);
  assert.equal(write.status, 405);
  assert.equal(fetches, 0);
});

test('remote login proxy exposes a non-cached deployment marker', async () => {
  const response = await proxyRemoteLogin(
    new Request('https://fb-login.chiping.co.il/__ready'),
    {}
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '__DEPLOYMENT_MARKER__');
  assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0');
});
