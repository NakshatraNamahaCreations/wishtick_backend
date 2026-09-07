import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ErrorCode } from 'src/common/errors/error-codes';
import { WishlistItemStatus, WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface WishlistView {
  id: string;
  title: string;
  occasionLabel: string | null;
  visibility: WishlistVisibility;
  stats: { itemCount: number; fulfilledCount: number };
  access: { canView: boolean; canGift: boolean; canManage: boolean; relationship: string };
  share?: { slug: string; url: string; hasPasscode: boolean };
}

interface ItemView {
  id: string;
  title: string;
  recipientName: string | null;
  relation: string | null;
  occasionKey: string | null;
  position: number;
  status: WishlistItemStatus;
  price: { amountMinor: number | null; currency: string };
}

interface Actor {
  token: string;
  userId: string;
  email: string;
}

describe('Wishlists (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let itemModel: Model<WishlistItemDocument>;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const newUser = async (name = 'Test User'): Promise<Actor> => {
    const email = `wl${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id, email };
  };

  const createWishlist = async (
    actor: Actor,
    overrides: Partial<{ title: string; visibility: WishlistVisibility }> = {},
  ): Promise<WishlistView> => {
    const res = await request(app.getHttpServer())
      .post(`${V1}/wishlists`)
      .set(auth(actor.token))
      .send({ title: overrides.title ?? 'My List', visibility: overrides.visibility })
      .expect(201);
    return (res.body as Envelope<WishlistView>).data;
  };

  const addItem = async (actor: Actor, wishlistId: string, title: string): Promise<ItemView> => {
    const res = await request(app.getHttpServer())
      .post(`${V1}/wishlists/${wishlistId}/items`)
      .set(auth(actor.token))
      .send({ title })
      .expect(201);
    return (res.body as Envelope<ItemView>).data;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    itemModel = app.get<Model<WishlistItemDocument>>(getModelToken(WishlistItem.name));
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // ── CRUD ──────────────────────────────────────────────────────────────────

  describe('wishlist CRUD', () => {
    it('creates a private list with a share slug already minted', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner, { title: 'Birthday 2026' });

      // Private by default: the safe choice, not the convenient one.
      expect(wishlist.visibility).toBe(WishlistVisibility.PRIVATE);
      expect(wishlist.access).toMatchObject({ canManage: true, canGift: false });
      // Minted at creation so flipping to public later does not change the link.
      expect(wishlist.share?.slug).toHaveLength(16);
    });

    it('saves and updates occasionLabel as free text, no taxonomy involved', async () => {
      const owner = await newUser();
      const created = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists`)
          .set(auth(owner.token))
          .send({ title: 'Birthday 2026', occasionLabel: "Ananya's Birthday" })
          .expect(201)
      ).body as Envelope<WishlistView>;
      expect(created.data.occasionLabel).toBe("Ananya's Birthday");

      const updated = (
        await request(app.getHttpServer())
          .patch(`${V1}/wishlists/${created.data.id}`)
          .set(auth(owner.token))
          .send({ occasionLabel: 'Anniversary' })
          .expect(200)
      ).body as Envelope<WishlistView>;
      expect(updated.data.occasionLabel).toBe('Anniversary');
    });

    it('hides the share slug from everyone but the owner', async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.PUBLIC });

      const asStranger = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlist.id}`)
          .set(auth(stranger.token))
          .expect(200)
      ).body as Envelope<WishlistView>;

      // The slug is a bearer credential: only the person entitled to hand it
      // out gets to read it.
      expect(asStranger.data.share).toBeUndefined();
      expect(asStranger.data.access.canView).toBe(true);
    });

    it('answers 404 — not 403 — when the caller may not see the list', async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const wishlist = await createWishlist(owner);

      // A 403 would confirm the list exists, which is enough to probe for a
      // surprise party.
      const res = await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlist.id}`)
        .set(auth(stranger.token))
        .expect(404);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.WISHLIST_NOT_FOUND);
    });

    it('refuses edits from a non-owner', async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.PUBLIC });

      // Visible, so 403 rather than 404 — hiding it now would be absurd.
      const res = await request(app.getHttpServer())
        .patch(`${V1}/wishlists/${wishlist.id}`)
        .set(auth(stranger.token))
        .send({ title: 'Hijacked' })
        .expect(403);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('archives instead of deleting, and kills the share link', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.PUBLIC });
      const slug = wishlist.share!.slug;

      await request(app.getHttpServer())
        .delete(`${V1}/wishlists/${wishlist.id}`)
        .set(auth(owner.token))
        .expect(200);

      // The row survives (gifts and chats reference it)...
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists?includeArchived=true`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<WishlistView[]>;
      expect(mine.data).toHaveLength(1);

      // ...but the link is dead immediately.
      await request(app.getHttpServer()).get(`${V1}/public/wishlists/${slug}`).expect(404);
    });

    it('lists only your own wishlists', async () => {
      const a = await newUser();
      const b = await newUser();
      await createWishlist(a, { title: "A's list" });
      await createWishlist(b, { title: "B's list" });

      const mine = (
        await request(app.getHttpServer()).get(`${V1}/wishlists`).set(auth(a.token)).expect(200)
      ).body as Envelope<WishlistView[]>;
      expect(mine.data).toHaveLength(1);
      expect(mine.data[0].title).toBe("A's list");
    });
  });

  // ── Visibility changes ────────────────────────────────────────────────────

  describe('opening a closed list', () => {
    it('rotates the slug when private becomes public', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.PRIVATE });
      const oldSlug = wishlist.share!.slug;

      const updated = (
        await request(app.getHttpServer())
          .patch(`${V1}/wishlists/${wishlist.id}`)
          .set(auth(owner.token))
          .send({ visibility: WishlistVisibility.PUBLIC })
          .expect(200)
      ).body as Envelope<WishlistView>;

      // Any link shared while the list was private must stop working — going
      // public should be a deliberate act, not a side effect of a toggle.
      expect(updated.data.share!.slug).not.toBe(oldSlug);
      await request(app.getHttpServer()).get(`${V1}/public/wishlists/${oldSlug}`).expect(404);
      await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${updated.data.share!.slug}`)
        .expect(200);
    });

    it('keeps the slug when public becomes private', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.PUBLIC });
      const slug = wishlist.share!.slug;

      const updated = (
        await request(app.getHttpServer())
          .patch(`${V1}/wishlists/${wishlist.id}`)
          .set(auth(owner.token))
          .send({ visibility: WishlistVisibility.PRIVATE })
          .expect(200)
      ).body as Envelope<WishlistView>;

      // Narrowing is already safe; the policy refuses the link regardless.
      expect(updated.data.share!.slug).toBe(slug);
      await request(app.getHttpServer()).get(`${V1}/public/wishlists/${slug}`).expect(404);
    });
  });

  // ── Items ─────────────────────────────────────────────────────────────────

  describe('items', () => {
    it('adds items, keeps the counter in step, and filters', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner);

      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/items`)
        .set(auth(owner.token))
        .send({
          title: 'Headphones',
          price: { amountMinor: 249900, currency: 'INR' },
          category: 'electronics',
          priority: 1,
        })
        .expect(201);
      await addItem(owner, wishlist.id, 'A book');

      const refreshed = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlist.id}`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<WishlistView>;
      expect(refreshed.data.stats.itemCount).toBe(2);

      const filtered = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlist.id}/items?category=electronics`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<ItemView[]>;
      expect(filtered.data).toHaveLength(1);
      expect(filtered.data[0].title).toBe('Headphones');
    });

    it('rejects a price that is not in minor units', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner);
      // 2499.99 would accumulate float drift once Sprint 7 sums contributions.
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/items`)
        .set(auth(owner.token))
        .send({ title: 'Bad price', price: { amountMinor: 2499.99 } })
        .expect(400);
    });

    it('rejects an unknown category', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner);
      const res = await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/items`)
        .set(auth(owner.token))
        .send({ title: 'Mystery', category: 'not-a-real-category' })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.TAXONOMY_VALUE_INVALID);
    });

    it('rejects an unknown occasionKey', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner);
      const res = await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/items`)
        .set(auth(owner.token))
        .send({ title: 'Mystery', occasionKey: 'not-a-real-occasion' })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.TAXONOMY_VALUE_INVALID);
    });

    it('saves who a gift is for and why, same taxonomy as important-dates', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner);
      const item = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlist.id}/items`)
          .set(auth(owner.token))
          .send({
            title: 'Noise-cancelling headphones',
            recipientName: 'Ananya',
            relation: 'Best Friend',
            occasionKey: 'birthday',
          })
          .expect(201)
      ).body as Envelope<ItemView>;

      expect(item.data.recipientName).toBe('Ananya');
      expect(item.data.relation).toBe('Best Friend');
      expect(item.data.occasionKey).toBe('birthday');

      const updated = (
        await request(app.getHttpServer())
          .patch(`${V1}/wishlists/${wishlist.id}/items/${item.data.id}`)
          .set(auth(owner.token))
          .send({ recipientName: 'Rahul', relation: 'Brother', occasionKey: 'anniversary' })
          .expect(200)
      ).body as Envelope<ItemView>;
      expect(updated.data).toMatchObject({
        recipientName: 'Rahul',
        relation: 'Brother',
        occasionKey: 'anniversary',
      });
    });

    it('will not let a participant add items', async () => {
      const owner = await newUser();
      const guest = await newUser();
      const wishlist = await createWishlist(owner);
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/participants`)
        .set(auth(owner.token))
        .send({ userId: guest.userId })
        .expect(201);

      // A guest may see and gift, never edit.
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/items`)
        .set(auth(guest.token))
        .send({ title: 'Sneaky addition' })
        .expect(403);
    });

    it('freezes substantive fields once an item is claimed', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner);
      const item = await addItem(owner, wishlist.id, 'Blue headphones');

      // Sprint 6 owns this transition; forced here to assert the guard now.
      await itemModel.updateOne(
        { _id: item.id },
        { $set: { status: WishlistItemStatus.PURCHASED } },
      );

      // Editing "Blue headphones" into "A toaster" after someone bought the
      // headphones strands the gifter with the wrong gift.
      const res = await request(app.getHttpServer())
        .patch(`${V1}/wishlists/${wishlist.id}/items/${item.id}`)
        .set(auth(owner.token))
        .send({ title: 'A toaster' })
        .expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.WISHLIST_ITEM_LOCKED);

      // Presentation-only changes stay allowed — recipient/relation/occasion
      // describe why the item was added, not what it is, so a claim does not
      // freeze them the way title/price/productLink are frozen.
      await request(app.getHttpServer())
        .patch(`${V1}/wishlists/${wishlist.id}/items/${item.id}`)
        .set(auth(owner.token))
        .send({
          notes: 'Thank you!',
          recipientName: 'Ananya',
          relation: 'Best Friend',
          occasionKey: 'birthday',
        })
        .expect(200);
    });

    it('refuses to delete a claimed item', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner);
      const item = await addItem(owner, wishlist.id, 'Reserved thing');
      await itemModel.updateOne(
        { _id: item.id },
        { $set: { status: WishlistItemStatus.RESERVED } },
      );

      const res = await request(app.getHttpServer())
        .delete(`${V1}/wishlists/${wishlist.id}/items/${item.id}`)
        .set(auth(owner.token))
        .expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.WISHLIST_ITEM_LOCKED);
    });
  });

  // ── Reorder ───────────────────────────────────────────────────────────────

  describe('reorder', () => {
    it('applies a new order atomically', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner);
      const a = await addItem(owner, wishlist.id, 'First');
      const b = await addItem(owner, wishlist.id, 'Second');
      const c = await addItem(owner, wishlist.id, 'Third');

      const reordered = (
        await request(app.getHttpServer())
          .patch(`${V1}/wishlists/${wishlist.id}/items/reorder`)
          .set(auth(owner.token))
          .send({ itemIds: [c.id, a.id, b.id] })
          .expect(200)
      ).body as Envelope<ItemView[]>;

      expect(reordered.data.map((i) => i.title)).toEqual(['Third', 'First', 'Second']);
      // Positions stay strictly increasing, so the order is stable on re-read.
      const positions = reordered.data.map((i) => i.position);
      expect(positions).toEqual([...positions].sort((x, y) => x - y));
      expect(new Set(positions).size).toBe(3);
    });

    it('rejects a partial list rather than silently interleaving', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner);
      const a = await addItem(owner, wishlist.id, 'First');
      await addItem(owner, wishlist.id, 'Second');

      // Omitted items would keep stale positions and interleave unpredictably.
      const res = await request(app.getHttpServer())
        .patch(`${V1}/wishlists/${wishlist.id}/items/reorder`)
        .set(auth(owner.token))
        .send({ itemIds: [a.id] })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('rejects duplicate ids', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner);
      const a = await addItem(owner, wishlist.id, 'First');
      await addItem(owner, wishlist.id, 'Second');

      await request(app.getHttpServer())
        .patch(`${V1}/wishlists/${wishlist.id}/items/reorder`)
        .set(auth(owner.token))
        .send({ itemIds: [a.id, a.id] })
        .expect(400);
    });

    it("rejects an id from someone else's wishlist", async () => {
      const owner = await newUser();
      const other = await newUser();
      const wishlist = await createWishlist(owner);
      const mine = await addItem(owner, wishlist.id, 'Mine');

      const theirList = await createWishlist(other);
      const theirs = await addItem(other, theirList.id, 'Theirs');

      await request(app.getHttpServer())
        .patch(`${V1}/wishlists/${wishlist.id}/items/reorder`)
        .set(auth(owner.token))
        .send({ itemIds: [mine.id, theirs.id] })
        .expect(400);
    });
  });

  // ── Participants ──────────────────────────────────────────────────────────

  describe('participants', () => {
    it('grants access, and revokes it on the next request', async () => {
      const owner = await newUser();
      const guest = await newUser();
      const wishlist = await createWishlist(owner);
      await addItem(owner, wishlist.id, 'A thing');

      const participant = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlist.id}/participants`)
          .set(auth(owner.token))
          .send({ userId: guest.userId, role: 'contributor' })
          .expect(201)
      ).body as Envelope<{ id: string }>;

      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlist.id}`)
        .set(auth(guest.token))
        .expect(200);

      await request(app.getHttpServer())
        .delete(`${V1}/wishlists/${wishlist.id}/participants/${participant.data.id}`)
        .set(auth(owner.token))
        .expect(204);

      // Immediately, with no cache to wait out.
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlist.id}`)
        .set(auth(guest.token))
        .expect(404);
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlist.id}/items`)
        .set(auth(guest.token))
        .expect(404);
    });

    it('refuses to invite the owner', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner);
      const res = await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/participants`)
        .set(auth(owner.token))
        .send({ userId: owner.userId })
        .expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.CANNOT_INVITE_OWNER);
    });

    it('refuses a duplicate invite', async () => {
      const owner = await newUser();
      const guest = await newUser();
      const wishlist = await createWishlist(owner);

      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/participants`)
        .set(auth(owner.token))
        .send({ userId: guest.userId })
        .expect(201);
      const res = await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/participants`)
        .set(auth(owner.token))
        .send({ userId: guest.userId })
        .expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.PARTICIPANT_ALREADY_EXISTS);
    });

    it('keeps the guest list owner-only', async () => {
      const owner = await newUser();
      const guest = await newUser();
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.PUBLIC });
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/participants`)
        .set(auth(owner.token))
        .send({ userId: guest.userId })
        .expect(201);

      // Who was invited is itself the secret behind a surprise.
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlist.id}/participants`)
        .set(auth(guest.token))
        .expect(403);
    });

    it('surfaces a shared list under shared-with-me', async () => {
      const owner = await newUser();
      const guest = await newUser();
      const wishlist = await createWishlist(owner, { title: 'Shared list' });
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/participants`)
        .set(auth(owner.token))
        .send({ userId: guest.userId })
        .expect(201);

      const shared = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/shared-with-me`)
          .set(auth(guest.token))
          .expect(200)
      ).body as Envelope<WishlistView[]>;
      expect(shared.data).toHaveLength(1);
      expect(shared.data[0].title).toBe('Shared list');
      expect(shared.data[0].share).toBeUndefined();
    });
  });

  // ── Exit criterion: the public projection leaks nothing ───────────────────

  describe('public share link', () => {
    it('serves a redacted view with no owner PII and no gifter identity', async () => {
      const owner = await newUser('Aarav Sharma');
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.PUBLIC });
      const item = await addItem(owner, wishlist.id, 'Headphones');
      await itemModel.updateOne(
        { _id: item.id },
        { $set: { status: WishlistItemStatus.RESERVED } },
      );

      // Give the owner a full profile so there is real PII available to leak.
      await request(app.getHttpServer())
        .patch(`${V1}/me`)
        .set(auth(owner.token))
        .send({
          displayName: 'Aarav Sharma',
          dateOfBirth: '1995-04-17',
          contact: { city: 'Bengaluru', deliveryAddress: '221B Baker Street' },
        })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${wishlist.share!.slug}`)
        .expect(200);

      const body = res.body as Envelope<{
        ownerFirstName: string;
        items: { isClaimed: boolean; status?: unknown }[];
      }>;

      // First name only — enough for "Aarav's list", not a profile.
      expect(body.data.ownerFirstName).toBe('Aarav');

      // Whole-payload scan: an allowlist projection is only as good as the
      // proof that nothing slipped through.
      const raw = JSON.stringify(body);
      for (const secret of [
        owner.email,
        owner.userId,
        '221B Baker Street',
        'Bengaluru',
        '1995-04-17',
        'Sharma',
      ]) {
        expect(raw).not.toContain(secret);
      }

      // The claim is a boolean; the status and the gifter never appear.
      expect(body.data.items[0].isClaimed).toBe(true);
      expect(body.data.items[0].status).toBeUndefined();
      expect(raw).not.toContain('reserved');
    });

    it('refuses a private list even with the correct slug', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.PRIVATE });
      await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${wishlist.share!.slug}`)
        .expect(404);
    });

    it('opens an unlisted list by link', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.INVITE_ONLY });
      await addItem(owner, wishlist.id, 'Something');

      const res = await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${wishlist.share!.slug}`)
        .expect(200);
      expect((res.body as Envelope<{ itemCount: number }>).data.itemCount).toBe(1);
    });

    it('enforces a passcode when one is set', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.INVITE_ONLY });

      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/share`)
        .set(auth(owner.token))
        .send({ passcode: 'open-sesame' })
        .expect(200);

      const missing = await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${wishlist.share!.slug}`)
        .expect(401);
      expect((missing.body as Envelope<never>).error?.code).toBe(ErrorCode.SHARE_PASSCODE_REQUIRED);

      const wrong = await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${wishlist.share!.slug}?passcode=guessing`)
        .expect(403);
      expect((wrong.body as Envelope<never>).error?.code).toBe(ErrorCode.SHARE_PASSCODE_INVALID);

      await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${wishlist.share!.slug}?passcode=open-sesame`)
        .expect(200);
    });

    it('rejects an expired link', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.PUBLIC });

      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/share`)
        .set(auth(owner.token))
        .send({ expiresAt: new Date(Date.now() + 60_000).toISOString() })
        .expect(200);

      // Backdate it: an expiry in the past is refused at configure time.
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.id}/share`)
        .set(auth(owner.token))
        .send({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
        .expect(400);
    });

    it('kills old links when the owner rotates the slug', async () => {
      const owner = await newUser();
      const wishlist = await createWishlist(owner, { visibility: WishlistVisibility.PUBLIC });
      const oldSlug = wishlist.share!.slug;

      const rotated = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlist.id}/share`)
          .set(auth(owner.token))
          .send({ rotate: true })
          .expect(200)
      ).body as Envelope<{ slug: string }>;

      expect(rotated.data.slug).not.toBe(oldSlug);
      await request(app.getHttpServer()).get(`${V1}/public/wishlists/${oldSlug}`).expect(404);
      await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${rotated.data.slug}`)
        .expect(200);
    });

    it('serves an Open Graph preview carrying no PII', async () => {
      const owner = await newUser('Priya Nair');
      const wishlist = await createWishlist(owner, {
        title: 'Housewarming',
        visibility: WishlistVisibility.PUBLIC,
      });

      const res = await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${wishlist.share!.slug}/preview`)
        .expect(200);

      const body = res.body as Envelope<{ title: string; siteName: string }>;
      expect(body.data.title).toBe('Housewarming');
      expect(body.data.siteName).toBe('Wishtick');
      // WhatsApp unfurls this into a chat before anyone opens the link.
      expect(JSON.stringify(body)).not.toContain(owner.email);
      expect(JSON.stringify(body)).not.toContain(owner.userId);
    });

    it('404s an unknown slug', async () => {
      await request(app.getHttpServer()).get(`${V1}/public/wishlists/nosuchslug123456`).expect(404);
    });
  });

  // -- A list made for a WishMate -------------------------------------------

  describe('a wishlist made for a WishMate', () => {
    const becomeWishmates = async (a: Actor, b: Actor): Promise<void> => {
      await request(app.getHttpServer())
        .post(`${V1}/people/${b.userId}/request`)
        .set(auth(a.token))
        .expect(201);
      const received = await request(app.getHttpServer())
        .get(`${V1}/wishlinks/received`)
        .set(auth(b.token))
        .expect(200);
      const linkId = (received.body as Envelope<{ linkId: string }[]>).data[0].linkId;
      await request(app.getHttpServer())
        .post(`${V1}/wishlinks/${linkId}/accept`)
        .set(auth(b.token))
        .expect(201);
    };

    const createFor = (actor: Actor, forUserId: string | null) =>
      request(app.getHttpServer())
        .post(`${V1}/wishlists`)
        .set(auth(actor.token))
        .send({ title: 'Siya birthday', visibility: 'private', forUserId });

    it('records who it is for, and asks nobody', async () => {
      const owner = await newUser('Rohan');
      const siya = await newUser('Siya');
      await becomeWishmates(owner, siya);

      const created = (await createFor(owner, siya.userId).expect(201)).body as Envelope<{
        id: string;
        forUserId: string | null;
      }>;
      expect(created.data.forUserId).toBe(siya.userId);

      // A label the owner chose: the person named is not told and gets no
      // access. Private stays private, even to them.
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${created.data.id}`)
        .set(auth(siya.token))
        .expect(404);
      const links = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlinks/received`)
          .set(auth(siya.token))
          .expect(200)
      ).body as Envelope<unknown[]>;
      expect(links.data).toHaveLength(0);
    });

    it('only a current WishMate may be named', async () => {
      const owner = await newUser();
      const stranger = await newUser();
      await createFor(owner, stranger.userId).expect(400);
    });

    it('cannot be for yourself', async () => {
      const owner = await newUser();
      // Its own message: the WishMate check would refuse this too, with a
      // different one, and a test on the status alone could not tell them apart.
      const res = await createFor(owner, owner.userId).expect(400);
      expect((res.body as Envelope<never>).error?.message).toBe('A list cannot be for yourself');
    });

    it('can be unlinked, and relinked, on update', async () => {
      const owner = await newUser();
      const siya = await newUser('Siya');
      await becomeWishmates(owner, siya);
      const created = (await createFor(owner, siya.userId).expect(201)).body as Envelope<{
        id: string;
      }>;

      const cleared = (
        await request(app.getHttpServer())
          .patch(`${V1}/wishlists/${created.data.id}`)
          .set(auth(owner.token))
          .send({ forUserId: null })
          .expect(200)
      ).body as Envelope<{ forUserId: string | null }>;
      expect(cleared.data.forUserId).toBeNull();

      const again = (
        await request(app.getHttpServer())
          .patch(`${V1}/wishlists/${created.data.id}`)
          .set(auth(owner.token))
          .send({ forUserId: siya.userId })
          .expect(200)
      ).body as Envelope<{ forUserId: string | null }>;
      expect(again.data.forUserId).toBe(siya.userId);

      // An update that says nothing about it leaves it alone.
      const untouched = (
        await request(app.getHttpServer())
          .patch(`${V1}/wishlists/${created.data.id}`)
          .set(auth(owner.token))
          .send({ title: 'Renamed' })
          .expect(200)
      ).body as Envelope<{ forUserId: string | null }>;
      expect(untouched.data.forUserId).toBe(siya.userId);
    });
  });
});
