import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsMongoId,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ContributionMode, GroupGiftVisibility, OverfundPolicy } from '../group-gift.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** A non-item cost: delivery, packaging, handling (`4007:628`). */
export class AddChargeDto {
  @ApiProperty({ example: 'Delivery' })
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  label!: string;

  /** Minor units, like every other amount in this module. */
  @ApiProperty({ minimum: 1, example: 20000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountMinor!: number;
}

export class CreateGroupGiftDto {
  /** `299:1658` marks Group Title with a red asterisk. */
  @ApiProperty({ example: "Siya's birthday gift", maxLength: 120 })
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  title!: string;

  @ApiPropertyOptional({
    description:
      'Target in minor units. Defaults to the item price. Charges and extra gifts are ' +
      'added to it, so the stored target is always the Grand Total.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  targetAmountMinor?: number;

  /**
   * Where members send their share (`299:1658` — "All group payments will be
   * collected in your account"). Optional at create so a host can add it before
   * sharing the link; nobody can be asked to pay without one.
   */
  @ApiPropertyOptional({ example: 'rohanr1@okaxis' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  hostUpiId?: string;

  @ApiPropertyOptional({ enum: ContributionMode, default: ContributionMode.EQUAL })
  @IsOptional()
  @IsEnum(ContributionMode)
  contributionMode?: ContributionMode;

  /** The ₹500 / ₹1,000 / ₹2,000 chips, in minor units. */
  @ApiPropertyOptional({ type: [Number], example: [50000, 100000, 200000] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  suggestedAmountsMinor?: number[];

  /** Charges agreed up front, before anyone contributes (`4007:568`). */
  @ApiPropertyOptional({ type: [AddChargeDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AddChargeDto)
  charges?: AddChargeDto[];

  @ApiPropertyOptional({ description: 'When the collection closes. Must be in the future.' })
  @IsOptional()
  @IsDateString({ strict: true })
  deadline?: string;

  @ApiPropertyOptional({ enum: OverfundPolicy, default: OverfundPolicy.CAP })
  @IsOptional()
  @IsEnum(OverfundPolicy)
  overfundPolicy?: OverfundPolicy;

  @ApiPropertyOptional({
    enum: GroupGiftVisibility,
    default: GroupGiftVisibility.HIDDEN_FROM_OWNER,
  })
  @IsOptional()
  @IsEnum(GroupGiftVisibility)
  visibility?: GroupGiftVisibility;

  @ApiPropertyOptional({ description: "The initiator's pitch, shown on the share card." })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  @Transform(trim)
  message?: string;
}

export class ContributeDto {
  @ApiProperty({ description: 'Contribution in minor units.' })
  @IsInt()
  @Min(1)
  amountMinor!: number;

  @ApiPropertyOptional({ description: 'A note shown alongside the contribution.' })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  @Transform(trim)
  message?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Hide your identity from every participant list (the total still counts you).',
  })
  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;
}

export class GroupGiftActionDto {
  @ApiPropertyOptional({ description: 'A note recorded on the group-gift history.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}

export class ShareGroupGiftDto {
  @ApiPropertyOptional({ description: 'Rotate the slug, invalidating the old link.' })
  @IsOptional()
  @IsBoolean()
  rotate?: boolean;

  @ApiPropertyOptional({ description: 'Set a passcode, or null to clear it.', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(trim)
  passcode?: string | null;

  @ApiPropertyOptional({ description: 'Set an expiry, or null to clear it.', nullable: true })
  @IsOptional()
  @IsDateString({ strict: true })
  expiresAt?: string | null;
}

export class PublicGroupGiftQueryDto {
  @ApiPropertyOptional({ description: 'Passcode, if the link requires one.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  passcode?: string;
}

export class ListMyGroupGiftsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

// ── Settle-up (Sprint 6b) ────────────────────────────────────────────────────

export class AddGiftLineDto {
  @ApiProperty({ description: 'A second item to fold into this group gift.' })
  @IsString()
  itemId!: string;
}

export class ReturnAllocationDto {
  @ApiProperty()
  @IsString()
  contributorId!: string;

  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountMinor!: number;
}

export class DistributeReturnDto {
  /**
   * Omit for "split equally" — the default the design pre-selects. Supplying
   * this is the "Custom Refund" branch of `4093:444`.
   */
  @ApiPropertyOptional({ type: [ReturnAllocationDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ReturnAllocationDto)
  custom?: ReturnAllocationDto[];

  @ApiPropertyOptional({ maxLength: 280 })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  @Transform(trim)
  note?: string;
}

export class RequestTopUpDto {
  /**
   * "Additional Amount Required" on `4092:174`, in minor units.
   *
   * Supplied rather than derived: the bill is settled before anyone
   * contributes, so more money is only ever needed because the price moved
   * outside Wishtick — and only the host can see that.
   */
  @ApiProperty({ minimum: 1, example: 200000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  additionalAmountMinor!: number;

  /** The "Message to group (optional)" field on `4092:174`. */
  @ApiPropertyOptional({ maxLength: 280 })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  @Transform(trim)
  note?: string;
}

/** The recipient's thank-you note (`2219:603`). */
export class ThankYouDto {
  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  note!: string;
}

export class ShareUpiDto {
  @ApiProperty({ example: 'name@okhdfc' })
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  upiId!: string;

  /** `4095:611`'s "Save this UPI ID in my profile" checkbox. */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  saveToProfile?: boolean;
}

/** The WishMates a member is asking to chip in. */
export class InviteToGroupGiftDto {
  @ApiProperty({ type: [String], description: 'WishMates of the caller' })
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  userIds!: string[];
}
