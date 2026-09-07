import * as Joi from 'joi';

/**
 * Boot fails loudly here rather than 200-ing with a broken dependency later.
 * Every var read anywhere in the app must appear in this schema.
 */
export const envValidationSchema = Joi.object({
  // App
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  API_PREFIX: Joi.string().default('api'),
  CORS_ORIGINS: Joi.string().default('*'),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  WEB_APP_URL: Joi.string().uri().default('http://localhost:5173'),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),
  SWAGGER_ENABLED: Joi.boolean().default(true),

  // Mongo
  MONGO_URI: Joi.string().required(),
  MONGO_DB_NAME: Joi.string().required(),
  // Connection-pool bounds — raised under load test; min keeps warm sockets ready.
  MONGO_MAX_POOL_SIZE: Joi.number().integer().min(1).max(500).default(20),
  MONGO_MIN_POOL_SIZE: Joi.number().integer().min(0).max(100).default(2),

  // Redis
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().min(0).default(0),
  REDIS_TLS: Joi.boolean().default(false),
  REDIS_KEY_PREFIX: Joi.string().default('wishtick:'),

  // JWT — short secrets are a real vulnerability, so the floor is enforced.
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  // Must be a `ms`-parseable duration. Without this pattern a typo like "15mm"
  // boots fine and only explodes at the first login attempt.
  JWT_ACCESS_TTL: Joi.string()
    .pattern(/^\d+(ms|s|m|h|d|w|y)$/)
    .default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_TTL: Joi.string()
    .pattern(/^\d+(ms|s|m|h|d|w|y)$/)
    .default('30d'),
  JWT_ISSUER: Joi.string().default('wishtick'),
  JWT_AUDIENCE: Joi.string().default('wishtick-app'),

  // OTP / password reset
  OTP_LENGTH: Joi.number().min(4).max(8).default(4),
  OTP_TTL_SECONDS: Joi.number().min(60).default(600),
  OTP_MAX_ATTEMPTS: Joi.number().min(1).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: Joi.number().min(0).default(60),
  PASSWORD_RESET_TTL_SECONDS: Joi.number().min(60).default(1800),

  // Throttling
  THROTTLE_TTL_SECONDS: Joi.number().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().min(1).default(100),

  // Delivery
  MAILER_DRIVER: Joi.string().valid('console', 'ses').default('console'),
  SMS_DRIVER: Joi.string().valid('console', 'http').default('console'),
  MAIL_FROM: Joi.string().default('Wishtick <no-reply@wishtick.app>'),
  // SES creds required only when MAILER_DRIVER=ses, mirroring the S3 precedent.
  SES_REGION: Joi.string().allow('').default(''),
  SES_ACCESS_KEY_ID: Joi.string().when('MAILER_DRIVER', {
    is: 'ses',
    then: Joi.required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  SES_SECRET_ACCESS_KEY: Joi.string().when('MAILER_DRIVER', {
    is: 'ses',
    then: Joi.required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  SES_CONFIGURATION_SET: Joi.string().allow('').default(''),
  // HTTP SMS gateway required only when SMS_DRIVER=http.
  SMS_HTTP_ENDPOINT: Joi.string().when('SMS_DRIVER', {
    is: 'http',
    then: Joi.required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  SMS_HTTP_AUTH_TOKEN: Joi.string().allow('').default(''),
  SMS_SENDER_ID: Joi.string().default('WISHTK'),

  // Push. Firebase creds required only when PUSH_DRIVER=fcm, mirroring SES.
  // Until then the console driver no-ops and the other channels are unaffected.
  PUSH_DRIVER: Joi.string().valid('console', 'fcm').default('console'),
  FIREBASE_PROJECT_ID: Joi.string().when('PUSH_DRIVER', {
    is: 'fcm',
    then: Joi.required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  FIREBASE_CLIENT_EMAIL: Joi.string().when('PUSH_DRIVER', {
    is: 'fcm',
    then: Joi.required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  FIREBASE_PRIVATE_KEY: Joi.string().when('PUSH_DRIVER', {
    is: 'fcm',
    then: Joi.required(),
    otherwise: Joi.string().allow('').default(''),
  }),

  // Notifications
  NOTIF_QUIET_HOURS_START: Joi.number().integer().min(0).max(23).default(22),
  NOTIF_QUIET_HOURS_END: Joi.number().integer().min(0).max(23).default(8),
  NOTIF_DIGEST_HOUR: Joi.number().integer().min(0).max(23).default(9),
  NOTIF_UNSUBSCRIBE_SECRET: Joi.string().allow('').default(''),
  THANK_YOU_DELAY_HOURS: Joi.number().min(0).max(168).default(24),
  NOTIF_BOUNCE_WEBHOOK_SECRET: Joi.string().allow('').default(''),
  /** In-app notifications older than this are dropped by a TTL index. */
  NOTIF_RETENTION_DAYS: Joi.number().integer().min(1).max(730).default(180),
  NOTIF_WORKER_CONCURRENCY: Joi.number().integer().min(1).max(32).default(4),

  // Reels
  REEL_MAX_AUDIO_SECONDS: Joi.number().integer().min(1).max(600).default(60),
  REEL_MAX_VIDEO_SECONDS: Joi.number().integer().min(1).max(600).default(90),
  REEL_FFMPEG_TIMEOUT_MS: Joi.number().integer().min(1_000).default(120_000),
  REEL_WORKER_CONCURRENCY: Joi.number().integer().min(1).max(8).default(1),
  REEL_MODERATION_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  REEL_TEMP_DIR: Joi.string().default('./.reels-tmp'),
  REEL_WATERMARK: Joi.string().default('Wishtick'),

  // Admin panel
  ADMIN_JWT_AUDIENCE: Joi.string().default('wishtick-admin'),
  ADMIN_JWT_ACCESS_SECRET: Joi.string().allow('').default(''),
  ADMIN_ACCESS_TTL_HOURS: Joi.number().min(1).max(24).default(2),
  ADMIN_BOOTSTRAP_EMAIL: Joi.string().allow('').default(''),
  ADMIN_BOOTSTRAP_PASSWORD: Joi.string().allow('').default(''),

  // Analytics
  ANALYTICS_RAW_TTL_DAYS: Joi.number().integer().min(1).max(730).default(180),
  ANALYTICS_CACHE_TTL_SECONDS: Joi.number().integer().min(0).max(3600).default(300),
  ANALYTICS_WORKER_CONCURRENCY: Joi.number().integer().min(1).max(16).default(2),

  // Storage / media
  STORAGE_DRIVER: Joi.string().valid('local', 's3').default('local'),
  // Required only for the s3 driver — a local-driver dev box must not be forced
  // to invent AWS credentials, but an s3 deploy must not boot half-configured.
  S3_BUCKET: Joi.string().when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  S3_REGION: Joi.string().when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.string().allow('').default(''),
  }),
  S3_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  S3_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  /** Set for S3-compatible services (R2, MinIO, DigitalOcean Spaces). */
  S3_ENDPOINT: Joi.string().allow('').default(''),
  S3_FORCE_PATH_STYLE: Joi.boolean().default(false),
  /** Public read base (CDN) for objects; falls back to the S3 URL. */
  S3_PUBLIC_BASE_URL: Joi.string().allow('').default(''),
  /** Leave false on any non-AWS endpoint — see configuration.ts. */
  S3_REQUEST_CHECKSUMS: Joi.boolean().default(false),
  LOCAL_STORAGE_DIR: Joi.string().default('./uploads'),

  // Video. 'storage' keeps clips as flat files, which is right for local dev
  // and wrong for anyone on mobile data.
  VIDEO_DRIVER: Joi.string().valid('storage', 'bunny_stream').default('storage'),
  ...(() => {
    const requiredForStream = Joi.string().when('VIDEO_DRIVER', {
      is: 'bunny_stream',
      then: Joi.required(),
      otherwise: Joi.string().allow('').default(''),
    });
    return {
      BUNNY_STREAM_LIBRARY_ID: requiredForStream,
      BUNNY_STREAM_API_KEY: requiredForStream,
      BUNNY_STREAM_TOKEN_KEY: requiredForStream,
      BUNNY_STREAM_CDN_HOSTNAME: requiredForStream,
    };
  })(),
  BUNNY_STREAM_TOKEN_TTL_SECONDS: Joi.number().default(14400),
  /** Signed upload/download URLs are short-lived by design. */
  MEDIA_URL_TTL_SECONDS: Joi.number().min(60).default(900),
  MEDIA_MAX_BYTES: Joi.number()
    .min(1024)
    .default(10 * 1024 * 1024),

  // Account lifecycle
  ACCOUNT_DELETION_GRACE_DAYS: Joi.number().min(0).max(90).default(30),

  // ─── Gifting ────────────────────────────────────────────────────────────
  /** Default reservation lifetime; per-wishlist override lands in a later sprint. */
  RESERVATION_TTL_HOURS: Joi.number().min(1).max(720).default(72),
  /** Warn the gifter this long before a reservation lapses. */
  RESERVATION_WARN_HOURS: Joi.number().min(0).max(240).default(12),
  /**
   * Per-provider webhook signing secrets, as a JSON object
   * `{"provider":"secret"}`. Empty means no webhook provider is configured,
   * and every webhook is rejected — fail closed.
   */
  GIFT_WEBHOOK_SECRETS: Joi.string().allow('').default(''),
  /** A webhook older than this (clock-skew + delivery latency) is rejected. */
  GIFT_WEBHOOK_TOLERANCE_SECONDS: Joi.number().min(30).max(3600).default(300),

  // ─── Group gifting ──────────────────────────────────────────────────────
  /** Smallest contribution, in minor units (default 100 = ₹1). Blocks dust pledges. */
  GROUP_GIFT_MIN_CONTRIBUTION_MINOR: Joi.number().integer().min(1).default(100),
  /** Sanity ceiling on a group-gift target, in minor units (default ₹1,000,000). */
  GROUP_GIFT_MAX_TARGET_MINOR: Joi.number().integer().min(1).default(100_000_000),

  // ─── Products / affiliate ───────────────────────────────────────────────
  // 'fixture' is an in-memory catalogue for dev and tests; 'serpapi' is the
  // real catalogue, reading Google Shopping through SerpApi.
  PRODUCT_PROVIDER: Joi.string().valid('fixture', 'serpapi').default('fixture'),
  SERPAPI_KEY: Joi.string().allow('').default(''),
  /**
   * SerpApi locale. Defaults target India, which is the only market Wishtick
   * prices in — everything downstream assumes INR minor units.
   */
  SERPAPI_COUNTRY: Joi.string().default('in'),
  SERPAPI_LANGUAGE: Joi.string().default('en'),
  SERPAPI_GOOGLE_DOMAIN: Joi.string().default('google.co.in'),

  // The network that turns a merchant URL into a paid link. 'none' means every
  // outbound click goes to the plain merchant URL and earns nothing — a valid
  // state, and the one dev runs in.
  AFFILIATE_NETWORK: Joi.string().valid('none', 'cuelinks').default('none'),
  CUELINKS_API_KEY: Joi.string().allow('').default(''),
  CUELINKS_BASE_URL: Joi.string().uri().default('https://developers.cuelinks.com/pub_api/v3'),

  PRODUCT_TIMEOUT_MS: Joi.number().min(100).default(4_000),
  PRODUCT_MAX_RETRIES: Joi.number().min(0).max(5).default(2),
  PRODUCT_RETRY_BASE_DELAY_MS: Joi.number().min(10).default(150),
  /** Shared across instances — the vendor's quota is per-account, not per-pod. */
  PRODUCT_RATE_LIMIT_PER_MINUTE: Joi.number().min(0).default(600),
  PRODUCT_BREAKER_FAILURE_THRESHOLD: Joi.number().min(1).default(5),
  PRODUCT_BREAKER_RESET_MS: Joi.number().min(1_000).default(30_000),
  /** How long a search result counts as fresh. */
  PRODUCT_CACHE_TTL_SECONDS: Joi.number().min(0).default(900),
  /**
   * How long a stale result may still be served when the provider is down.
   * Much longer than the fresh window: an old price beats a broken page.
   */
  PRODUCT_STALE_TTL_SECONDS: Joi.number().min(0).default(86_400),

  // URL resolution (SSRF-sensitive — see SsrfGuard)
  PRODUCT_URL_FETCH_TIMEOUT_MS: Joi.number().min(100).default(5_000),
  PRODUCT_URL_MAX_BYTES: Joi.number()
    .min(1_024)
    .default(512 * 1024),
  PRODUCT_URL_MAX_REDIRECTS: Joi.number().min(0).max(10).default(3),
  /**
   * Allows fetching private/loopback addresses. Tests need it to run a local
   * origin server; it must never be true anywhere else.
   */
  PRODUCT_URL_ALLOW_PRIVATE: Joi.boolean().default(false),

  // Local secret signing the local-driver upload URLs. Defaults off the JWT
  // secret so dev works with no extra setup; s3 deploys never use it.
  STORAGE_SIGNING_SECRET: Joi.string().allow('').default(''),

  // Observability
  SENTRY_DSN: Joi.string().allow('').default(''),
})
  // The two JWT secrets must differ, otherwise a refresh token would validate
  // as an access token and silently bypass the 15-minute access window.
  .custom((value: Record<string, unknown>, helpers) => {
    if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
      return helpers.message({
        custom: 'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values',
      });
    }
    return value;
  })
  .custom((value: Record<string, unknown>, helpers) => {
    if (value.NODE_ENV === 'production' && value.CORS_ORIGINS === '*') {
      return helpers.message({ custom: 'CORS_ORIGINS must not be "*" in production' });
    }
    return value;
  })
  // PRODUCT_URL_ALLOW_PRIVATE disables the SSRF guard's address checks. It
  // exists so tests can fetch a loopback origin; in production it would let
  // anyone paste a link pointing at 169.254.169.254 and have the server read
  // its own cloud credentials. Refuse to boot rather than trust a checklist.
  .custom((value: Record<string, unknown>, helpers) => {
    if (value.NODE_ENV === 'production' && value.PRODUCT_URL_ALLOW_PRIVATE === true) {
      return helpers.message({
        custom: 'PRODUCT_URL_ALLOW_PRIVATE must never be true in production (SSRF)',
      });
    }
    return value;
  })
  // Selecting a vendor without its key would boot fine and then fail on every
  // call — an outage that looks like an empty catalogue. Refuse the boot
  // instead, the same reasoning as the fixture-in-production guard.
  .custom((value: Record<string, unknown>, helpers) => {
    if (value.PRODUCT_PROVIDER === 'serpapi' && !value.SERPAPI_KEY) {
      return helpers.message({ custom: 'PRODUCT_PROVIDER=serpapi requires SERPAPI_KEY' });
    }
    if (value.AFFILIATE_NETWORK === 'cuelinks' && !value.CUELINKS_API_KEY) {
      return helpers.message({ custom: 'AFFILIATE_NETWORK=cuelinks requires CUELINKS_API_KEY' });
    }
    return value;
  });
