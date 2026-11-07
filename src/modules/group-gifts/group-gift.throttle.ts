/**
 * Money-adjacent, and creating one claims an item: a tight per-IP bucket
 * blunts scripting. Shared by the group-gift and settle-up controllers, so
 * every route that moves or records money is held to the same limit.
 */
export const GROUP_GIFT_THROTTLE = { default: { limit: 30, ttl: 60_000 } };
