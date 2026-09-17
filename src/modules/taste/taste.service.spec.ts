import { TAXONOMY_SEED } from '../taxonomy/taxonomy.seed';
import { TaxonomyKind, type TaxonomyOptions } from '../taxonomy/taxonomy.types';
import { WishmateRelationship } from '../wishmates/wishmates.views';
import { TasteService } from './taste.service';
import type { TastePreferences } from './taste-profile.builder';

/**
 * Who may read what about somebody's taste.
 *
 * Preferences were collected for the person's own benefit and, until this,
 * were shown to nobody — `wishmates.service.ts` projects them away on purpose.
 * Widening that is a decision, and these are the rules of it.
 */
describe('TasteService.summaryFor', () => {
  function seededOptions(): TaxonomyOptions {
    const grouped = Object.values(TaxonomyKind).reduce<TaxonomyOptions>(
      (acc, kind) => ({ ...acc, [kind]: [] }),
      {} as TaxonomyOptions,
    );
    for (const term of TAXONOMY_SEED) {
      grouped[term.kind].push({ key: term.key, label: term.label, meta: term.meta });
    }
    return grouped;
  }

  const fullTaste: TastePreferences & { shareSizes?: boolean } = {
    interests: ['fashion_shoes', 'tech_gaming'],
    interestCategories: ['fashion', 'technology'],
    customInterests: ['Vinyl records', '   '],
    favouriteColors: ['purple_plum', 'blue_navy'],
    clothingSize: 'xl',
    shoeSize: 'uk_9',
    fitPreference: 'relaxed',
  };

  function service(preferences: TastePreferences = fullTaste): TasteService {
    const profiles = {
      getOrCreate: jest.fn().mockResolvedValue({ preferences }),
    };
    const taxonomy = { getOptions: jest.fn().mockResolvedValue(seededOptions()) };
    return new TasteService(profiles as never, taxonomy as never);
  }

  const forRelationship = (relationship: WishmateRelationship, preferences?: TastePreferences) =>
    service(preferences).summaryFor('u_target', { relationship, displayName: 'Priyal' });

  describe('who gets one at all', () => {
    it('an accepted WishMate does', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES);

      expect(summary).not.toBeNull();
      expect(summary!.interests.map((i) => i.label)).toContain('Shoes');
    });

    it('so does the person themself', async () => {
      const summary = await forRelationship(WishmateRelationship.SELF);

      expect(summary!.isSelf).toBe(true);
      expect(summary!.title).toBe('What you like');
    });

    it.each([
      WishmateRelationship.NONE,
      WishmateRelationship.REQUEST_SENT,
      WishmateRelationship.REQUEST_RECEIVED,
    ])('%s gets nothing', async (relationship) => {
      // Null, not an empty summary: a viewer able to tell "withheld" from
      // "they have not said" has learned the thing they were refused.
      expect(await forRelationship(relationship)).toBeNull();
    });

    it('a pending request is not a half-open door', async () => {
      // Asking to connect is not being connected.
      const sent = await forRelationship(WishmateRelationship.REQUEST_SENT);
      const received = await forRelationship(WishmateRelationship.REQUEST_RECEIVED);

      expect(sent).toBeNull();
      expect(received).toBeNull();
    });
  });

  describe('what is in it', () => {
    it('labels, never raw taxonomy keys', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES);
      const serialised = JSON.stringify(summary);

      expect(summary!.interests[0].label).toBe('Shoes');
      // The key travels for the client to act on, but no *label* position may
      // hold one — a screen rendering `fashion_shoes` at somebody is a bug.
      expect(summary!.interests.every((i) => i.label !== i.key)).toBe(true);
      expect(serialised).not.toContain('"label":"fashion_shoes"');
    });

    it('colours carry their hex, so the app holds no colour table', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES);

      expect(summary!.colours[0]).toEqual(
        expect.objectContaining({ key: 'purple_plum', label: 'Plum' }),
      );
      expect(summary!.colours[0].hex).toMatch(/^#/);
    });

    it('drops a key the taxonomy has retired rather than echoing it', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES, {
        interests: ['music', 'fashion_shoes'],
      });

      expect(summary!.interests.map((i) => i.key)).toEqual(['fashion_shoes']);
    });

    it('free text is shown, trimmed, and blank entries are not', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES);

      expect(summary!.customInterests).toEqual(['Vinyl records']);
    });

    it('caps each list, so a profile is readable rather than a wall', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES, {
        interests: TAXONOMY_SEED.filter((t) => t.kind === TaxonomyKind.INTEREST).map((t) => t.key),
        favouriteColors: TAXONOMY_SEED.filter((t) => t.kind === TaxonomyKind.COLOR).map(
          (t) => t.key,
        ),
      });

      expect(summary!.interests.length).toBeLessThanOrEqual(8);
      expect(summary!.colours.length).toBeLessThanOrEqual(6);
    });
  });

  describe('sizes', () => {
    it('are shared by default, as how a listing would write them', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES);

      expect(summary!.sizes).toEqual({ clothing: 'XL', shoe: 'UK 9', fit: 'Relaxed' });
    });

    it('are withheld entirely when the owner turned them off', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES, {
        ...fullTaste,
        shareSizes: false,
      } as TastePreferences);

      // Null, not blanked: "they chose not to say" and "they said nothing"
      // must look the same from outside.
      expect(summary!.sizes).toBeNull();
      expect(JSON.stringify(summary)).not.toContain('XL');
    });

    it('turning them off keeps the rest of the taste visible', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES, {
        ...fullTaste,
        shareSizes: false,
      } as TastePreferences);

      expect(summary!.interests.length).toBeGreaterThan(0);
      expect(summary!.colours.length).toBeGreaterThan(0);
    });

    it('the owner still sees their own, whatever the switch says', async () => {
      const summary = await service({
        ...fullTaste,
        shareSizes: false,
      } as TastePreferences).summaryFor('u_target', {
        relationship: WishmateRelationship.SELF,
      });

      expect(summary!.sizes?.clothing).toBe('XL');
    });

    it('"prefer not to say" is not a size', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES, {
        clothingSize: 'prefer_not_to_say',
      });

      expect(summary!.sizes?.clothing).toBeNull();
    });
  });

  describe('an account that has said nothing', () => {
    it('says so, rather than showing an empty card', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES, {});

      expect(summary!.interests).toEqual([]);
      expect(summary!.note).toContain('not added their likes yet');
      expect(summary!.completeness).toBe(0);
    });

    it('tells the owner what filling it in is for', async () => {
      const summary = await service({}).summaryFor('u_target', {
        relationship: WishmateRelationship.SELF,
      });

      expect(summary!.note).toContain('WishMates see');
    });

    it('is named for the person when the viewer knows their name', async () => {
      const summary = await forRelationship(WishmateRelationship.WISHMATES, {});

      expect(summary!.title).toBe('What Priyal likes');
    });

    it('and impersonally when it does not', async () => {
      const summary = await service({}).summaryFor('u_target', {
        relationship: WishmateRelationship.WISHMATES,
      });

      expect(summary!.title).toBe('What they like');
    });
  });
});
