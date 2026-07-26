import { FacebookSessionRequiredError, postFacebookGroupJob } from './facebook.mjs';

function nextRetryAt(attempts) {
  const delayMs = Math.min(6 * 60 * 60 * 1000, 10 * 60 * 1000 * (2 ** Math.max(0, attempts)));
  return new Date(Date.now() + delayMs).toISOString();
}

async function notify(config, event) {
  if (!config.alertWebhookUrl) return;
  try {
    await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'chiping-facebook-group-poster', ...event }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error('[facebook-group-poster] alert delivery failed:', error.message);
  }
}

export class JobRunner {
  constructor(store, config, options = {}) {
    this.store = store;
    this.config = config;
    this.postJob = options.postJob || postFacebookGroupJob;
    this.running = false;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.kick().catch((error) => {
      console.error('[facebook-group-poster] queue tick failed:', error.message);
    }), this.config.retryIntervalMs);
    this.timer.unref();
    return this.kick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async kick() {
    if (this.running || this.config.dryRun) return;
    this.running = true;
    try {
      while (true) {
        const job = await this.store.claimNext();
        if (!job) return;
        try {
          const result = await this.postJob(job, this.config);
          await this.store.markPosted(job.id, result?.postUrl || this.config.groupUrl);
          console.log(`[facebook-group-poster] posted ${job.idempotency_key}`);
        } catch (error) {
          if (error instanceof FacebookSessionRequiredError) {
            await this.store.markBlocked(job.id, error.message);
            await notify(this.config, {
              level: 'blocked',
              job_id: job.id,
              product_id: job.product_id,
              reason: error.message,
            });
            console.error(`[facebook-group-poster] blocked: ${error.message}`);
            return;
          }
          const attemptsAfterFailure = job.attempts + 1;
          if (attemptsAfterFailure >= this.config.maxAttempts) {
            await this.store.markBlocked(job.id, `max retries reached: ${error.message}`);
            await notify(this.config, {
              level: 'blocked',
              job_id: job.id,
              product_id: job.product_id,
              reason: `max retries reached: ${error.message}`,
            });
            console.error(`[facebook-group-poster] blocked after retries: ${error.message}`);
            return;
          }
          await this.store.markRetry(job.id, error.message, nextRetryAt(job.attempts));
          console.error(`[facebook-group-poster] retrying ${job.idempotency_key}: ${error.message}`);
          return;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
