/**
 * k6 load test — the read-heavy top endpoints at ~3× expected launch traffic.
 *
 * Run against a STAGING instance (never production), seeded with demo data:
 *   BASE_URL=https://staging.example.com \
 *   TARGET_VUS=150 \
 *   k6 run docs/load-test/k6-smoke.js
 *
 * TARGET_VUS is the sustained concurrency; set it to 3× your modelled launch
 * concurrency. The thresholds fail the run (non-zero exit) so this can gate a
 * release. Tune the numbers to the SLO once real baselines exist.
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const V1 = `${BASE}/api/v1`;
const TARGET = Number(__ENV.TARGET_VUS || 150);

const errors = new Rate('business_errors');

export const options = {
  scenarios: {
    steady: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: TARGET }, // ramp up
        { duration: '5m', target: TARGET }, // hold at 3× launch
        { duration: '1m', target: 0 }, // ramp down
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // < 1% transport failures
    http_req_duration: ['p(95)<400', 'p(99)<900'], // p95 < 400ms, p99 < 900ms
    business_errors: ['rate<0.01'], // < 1% non-2xx business responses
  },
};

// One account per VU, created once in setup and shared. A real test would seed a
// pool of accounts + wishlists so reads hit warm, realistic data.
export function setup() {
  const email = `loadtest-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = http.post(
    `${V1}/auth/signup`,
    JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'Load Test' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const body = res.json();
  return { token: body && body.data && body.data.tokens ? body.data.tokens.accessToken : null };
}

export default function (data) {
  const authHeaders = {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
  };
  const record = (res) => {
    const ok = res.status >= 200 && res.status < 300;
    check(res, { '2xx': () => ok });
    errors.add(!ok);
  };

  group('reads', () => {
    record(http.get(`${V1}/me`, authHeaders));
    record(http.get(`${V1}/onboarding/options`)); // public, large — exercises gzip
    record(http.get(`${V1}/wishlists`, authHeaders));
    record(http.get(`${V1}/dashboard`, authHeaders));
    record(http.get(`${V1}/notifications`, authHeaders));
    record(http.get(`${V1}/events`, authHeaders));
    record(http.get(`${V1}/products/search?q=headphones`, authHeaders));
  });

  group('writes', () => {
    // A light write so the pool + transaction paths see load without polluting data.
    const wl = http.post(
      `${V1}/wishlists`,
      JSON.stringify({ title: `Load ${__VU}-${__ITER}`, visibility: 'private' }),
      authHeaders,
    );
    record(wl);
  });

  sleep(1); // ~1 iteration/VU/sec think time
}
