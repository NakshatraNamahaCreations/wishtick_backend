// Mongoose's re-export rather than the `mongodb` package: `mongodb` is not a
// declared dependency, and a dev dependency drags in a second copy whose types
// are nominally incompatible. See the note in all-exceptions.filter.ts.
import type { mongo } from 'mongoose';

type Db = mongo.Db;

export interface Migration {
  /** Sort key and unique id. Zero-padded so string sort == run order. */
  id: string;
  description: string;
  up: (db: Db) => Promise<void>;
  /**
   * Optional. Many migrations are not safely reversible (a seed that users have
   * since edited, a dropped column). Omitting `down` is an honest signal that
   * rolling back needs a human, rather than a lie that it is automatic.
   */
  down?: (db: Db) => Promise<void>;
}
