import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Loaded via jest `setupFiles`, so this runs before ConfigModule reads the
 * environment. Values mirror .env.example but with test-friendly limits.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SWAGGER_ENABLED = 'false';
process.env.PORT = '0';

// Overwritten per-suite by the in-memory server; ConfigModule only needs these
// to satisfy Joi at import time.
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017';
process.env.MONGO_DB_NAME ??= 'wishtick_test';

process.env.REDIS_HOST ??= 'localhost';
process.env.REDIS_PORT ??= '6379';
// Per worker, not per run. Mongo is already isolated (each suite gets its own
// in-memory replica set) but Redis is a single shared server, so one prefix
// meant parallel suites shared a keyspace — the product search cache, the
// provider rate-limit counters and the OTP store all collide under keys that
// carry no suite identity. Cross-talk there fails a test for something the
// other suite did.
process.env.REDIS_KEY_PREFIX = `wishtick-test-${process.env.JEST_WORKER_ID ?? '0'}:`;

process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-definitely-long-enough-1234';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-definitely-long-enough-5678';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL = '30d';

process.env.OTP_LENGTH = '4';
process.env.OTP_TTL_SECONDS = '600';
process.env.OTP_MAX_ATTEMPTS = '5';
// Zero by default so tests can request codes back-to-back; the cooldown suite
// re-enables it explicitly.
process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
process.env.PASSWORD_RESET_TTL_SECONDS = '1800';

process.env.THROTTLE_TTL_SECONDS = '60';
process.env.THROTTLE_LIMIT = '1000';

// Storage: the local driver writes real files, so point it at an isolated temp
// directory per run rather than the repo's ./uploads.
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = path.join(os.tmpdir(), `wishtick-test-uploads-${process.pid}`);
process.env.STORAGE_SIGNING_SECRET = 'test-storage-signing-secret';
process.env.MEDIA_URL_TTL_SECONDS = '900';
process.env.MEDIA_MAX_BYTES = String(10 * 1024 * 1024);

// The upload URL is absolute, so the local driver needs a base that matches the
// supertest server. Tests never fetch it over the network — they PUT to the
// path via supertest — but the value must parse.
process.env.APP_URL = 'http://127.0.0.1:3000';

process.env.ACCOUNT_DELETION_GRACE_DAYS = '30';

// Gifting: a known webhook secret so the auto-tick tests can sign requests, and
// a short reservation TTL so expiry is testable without waiting 72 hours.
process.env.RESERVATION_TTL_HOURS = '72';
process.env.GIFT_WEBHOOK_SECRETS = JSON.stringify({ testprovider: 'test-webhook-secret-123' });
process.env.GIFT_WEBHOOK_TOLERANCE_SECONDS = '300';

// Notifications: console drivers (the FakeMailer/FakeSmsSender stand in), a known
// bounce-webhook secret, and quiet hours OFF by default so a test that wants to
// exercise deferral turns them on explicitly via the preferences endpoint.
process.env.MAILER_DRIVER = 'console';
process.env.SMS_DRIVER = 'console';
process.env.NOTIF_BOUNCE_WEBHOOK_SECRET = 'test-bounce-secret';
process.env.THANK_YOU_DELAY_HOURS = '24';

// Reels: scratch space under the repo (which lives on the big disk) rather than
// the OS temp dir, and moderation off so wishes auto-approve — the moderation
// gate is exercised by explicitly rejecting a wish instead.
process.env.REEL_TEMP_DIR = path.join(process.cwd(), `.reels-tmp-test-${process.pid}`);
process.env.REEL_MODERATION_ENABLED = 'false';
// Tightened from the 60s/90s defaults so the duration cap is testable against a
// clip that takes a moment to encode, not a minute.
process.env.REEL_MAX_AUDIO_SECONDS = '5';
process.env.REEL_MAX_VIDEO_SECONDS = '8';

// Products: the fixture catalogue, with the guard knobs tightened so tests can
// exercise timeouts and the breaker without waiting seconds.
process.env.PRODUCT_PROVIDER = 'fixture';
process.env.PRODUCT_TIMEOUT_MS = '300';
process.env.PRODUCT_MAX_RETRIES = '1';
process.env.PRODUCT_RETRY_BASE_DELAY_MS = '10';
process.env.PRODUCT_RATE_LIMIT_PER_MINUTE = '10000';
process.env.PRODUCT_BREAKER_FAILURE_THRESHOLD = '3';
process.env.PRODUCT_BREAKER_RESET_MS = '1000';
process.env.PRODUCT_CACHE_TTL_SECONDS = '900';
process.env.PRODUCT_STALE_TTL_SECONDS = '86400';
// The URL-resolver tests run a real origin server on loopback, which the SSRF
// guard blocks by design. Joi refuses this flag in production.
process.env.PRODUCT_URL_ALLOW_PRIVATE = 'true';
process.env.PRODUCT_URL_FETCH_TIMEOUT_MS = '2000';

// Affiliate network on, with a fake key: the suite stubs `fetch`, so no request
// ever leaves the process. Enabled by default so the monetization path is
// exercised by every products test rather than only the affiliate one.
process.env.AFFILIATE_NETWORK = 'cuelinks';
process.env.CUELINKS_API_KEY = 'test-cuelinks-key';
process.env.CUELINKS_BASE_URL = 'https://cuelinks.test/pub_api/v3';

// Admin panel: its own audience so a user token can never authenticate on
// /admin, and a bootstrap super-admin seeded at boot so tests have an operator
// to log in as. TOTP is off for that seed (first login is password-only), which
// is exactly the enrolment path the 2FA tests then drive.
process.env.ADMIN_JWT_AUDIENCE = 'wishtick-admin';
process.env.ADMIN_JWT_ACCESS_SECRET = 'test-admin-access-secret-that-is-long-enough-abcd';
process.env.ADMIN_ACCESS_TTL_HOURS = '2';
process.env.ADMIN_BOOTSTRAP_EMAIL = 'root@wishtick.test';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'RootAdminPassw0rd!';

// Analytics: a short raw-event TTL and cache window so a rollup/overview test
// need not wait on the production defaults.
process.env.ANALYTICS_RAW_TTL_DAYS = '180';
process.env.ANALYTICS_CACHE_TTL_SECONDS = '5';

export {};
