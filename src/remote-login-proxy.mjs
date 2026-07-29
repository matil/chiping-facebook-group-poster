const UPSTREAM_SUFFIX = '.trycloudflare.com';
const BAKED_UPSTREAM = '__REMOTE_UPSTREAM__';
const PUBLIC_HOSTS = new Set([
  'fb-login.chiping.co.il',
  'chiping-fb-login.pages.dev',
]);

function upstreamUrl(requestUrl, configuredUpstream) {
  let target;
  try {
    target = new URL(String(configuredUpstream || ''));
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' || !target.hostname.endsWith(UPSTREAM_SUFFIX)) return null;

  const incoming = new URL(requestUrl);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  target.hash = '';
  return target;
}

function safeHeaders(headers) {
  const result = new Headers(headers);
  result.set('Cache-Control', 'no-store, max-age=0');
  result.set('Pragma', 'no-cache');
  result.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  result.set('Referrer-Policy', 'no-referrer');
  return result;
}

export async function proxyRemoteLogin(request, env, fetchImpl = fetch) {
  const incoming = new URL(request.url);
  if (incoming.protocol !== 'https:' || !PUBLIC_HOSTS.has(incoming.hostname)) {
    return new Response('Not found', { status: 404 });
  }
  if (incoming.pathname === '/') {
    return Response.redirect(`${incoming.origin}/vnc.html?autoconnect=true&resize=scale`, 302);
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const target = upstreamUrl(request.url, env?.REMOTE_UPSTREAM || BAKED_UPSTREAM);
  if (!target) return new Response('Remote login is offline', { status: 503 });

  try {
    const response = await fetchImpl(new Request(target, request));
    if (response.status === 101) return response;
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: safeHeaders(response.headers),
    });
  } catch {
    return new Response('Remote login is offline', {
      status: 502,
      headers: safeHeaders(),
    });
  }
}

export default {
  fetch: proxyRemoteLogin,
};
