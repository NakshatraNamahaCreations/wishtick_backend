import { Injectable } from '@nestjs/common';
import type { Types } from 'mongoose';

export const WISHMATE_LINK = Symbol('WISHMATE_LINK');

/**
 * Answers "are these two people WishMates?" for the WISHMATES visibility.
 *
 * A port rather than a direct call on WishmatesService, for the reason
 * [EVENT_PARTICIPATION] gives: this policy is the one place that decides who
 * may do what to a wishlist, and it stays testable in isolation by depending
 * on an interface rather than on another feature's service. Unlike events
 * there is no cycle to break — WishlistsModule already imports WishmatesModule
 * one-way — so the implementation is provided from there rather than from a
 * module of its own.
 */
export interface IWishmateLink {
  /**
   * True only for an *accepted* link, in either direction.
   *
   * Pending does not count: a request that has been sent is somebody asking,
   * not somebody admitted, and a list set to WishMates-only would otherwise
   * open to anyone who had merely knocked. Declined is indistinguishable from
   * no link at all, which is the wishmates module's own rule.
   */
  areLinked(ownerId: Types.ObjectId, viewerId: string): Promise<boolean>;
}

/**
 * Denies everyone. Kept for tests that need the wishlist domain in isolation,
 * without the wishmates module attached.
 *
 * Deny rather than allow, always: a stub that grants access turns "we forgot
 * to wire this up" into a data leak, while a stub that denies turns it into an
 * obvious bug report.
 */
@Injectable()
export class NullWishmateLink implements IWishmateLink {
  areLinked(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
