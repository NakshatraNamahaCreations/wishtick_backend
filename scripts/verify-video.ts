/* eslint-disable no-console */
/**
 * Puts one real clip through Bunny Stream and proves it plays: create → fetch →
 * encode → signed HLS → and, critically, a *segment* fetched the way a player
 * fetches it.
 *
 * That last step is the whole point. CDN token authentication is on, and a
 * query-string token authorizes exactly one file — so it would sign the
 * playlist and nothing it references, and the video would 403 the instant
 * playback moved past the manifest. This script fails loudly if the directory
 * token is not doing its job, instead of leaving that to a user on a phone.
 *
 *   npm run verify:video
 */
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { signedDirectoryUrl } from '../src/infra/video/bunny-token';

const env = (key: string, fallback = ''): string => process.env[key] ?? fallback;

const libraryId = env('BUNNY_STREAM_LIBRARY_ID');
const apiKey = env('BUNNY_STREAM_API_KEY');
const tokenKey = env('BUNNY_STREAM_TOKEN_KEY');
const cdnHostname = env('BUNNY_STREAM_CDN_HOSTNAME');
const API = 'https://video.bunnycdn.com';

/**
 * Where the sample clip comes from. Small, openly published, and nothing the
 * repo has to carry.
 *
 * It is uploaded to OUR storage first and Stream is pointed at our own CDN,
 * because that is the production path exactly: the phone PUTs to storage, and
 * the server hands Bunny a URL. Pointing Stream straight at a third party
 * would test a code path the app never takes — and several public hosts refuse
 * a datacentre pull anyway, which is a fact about them, not about us.
 */
const SAMPLE_SOURCE =
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';

let step = 'start';
const at = (name: string): void => {
  step = name;
  process.stdout.write(`\n▸ ${name}\n`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      AccessKey: apiKey,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Signs with the app's own helper, not a copy of it. A verification script that
 * reimplements the thing it verifies proves only that the copy works.
 */
function directoryUrl(directory: string, file: string, ttlSeconds = 3600): string {
  return signedDirectoryUrl({
    securityKey: tokenKey,
    hostname: cdnHostname,
    directory,
    file,
    ttlSeconds,
  });
}

async function main(): Promise<void> {
  at('config');
  for (const [name, value] of Object.entries({
    BUNNY_STREAM_LIBRARY_ID: libraryId,
    BUNNY_STREAM_CDN_HOSTNAME: cdnHostname,
  })) {
    if (!value) throw new Error(`${name} is empty`);
    console.log(`  ${name} = ${value}`);
  }
  if (!apiKey) throw new Error('BUNNY_STREAM_API_KEY is empty');
  if (!tokenKey) throw new Error('BUNNY_STREAM_TOKEN_KEY is empty');

  at('stage the clip in our own storage (what the phone does)');
  const source = await fetch(SAMPLE_SOURCE);
  if (!source.ok) throw new Error(`could not fetch the sample: ${source.status}`);
  const bytes = Buffer.from(await source.arrayBuffer());
  console.log(`  ${bytes.length} bytes`);

  const s3 = new S3Client({
    region: env('S3_REGION'),
    endpoint: env('S3_ENDPOINT'),
    forcePathStyle: env('S3_FORCE_PATH_STYLE') === 'true',
    credentials: {
      accessKeyId: env('S3_ACCESS_KEY_ID'),
      secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const stagedKey = `_verify/${Date.now()}.mp4`;
  const putUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: env('S3_BUCKET'),
      Key: stagedKey,
      ContentType: 'video/mp4',
    }),
    { expiresIn: 900 },
  );
  const put = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: bytes,
  });
  if (!put.ok) throw new Error(`staging PUT failed: ${put.status}`);
  const stagedUrl = `${env('S3_PUBLIC_BASE_URL').replace(/\/$/, '')}/${stagedKey}`;
  console.log(`  ${stagedUrl}`);

  at('create video');
  const created = await api<{ guid: string }>('POST', `/library/${libraryId}/videos`, {
    title: `wishtick verify ${new Date().toISOString()}`,
  });
  const id = created.guid;
  console.log(`  guid = ${id}`);

  try {
    at('fetch source (Bunny pulls it — no bytes through us)');
    await api('POST', `/library/${libraryId}/videos/${id}/fetch`, { url: stagedUrl });
    console.log('  accepted');

    at('wait for encode');
    let status = -1;
    for (let i = 0; i < 90; i++) {
      const v = await api<{ status: number; encodeProgress?: number }>(
        'GET',
        `/library/${libraryId}/videos/${id}`,
      );
      if (v.status !== status) {
        status = v.status;
        console.log(`  status=${v.status} progress=${v.encodeProgress ?? 0}%`);
      }
      if (v.status === 4) break;
      if (v.status === 5 || v.status === 6) throw new Error(`encode failed (status ${v.status})`);
      await sleep(10_000);
    }
    if (status !== 4) throw new Error(`still not finished after 15 minutes (status ${status})`);

    at('UNSIGNED playlist must be refused (proves token auth is on)');
    const unsigned = await fetch(`https://${cdnHostname}/${id}/playlist.m3u8`);
    console.log(`  ${unsigned.status}`);
    if (unsigned.ok) {
      console.warn('  ⚠ served without a token — CDN token authentication is NOT enabled');
    }

    at('SIGNED playlist');
    const playlistUrl = directoryUrl(id, 'playlist.m3u8');
    const playlist = await fetch(playlistUrl);
    if (!playlist.ok) {
      throw new Error(
        `${playlist.status} — the directory token was rejected.\n` + `  url: ${playlistUrl}`,
      );
    }
    const manifest = await playlist.text();
    console.log(`  ${playlist.status}, ${manifest.split('\n').length} lines`);

    at('SEGMENT via the same token (the step that usually breaks)');
    // Take the first thing the manifest points at and fetch it the way a
    // player would: same directory, no query string of its own.
    const child = manifest
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (!child) throw new Error(`manifest referenced nothing:\n${manifest.slice(0, 400)}`);
    console.log(`  first reference: ${child}`);

    const segmentUrl = directoryUrl(id, child);
    const segment = await fetch(segmentUrl);
    console.log(`  ${segment.status}`);
    if (!segment.ok) {
      throw new Error(
        `the playlist is authorized but its contents are not — playback would\n` +
          `  stall the moment it started. url: ${segmentUrl}`,
      );
    }

    console.log('\n✔ video streams: signed playlist AND segment both served\n');
  } finally {
    at('cleanup');
    await api('DELETE', `/library/${libraryId}/videos/${id}`).catch(() => undefined);
    await s3
      .send(new DeleteObjectCommand({ Bucket: env('S3_BUCKET'), Key: stagedKey }))
      .catch(() => undefined);
    console.log('  deleted');
  }
}

main().catch((err: unknown) => {
  console.error(`\n✖ failed at: ${step}\n`);
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
