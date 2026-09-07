# Environment reference

Every variable the backend reads, grouped by concern. The authoritative schema is
[`src/config/env.validation.ts`](../src/config/env.validation.ts) (boot fails loudly
if a value is missing or malformed); the typed view is
[`src/config/configuration.ts`](../src/config/configuration.ts). Copy
[`.env.example`](../.env.example) to `.env` to start.

**Required (no default):** `MONGO_URI`, `MONGO_DB_NAME`, `JWT_ACCESS_SECRET` (≥32
chars), `JWT_REFRESH_SECRET` (≥32 chars, must differ from the access secret).
Driver-specific secrets (`SES_*`, `S3_*`, `SMS_HTTP_*`) become required only when
their driver is selected.

## App
| Var | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `staging` \| `production` |
| `PORT` | `3000` | |
| `API_PREFIX` | `api` | Routes are `/{prefix}/v1/...` |
| `CORS_ORIGINS` | `*` | Comma-separated allowlist. **Must not be `*` in production** (boot refuses). |
| `APP_URL` / `WEB_APP_URL` | localhost | Absolute bases for links |
| `LOG_LEVEL` | `info` | pino level |
| `SWAGGER_ENABLED` | `true` | Docs served only when true **and** not production |

## Data stores
| Var | Default | Notes |
|---|---|---|
| `MONGO_URI`, `MONGO_DB_NAME` | — | Required |
| `MONGO_MAX_POOL_SIZE` | `20` | Raise under load test |
| `MONGO_MIN_POOL_SIZE` | `2` | Warm sockets |
| `REDIS_HOST/PORT/PASSWORD/DB/TLS` | localhost:6379 db 0 | |
| `REDIS_KEY_PREFIX` | `wishtick:` | Isolate environments sharing one Redis |

## Auth & security
| Var | Default | Notes |
|---|---|---|
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | — | Required, ≥32, must differ |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `15m` / `30d` | `ms`-parseable |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `wishtick` / `wishtick-app` | |
| `ADMIN_JWT_AUDIENCE` | `wishtick-admin` | **Distinct** audience keeps user tokens off `/admin` |
| `ADMIN_JWT_ACCESS_SECRET` | (user secret) | Set a distinct value in production |
| `ADMIN_ACCESS_TTL_HOURS` | `2` | |
| `ADMIN_BOOTSTRAP_EMAIL` / `_PASSWORD` | — | Seeds the first super-admin on boot |
| `THROTTLE_TTL_SECONDS` / `THROTTLE_LIMIT` | `60` / `100` | Redis-backed global rate limit (the edge limiter) |
| `OTP_*`, `PASSWORD_RESET_TTL_SECONDS` | see example | |

## Retention & workers
| Var | Default | Notes |
|---|---|---|
| `ANALYTICS_RAW_TTL_DAYS` | `180` | TTL on raw events |
| `ANALYTICS_WORKER_CONCURRENCY` | `2` | Rollup worker |
| `NOTIF_RETENTION_DAYS` | `180` | TTL on in-app notifications |
| `NOTIF_WORKER_CONCURRENCY` | `4` | Dispatch worker (I/O-bound) |
| `REEL_WORKER_CONCURRENCY` | `1` | ffmpeg is CPU-heavy — keep small |
| `ACCOUNT_DELETION_GRACE_DAYS` | `30` | Soft-delete → anonymize window |

## Delivery, storage, products, gifting
See [`.env.example`](../.env.example) for the full annotated list —
`MAILER_DRIVER`/`SMS_DRIVER` (+ their `SES_*`/`SMS_HTTP_*` secrets),
`STORAGE_DRIVER` (+ `S3_*` or `LOCAL_STORAGE_DIR`), `PRODUCT_*`, `GIFT_WEBHOOK_*`,
and the group-gift bounds.

## SSRF-sensitive
`PRODUCT_URL_ALLOW_PRIVATE` disables the SSRF guard's address checks so tests can
fetch a loopback origin. **Boot refuses it in production** — it would let a pasted
link reach `169.254.169.254` and read the instance's cloud credentials.

## Observability
`SENTRY_DSN` — empty disables Sentry. Log redaction (auth headers, tokens,
passwords, OTP codes) is always on; see [`src/app.module.ts`](../src/app.module.ts).
