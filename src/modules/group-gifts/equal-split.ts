/**
 * "Split equally", worked out.
 *
 * The rules, in the host's words:
 *
 *  - Everyone in the group pays the same share of the total — the host too.
 *  - The host has already paid theirs: they are the one collecting the money,
 *    so it is in their hands from the start. ₹1,000 among five is ₹200 each,
 *    and the host shows as paid ₹200 before anybody has sent anything.
 *  - Somebody who pays more than their share lowers everybody else's: what is
 *    left is shared again among the people still to pay.
 *  - Somebody who pays less still owes the rest, and is reminded until they
 *    have paid it.
 *
 * Pure: no database, no clock. The service feeds it who is in the group and
 * what each has paid, and stores or shows what comes back.
 */

export interface SplitMemberInput {
  userId: string;
  /** Everything this person has paid in so far, in minor units. */
  paidMinor: number;
}

export interface SplitMember {
  userId: string;
  /** What this person is expected to have paid in total. */
  shareMinor: number;
  paidMinor: number;
  /** What is still to come from them. Zero once they have paid their share. */
  owesMinor: number;
}

export interface EqualSplit {
  /** Everyone the total is divided among, the host included. */
  memberCount: number;
  /** The total divided evenly — what the host is counted as having paid. */
  baseShareMinor: number;
  host: SplitMember;
  /** Everyone but the host, in the order given. */
  others: SplitMember[];
}

/**
 * The host's part of an even split: the total over the headcount, with any
 * paise that do not divide evenly. The host is the one holding the money, so
 * the odd paise are theirs rather than a stranger's — the same rule settling
 * up already follows.
 */
export function hostShareOf(targetMinor: number, memberCount: number): number {
  if (memberCount < 2 || targetMinor <= 0) return 0;
  const base = Math.floor(targetMinor / memberCount);
  return base + (targetMinor - base * memberCount);
}

/**
 * Who owes what.
 *
 * [hostPaidMinor] is everything counted as the host's — their share, and
 * anything they paid on top. [others] are everybody else in the group, paid
 * or not.
 *
 * Everybody still to pay owes the same *total*: what is left after the host
 * and the people who have already paid in full, divided among those who have
 * not. That is worked out again after anyone turns out to have paid enough
 * already — somebody who paid ₹150 when the rest are down to ₹133 each has
 * done their part, and their extra comes off the others. Repeats until nobody
 * else crosses the line.
 */
export function equalSplit(input: {
  targetMinor: number;
  hostId: string;
  hostPaidMinor: number;
  others: SplitMemberInput[];
}): EqualSplit {
  const { targetMinor, hostId, hostPaidMinor, others } = input;
  const memberCount = others.length + 1;
  const baseShareMinor = memberCount < 2 ? targetMinor : Math.floor(targetMinor / memberCount);

  const host: SplitMember = {
    userId: hostId,
    shareMinor: Math.max(hostShareOf(targetMinor, memberCount), hostPaidMinor),
    paidMinor: hostPaidMinor,
    owesMinor: 0,
  };

  // Everybody not yet known to have paid their part.
  let open = others.map((m) => m.userId);
  let fairShare = 0;
  for (;;) {
    if (open.length === 0) break;
    const paidByDone = others
      .filter((m) => !open.includes(m.userId))
      .reduce((sum, m) => sum + m.paidMinor, 0);
    const left = Math.max(0, targetMinor - hostPaidMinor - paidByDone);
    // Rounded up: a few paise too many beats a total that never quite lands.
    fairShare = Math.ceil(left / open.length);
    const stillOpen = open.filter(
      (id) => (others.find((m) => m.userId === id)?.paidMinor ?? 0) < fairShare,
    );
    if (stillOpen.length === open.length) break;
    open = stillOpen;
  }

  return {
    memberCount,
    baseShareMinor,
    host,
    others: others.map((m) => {
      const paidEnough = !open.includes(m.userId);
      const shareMinor = paidEnough ? m.paidMinor : fairShare;
      return {
        userId: m.userId,
        shareMinor,
        paidMinor: m.paidMinor,
        owesMinor: paidEnough ? 0 : Math.max(0, fairShare - m.paidMinor),
      };
    }),
  };
}
