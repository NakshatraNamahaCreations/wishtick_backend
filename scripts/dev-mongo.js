/**
 * Ensures the local development MongoDB is running before the backend starts.
 *
 * Why this exists: the app needs a Mongo replica set (transactions), Atlas blocks
 * local runs whose IP is not allowlisted, and a plain background mongod dies with
 * the shell that launched it. This script makes `npm start` self-sufficient — it
 * starts a detached, persistent mongod (single-node replica set) against a fixed
 * data directory if one is not already listening, and initiates the replica set
 * the first time. Idempotent: if Mongo is already up, it is a fast no-op.
 *
 * Skipped automatically when MONGO_URI is not a local address (e.g. Atlas), so it
 * never interferes with a cloud-pointed .env.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { MongoClient } = require('mongoose').mongo;

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, '.dev-mongo', 'mongod.exe');
const DATA = path.join(ROOT, '.dev-mongo-data');
const PORT = 27017;
const PROBE = `mongodb://127.0.0.1:${PORT}/?directConnection=true&serverSelectionTimeoutMS=1500`;

// Load .env just enough to read MONGO_URI (no dependency on @nestjs/config here).
function mongoUri() {
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const line = env.split(/\r?\n/).find((l) => /^\s*MONGO_URI\s*=/.test(l));
    return line ? line.replace(/^\s*MONGO_URI\s*=/, '').trim() : '';
  } catch {
    return '';
  }
}

const isLocal = (uri) => /127\.0\.0\.1|localhost/.test(uri) && !uri.startsWith('mongodb+srv');

async function ping() {
  const client = new MongoClient(PROBE);
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function ensureReplicaSet() {
  const client = new MongoClient(PROBE);
  await client.connect();
  const admin = client.db('admin');
  try {
    await admin.command({ replSetGetStatus: 1 });
  } catch {
    try {
      await admin.command({
        replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${PORT}` }] },
      });
    } catch (err) {
      if (!/already initialized/i.test(String(err && err.message))) throw err;
    }
  }
  for (let i = 0; i < 60; i++) {
    const hello = await admin.command({ hello: 1 });
    if (hello.isWritablePrimary) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await client.close();
}

async function main() {
  const uri = mongoUri();
  if (!isLocal(uri)) {
    console.log(`[dev-mongo] MONGO_URI is not local (${uri.slice(0, 24)}…) — leaving Mongo to you.`);
    return;
  }

  if (await ping()) {
    await ensureReplicaSet();
    console.log('[dev-mongo] MongoDB already running on 27017 (rs0).');
    return;
  }

  if (!fs.existsSync(BIN)) {
    console.error(`[dev-mongo] mongod binary not found at ${BIN}. See docs/LOCAL_DEV.md.`);
    process.exit(1);
  }
  fs.mkdirSync(DATA, { recursive: true });

  console.log('[dev-mongo] Starting local MongoDB…');
  const child = spawn(
    BIN,
    ['--replSet', 'rs0', '--port', String(PORT), '--dbpath', DATA, '--bind_ip', '127.0.0.1'],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  for (let i = 0; i < 60 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await ping())) {
    console.error('[dev-mongo] MongoDB did not come up in time.');
    process.exit(1);
  }
  await ensureReplicaSet();
  console.log('[dev-mongo] MongoDB up on mongodb://127.0.0.1:27017 (rs0).');
}

main().catch((err) => {
  console.error('[dev-mongo] failed:', err && err.message ? err.message : err);
  process.exit(1);
});
