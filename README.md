# Chiping Facebook Group Poster

This is an isolated browser poster for the Chiping Facebook Group:
`https://www.facebook.com/groups/chiping`.

It receives a signed, idempotent job from `deals-engine`, stores it in its own
durable queue, then posts it through the Group's normal browser UI. It does not
run inside the Cloudflare deals Worker, does not share its queue or dependencies,
and does not change any other source, enrichment, Telegram, or X job.

It supports two isolated runtimes:

- GitHub Actions: the zero-cost option. A disposable runner restores an encrypted
  browser state and queue, posts one item, then saves only the encrypted state.
- A persistent Docker service: retained for a future VM deployment.

## GitHub Actions setup

This repository can be public because it contains no Facebook credentials, cookies,
or product queue. Standard GitHub-hosted Actions runners are free for public
repositories. The workflow is triggered by the deals engine after it selects and
price-validates an item, and hourly to retry a retained item.

Set these **repository secrets** under `Settings > Secrets and variables > Actions`:

| Secret | Purpose |
| --- | --- |
| `FACEBOOK_LOGIN_EMAIL` | Dedicated Facebook posting-account email |
| `FACEBOOK_LOGIN_PASSWORD` | Dedicated Facebook posting-account password |
| `FACEBOOK_STATE_ENCRYPTION_KEY` | A new random value, at least 32 characters |
| `FACEBOOK_ACTION_POSTING_ENABLED` | Keep unset or `false` until a dry-run review is complete; set `true` only to permit posting |

The queue and Playwright `storageState` are encrypted with AES-256-GCM before the
GitHub Actions cache stores them. The credentials are written only to short-lived
runner files and are never committed, logged, or included in the cached state.

Create a **fine-grained GitHub token** for the deals engine that is restricted to
this repository and has only `Contents: Read and write`. The engine uses it solely
to create the `chiping-facebook-post` repository-dispatch event. Set these
Cloudflare Worker secrets only after the GitHub workflow has been reviewed:

```bash
wrangler secret put FACEBOOK_CHIPING_GITHUB_TOKEN
wrangler secret put FACEBOOK_CHIPING_PUBLISHER
# Value: github_actions
wrangler secret put CHIPING_FACEBOOK_POSTING_ENABLED
# Value: true
```

Do not set `FACEBOOK_ACTION_POSTING_ENABLED=true` or the Worker publisher secrets
until the Action has been manually run in dry-run mode and its logs show the
expected queue state. The workflow always keeps at least 20 hours between successful
Facebook posts, retries transient failures hourly, and blocks the retained queue on
a Facebook checkpoint, CAPTCHA, device approval, or 2FA request. It cannot and does
not bypass Facebook account security.

## Security model

- Facebook credentials are never placed in code, Git, Cloudflare, Make, or Supabase.
  They are mounted into the VM as root-readable Docker secret files.
- The GitHub Action keeps only an AES-256-GCM encrypted browser state in its cache.
  The Docker runtime keeps a profile on its encrypted persistent volume. When a
  normal login is needed, either runtime reads the configured secret files and
  signs in itself.
- `POSTER_SHARED_SECRET` authenticates `deals-engine` requests with HMAC-SHA256,
  a five-minute timestamp window, and a fixed Chiping-only payload contract.
- The Group URL is fixed in configuration and cannot be selected by a caller.
- The service processes one job at a time. A repeated delivery is deduplicated by
  `chiping-facebook:v1:{productId}`.
- It never logs out after posting. Repeated login/logout activity is more likely
  to trigger Facebook verification. A Facebook checkpoint or 2FA challenge
  blocks the queue and can alert `POSTER_ALERT_WEBHOOK_URL`; it does not attempt
  to bypass Facebook security checks.

## VM setup

Use a small always-on Linux VM with Docker and an encrypted persistent disk. Do
not expose the service port or VNC to the public internet.

```bash
cd facebook-group-poster
cp .env.example .env
# Set POSTER_SHARED_SECRET to a random 32+ character value.
```

### Automatic Facebook login

Create two secret files on the VM with mode `0600`, owned by the Docker
operator. Do not send either value through chat or add it to `.env`.

```bash
install -d -m 700 secrets
printf '%s' 'facebook-login-email' > secrets/facebook_login_email
printf '%s' 'facebook-login-password' > secrets/facebook_login_password
chmod 600 secrets/facebook_login_email secrets/facebook_login_password
cp docker-compose.secrets.example.yml docker-compose.secrets.yml
```

Set these non-secret file paths in `.env`:

```bash
FACEBOOK_LOGIN_EMAIL_SECRET_FILE=./secrets/facebook_login_email
FACEBOOK_LOGIN_PASSWORD_SECRET_FILE=./secrets/facebook_login_password
FACEBOOK_LOGIN_EMAIL_FILE=/run/secrets/facebook_login_email
FACEBOOK_LOGIN_PASSWORD_FILE=/run/secrets/facebook_login_password
```

Start the actual service:

```bash
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d facebook-group-poster
curl http://127.0.0.1:8788/health
```

Expose only `/v1/jobs` through an authenticated HTTPS reverse proxy or Cloudflare
Tunnel. Keep the service's Docker port bound to `127.0.0.1`; no public VNC port.

## Go live

1. Keep `POSTER_DRY_RUN=true` while checking service health.
2. Change it to `false` after the VM secret files are mounted, then restart the service.
3. Set these **deals-engine Worker secrets**:

```bash
wrangler secret put FACEBOOK_CHIPING_GROUP_POSTER_URL
wrangler secret put FACEBOOK_CHIPING_GROUP_POSTER_SECRET
wrangler secret put FACEBOOK_CHIPING_PUBLISHER
# Value: group_poster
wrangler secret put CHIPING_FACEBOOK_POSTING_ENABLED
# Value: true
```

The existing Make transport remains the default until
`FACEBOOK_CHIPING_PUBLISHER=group_poster` is explicitly set. The Worker treats a
`202 accepted` response as an outbox handoff. From that point the Group poster's
own persistent queue owns retries and duplicate prevention.

## Session recovery

If Facebook requests a normal login, the service uses its VM-mounted secret
files and continues automatically. If Facebook requests a checkpoint, CAPTCHA,
device approval, or 2FA, the current post becomes `blocked` and the service
stops processing later jobs. This cannot be safely bypassed; after the account
is cleared, send a signed empty request to `POST /v1/session/resume` to continue
the retained queue.

The browser service does not return, log, or persist the Facebook password. It
uses the mounted secret only when the Facebook login form is actually present.
