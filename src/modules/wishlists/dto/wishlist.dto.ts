import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  ItemImportance,
  ParticipantRole,
  WishlistItemStatus,
  WishlistVisibility,
} from '../wishlist.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateWishlistDto {
  @ApiProperty({ example: 'My 30th Birthday' })
  @IsString()
  @Length(1, 140)
  @Transform(trim)
  title!: string;

  @ApiPropertyOptional({ example: 'Things I have been eyeing all year.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  description?: string | null;

  @ApiPropertyOptional({ enum: WishlistVisibility, default: WishlistVisibility.PRIVATE })
  @IsOptional()
  @IsEnum(WishlistVisibility)
  visibility?: WishlistVisibility;

  @ApiPropertyOptional({ description: 'A confirmed media id from /media/confirm' })
  @IsOptional()
  @IsMongoId()
  coverMediaId?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  chatEnabled?: boolean;

  @ApiPropertyOptional({
    example: "Ananya's Birthday",
    description: 'Free text, display only — not validated against the occasion taxonomy.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  @Transform(trim)
  occasionLabel?: string | null;

  @ApiPropertyOptional({
    description:
      'The WishMate this list is for, when one was picked while naming it. Must be a ' +
      'current WishMate; null clears it.',
  })
  @IsOptional()
  @IsMongoId()
  forUserId?: string | null;
}

export class UpdateWishlistDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 140)
  @Transform(trim)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  description?: string | null;

  @ApiPropertyOptional({ enum: WishlistVisibility })
  @IsOptional()
  @IsEnum(WishlistVisibility)
  visibility?: WishlistVisibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  coverMediaId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  chatEnabled?: boolean;

  @ApiPropertyOptional({ example: "Ananya's Birthday" })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  @Transform(trim)
  occasionLabel?: string | null;

  @ApiPropertyOptional({
    description:
      'The WishMate this list is for, when one was picked while naming it. Must be a ' +
      'current WishMate; null clears it.',
  })
  @IsOptional()
  @IsMongoId()
  forUserId?: string | null;
}

export class ShareWishlistDto {
  @ApiPropertyOptional({
    description: 'Mint a new slug, invalidating every link already shared.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  rotate?: boolean;

  @ApiPropertyOptional({ description: 'Set a passcode. Send null to clear it.' })
  @IsOptional()
  @IsString()
  @Length(4, 64)
  passcode?: string | null;

  @ApiPropertyOptional({ description: 'ISO date. Send null for no expiry.' })
  @IsOptional()
  @IsDateString({ strict: true })
  expiresAt?: string | null;
}

export class GiftPreferencesDto {
  @ApiPropertyOptional({ example: 'navy' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  color?: string | null;

  @ApiPropertyOptional({ example: 'M' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  size?: string | null;

  @ApiPropertyOptional({ example: 'The one with the zip pocket' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  variantNotes?: string | null;
}

export class PriceDto {
  @ApiPropertyOptional({
    example: 249900,
    description: 'Minor units (paise/cents). Never a decimal — see ItemPrice.',
  })
  @IsOptional()
  @IsInt({ message: 'amountMinor must be an integer in minor units, e.g. 249900 for ₹2499.00' })
  @Min(0)
  amountMinor?: number | null;

  @ApiPropertyOptional({ example: 'INR' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  currency?: string;
}

export class CreateItemDto {
  @ApiProperty({ example: 'Noise-cancelling headphones' })
  @IsString()
  @Length(1, 200)
  @Transform(trim)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  notes?: string | null;

  @ApiPropertyOptional({
    example: 'Ananya',
    description: 'Who this gift is for — free text, display only.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  @Transform(trim)
  recipientName?: string | null;

  @ApiPropertyOptional({
    example: 'Best Friend',
    description: "Free text, matching /me/important-dates' relation field.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  relation?: string | null;

  @ApiPropertyOptional({
    description: 'An occasion key from /onboarding/options (same taxonomy as important-dates).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  occasionKey?: string | null;

  @ApiPropertyOptional({ example: 'https://example.com/product/123' })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  productLink?: string | null;

  @ApiPropertyOptional({ type: PriceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceDto)
  price?: PriceDto;

  @ApiPropertyOptional({ description: 'A gift-category key from /onboarding/options' })
  @IsOptional()
  @IsString()
  category?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, default: 3, description: '1 = highest' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  priority?: number;

  @ApiPropertyOptional({ enum: ItemImportance })
  @IsOptional()
  @IsEnum(ItemImportance)
  importance?: ItemImportance;

  @ApiPropertyOptional({ minimum: 1, maximum: 99, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  quantity?: number;

  @ApiPropertyOptional({ type: GiftPreferencesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GiftPreferencesDto)
  giftPreferences?: GiftPreferencesDto;

  @ApiPropertyOptional({ type: [String], description: 'Confirmed media ids you own' })
  @IsOptional()
  @IsMongoId({ each: true })
  mediaIds?: string[];
}

export class UpdateItemDto extends CreateItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Transform(trim)
  declare title: string;
}

export class ReorderItemsDto {
  @ApiProperty({
    type: [String],
    description: 'Item ids in their new order. Must list every active item exactly once.',
  })
  @IsMongoId({ each: true })
  itemIds!: string[];
}

export class ListItemsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ enum: WishlistItemStatus })
  @IsOptional()
  @IsEnum(WishlistItemStatus)
  status?: WishlistItemStatus;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  priority?: number;
}

/**
 * Who to share a wishlist with — a Wishtick user, and only that.
 *
 * Sharing used to accept an email address for somebody without an account,
 * with the row linked up if a matching signup ever arrived. That is gone: the
 * app shares from a grid of WishMates, and anybody else is reached with the
 * list's share link, which makes them an account first.
 */
export class AddParticipantDto {
  @ApiProperty({ description: 'The Wishtick user to share with' })
  @IsMongoId()
  userId!: string;

  @ApiPropertyOptional({ enum: ParticipantRole, default: ParticipantRole.VIEWER })
  @IsOptional()
  @IsEnum(ParticipantRole)
  role?: ParticipantRole;
}

export class PublicWishlistQueryDto {
  @ApiPropertyOptional({ description: 'Required when the link is passcode-protected' })
  @IsOptional()
  @IsString()
  @Length(4, 64)
  passcode?: string;
}
