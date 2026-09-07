/* eslint-disable no-console */
/**
 * Round-trips one small object through the configured storage, the way the app
 * actually does it, and prints where each step fails.
 *
 * Worth having as a script rather than a test: it talks to a real vendor with
 * real credentials, so it can never run in CI, and the failures it catches are
 * all configuration — a wrong endpoint, path-style off, a signature the SDK
 * built with headers the client will not send. Every one of those produces a
 * 403 at upload time and nothing in the logs to explain it.
 *
 * The PUT uses bare fetch, NOT the SDK: the phone uploads with plain Dio, and a
 * presigned URL that only works when the AWS SDK replays it is a URL that does
 * not work.
 *
 *   npx ts-node -r tsconfig-paths/register -r dotenv/config scripts/verify-storage.ts
 */
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const env = (key: string, fallback = ''): string => process.env[key] ?? fallback;

const bucket = env('S3_BUCKET');
const region = env('S3_REGION');
const endpoint = env('S3_ENDPOINT');
const publicBaseUrl = env('S3_PUBLIC_BASE_URL').replace(/\/$/, '');
const forcePathStyle = env('S3_FORCE_PATH_STYLE') === 'true';
const requestChecksums = env('S3_REQUEST_CHECKSUMS') === 'true';

const key = `_verify/${Date.now()}.txt`;
const body = `wishtick storage check ${new Date().toISOString()}\n`;

let step = 'start';
const at = (name: string): void => {
  step = name;
  process.stdout.write(`\n▸ ${name}\n`);
};

async function main(): Promise<void> {
  at('config');
  for (const [name, value] of Object.entries({
    S3_BUCKET: bucket,
    S3_REGION: region,
    S3_ENDPOINT: endpoint,
    S3_PUBLIC_BASE_URL: publicBaseUrl,
  })) {
    if (!value) throw new Error(`${name} is empty`);
    console.log(`  ${name} = ${value}`);
  }
  console.log(`  forcePathStyle = ${forcePathStyle}`);
  console.log(`  requestChecksums = ${requestChecksums}`);

  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle } : {}),
    ...(env('S3_ACCESS_KEY_ID') && env('S3_SECRET_ACCESS_KEY')
      ? {
          credentials: {
            accessKeyId: env('S3_ACCESS_KEY_ID'),
            secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
          },
        }
      : {}),
    ...(requestChecksums
      ? {}
      : {
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
        }),
  });

  at('presign PUT');
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'text/plain' }),
    { expiresIn: 900 },
  );
  console.log(`  ${uploadUrl.split('?')[0]}?…`);

  at('PUT as the phone does (plain fetch, no SDK)');
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body,
  });
  if (!put.ok) {
    throw new Error(`${put.status} ${put.statusText}\n${(await put.text()).slice(0, 500)}`);
  }
  console.log(`  ${put.status}`);

  at('HEAD (what MediaService.confirm does)');
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  console.log(`  size=${head.ContentLength} type=${head.ContentType}`);
  if (head.ContentLength !== Buffer.byteLength(body)) {
    throw new Error(`size mismatch: stored ${head.ContentLength}, sent ${Buffer.byteLength(body)}`);
  }

  at('GET the public CDN URL');
  const publicUrl = `${publicBaseUrl}/${key}`;
  console.log(`  ${publicUrl}`);
  const get = await fetch(publicUrl);
  if (!get.ok) {
    throw new Error(
      `${get.status} ${get.statusText}\n` +
        '  The object stored fine, so this is the pull zone: either it is not\n' +
        '  connected to this storage zone, or S3_PUBLIC_BASE_URL is wrong.',
    );
  }
  const served = await get.text();
  if (served !== body) throw new Error(`CDN served different bytes:\n${served.slice(0, 200)}`);
  console.log(`  ${get.status}, bytes match`);

  at('cleanup');
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  console.log('  deleted');

  console.log('\n✔ storage is wired correctly\n');
}

main().catch((err: unknown) => {
  console.error(`\n✖ failed at: ${step}\n`);
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
