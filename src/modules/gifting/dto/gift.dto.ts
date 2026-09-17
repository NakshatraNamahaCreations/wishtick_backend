import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ReserveItemDto {
  @ApiPropertyOptional({
    default: true,
    description: 'Keep the reservation hidden from the wishlist owner (a surprise).',
  })
  @IsOptional()
  @IsBoolean()
  hiddenFromOwner?: boolean;
}

export class GiftOfflineDto {
  @ApiPropertyOptional({ description: 'A note for the owner, e.g. how it was delivered' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  deliveryNotes?: string;

  @ApiPropertyOptional({ description: 'When it was bought/handed over. Defaults to now.' })
  @IsOptional()
  @IsDateString({ strict: true })
  confirmedAt?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  hiddenFromOwner?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Show your first name on the bought item to other guests. Never shown to the person ' +
      'the gift is for.',
  })
  @IsOptional()
  @IsBoolean()
  showName?: boolean;
}

export class GiftActionDto {
  @ApiPropertyOptional({ description: 'A note recorded on the gift history' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;

  @ApiPropertyOptional({ description: 'Delivery notes to attach' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  deliveryNotes?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Show your first name on the bought item to other guests. Never shown to the person ' +
      'the gift is for.',
  })
  @IsOptional()
  @IsBoolean()
  showName?: boolean;
}

export class SetShowNameDto {
  @ApiProperty({ description: 'Show your first name on the bought item to other guests' })
  @IsBoolean()
  showName!: boolean;
}
