import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { TaxonomyService } from 'src/modules/taxonomy/taxonomy.service';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import { WISHMATE_LINK, type IWishmateLink } from 'src/modules/wishlists/access/wishmate-link.port';
import { ImportantDatesService, OTHER_OCCASION_KEY } from './important-dates.service';
import {
  ImportantDateFollow,
  type ImportantDateFollowDocument,
} from './schemas/important-date-follow.schema';
import { ImportantDate, type ImportantDateDocument } from './schemas/important-date.schema';

/** One of a WishMate's shared dates, as their profile shows it. */
export interface SharedDateView {
  id: string;
  personName: string;
  relation: string;
  /** The occasion as a person reads it — "Birthday", or what they typed. */
  occasionLabel: string;
  /** Date-only ISO of the saved date. */
  date: string;
  /** The next time it comes round, date-only ISO; today or later. */
  nextOccurrence: string;
  daysAway: number;
  /** Whether the viewer asked to be reminded of it. */
  reminding: boolean;
}

/**
 * Dates a person shared with their WishMates, seen from a WishMate's side —
 * and "Remind me" on them.
 *
 * Everything here is gated on the two being WishMates *now*: the profile
 * screen asks every time it opens, and the reminder scan checks again on every
 * send, so a WishMate who is removed stops seeing the dates and stops being
 * reminded without any clean-up step that could be missed.
 */
@Injectable()
export class SharedDatesService {
  constructor(
    @InjectModel(ImportantDate.name) private readonly dates: Model<ImportantDateDocument>,
    @InjectModel(ImportantDateFollow.name)
    private readonly follows: Model<ImportantDateFollowDocument>,
    @Inject(WISHMATE_LINK) private readonly links: IWishmateLink,
    private readonly taxonomy: TaxonomyService,
  ) {}

  /** [ownerId]'s shared dates, soonest first, for [viewerId]. */
  async listFor(viewerId: string, ownerId: string): Promise<SharedDateView[]> {
    await this.assertWishmates(viewerId, ownerId);
    const docs = await this.dates
      .find({ userId: new Types.ObjectId(ownerId), visibility: 'wishmates' })
      .lean()
      .exec();
    if (docs.length === 0) return [];

    const followed = new Set(
      (
        await this.follows
          .find({
            userId: new Types.ObjectId(viewerId),
            importantDateId: { $in: docs.map((d) => d._id) },
          })
          .select('importantDateId')
          .lean()
          .exec()
      ).map((f) => f.importantDateId.toString()),
    );
    const labels = await this.occasionLabels();
    const today = ImportantDatesService.utcToday();

    return docs
      .map((doc) => {
        const upcoming = ImportantDatesService.toUpcoming(ImportantDatesService.toView(doc), today);
        return {
          id: upcoming.id,
          personName: upcoming.personName,
          relation: upcoming.relation,
          occasionLabel:
            doc.occasionKey === OTHER_OCCASION_KEY
              ? (doc.customOccasion ?? 'Celebration')
              : (labels.get(doc.occasionKey) ?? doc.occasionKey),
          date: upcoming.date,
          nextOccurrence: upcoming.nextOccurrence,
          daysAway: upcoming.daysAway,
          reminding: followed.has(upcoming.id),
        } satisfies SharedDateView;
      })
      .sort((a, b) => a.daysAway - b.daysAway || a.personName.localeCompare(b.personName));
  }

  /** "Remind me" — a week before, three days before and on the day, yearly. */
  async remind(viewerId: string, ownerId: string, dateId: string): Promise<void> {
    await this.assertWishmates(viewerId, ownerId);
    const date = await this.sharedDate(ownerId, dateId);
    await this.follows
      .updateOne(
        { userId: new Types.ObjectId(viewerId), importantDateId: date._id },
        { $setOnInsert: { ownerId: date.userId } },
        { upsert: true },
      )
      .exec();
  }

  /** Stops it. Asking twice, or for a date never followed, is not an error. */
  async stopReminding(viewerId: string, ownerId: string, dateId: string): Promise<void> {
    if (!Types.ObjectId.isValid(dateId)) return;
    await this.follows
      .deleteOne({
        userId: new Types.ObjectId(viewerId),
        importantDateId: new Types.ObjectId(dateId),
        ownerId: new Types.ObjectId(ownerId),
      })
      .exec();
  }

  private async assertWishmates(viewerId: string, ownerId: string): Promise<void> {
    if (!Types.ObjectId.isValid(ownerId) || viewerId === ownerId) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Person not found', 404);
    }
    const accepted = await this.links.acceptedAmong(new Types.ObjectId(ownerId), [viewerId]);
    if (!accepted.has(viewerId)) {
      throw new AppException(
        ErrorCode.NOT_WISHMATES,
        'Only WishMates can see the dates someone shares.',
        403,
      );
    }
  }

  /** The owner's date, if it is shared — one 404 for missing and private alike. */
  private async sharedDate(ownerId: string, dateId: string): Promise<ImportantDateDocument> {
    const notFound = new AppException(ErrorCode.NOT_FOUND, 'Date not found', 404);
    if (!Types.ObjectId.isValid(dateId)) throw notFound;
    const date = await this.dates
      .findOne({
        _id: new Types.ObjectId(dateId),
        userId: new Types.ObjectId(ownerId),
        visibility: 'wishmates',
      })
      .exec();
    if (!date) throw notFound;
    return date;
  }

  private async occasionLabels(): Promise<Map<string, string>> {
    const options = await this.taxonomy.getOptions();
    return new Map(
      (options[TaxonomyKind.OCCASION] ?? []).map((option) => [option.key, option.label]),
    );
  }
}
