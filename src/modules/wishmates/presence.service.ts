import { Injectable } from '@nestjs/common';
import { CacheService } from 'src/infra/redis/cache.service';

/**
 * How long a connection is believed in without further evidence.
 *
 * Longer than the socket lifecycle needs, because a disconnect is not always
 * delivered: a phone that loses signal or is killed from the app switcher
 * never sends one, and without an expiry that user would read as "Online"
 * forever. The TTL is what makes presence self-correcting.
 */
const ONLINE_TTL_SECONDS = 90;

/** Last-seen is kept far longer — it is the fallback once someone goes offline. */
const LAST_SEEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface PresenceState {
  online: boolean;
  lastSeenAt: string | null;
}

/**
 * Who is online, for the green dot on the chat list, chat header and profile
 * (`4177:179`, `4177:6`, `4177:267`).
 *
 * Redis rather than Mongo on purpose: this is the highest-churn, least durable
 * state in the app — it changes on every connect and is worthless after a
 * restart — and writing it to the profile document would rewrite a row on
 * every socket event for a value that expires in ninety seconds.
 *
 * A user may hold several sockets at once (phone and web). Connections are
 * therefore counted rather than flagged, so closing one tab does not mark
 * someone offline while their phone is still connected.
 */
@Injectable()
export class PresenceService {
  constructor(private readonly cache: CacheService) {}

  private onlineKey(userId: string): string {
    return `presence:online:${userId}`;
  }

  private lastSeenKey(userId: string): string {
    return `presence:seen:${userId}`;
  }

  /** A socket opened. Returns the number of connections now held. */
  async connected(userId: string): Promise<number> {
    const key = this.onlineKey(userId);
    const count = await this.cache.client.incr(key);
    // Refreshed on every connect, so a long-lived socket keeps the key alive
    // as long as the user keeps opening them.
    await this.cache.client.expire(key, ONLINE_TTL_SECONDS);
    await this.touch(userId);
    return count;
  }

  /**
   * A socket closed.
   *
   * Floors at zero and deletes: a missed connect (a restart mid-session) could
   * otherwise decrement into negatives, which would read as permanently
   * offline no matter how many sockets were actually open.
   */
  async disconnected(userId: string): Promise<void> {
    const key = this.onlineKey(userId);
    const count = await this.cache.client.decr(key);
    if (count <= 0) await this.cache.client.del(key);
    else await this.cache.client.expire(key, ONLINE_TTL_SECONDS);
    await this.touch(userId);
  }

  /** Records "seen just now", and keeps a live connection from expiring. */
  async touch(userId: string): Promise<void> {
    await this.cache.client.set(
      this.lastSeenKey(userId),
      new Date().toISOString(),
      'EX',
      LAST_SEEN_TTL_SECONDS,
    );
    // Only extends a key that exists — never resurrects one that expired.
    await this.cache.client.expire(this.onlineKey(userId), ONLINE_TTL_SECONDS);
  }

  async stateOf(userId: string): Promise<PresenceState> {
    const [state] = await this.stateOfMany([userId]);
    return state ?? { online: false, lastSeenAt: null };
  }

  /**
   * Presence for a list of people in two round trips rather than 2N.
   *
   * The chat list and the WishMates screen both render dozens of rows; asking
   * per row is what turns a presence dot into a performance problem.
   */
  async stateOfMany(userIds: string[]): Promise<PresenceState[]> {
    if (userIds.length === 0) return [];

    const [onlineRaw, seenRaw] = await Promise.all([
      this.cache.client.mget(...userIds.map((id) => this.onlineKey(id))),
      this.cache.client.mget(...userIds.map((id) => this.lastSeenKey(id))),
    ]);

    return userIds.map((_, i) => ({
      online: Number(onlineRaw[i] ?? 0) > 0,
      lastSeenAt: seenRaw[i] ?? null,
    }));
  }

  /** Clears every connection for a user — used when their sessions are revoked. */
  async clear(userId: string): Promise<void> {
    await this.cache.client.del(this.onlineKey(userId));
  }
}
