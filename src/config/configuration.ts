/**
 * Typed view over the validated environment. Nothing outside this file reads
 * `process.env` — every consumer goes through ConfigService<AppConfig, true>.
 */
export interface AppConfig {
  app: {
    env: 'development' | 'test' | 'staging' | 'production';
    port: number;
    apiPrefix: string;
    corsOrigins: string[];
    appUrl: string;
    webAppUrl: string;
    logLevel: string;
    swaggerEnabled: boolean;
    isProduction: boolean;
  };
  mongo: {
    uri: string;
    dbName: string;
    /** Connection-pool bounds — tuned per environment under load test. */
    maxPoolSize: number;
    minPoolSize: number;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
    tls: boolean;
    keyPrefix: string;
  };
  jwt: {
    accessSecret: string;
    accessTtl: string;
    refreshSecret: string;
    refreshTtl: string;
    issuer: string;
    audience: string;
  };
  admin: {
    /** A DISTINCT JWT audience so a user token can never validate on /admin. */
    jwtAudience: string;
    accessSecret: string;
    accessTtlHours: number;
    /** Seeds the first super-admin on boot when no admin exists yet. */
    bootstrapEmail: string;
    bootstrapPassword: string;
  };
  analytics: {
    /** Raw AnalyticsEvent retention (TTL), in days. */
    rawTtlDays: number;
    /** Analytics dashboard cache, in seconds. */
    cacheTtlSeconds: number;
    /** How many rollup jobs the worker runs at once. */
    workerConcurrency: number;
  };
  otp: {
    length: number;
    ttlSeconds: number;
    maxAttempts: number;
    resendCooldownSeconds: number;
  };
  passwordReset: {
    ttlSeconds: number;
  };
  throttle: {
    ttlSeconds: number;
    limit: number;
  };
  delivery: {
    mailerDriver: 'console' | 'ses';
    smsDriver: 'console' | 'http';
    pushDriver: 'console' | 'fcm';
    mailFrom: string;
    ses: {
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      configurationSet: string;
    };
    sms: {
      /** Generic HTTP SMS gateway (MSG91/Twilio-style). POST {to, body} with an auth header. */
      endpoint: string;
      authToken: string;
      senderId: string;
    };
    /** Firebase service account, for FCM HTTP v1. Empty until push is set up. */
    fcm: {
      projectId: string;
      clientEmail: string;
      /** PEM with `
` escapes, as an env var must store it. */
      privateKey: string;
    };
  };
  notifications: {
    /** Local-time hours [start, end) during which non-critical sends are deferred. */
    quietHoursStart: number;
    quietHoursEnd: number;
    /** Hour (local) the daily digest is sent. */
    digestHour: number;
    /** Signs unsubscribe tokens; defaults to the access secret in dev. */
    unsubscribeSecret: string;
    /** How long after a gift is fulfilled the thank-you note auto-sends, in hours. */
    thankYouDelayHours: number;
    /** Signs the bounce/complaint webhook. Empty = webhook rejected (fail closed). */
    bounceWebhookSecret: string;
    /** In-app notification retention (TTL), in days. */
    retentionDays: number;
    /** How many dispatch jobs the worker runs at once. */
    workerConcurrency: number;
  };
  reels: {
    /** Server-enforced caps re-checked by ffprobe at submit time. */
    maxAudioDurationMs: number;
    maxVideoDurationMs: number;
    /** Hard timeout on each ffmpeg/ffprobe child process. */
    ffmpegTimeoutMs: number;
    /** How many reels compile at once — ffmpeg is CPU-heavy, so small. */
    workerConcurrency: number;
    /** When off, every wish is auto-approved and enters the compile. */
    moderationEnabled: boolean;
    /** Base directory for render scratch space; cleaned on every exit path. */
    tempDir: string;
    /** Watermark caption burned into the reel. */
    watermark: string;
  };
  storage: {
    driver: 'local' | 's3';
    signingSecret: string;
    urlTtlSeconds: number;
    maxBytes: number;
    localDir: string;
    s3: {
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      endpoint: string;
      forcePathStyle: boolean;
      publicBaseUrl: string;
      /**
       * Whether the SDK may add its own CRC32 checksum headers to requests.
       *
       * Off for every S3-compatible provider: since ~3.729 the SDK folds
       * `x-amz-checksum-*` into the signature, and a phone PUTting to a
       * presigned URL never sends them, so the signature cannot match.
       */
      requestChecksums: boolean;
    };
  };
  /**
   * Where video lives. Images and audio always go to `storage` — an image is
   * usable the moment its bytes land, and a voice note streams fine as a plain
   * file over a CDN that honours range requests. Video does not: a 50 MB phone
   * clip served flat cannot adapt its bitrate, so it stalls on mobile.
   */
  video: {
    driver: 'storage' | 'bunny_stream';
    bunny: {
      libraryId: string;
      apiKey: string;
      /** Signs playback URLs. Distinct from apiKey, and the weaker of the two. */
      tokenKey: string;
      cdnHostname: string;
      tokenTtlSeconds: number;
    };
  };
  account: {
    deletionGraceDays: number;
  };
  gifting: {
    reservationTtlHours: number;
    reservationWarnHours: number;
    /** provider → signing secret. */
    webhookSecrets: Record<string, string>;
    webhookToleranceSeconds: number;
  };
  orders: {
    /**
     * courier → signing secret. Empty until a logistics contract exists, which
     * makes every courier webhook 404 rather than be silently trusted.
     */
    courierWebhookSecrets: Record<string, string>;
    courierWebhookToleranceSeconds: number;
  };
  groupGifting: {
    /** Smallest allowed contribution, in minor units. Stops zero/dust pledges. */
    minContributionMinor: number;
    /** Largest allowed target, in minor units. A sanity ceiling, not a business rule. */
    maxTargetMinor: number;
  };
  products: {
    provider: 'fixture' | 'serpapi';
    /** SerpApi private key. Empty unless `provider` is `serpapi`. */
    serpApiKey: string;
    /** SerpApi locale — `gl`, `hl`, `google_domain`. Defaults target India. */
    serpApiCountry: string;
    serpApiLanguage: string;
    serpApiDomain: string;
    timeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    rateLimitPerMinute: number;
    breakerFailureThreshold: number;
    breakerResetMs: number;
    cacheTtlSeconds: number;
    staleTtlSeconds: number;
    prewarmEnabled: boolean;
    prewarmCron: string;
    urlFetchTimeoutMs: number;
    urlMaxBytes: number;
    urlMaxRedirects: number;
    urlAllowPrivate: boolean;
  };
  /**
   * The affiliate network that monetizes an outbound click.
   *
   * Separate from `products` because it is a different vendor with its own key:
   * the catalogue tells us *what* a product is, the network tells us *how to get
   * paid* for sending someone to it. Either can be swapped without the other.
   */
  affiliate: {
    network: 'none' | 'cuelinks';
    cuelinksApiKey: string;
    cuelinksBaseUrl: string;
  };
  observability: {
    sentryDsn: string;
  };
}

const toBool = (v: string | undefined, fallback = false): boolean =>
  v === undefined || v === '' ? fallback : v === 'true' || v === '1';

const toInt = (v: string | undefined, fallback: number): number =>
  v === undefined || v === '' ? fallback : Number.parseInt(v, 10);

/**
 * Parses a `{"k":"v"}` env string into a string map. A malformed value returns
 * `{}` rather than throwing, so one bad secret does not brick the boot — the
 * effect is "no webhook providers configured", which fails closed.
 */
const parseJsonRecord = (v: string | undefined): Record<string, string> => {
  if (!v) return {};
  try {
    const parsed: unknown = JSON.parse(v);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, val]) => typeof val === 'string')
          .map(([k, val]) => [k, val as string]),
      );
    }
  } catch {
    // fall through to empty
  }
  return {};
};

export const configuration = (): AppConfig => {
  const env = (process.env.NODE_ENV ?? 'development') as AppConfig['app']['env'];

  return {
    app: {
      env,
      port: toInt(process.env.PORT, 3000),
      apiPrefix: process.env.API_PREFIX ?? 'api',
      corsOrigins: (process.env.CORS_ORIGINS ?? '*')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      appUrl: process.env.APP_URL ?? 'http://localhost:3000',
      webAppUrl: process.env.WEB_APP_URL ?? 'http://localhost:5173',
      logLevel: process.env.LOG_LEVEL ?? 'info',
      swaggerEnabled: toBool(process.env.SWAGGER_ENABLED, true),
      isProduction: env === 'production',
    },
    mongo: {
      uri: process.env.MONGO_URI as string,
      dbName: process.env.MONGO_DB_NAME as string,
      maxPoolSize: toInt(process.env.MONGO_MAX_POOL_SIZE, 20),
      minPoolSize: toInt(process.env.MONGO_MIN_POOL_SIZE, 2),
    },
    redis: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: toInt(process.env.REDIS_PORT, 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: toInt(process.env.REDIS_DB, 0),
      tls: toBool(process.env.REDIS_TLS, false),
      keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'wishtick:',
    },
    jwt: {
      accessSecret: process.env.JWT_ACCESS_SECRET as string,
      accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
      refreshSecret: process.env.JWT_REFRESH_SECRET as string,
      refreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
      issuer: process.env.JWT_ISSUER ?? 'wishtick',
      audience: process.env.JWT_AUDIENCE ?? 'wishtick-app',
    },
    admin: {
      jwtAudience: process.env.ADMIN_JWT_AUDIENCE ?? 'wishtick-admin',
      // Distinct secret is best practice; defaults to the user secret in dev, but
      // the DISTINCT AUDIENCE is what actually keeps user tokens off /admin.
      accessSecret:
        process.env.ADMIN_JWT_ACCESS_SECRET || (process.env.JWT_ACCESS_SECRET as string),
      accessTtlHours: toInt(process.env.ADMIN_ACCESS_TTL_HOURS, 2),
      bootstrapEmail: process.env.ADMIN_BOOTSTRAP_EMAIL ?? '',
      bootstrapPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD ?? '',
    },
    analytics: {
      rawTtlDays: toInt(process.env.ANALYTICS_RAW_TTL_DAYS, 180),
      cacheTtlSeconds: toInt(process.env.ANALYTICS_CACHE_TTL_SECONDS, 300),
      workerConcurrency: toInt(process.env.ANALYTICS_WORKER_CONCURRENCY, 2),
    },
    otp: {
      length: toInt(process.env.OTP_LENGTH, 4),
      ttlSeconds: toInt(process.env.OTP_TTL_SECONDS, 600),
      maxAttempts: toInt(process.env.OTP_MAX_ATTEMPTS, 5),
      resendCooldownSeconds: toInt(process.env.OTP_RESEND_COOLDOWN_SECONDS, 60),
    },
    passwordReset: {
      ttlSeconds: toInt(process.env.PASSWORD_RESET_TTL_SECONDS, 1800),
    },
    throttle: {
      ttlSeconds: toInt(process.env.THROTTLE_TTL_SECONDS, 60),
      limit: toInt(process.env.THROTTLE_LIMIT, 100),
    },
    delivery: {
      mailerDriver: (process.env.MAILER_DRIVER ?? 'console') as 'console' | 'ses',
      smsDriver: (process.env.SMS_DRIVER ?? 'console') as 'console' | 'http',
      pushDriver: (process.env.PUSH_DRIVER ?? 'console') as 'console' | 'fcm',
      mailFrom: process.env.MAIL_FROM ?? 'Wishtick <no-reply@wishtick.app>',
      ses: {
        region: process.env.SES_REGION ?? process.env.S3_REGION ?? '',
        accessKeyId: process.env.SES_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.SES_SECRET_ACCESS_KEY ?? '',
        configurationSet: process.env.SES_CONFIGURATION_SET ?? '',
      },
      sms: {
        endpoint: process.env.SMS_HTTP_ENDPOINT ?? '',
        authToken: process.env.SMS_HTTP_AUTH_TOKEN ?? '',
        senderId: process.env.SMS_SENDER_ID ?? 'WISHTK',
      },
      fcm: {
        projectId: process.env.FIREBASE_PROJECT_ID ?? '',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
        privateKey: process.env.FIREBASE_PRIVATE_KEY ?? '',
      },
    },
    notifications: {
      quietHoursStart: toInt(process.env.NOTIF_QUIET_HOURS_START, 22),
      quietHoursEnd: toInt(process.env.NOTIF_QUIET_HOURS_END, 8),
      digestHour: toInt(process.env.NOTIF_DIGEST_HOUR, 9),
      unsubscribeSecret:
        process.env.NOTIF_UNSUBSCRIBE_SECRET || (process.env.JWT_ACCESS_SECRET as string),
      thankYouDelayHours: toInt(process.env.THANK_YOU_DELAY_HOURS, 24),
      bounceWebhookSecret: process.env.NOTIF_BOUNCE_WEBHOOK_SECRET ?? '',
      retentionDays: toInt(process.env.NOTIF_RETENTION_DAYS, 180),
      workerConcurrency: toInt(process.env.NOTIF_WORKER_CONCURRENCY, 4),
    },
    reels: {
      maxAudioDurationMs: toInt(process.env.REEL_MAX_AUDIO_SECONDS, 60) * 1_000,
      maxVideoDurationMs: toInt(process.env.REEL_MAX_VIDEO_SECONDS, 90) * 1_000,
      ffmpegTimeoutMs: toInt(process.env.REEL_FFMPEG_TIMEOUT_MS, 120_000),
      workerConcurrency: toInt(process.env.REEL_WORKER_CONCURRENCY, 1),
      moderationEnabled: toBool(process.env.REEL_MODERATION_ENABLED, false),
      tempDir: process.env.REEL_TEMP_DIR ?? './.reels-tmp',
      watermark: process.env.REEL_WATERMARK ?? 'Wishtick',
    },
    storage: {
      driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
      // Falls back to the access secret so a dev box needs no extra setup. The
      // local driver is dev-only, so this never signs anything in production.
      signingSecret:
        process.env.STORAGE_SIGNING_SECRET || (process.env.JWT_ACCESS_SECRET as string),
      urlTtlSeconds: toInt(process.env.MEDIA_URL_TTL_SECONDS, 900),
      maxBytes: toInt(process.env.MEDIA_MAX_BYTES, 10 * 1024 * 1024),
      localDir: process.env.LOCAL_STORAGE_DIR ?? './uploads',
      s3: {
        bucket: process.env.S3_BUCKET ?? '',
        region: process.env.S3_REGION ?? '',
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
        endpoint: process.env.S3_ENDPOINT ?? '',
        forcePathStyle: toBool(process.env.S3_FORCE_PATH_STYLE, false),
        publicBaseUrl: process.env.S3_PUBLIC_BASE_URL ?? '',
        requestChecksums: toBool(process.env.S3_REQUEST_CHECKSUMS, false),
      },
    },
    video: {
      driver: (process.env.VIDEO_DRIVER ?? 'storage') as 'storage' | 'bunny_stream',
      bunny: {
        libraryId: process.env.BUNNY_STREAM_LIBRARY_ID ?? '',
        apiKey: process.env.BUNNY_STREAM_API_KEY ?? '',
        tokenKey: process.env.BUNNY_STREAM_TOKEN_KEY ?? '',
        cdnHostname: process.env.BUNNY_STREAM_CDN_HOSTNAME ?? '',
        tokenTtlSeconds: toInt(process.env.BUNNY_STREAM_TOKEN_TTL_SECONDS, 14_400),
      },
    },
    account: {
      deletionGraceDays: toInt(process.env.ACCOUNT_DELETION_GRACE_DAYS, 30),
    },
    gifting: {
      reservationTtlHours: toInt(process.env.RESERVATION_TTL_HOURS, 72),
      reservationWarnHours: toInt(process.env.RESERVATION_WARN_HOURS, 12),
      webhookSecrets: parseJsonRecord(process.env.GIFT_WEBHOOK_SECRETS),
      webhookToleranceSeconds: toInt(process.env.GIFT_WEBHOOK_TOLERANCE_SECONDS, 300),
    },
    orders: {
      courierWebhookSecrets: parseJsonRecord(process.env.COURIER_WEBHOOK_SECRETS),
      courierWebhookToleranceSeconds: toInt(process.env.COURIER_WEBHOOK_TOLERANCE_SECONDS, 300),
    },
    groupGifting: {
      minContributionMinor: toInt(process.env.GROUP_GIFT_MIN_CONTRIBUTION_MINOR, 100),
      maxTargetMinor: toInt(process.env.GROUP_GIFT_MAX_TARGET_MINOR, 100_000_000),
    },
    products: {
      provider: (process.env.PRODUCT_PROVIDER ?? 'fixture') as 'fixture' | 'serpapi',
      serpApiKey: process.env.SERPAPI_KEY ?? '',
      serpApiCountry: process.env.SERPAPI_COUNTRY ?? 'in',
      serpApiLanguage: process.env.SERPAPI_LANGUAGE ?? 'en',
      serpApiDomain: process.env.SERPAPI_GOOGLE_DOMAIN ?? 'google.co.in',
      timeoutMs: toInt(process.env.PRODUCT_TIMEOUT_MS, 4_000),
      maxRetries: toInt(process.env.PRODUCT_MAX_RETRIES, 2),
      retryBaseDelayMs: toInt(process.env.PRODUCT_RETRY_BASE_DELAY_MS, 150),
      rateLimitPerMinute: toInt(process.env.PRODUCT_RATE_LIMIT_PER_MINUTE, 600),
      breakerFailureThreshold: toInt(process.env.PRODUCT_BREAKER_FAILURE_THRESHOLD, 5),
      breakerResetMs: toInt(process.env.PRODUCT_BREAKER_RESET_MS, 30_000),
      // 6h, not the 15m this started at. A search is a live scrape upstream
      // and costs seconds; freshness here buys price accuracy, which the
      // import re-checks anyway before anyone is charged. Trading a slightly
      // older price for a page that loads is the right way round — and the
      // stale window below is still the outage backstop.
      cacheTtlSeconds: toInt(process.env.PRODUCT_CACHE_TTL_SECONDS, 21_600),
      staleTtlSeconds: toInt(process.env.PRODUCT_STALE_TTL_SECONDS, 86_400),
      prewarmEnabled: toBool(process.env.PRODUCT_PREWARM_ENABLED, true),
      // Every 4h at :20 — inside the 6h freshness window, so a warmed shelf
      // never lapses back to cold. Off the hour for the same reason the
      // nightly sync is: shared vendors, shared schedulers.
      prewarmCron: process.env.PRODUCT_PREWARM_CRON ?? '20 */4 * * *',
      urlFetchTimeoutMs: toInt(process.env.PRODUCT_URL_FETCH_TIMEOUT_MS, 5_000),
      urlMaxBytes: toInt(process.env.PRODUCT_URL_MAX_BYTES, 512 * 1024),
      urlMaxRedirects: toInt(process.env.PRODUCT_URL_MAX_REDIRECTS, 3),
      urlAllowPrivate: toBool(process.env.PRODUCT_URL_ALLOW_PRIVATE, false),
    },
    affiliate: {
      network: (process.env.AFFILIATE_NETWORK ?? 'none') as 'none' | 'cuelinks',
      cuelinksApiKey: process.env.CUELINKS_API_KEY ?? '',
      cuelinksBaseUrl:
        process.env.CUELINKS_BASE_URL ?? 'https://developers.cuelinks.com/pub_api/v3',
    },
    observability: {
      sentryDsn: process.env.SENTRY_DSN ?? '',
    },
  };
};
