import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';
import { Address, AddressLabel, type AddressDocument } from './schemas/address.schema';

export interface AddressView {
  id: string;
  label: string;
  fullName: string;
  mobile: string;
  altMobile: string | null;
  email: string | null;
  line1: string;
  locality: string;
  landmark: string | null;
  pincode: string;
  city: string;
  state: string;
  countryCode: string;
  isDefault: boolean;
  /** The card's middle block, pre-joined so every client formats it alike. */
  formatted: string;
}

/** A sanity cap, not a product rule — mirrors MAX_DATES_PER_USER. */
const MAX_ADDRESSES_PER_USER = 20;

@Injectable()
export class AddressesService {
  constructor(@InjectModel(Address.name) private readonly model: Model<AddressDocument>) {}

  /** Default first, then oldest first — the order the picker renders. */
  async list(userId: string): Promise<AddressView[]> {
    const docs = await this.model
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ isDefault: -1, createdAt: 1 })
      .lean()
      .exec();
    return docs.map((doc) => AddressesService.toView(doc));
  }

  async create(userId: string, dto: CreateAddressDto): Promise<AddressView> {
    const _userId = new Types.ObjectId(userId);

    const count = await this.model.countDocuments({ userId: _userId }).exec();
    if (count >= MAX_ADDRESSES_PER_USER) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        `You can save up to ${MAX_ADDRESSES_PER_USER} addresses`,
        400,
      );
    }

    // The first address is always the default — otherwise a user could end up
    // with saved addresses and nothing selected at checkout.
    const isDefault = dto.isDefault === true || count === 0;
    if (isDefault) await this.clearDefault(_userId);

    const doc = await this.model.create({
      userId: _userId,
      label: dto.label ?? AddressLabel.HOME,
      fullName: dto.fullName,
      mobile: dto.mobile,
      altMobile: dto.altMobile ?? null,
      email: dto.email ?? null,
      line1: dto.line1,
      locality: dto.locality,
      landmark: dto.landmark ?? null,
      pincode: dto.pincode,
      city: dto.city,
      state: dto.state,
      countryCode: dto.countryCode ?? 'IN',
      isDefault,
    });
    return AddressesService.toView(doc.toObject());
  }

  async update(userId: string, id: string, dto: UpdateAddressDto): Promise<AddressView> {
    const _userId = new Types.ObjectId(userId);
    const doc = await this.findOwned(_userId, id);

    if (dto.label !== undefined) doc.label = dto.label;
    if (dto.fullName !== undefined) doc.fullName = dto.fullName;
    if (dto.mobile !== undefined) doc.mobile = dto.mobile;
    if (dto.altMobile !== undefined) doc.altMobile = dto.altMobile ?? null;
    if (dto.email !== undefined) doc.email = dto.email ?? null;
    if (dto.line1 !== undefined) doc.line1 = dto.line1;
    if (dto.locality !== undefined) doc.locality = dto.locality;
    if (dto.landmark !== undefined) doc.landmark = dto.landmark ?? null;
    if (dto.pincode !== undefined) doc.pincode = dto.pincode;
    if (dto.city !== undefined) doc.city = dto.city;
    if (dto.state !== undefined) doc.state = dto.state;
    if (dto.countryCode !== undefined) doc.countryCode = dto.countryCode ?? 'IN';

    // Promoting to default demotes the incumbent. Clearing the flag on the
    // only default is refused rather than silently leaving the user with none.
    if (dto.isDefault === true && !doc.isDefault) {
      await this.clearDefault(_userId);
      doc.isDefault = true;
    } else if (dto.isDefault === false && doc.isDefault) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'Set another address as the default instead of clearing this one',
        400,
      );
    }

    await doc.save();
    return AddressesService.toView(doc.toObject());
  }

  /** "Set as default" — the promotion on its own, without an edit around it. */
  async setDefault(userId: string, id: string): Promise<AddressView> {
    return this.update(userId, id, { isDefault: true });
  }

  async remove(userId: string, id: string): Promise<void> {
    const _userId = new Types.ObjectId(userId);
    const doc = await this.findOwned(_userId, id);
    const wasDefault = doc.isDefault;

    await this.model.deleteOne({ _id: doc._id, userId: _userId }).exec();

    // Removing the default promotes the next-oldest, so a user with any
    // address always has a default.
    if (wasDefault) {
      const next = await this.model.findOne({ userId: _userId }).sort({ createdAt: 1 }).exec();
      if (next) {
        next.isDefault = true;
        await next.save();
      }
    }
  }

  private async clearDefault(userId: Types.ObjectId): Promise<void> {
    await this.model.updateMany({ userId, isDefault: true }, { $set: { isDefault: false } }).exec();
  }

  /**
   * Scoped to the caller: someone else's id 404s exactly like an unknown one,
   * so ids stay unguessable (same reasoning as ImportantDatesService.remove).
   */
  private async findOwned(userId: Types.ObjectId, id: string): Promise<AddressDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Address not found', 404);
    }
    const doc = await this.model.findOne({ _id: new Types.ObjectId(id), userId }).exec();
    if (!doc) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Address not found', 404);
    }
    return doc;
  }

  /**
   * The card in `324:1295` reads "D-Block, JP Nagar, Mysuru, Karnataka 570031"
   * — one line, comma-separated, with the pincode trailing the state and no
   * comma before it. Built here rather than in each client so the address
   * book, the delivery picker and any future export all agree.
   */
  private static formatLines(doc: Address): string {
    const street = [doc.line1, doc.locality, doc.landmark].filter(Boolean).join(', ');
    const region = [doc.city, doc.state].filter(Boolean).join(', ');
    return [street, `${region} ${doc.pincode}`.trim()].filter(Boolean).join(', ');
  }

  /** An allowlist — the document must never be spread into a response. */
  private static toView(doc: Address): AddressView {
    return {
      id: doc._id.toString(),
      label: doc.label,
      fullName: doc.fullName,
      mobile: doc.mobile,
      altMobile: doc.altMobile,
      email: doc.email,
      line1: doc.line1,
      locality: doc.locality,
      landmark: doc.landmark,
      pincode: doc.pincode,
      city: doc.city,
      state: doc.state,
      countryCode: doc.countryCode,
      isDefault: doc.isDefault,
      formatted: AddressesService.formatLines(doc),
    };
  }
}
