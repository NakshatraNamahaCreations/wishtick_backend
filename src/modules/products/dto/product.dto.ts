import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PLATFORM_KEYS, type PlatformKey } from '../platforms';

export class SearchProductsQueryDto {
  @ApiPropertyOptional({ example: 'headphones' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  q?: string;

  @ApiPropertyOptional({ description: 'A gift-category key from /onboarding/options' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional({ example: 100000, description: 'Minor units' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceMinor?: number;

  @ApiPropertyOptional({ example: 500000, description: 'Minor units' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceMinor?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // Capped: an unbounded page size is a free way to make us hammer the vendor
  // and serialize a megabyte per request.
  @Max(50)
  pageSize?: number;

  @ApiPropertyOptional({
    enum: PLATFORM_KEYS,
    description:
      'Only products sold on this store. Filters the same ~40 results the plain search ' +
      'fetches, so switching stores does not cost another vendor search.',
  })
  @IsOptional()
  @IsIn(PLATFORM_KEYS)
  platform?: PlatformKey;
}

export class ResolveUrlDto {
  @ApiProperty({ example: 'https://shop.example.test/p/hp-001' })
  @IsString()
  @MaxLength(2048)
  // Deliberately NOT @IsUrl: the SSRF guard parses and vets this properly, and
  // two different notions of "valid URL" is how a bypass gets in. The length
  // cap is the only thing worth enforcing here.
  url!: string;
}

export class ImportProductDto {
  @ApiProperty({ example: 'fixture' })
  @IsString()
  @MaxLength(40)
  provider!: string;

  @ApiProperty({ example: 'hp-001' })
  @IsString()
  @MaxLength(200)
  externalId!: string;

  /**
   * The gift's name, when the person changed the product's own.
   *
   * The add-gift sheet fills its name field from the link and leaves it
   * editable; without this, what they typed would be quietly replaced by the
   * catalogue's title the moment they saved.
   */
  @ApiPropertyOptional({ example: 'Galaxy Watch for Dad' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: 'A note for whoever gifts this' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /**
   * Who the buyer is shopping for, when they came through "Gift Now".
   *
   * Free text mirroring `ImportantDate.personName`, and deliberately not a
   * user id: the person being bought for usually has no Wishtick account, and
   * this flow creates no `Gift` — it saves to the buyer's *own* list so they
   * can find it again, then sends them to the shop.
   */
  @ApiPropertyOptional({ example: 'Ananya' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  recipientName?: string;

  @ApiPropertyOptional({ example: 'Sister' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  relation?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: '1 = highest' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  priority?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 99, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity?: number;
}
