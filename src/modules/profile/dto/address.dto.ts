import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AddressLabel } from '../schemas/address.schema';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** An empty field in the form means "not given", not an empty string. */
const trimToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/** The field set of "Add New Address" (`324:1340`), in the frame's own order. */
export class CreateAddressDto {
  @ApiPropertyOptional({ enum: AddressLabel, default: AddressLabel.HOME })
  @IsOptional()
  @IsEnum(AddressLabel)
  label?: AddressLabel;

  @ApiProperty({ example: 'Siya', description: 'Who receives the parcel' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(trim)
  fullName!: string;

  @ApiProperty({ example: '9890900089' })
  @IsString()
  // Deliberately loose: 7–19 digits with an optional +country. Indian numbers
  // are the common case but a stricter pattern would reject a valid overseas
  // one, and the parcel is not always going to India.
  @Matches(/^\+?[0-9][0-9 -]{6,18}$/, { message: 'mobile must be a phone number' })
  @Transform(trim)
  mobile!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\+?[0-9][0-9 -]{6,18}$/, { message: 'altMobile must be a phone number' })
  @Transform(trimToNull)
  altMobile?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  @Transform(trimToNull)
  email?: string | null;

  @ApiProperty({ example: 'D-Block', description: 'Flat No / Building Name' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Transform(trim)
  line1!: string;

  @ApiProperty({ example: 'JP Nagar', description: 'Locality / Area' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Transform(trim)
  locality!: string;

  @ApiPropertyOptional({ example: 'Near Metro Station' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trimToNull)
  landmark?: string | null;

  @ApiProperty({ example: '570031', description: 'Six-digit Indian PIN code' })
  @IsString()
  @Matches(/^[1-9][0-9]{5}$/, {
    message: 'pincode must be a six-digit Indian PIN code',
  })
  @Transform(trim)
  pincode!: string;

  @ApiProperty({ example: 'Mysuru' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(trim)
  city!: string;

  @ApiProperty({ example: 'Karnataka' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(trim)
  state!: string;

  @ApiPropertyOptional({ default: 'IN', description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  countryCode?: string;

  @ApiPropertyOptional({
    description: 'Make this the default. The first address saved is always the default.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** Every field optional; only what is sent changes. */
export class UpdateAddressDto extends PartialType(CreateAddressDto) {}
