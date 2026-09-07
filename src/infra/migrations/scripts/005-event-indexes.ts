import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for events and invites.
 *
 * Names omitted for the same reason as 001/003/004 — see the note there.
 */
export const migration005: Migration = {
  id: '005-event-indexes',
  description: 'Indexes for events and event invites',

  up: async (db: Db): Promise<void> => {
    await db.collection('events').createIndex({ hostId: 1, startsAt: -1 });
    // A share slug is a bearer credential; two events sharing one would make the
    // link ambiguous.
    await db.collection('events').createIndex({ shareSlug: 1 }, { unique: true });
    await db.collection('events').createIndex({ status: 1, startsAt: 1 });

    await db.collection('event_invites').createIndex({ token: 1 }, { unique: true });
    await db.collection('event_invites').createIndex({ eventId: 1, rsvp: 1 });
    await db.collection('event_invites').createIndex({ invitedUserId: 1, revokedAt: 1 });

    // Deduplication enforced by the database, not just by the bulk-invite code.
    //
    // The invite endpoint takes a list from someone's address book, which
    // routinely repeats a person, and two concurrent requests could both pass an
    // application-level check. A duplicate invite means a guest gets two
    // messages and the RSVP count double-counts them.
    //
    // Partial, so the many invites with no email (or no phone) do not collide on
    // null. The (eventId, invitedUserId) one doubles as the lookup
    // AccessPolicyService runs for every EVENT_ONLY wishlist read.
    await db
      .collection('event_invites')
      .createIndex(
        { eventId: 1, email: 1 },
        { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
      );
    await db
      .collection('event_invites')
      .createIndex(
        { eventId: 1, phone: 1 },
        { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
      );
    await db
      .collection('event_invites')
      .createIndex(
        { eventId: 1, invitedUserId: 1 },
        { unique: true, partialFilterExpression: { invitedUserId: { $type: 'objectId' } } },
      );
  },

  down: async (db: Db): Promise<void> => {
    await Promise.all([
      db.collection('events').dropIndexes(),
      db.collection('event_invites').dropIndexes(),
    ]);
  },
};
