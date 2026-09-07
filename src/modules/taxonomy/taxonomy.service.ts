import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import { TaxonomyTerm, type TaxonomyDocument } from './schemas/taxonomy.schema';
import { TaxonomyKind, type TaxonomyOption, type TaxonomyOptions } from './taxonomy.types';

// v2: the Wishtick-UI-v2 reseed added kinds (interest_category, fit_preference)
// — bumping the key stops a warm v1 cache from hiding them for up to an hour.
// v3: Sprint 7 added `relation` for the event-creation picker (`2252:423`).
// Same reason: without the bump, the picker would be empty on any instance
// whose cache was warm at deploy.
// Exported so a test asserting the cache was written cannot go stale silently
// the next time this is bumped.
export const TAXONOMY_CACHE_KEY = 'taxonomy:options:v3';
const CACHE_KEY = TAXONOMY_CACHE_KEY;
const CACHE_TTL_SECONDS = 3_600;

@Injectable()
export class TaxonomyService {
  private readonly logger = new Logger(TaxonomyService.name);

  constructor(
    @InjectModel(TaxonomyTerm.name) private readonly model: Model<TaxonomyDocument>,
    private readonly cache: CacheService,
  ) {}

  /**
   * The full options payload, cached for an hour. Read on every onboarding
   * start and changed roughly never, so it is the clearest cache win in the app.
   */
  async getOptions(): Promise<TaxonomyOptions> {
    return this.cache.wrap(CACHE_KEY, CACHE_TTL_SECONDS, async () => {
      const terms = await this.model
        .find({ active: true })
        .sort({ kind: 1, sortOrder: 1, label: 1 })
        .lean()
        .exec();

      // Start from every kind so a kind with no rows returns [] rather than
      // being absent — a client should not have to handle both shapes.
      const grouped = Object.values(TaxonomyKind).reduce<TaxonomyOptions>(
        (acc, kind) => ({ ...acc, [kind]: [] }),
        {} as TaxonomyOptions,
      );

      for (const term of terms) {
        const option: TaxonomyOption = { key: term.key, label: term.label };
        if (term.meta && Object.keys(term.meta).length > 0) option.meta = term.meta;
        grouped[term.kind].push(option);
      }
      return grouped;
    });
  }

  /**
   * Must be called by any write that changes taxonomy rows (Sprint 11 admin
   * CRUD). Without it an admin's edit is invisible for up to an hour.
   */
  async bustCache(): Promise<void> {
    await this.cache.del(CACHE_KEY);
    this.logger.log('Taxonomy options cache busted');
  }

  /** Active keys for one kind. */
  async validKeys(kind: TaxonomyKind): Promise<Set<string>> {
    const options = await this.getOptions();
    return new Set(options[kind].map((o) => o.key));
  }

  /**
   * Rejects unknown keys, naming the field and the offending values.
   *
   * This is what keeps preferences groupable in the Sprint 11 analytics: if
   * clients could post free text, `interests` becomes a bag of typos and
   * "users interested in music" stops being answerable.
   */
  async assertValid(kind: TaxonomyKind, keys: string[], field: string): Promise<void> {
    if (keys.length === 0) return;
    const valid = await this.validKeys(kind);
    const unknown = [...new Set(keys)].filter((k) => !valid.has(k));
    if (unknown.length > 0) {
      throw new AppException(
        ErrorCode.TAXONOMY_VALUE_INVALID,
        `Unknown ${field}: ${unknown.join(', ')}`,
        400,
        { field, unknown, kind },
      );
    }
  }

  /** Single-value variant; null/undefined is always allowed (fields are optional). */
  async assertValidOne(
    kind: TaxonomyKind,
    key: string | null | undefined,
    field: string,
  ): Promise<void> {
    if (key === null || key === undefined) return;
    await this.assertValid(kind, [key], field);
  }
}
