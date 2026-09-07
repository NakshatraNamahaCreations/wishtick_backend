# Local development

The one command you need:

```bash
npm start
```

That's it. `npm start` now **guarantees its database is up before booting** — a
`prestart` hook (`npm run db:up`) starts a local MongoDB if one isn't already
running, then Nest boots. The API comes up on **http://localhost:3000**
(Swagger at `/api/docs`).

## Why this exists (the errors we used to hit)

Three recurring failures, now fixed at the root:

| Symptom | Cause | Fix |
|---|---|---|
| `Could not connect to any servers in your MongoDB Atlas cluster … IP isn't whitelisted` | `.env` pointed at Atlas, which rejects non-allowlisted IPs | `.env` now points at a **local** Mongo |
| `Could not reach the server` (panel) | the backend process had died | it's just `npm start`; it now works reliably because the DB is always up |
| Mongo down after a reboot/session | a background `mongod` dies with its shell; only Redis (a Windows service) survived | Mongo now **auto-starts at logon** too |

## The pieces

- **Database target** — `.env` uses `MONGO_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0`
  (single-node replica set — the app needs transactions). The Atlas URL is kept
  commented right below it; to use Atlas, add your current IP in **Atlas → Network
  Access**, then swap the two `MONGO_URI` lines.
- **Redis** — already runs as a Windows service (`Redis`, Automatic), so it's always
  up. Nothing to do.
- **Mongo, on demand** — [`scripts/dev-mongo.js`](../scripts/dev-mongo.js) starts a
  detached `mongod` (staged at `.dev-mongo/mongod.exe`, data in `.dev-mongo-data/`)
  and initiates the replica set the first time. Idempotent — a no-op if Mongo is
  already running. It skips itself automatically if `MONGO_URI` isn't local.
- **Mongo, always** — [`scripts/wishtick-mongo.vbs`](../scripts/wishtick-mongo.vbs) is
  copied into the Windows **Startup** folder, so Mongo starts hidden at every logon,
  the same way Redis does. To turn this off, delete:
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\wishtick-mongo.vbs`.

## Admin panel login

The backend seeds a super-admin from `.env` on first boot:

- **Email:** `admin@wishtick.com`
- **Password:** `admin@wishtick` (from `ADMIN_BOOTSTRAP_PASSWORD`)

## Handy commands

```bash
npm run db:up      # ensure local Mongo is up (without starting the backend)
npm start          # ensure Mongo, then boot the API
npm run start:dev  # same, with --watch
npm run seed:admin # (re)seed the bootstrap admin
```

## Prefer Docker?

`docker-compose.yml` defines the same Mongo replica set (and a Redis, which you
don't need since one already runs as a service). With Docker Desktop running:
`docker compose up -d mongo mongo-init`, then point `.env` at
`mongodb://127.0.0.1:27017/?replicaSet=rs0`.
