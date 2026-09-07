import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsTimezone } from 'src/common/validators/is-timezone.validator';
import { EventType, EventVisibility, RsvpResponse } from '../event.types';
import { GuestListFormat } from '../guest-list-export.service';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class InviteTemplateChoiceDto {
  @ApiProperty({ example: 'celebration' })
  @IsString()
  @MaxLength(40)
  templateId!: string;

  @ApiProperty({ example: 'blush' })
  @IsString()
  @MaxLength(40)
  colorVariant!: string;

  @ApiPropertyOptional({
    description: 'Copy for the template slots, e.g. { headline, subtitle, venue }',
    example: { headline: "Aarav's 30th", venue: 'The Terrace' },
  })
  @IsOptional()
  @IsObject()
  fields?: Record<string, string>;
}

export class CreateEventDto {
  @ApiProperty({ example: "Aarav's 30th Birthday" })
  @IsString()
  @Length(1, 140)
  @Transform(trim)
  title!: string;

  @ApiProperty({ enum: EventType })
  @IsEnum(EventType)
  type!: EventType;

  @ApiProperty({ example: '2026-09-14T13:30:00.000Z' })
  @IsDateString({ strict: true })
  startsAt!: string;

  @ApiPropertyOptional({ example: '2026-09-14T17:00:00.000Z' })
  @IsOptional()
  @IsDateString({ strict: true })
  endsAt?: string | null;

  @ApiProperty({ example: 'Asia/Kolkata', description: 'Where the event actually happens' })
  @IsTimezone()
  timezone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  description?: string | null;

  @ApiPropertyOptional({ enum: EventVisibility, default: EventVisibility.PRIVATE })
  @IsOptional()
  @IsEnum(EventVisibility)
  visibility?: EventVisibility;

  @ApiPropertyOptional({ description: 'A confirmed media id you own (purpose: event_cover)' })
  @IsOptional()
  @IsMongoId()
  coverMediaId?: string | null;

  @ApiPropertyOptional({
    description:
      'A confirmed media id you own (purpose: event_invite) — your own invitation. Taken at ' +
      'create, not only on update, because the app uploads the card before the event exists: ' +
      'the event is made only once the host has seen the preview and gone on to share it.',
  })
  @IsOptional()
  @IsMongoId()
  inviteMediaId?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'Wishlists you own, shown on the invite' })
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  @ArrayMaxSize(10)
  wishlistIds?: string[];

  @ApiPropertyOptional({ type: InviteTemplateChoiceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => InviteTemplateChoiceDto)
  inviteTemplate?: InviteTemplateChoiceDto;
  @ApiPropertyOptional({ description: 'Where it is happening (`257:755`)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  venue?: string | null;

  @ApiPropertyOptional({ description: 'Who the event is for (`257:733`)', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  personName?: string | null;

  @ApiPropertyOptional({ description: 'A `relation` taxonomy key (`2252:423`)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  relation?: string | null;

  @ApiPropertyOptional({
    description:
      'The host is the one being celebrated — their own birthday or wedding. Distinct from ' +
      'leaving personName/relation empty, which is what an unfinished draft looks like.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  forSelf?: boolean;
}

export class UpdateEventDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 140)
  @Transform(trim)
  title?: string;

  @ApiPropertyOptional({ enum: EventType })
  @IsOptional()
  @IsEnum(EventType)
  type?: EventType;

  @ApiPropertyOptional({ description: 'Moving this reschedules every reminder' })
  @IsOptional()
  @IsDateString({ strict: true })
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({ strict: true })
  endsAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsTimezone()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  description?: string | null;

  @ApiPropertyOptional({ enum: EventVisibility })
  @IsOptional()
  @IsEnum(EventVisibility)
  visibility?: EventVisibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  coverMediaId?: string | null;

  @ApiPropertyOptional({
    description: 'A confirmed media id you own (purpose: event_invite) — your own invitation',
  })
  @IsOptional()
  @IsMongoId()
  inviteMediaId?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  @ArrayMaxSize(10)
  wishlistIds?: string[];

  @ApiPropertyOptional({ type: InviteTemplateChoiceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => InviteTemplateChoiceDto)
  inviteTemplate?: InviteTemplateChoiceDto;
  @ApiPropertyOptional({ description: 'Where it is happening (`257:755`)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  venue?: string | null;

  @ApiPropertyOptional({ description: 'Who the event is for (`257:733`)', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  personName?: string | null;

  @ApiPropertyOptional({ description: 'A `relation` taxonomy key (`2252:423`)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  relation?: string | null;

  @ApiPropertyOptional({
    description:
      'The host is the one being celebrated — their own birthday or wedding. Distinct from ' +
      'leaving personName/relation empty, which is what an unfinished draft looks like.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  forSelf?: boolean;
}

/**
 * Who is being invited — a Wishtick user, and only that.
 *
 * Invitations used to be addressed to an email or a phone number, with the
 * account linked up later if the person ever signed up. That is gone: the app
 * invites from a grid of WishMates, so a recipient is always somebody who
 * already has an account, and the invite is bound to it from the first moment
 * rather than after a signup happens to match an address.
 *
 * Somebody who is *not* a WishMate is reached by the share link instead — see
 * `POST /events/by-slug/:slug/join`, where identity comes from signing in.
 */
export class InviteRecipientDto {
  @ApiProperty({ description: 'The Wishtick user to invite' })
  @IsMongoId()
  userId!: string;
}

export class BulkInviteDto {
  @ApiProperty({
    type: [InviteRecipientDto],
    description: 'Duplicates are collapsed, not rejected',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InviteRecipientDto)
  // A guest list, not an import job. Beyond this it is someone pasting a
  // contact export, and every entry is a real message with a real cost.
  @ArrayMaxSize(200)
  recipients!: InviteRecipientDto[];
}

/**
 * Numbers picked out of the host's contacts.
 *
 * Loose validation on purpose: a contacts list is full of numbers written
 * every possible way, and the server normalises rather than refuses. What it
 * will not take is something that cannot be a phone number at all.
 */
export class InviteByPhoneDto {
  @ApiProperty({
    type: [String],
    description:
      'Phone numbers in E.164 (`+919876543210`). The client resolves each ' +
      'contact against the device region before sending; the server only ' +
      'strips spacing and adds the leading +.',
    example: ['+919876543210', '+919812345678'],
  })
  @IsArray()
  @IsString({ each: true })
  // The same ceiling as a WishMate bulk invite: past this it is a contacts
  // export rather than a guest list, and every entry is a real invitation.
  @ArrayMaxSize(200)
  @Matches(/^\+?[0-9\s()-]{6,20}$/, {
    each: true,
    message: 'Each recipient must be a phone number',
  })
  phones!: string[];
}

export class RsvpDto {
  @ApiProperty({ enum: [RsvpResponse.YES, RsvpResponse.NO, RsvpResponse.MAYBE] })
  @IsEnum(RsvpResponse)
  response!: RsvpResponse;

  @ApiPropertyOptional({ minimum: 0, maximum: 10, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  plusOnes?: number;

  @ApiPropertyOptional({ example: 'Wouldn’t miss it!' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  message?: string;
}

export class PreviewInviteDto {
  @ApiPropertyOptional({
    type: InviteTemplateChoiceDto,
    description: "Preview an unsaved choice. Defaults to the event's saved template.",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => InviteTemplateChoiceDto)
  inviteTemplate?: InviteTemplateChoiceDto;
}

export class ListTemplatesQueryDto {
  @ApiPropertyOptional({ enum: EventType })
  @IsOptional()
  @IsEnum(EventType)
  eventType?: EventType;
}

/** Which file "Download Guest List" should produce (`4096:206`). */
export class ExportGuestListQueryDto {
  @ApiPropertyOptional({ enum: GuestListFormat, default: GuestListFormat.PDF })
  @IsOptional()
  @IsEnum(GuestListFormat)
  format?: GuestListFormat;
}

/**
 * The ids a multi-select delete is asking to remove.
 *
 * Bulk rather than one call each, because the gesture is inherently plural:
 * the host ticks several and presses delete once, and N round trips would let
 * the list end up half-deleted with no single answer to report.
 */
export class BulkDeleteEventsDto {
  @ApiProperty({ type: [String], description: 'Events to delete permanently' })
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  ids!: string[];
}

/** A guest offering one of their own wishlists to an event. */
export class SubmitEventWishlistDto {
  @ApiProperty({ description: 'A wishlist you own that is not on an event yet' })
  @IsMongoId()
  wishlistId!: string;
}
