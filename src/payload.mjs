export const AMAZON_DEALS_POSTING_POLICY = 'amazon-deals-all';
export const COUPON_ANNOUNCEMENT_POSTING_POLICY = 'coupon-announcement';
export const COUPON_ANNOUNCEMENT_TYPE = 'coupon_announcement';
export const COUPON_ANNOUNCEMENT_URL = 'https://www.chiping.co.il/?coupons=1';
export const COUPON_ANNOUNCEMENT_IMAGE_URL = 'https://www.chiping.co.il/images/fb-coupons-aliexpress.png';

function validCommonFields(payload) {
  return payload?.site === 'chiping'
    && payload?.channel === 'facebook'
    && payload?.language === 'he'
    && typeof payload?.message === 'string'
    && payload.message.trim().length > 0
    && typeof payload?.imageUrl === 'string'
    && payload.imageUrl.startsWith('https://')
    && typeof payload?.itemUrl === 'string';
}

function validProductPayload(payload, key, postingPolicy) {
  if (!/^chiping-facebook:v1:\d+$/.test(key)) return false;
  if (!/^\d+$/.test(String(payload?.productId || ''))) return false;
  if (postingPolicy && !['curated', AMAZON_DEALS_POSTING_POLICY].includes(postingPolicy)) return false;
  try {
    const url = new URL(payload.itemUrl);
    return url.protocol === 'https:'
      && url.hostname === 'www.chiping.co.il'
      && url.pathname === '/'
      && url.searchParams.get('item') === String(payload.productId);
  } catch {
    return false;
  }
}

function validCouponAnnouncement(payload, key, postingPolicy) {
  return payload?.post_type === COUPON_ANNOUNCEMENT_TYPE
    && postingPolicy === COUPON_ANNOUNCEMENT_POSTING_POLICY
    && /^chiping-facebook:coupons:v1:[a-f0-9]{32}$/.test(key)
    && /^[a-f0-9]{32}$/.test(String(payload?.contentId || ''))
    && payload.itemUrl === COUPON_ANNOUNCEMENT_URL
    && payload.imageUrl === COUPON_ANNOUNCEMENT_IMAGE_URL;
}

export function validChipingFacebookPayload(payload) {
  if (!validCommonFields(payload)) return false;
  const key = String(payload?.idempotency_key || payload?.idempotencyKey || '').trim();
  const postingPolicy = String(payload?.posting_policy || '').trim().toLowerCase();
  if (payload?.post_type === COUPON_ANNOUNCEMENT_TYPE) {
    return validCouponAnnouncement(payload, key, postingPolicy);
  }
  return validProductPayload(payload, key, postingPolicy);
}

export function assertValidChipingFacebookPayload(payload) {
  if (!validChipingFacebookPayload(payload)) throw new Error('Unexpected social payload');
}

export function chipingFacebookTarget(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'www.chiping.co.il' || url.pathname !== '/') return null;
    const productId = String(url.searchParams.get('item') || '');
    if (/^\d+$/.test(productId)) return { type: 'item', value: productId };
    if (url.searchParams.get('coupons') === '1') return { type: 'coupons', value: '1' };
    return null;
  } catch {
    return null;
  }
}
