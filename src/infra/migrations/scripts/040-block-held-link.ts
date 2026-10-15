import { createHash } from 'node:crypto';
import { Types, type mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * `ChatService.directRefId`, restated: a migration runs without the app, and
 * must keep addressing the pair the way the rows were written even if the
 * service's helper later moves.
 */
const directRefId = (a: string, b: string): Types.ObjectId =>
  new Types.ObjectId(
    createHash('sha256').update([a, b].sort().join(':')).digest('hex').slice(0, 24),
  );

/**
 * Blocks made before a block *held* the WishMates connection, rather than
 * ending it (`user_blocks.heldLink`).
 *
 * Those blocks deleted the link and kept no record of it, so whether the two
 * were WishMates is read off the one thing that survived: a direct chat, which
 * is only ever started between WishMates. Where there is one, the block now
 * holds a connection dated from the chat's start — the blocked person can
 * carry on writing, and unblocking gives the connection back. Where there is
 * none, `heldLink` is set to null, which is what a new block between
 * strangers writes.
 *
 * Only rows with no `heldLink` at all are touched, so running it twice, or
 * after new blocks were made, changes nothing it should not.
 */
export const migration040: Migration = {
  id: '040-block-held-link',
  description: 'Blocks made before held connections: hold the connection where a chat shows one',

  up: async (db: Db): Promise<void> => {
    const blocks = db.collection('user_blocks');
    const chats = db.collection('chats');
    const legacy = blocks.find({ heldLink: { $exists: false } });
    for await (const row of legacy) {
      const blockerId = row.blockerId as Types.ObjectId;
      const blockedId = row.blockedId as Types.ObjectId;
      const chat = await chats.findOne(
        { type: 'direct', refId: directRefId(blockerId.toString(), blockedId.toString()) },
        { projection: { createdAt: 1 } },
      );
      const since =
        (chat?.createdAt as Date | undefined) ?? (row.createdAt as Date | undefined) ?? new Date();
      await blocks.updateOne(
        { _id: row._id, heldLink: { $exists: false } },
        {
          $set: {
            heldLink: chat
              ? {
                  requesterId: blockerId,
                  addresseeId: blockedId,
                  createdAt: since,
                  respondedAt: since,
                }
              : null,
          },
        },
      );
    }
  },

  down: async (db: Db): Promise<void> => {
    await db.collection('user_blocks').updateMany({}, { $unset: { heldLink: '' } });
  },
};
