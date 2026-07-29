import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function emptyState() {
  return { version: 1, jobs: {}, order: [] };
}

function dueAt(job) {
  const value = Date.parse(job.next_attempt_at || '');
  return Number.isFinite(value) ? value : 0;
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
    for (const job of Object.values(this.state.jobs)) {
      if (job?.status === 'processing') {
        job.status = 'retry';
        job.next_attempt_at = new Date().toISOString();
        job.last_error = 'service_restarted_during_processing';
        changed = true;
      }
    }
    if (changed) await this.persist();
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
    const existing = this.state.order
      .map((id) => this.state.jobs[id])
      .find((job) => job?.idempotency_key === idempotencyKey);
    if (existing) return { job: structuredClone(existing), accepted: false, deduplicated: true };

    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      idempotency_key: idempotencyKey,
      product_id: String(payload.productId || '').trim(),
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

  async claimNext(nowMs = Date.now()) {
    const job = this.state.order
      .map((id) => this.state.jobs[id])
      .find((entry) => entry && ['pending', 'retry'].includes(entry.status) && dueAt(entry) <= nowMs);
    if (!job) return null;
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

  async resumeBlocked() {
    const now = new Date().toISOString();
    let resumed = 0;
    for (const job of Object.values(this.state.jobs)) {
      if (job?.status !== 'blocked') continue;
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
    if (reset) await this.persist();
    return reset;
  }

  summary() {
    const result = { pending: 0, retry: 0, processing: 0, blocked: 0, posted: 0 };
    for (const job of Object.values(this.state.jobs)) {
      if (job?.status in result) result[job.status] += 1;
    }
    return result;
  }
}
