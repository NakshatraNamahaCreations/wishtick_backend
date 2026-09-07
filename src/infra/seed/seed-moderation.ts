/* eslint-disable no-console */
import { Algorithm, hash } from '@node-rs/argon2';
import { mongo } from 'mongoose';

/**
 * Seeds a realistic moderation scenario for driving the admin panel.
 *
 *   npm run seed:moderation           # create if absent
 *   npm run seed:moderation -- --reset  # wipe seeded docs first
 *
 * Everything it writes carries `seed: 'moderation-demo'`, so --reset removes
 * exactly what this created and never touches real data.
 *
 * DEVELOPMENT ONLY. It refuses to run when NODE_ENV=production — seeding fake
 * users and reports into a live database would corrupt the moderation record
 * and the analytics that read these collections.
 */

const SEED_TAG = 'moderation-demo';

const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const oid = () => new mongo.ObjectId();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo data with NODE_ENV=production.');
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  const dbName = process.env.MONGO_DB_NAME;
  if (!uri || !dbName) {
    console.error('MONGO_URI and MONGO_DB_NAME must be set');
    process.exit(1);
  }

  const reset = process.argv.includes('--reset');
  const client = new mongo.MongoClient(uri);
  await client.connect();

  try {
    const db = client.db(dbName);
    const collections = [
      'users',
      'wishlists',
      'events',
      'messages',
      'wishes',
      'reel_collections',
      'reports',
    ];

    if (reset) {
      let removed = 0;
      for (const name of collections) {
        const result = await db.collection(name).deleteMany({ seed: SEED_TAG });
        removed += result.deletedCount;
      }
      console.log(`Removed ${removed} previously seeded document(s).`);
    }

    if (await db.collection('reports').findOne({ seed: SEED_TAG })) {
      console.log('Demo data already present. Re-run with --reset to rebuild.');
      return;
    }

    const passwordHash = await hash('demo@wishtick123', ARGON_OPTIONS);

    // ── Users ────────────────────────────────────────────────────────────────
    const people = [
      { name: 'Asha Raman', email: 'asha@example.com', source: 'whatsapp' },
      { name: 'Dev Menon', email: 'dev@example.com', source: 'invite' },
      { name: 'Priya Nair', email: 'priya@example.com', source: 'organic' },
      { name: 'Rohit Shah', email: 'rohit@example.com', source: 'referral' },
      { name: 'Meera Iyer', email: 'meera@example.com', source: 'group_gift' },
    ];

    const users = people.map((person, index) => ({
      _id: oid(),
      email: person.email,
      phone: null,
      passwordHash,
      name: person.name,
      roles: ['user'],
      status: 'active',
      emailVerifiedAt: index % 2 === 0 ? daysAgo(30) : null,
      phoneVerifiedAt: null,
      tokensInvalidBefore: null,
      deletedAt: null,
      lastLoginAt: daysAgo(index),
      acquisition: { source: person.source, ref: null, capturedAt: daysAgo(60 - index * 5) },
      createdAt: daysAgo(60 - index * 5),
      updatedAt: daysAgo(index),
      seed: SEED_TAG,
      __v: 0,
    }));
    await db.collection('users').insertMany(users);

    const [asha, dev, priya, rohit] = users as [
      (typeof users)[0],
      (typeof users)[0],
      (typeof users)[0],
      (typeof users)[0],
    ];

    // ── Content to report ────────────────────────────────────────────────────
    const wishlist = {
      _id: oid(),
      ownerId: dev._id,
      title: 'Birthday wishlist 2026',
      description:
        'Cheap watches and designer bags, DM me on telegram @dealsfast for bulk pricing!!',
      visibility: 'public',
      coverUrl: null,
      shareSlug: `seed-${Date.now().toString(36)}`,
      chatEnabled: true,
      stats: { itemCount: 6, fulfilledCount: 1 },
      archivedAt: null,
      createdAt: daysAgo(4),
      updatedAt: daysAgo(4),
      seed: SEED_TAG,
      __v: 0,
    };
    await db.collection('wishlists').insertOne(wishlist);

    const event = {
      _id: oid(),
      hostId: priya._id,
      title: 'Rooftop birthday bash',
      type: 'birthday',
      description: 'Free entry, bring your own bottle. Address shared after RSVP.',
      startsAt: daysAgo(-14),
      timezone: 'Asia/Kolkata',
      visibility: 'public',
      status: 'published',
      coverUrl: null,
      wishlistIds: [],
      shareSlug: `evt-${Date.now().toString(36)}`,
      createdAt: daysAgo(9),
      updatedAt: daysAgo(9),
      seed: SEED_TAG,
      __v: 0,
    };
    await db.collection('events').insertOne(event);

    const chatId = oid();
    const message = {
      _id: oid(),
      chatId,
      senderId: rohit._id,
      kind: 'text',
      body: 'You are worthless and nobody wants you at this party. Stop showing up.',
      attachments: [],
      reactions: [],
      editedAt: null,
      deletedAt: null,
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
      seed: SEED_TAG,
      __v: 0,
    };
    await db.collection('messages').insertOne(message);

    const collectionId = oid();
    await db.collection('reel_collections').insertOne({
      _id: collectionId,
      recipientUserId: asha._id,
      initiatorId: priya._id,
      eventId: event._id,
      birthdayMonth: 3,
      birthdayDay: 14,
      birthdayDate: daysAgo(-30),
      timezone: 'Asia/Kolkata',
      status: 'collecting',
      releaseAt: daysAgo(-30),
      reelMediaUrl: null,
      durationMs: 0,
      shareSlug: `reel-${Date.now().toString(36)}`,
      submissionDeadline: daysAgo(-25),
      createdAt: daysAgo(12),
      updatedAt: daysAgo(12),
      seed: SEED_TAG,
      __v: 0,
    });

    const wish = {
      _id: oid(),
      collectionId,
      authorId: rohit._id,
      authorName: 'Rohit Shah',
      kind: 'text',
      text: 'Hope your birthday is as miserable as you deserve.',
      mediaId: null,
      durationMs: 4000,
      moderationStatus: 'pending',
      order: 3,
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
      seed: SEED_TAG,
      __v: 0,
    };
    await db.collection('wishes').insertOne(wish);

    // ── Reports ──────────────────────────────────────────────────────────────
    // Severity mirrors the server's own formula: base 1, +2 for a user target,
    // +1 for message/wish, +1 when auto-flagged.
    const reports = [
      {
        reporterId: asha._id,
        source: 'user',
        targetType: 'user',
        targetId: rohit._id.toString(),
        reason: 'Harassment',
        detail: 'Has sent abusive messages to several people in our event chat.',
        status: 'open',
        severity: 3,
        createdAt: daysAgo(1),
      },
      {
        reporterId: asha._id,
        source: 'auto',
        targetType: 'message',
        targetId: message._id.toString(),
        reason: 'Abusive language',
        detail: 'Auto-flagged by the profanity filter.',
        status: 'open',
        severity: 3,
        createdAt: daysAgo(1),
      },
      {
        reporterId: priya._id,
        source: 'user',
        targetType: 'wish',
        targetId: wish._id.toString(),
        reason: 'Hateful content',
        detail: 'This is meant to be a birthday message.',
        status: 'reviewing',
        severity: 2,
        createdAt: daysAgo(2),
      },
      {
        reporterId: priya._id,
        source: 'user',
        targetType: 'wishlist',
        targetId: wishlist._id.toString(),
        reason: 'Spam or scam links',
        detail: 'Description is an advert with an off-platform contact.',
        status: 'open',
        severity: 1,
        createdAt: daysAgo(3),
      },
      {
        reporterId: rohit._id,
        source: 'user',
        targetType: 'event',
        targetId: event._id.toString(),
        reason: 'Misleading information',
        detail: 'Venue address does not exist.',
        status: 'open',
        severity: 1,
        createdAt: daysAgo(5),
      },
      {
        reporterId: dev._id,
        source: 'user',
        targetType: 'wishlist',
        // Deliberately dangling: content hard-deleted after being reported.
        // The panel must say "no longer exists", not render an empty card.
        targetId: oid().toString(),
        reason: 'Spam or scam links',
        detail: 'Reported, then the owner deleted it.',
        status: 'open',
        severity: 1,
        createdAt: daysAgo(6),
      },
    ].map((report) => ({
      _id: oid(),
      ...report,
      resolution: null,
      handledBy: null,
      handledAt: null,
      updatedAt: report.createdAt,
      seed: SEED_TAG,
      __v: 0,
    }));

    await db.collection('reports').insertMany(reports);

    console.log('Seeded moderation demo data:');
    console.log(`  users    : ${users.length}`);
    console.log('  content  : 1 wishlist, 1 event, 1 message, 1 wish, 1 reel collection');
    console.log(`  reports  : ${reports.length} (5 resolvable, 1 deliberately dangling)`);
    console.log('\nAll demo users share the password: demo@wishtick123');
    console.log(`Remove it all with: npm run seed:moderation -- --reset`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
