import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_REQUEST_AGE_MS = 5 * 60 * 1000;

export function signPayload(secret, timestamp, body) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function isValidSignature(secret, timestamp, body, receivedSignature, nowMs = Date.now()) {
  if (!secret || !timestamp || !receivedSignature) return false;
  const requestMs = Number(timestamp);
  if (!Number.isFinite(requestMs) || Math.abs(nowMs - requestMs) > MAX_REQUEST_AGE_MS) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const received = Buffer.from(String(receivedSignature));
  return expected.length === received.length && timingSafeEqual(expected, received);
}
