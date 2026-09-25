import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Indexes for `event_join_requests` — people asking a host to let them into a
 * private event through its share link.
 *
 * `autoIndex` is off in every environment, so these exist only because this
 * migration makes them. The unique one is load-bearing: it is what stops the
 * same person asking twice, and what keeps a declined ask from being replaced
 * by a fresh one.
 */
export const migration036: Migration = {
  id: '036-event-join-requests',
  description: 'Indexes for private-event join requests',

  up: async (db: Db): Promise<void> => {
    const requests = db.collection('event_join_requests');
    await requests.createIndex(
      { eventId: 1, userId: 1 },
      { unique: true, name: 'eventId_1_userId_1' },
    );
    await requests.createIndex(
      { eventId: 1, status: 1, createdAt: 1 },
      { name: 'eventId_1_status_1_createdAt_1' },
    );
  },

  down: async (db: Db): Promise<void> => {
    const requests = db.collection('event_join_requests');
    await requests.dropIndex('eventId_1_status_1_createdAt_1').catch(() => undefined);
    await requests.dropIndex('eventId_1_userId_1').catch(() => undefined);
  },
};
