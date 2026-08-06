const SESSION_BLOCK_RE = /(?:facebook session|interactive login|security verification|security check|session expired|login credentials|posting profile|group posting is not available|composer could not be opened|post text box is not available)/i;
const MEDIA_BLOCK_RE = /(?:product image|media|link card|clickable image|published[^.]*without)/i;
const PREPARATION_BLOCK_RE = /Facebook preparation incomplete:/i;

export function isFacebookMediaBlock(job = {}) {
  const reason = String(job.last_error || '');
  return !PREPARATION_BLOCK_RE.test(reason) && MEDIA_BLOCK_RE.test(reason);
}

export function isFacebookSessionBlock(job = {}) {
  const reason = String(job.last_error || '');
  return Boolean(reason) && !MEDIA_BLOCK_RE.test(reason) && SESSION_BLOCK_RE.test(reason);
}

export function isFacebookPreparationBlock(job = {}) {
  return PREPARATION_BLOCK_RE.test(String(job.last_error || ''));
}

export function blocksFacebookQueue(job = {}) {
  return job?.status === 'blocked' && isFacebookSessionBlock(job);
}
