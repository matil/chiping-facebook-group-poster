import path from 'node:path';

const DEFAULT_GROUP_URL = 'https://www.facebook.com/groups/chiping';

function boolean(value, fallback = false) {
  if (value == null || String(value).trim() === '') return fallback;
  return /^(?:1|true|yes|on)$/i.test(String(value).trim());
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

export function normalizeGroupUrl(value = DEFAULT_GROUP_URL) {
  const url = new URL(String(value || DEFAULT_GROUP_URL).trim());
  if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com') {
    throw new Error('FACEBOOK_GROUP_URL must use https://www.facebook.com');
  }
  const pathName = url.pathname.replace(/\/+$/, '');
  if (pathName !== '/groups/chiping') {
    throw new Error('FACEBOOK_GROUP_URL must target the Chiping Facebook group');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(String(env.POSTER_DATA_DIR || '/data'));
  return {
    host: String(env.POSTER_HOST || '0.0.0.0'),
    port: positiveInteger(env.POSTER_PORT, 8788, 1, 65535),
    dataDir,
    profileDir: path.resolve(String(env.FACEBOOK_PROFILE_DIR || path.join(dataDir, 'facebook-profile'))),
    storageStateFile: String(env.FACEBOOK_STORAGE_STATE_FILE || '').trim(),
    groupUrl: normalizeGroupUrl(env.FACEBOOK_GROUP_URL || DEFAULT_GROUP_URL),
    sharedSecret: String(env.POSTER_SHARED_SECRET || ''),
    dryRun: boolean(env.POSTER_DRY_RUN, true),
    headless: boolean(env.POSTER_HEADLESS, false),
    maxAttempts: positiveInteger(env.POSTER_MAX_ATTEMPTS, 5, 1, 20),
    retryIntervalMs: positiveInteger(env.POSTER_RETRY_INTERVAL_MS, 60000, 5000, 3600000),
    facebookLoginEmailFile: String(env.FACEBOOK_LOGIN_EMAIL_FILE || '').trim(),
    facebookLoginPasswordFile: String(env.FACEBOOK_LOGIN_PASSWORD_FILE || '').trim(),
    alertWebhookUrl: String(env.POSTER_ALERT_WEBHOOK_URL || '').trim(),
  };
}

export function productionReady(config) {
  return !config.dryRun && config.sharedSecret.length >= 32;
}

export function publicConfig(config) {
  return {
    dry_run: config.dryRun,
    group_configured: Boolean(config.groupUrl),
    session_profile_present: Boolean(config.profileDir),
    automatic_login_configured: Boolean(config.facebookLoginEmailFile && config.facebookLoginPasswordFile),
    production_ready: productionReady(config),
  };
}
