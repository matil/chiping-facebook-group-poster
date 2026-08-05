import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function emptyState() {
  return { version: 2, jobs: {}, order: [], posted_products: {} };
}

function isProductPost(job = {}) {
  return String(job?.payload?.posting_policy || '').trim().toLowerCase() !== 'coupon-announcement'
    && /^\d+$/.test(String(job?.product_id || '').trim());
}

function postedProductEntry(job = {}, postUrl = null, postedAt = null) {
  if (!isProductPost(job)) return null;
  const productId = String(job.product_id).trim();
  return {
    product_id: productId,
    post_url: String(postUrl || job.post_url || '').trim() || null,
    posted_at: String(postedAt || job.posted_at || '').trim() || new Date().toISOString(),
  };
}

function dueAt(job) {
  const value = Date.parse(job.next_attempt_at || '');
  return Number.isFinite(value) ? value : 0;
}

function postingPriority(job) {
  const policy = String(job?.payload?.posting_policy || '').trim().toLowerCase();
  if (policy === 'coupon-announcement') return -1;
  return policy === 'amazon-deals-all' ? 0 : 1;
}

export class JobStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'queue.json');
    this.state = emptyState();
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.jobs && Array.isArray(parsed.order)) this.state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    let changed = false;
    if (!this.state.posted_products || typeof this.state.posted_products !== 'object') {
      this.state.posted_products = {};
      changed = true;
    }
    this.state.version = 2;
    for (const job of Object.values(this.state.jobs)) {
      if (job?.status === 'processing') {
        job.status = 'retry';
        job.next_attempt_at = new Date().toISOString();
        job.last_error = 'service_restarted_during_processing';
        changed = true;
      }
      if (job?.status === 'posted') {
        const entry = postedProductEntry(job);
        if (entry && !this.state.posted_products[entry.product_id]) {
          this.state.posted_products[entry.product_id] = entry;
          changed = true;
        }
      }
    }
    if (changed) await this.persist();
    return changed;
  }

  async persist() {
    const payload = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, payload, 'utf8');
      await rename(temporary, this.file);
    });
    return this.writeChain;
  }

  async enqueue(payload) {
    const idempotencyKey = String(payload?.idempotency_key || payload?.idempotencyKey || '').trim();
    const productId = String(payload?.productId || '').trim();
    const existing = this.state.order
      .map((id) => this.state.jobs[id])
      .find((job) => job?.idempotency_key === idempotencyKey);
    if (existing) {
      if (existing.status !== 'posted') {
        existing.payload = payload;
        existing.product_id = String(payload.productId || existing.product_id || '').trim();
        existing.content_id = String(payload.contentId || payload.productId || existing.content_id || '').trim();
        existing.updated_at = new Date().toISOString();
        await this.persist();
      }
      return { job: structuredClone(existing), accepted: false, deduplicated: true };
    }
    const postedProduct = this.state.posted_products?.[productId];
    if (postedProduct) {
      return {
        job: {
          id: `posted-product:${productId}`,
          idempotency_key: idempotencyKey,
          product_id: productId,
          content_id: productId,
          payload,
          status: 'posted',
          post_url: postedProduct.post_url,
          posted_at: postedProduct.posted_at,
        },
        accepted: false,
        deduplicated: true,
      };
    }

    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      idempotency_key: idempotencyKey,
      product_id: String(payload.productId || '').trim(),
      content_id: String(payload.contentId || payload.productId || '').trim(),
      payload,
      status: 'pending',
      attempts: 0,
      next_attempt_at: now,
      last_error: null,
      post_url: null,
      created_at: now,
      updated_at: now,
    };
    this.state.jobs[job.id] = job;
    this.state.order.push(job.id);
    await this.persist();
    return { job: structuredClone(job), accepted: true, deduplicated: false };
  }

  async expediteRetry(idempotencyKey, nowMs = Date.now()) {
    const normalizedKey = String(idempotencyKey || '').trim();
    const job = this.state.order
      .map((id) => this.state.jobs[id])
      .find((entry) => entry?.idempotency_key === normalizedKey);
    if (!job || job.status !== 'retry') return null;
    const now = new Date(nowMs).toISOString();
    job.next_attempt_at = now;
    job.updated_at = now;
    await this.persist();
    return structuredClone(job);
  }

  peekNext(nowMs = Date.now()) {
    const job = this.state.order
      .map((id) => this.state.jobs[id])
      .filter((entry) => entry && ['pending', 'retry'].includes(entry.status) && dueAt(entry) <= nowMs)
      .sort((left, right) => {
        const priorityDelta = postingPriority(left) - postingPriority(right);
        if (priorityDelta) return priorityDelta;
        return Date.parse(left.created_at || '') - Date.parse(right.created_at || '');
      })[0];
    return job ? structuredClone(job) : null;
  }

  async claimNext(nowMs = Date.now()) {
    const next = this.peekNext(nowMs);
    if (!next) return null;
    const job = this.state.jobs[next.id];
    job.status = 'processing';
    job.updated_at = new Date(nowMs).toISOString();
    await this.persist();
    return structuredClone(job);
  }

  async markPosted(id, postUrl) {
    const job = this.state.jobs[id];
    if (!job) return null;
    job.status = 'posted';
    job.post_url = postUrl || null;
    job.last_error = null;
    job.posted_at = new Date().toISOString();
    job.updated_at = job.posted_at;
    const entry = postedProductEntry(job, postUrl, job.posted_at);
    if (entry) this.state.posted_products[entry.product_id] = entry;
    await this.persist();
    return structuredClone(job);
  }

  async markRetry(id, error, nextAttemptAt) {
    const job = this.state.jobs[id];
    if (!job) return null;
    job.status = 'retry';
    job.attempts += 1;
    job.last_error = String(error || 'post_failed').slice(0, 500);
    job.next_attempt_at = nextAttemptAt;
    job.updated_at = new Date().toISOString();
    await this.persist();
    return structuredClone(job);
  }

  async markBlocked(id, error) {
    const job = this.state.jobs[id];
    if (!job) return null;
    job.status = 'blocked';
    job.last_error = String(error || 'facebook_session_required').slice(0, 500);
    job.next_attempt_at = null;
    job.updated_at = new Date().toISOString();
    await this.persist();
    return structuredClone(job);
  }

  async resumeBlocked(predicate = null) {
    const now = new Date().toISOString();
    let resumed = 0;
    for (const job of Object.values(this.state.jobs)) {
      if (job?.status !== 'blocked') continue;
      if (typeof predicate === 'function' && !predicate(job)) continue;
      job.status = 'retry';
      job.next_attempt_at = now;
      job.last_error = null;
      job.updated_at = now;
      resumed += 1;
    }
    if (resumed) await this.persist();
    return resumed;
  }

  async resetProduct(productId) {
    const normalizedProductId = String(productId || '').trim();
    if (!/^\d+$/.test(normalizedProductId)) return 0;
    const now = new Date().toISOString();
    let reset = 0;
    const removedFromLedger = Boolean(this.state.posted_products?.[normalizedProductId]);
    if (removedFromLedger) {
      delete this.state.posted_products[normalizedProductId];
    }
    for (const job of Object.values(this.state.jobs)) {
      if (String(job?.product_id || '') !== normalizedProductId) continue;
      job.status = 'pending';
      job.attempts = 0;
      job.next_attempt_at = now;
      job.last_error = null;
      job.post_url = null;
      delete job.posted_at;
      job.updated_at = now;
      reset += 1;
    }
    if (!reset && removedFromLedger) reset = 1;
    if (reset) await this.persist();
    return reset;
  }

  async confirmProductPosted(productId, postUrl) {
    const normalizedProductId = String(productId || '').trim();
    const normalizedPostUrl = String(postUrl || '').trim();
    if (!/^\d+$/.test(normalizedProductId) || !normalizedPostUrl) return 0;
    const now = new Date().toISOString();
    let confirmed = 0;
    for (const job of Object.values(this.state.jobs)) {
      if (String(job?.product_id || '') !== normalizedProductId) continue;
      job.status = 'posted';
      job.post_url = normalizedPostUrl;
      job.last_error = null;
      job.next_attempt_at = null;
      job.posted_at = now;
      job.updated_at = now;
      confirmed += 1;
    }
    this.state.posted_products[normalizedProductId] = {
      product_id: normalizedProductId,
      post_url: normalizedPostUrl,
      posted_at: now,
    };
    confirmed = Math.max(confirmed, 1);
    if (confirmed) await this.persist();
    return confirmed;
  }

  async finalizeProductPostedUnlinked(productId) {
    const normalizedProductId = String(productId || '').trim();
    if (!/^\d+$/.test(normalizedProductId)) return 0;
    const now = new Date().toISOString();
    let finalized = 0;
    for (const job of Object.values(this.state.jobs)) {
      if (String(job?.product_id || '') !== normalizedProductId) continue;
      job.status = 'posted';
      job.post_url = null;
      job.last_error = null;
      job.next_attempt_at = null;
      job.posted_at = now;
      job.updated_at = now;
      finalized += 1;
    }
    this.state.posted_products[normalizedProductId] = {
      product_id: normalizedProductId,
      post_url: null,
      posted_at: now,
    };
    finalized = Math.max(finalized, 1);
    if (finalized) await this.persist();
    return finalized;
  }

  summary() {
    const result = { pending: 0, retry: 0, processing: 0, blocked: 0, posted: 0 };
    for (const job of Object.values(this.state.jobs)) {
      if (job?.status in result) result[job.status] += 1;
    }
    return result;
  }

  postedLedgerEntries() {
    return Object.values(this.state.posted_products || {})
      .filter((entry) => /^\d+$/.test(String(entry?.product_id || '')))
      .sort((left, right) => Date.parse(left.posted_at || '') - Date.parse(right.posted_at || ''))
      .map((entry) => structuredClone(entry));
  }
}
