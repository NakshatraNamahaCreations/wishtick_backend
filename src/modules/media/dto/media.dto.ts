import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsMongoId, IsOptional, IsString, Matches, Min } from 'class-validator';
import { MediaPurpose } from '../schemas/media.schema';

export class CreateUploadUrlDto {
  @ApiProperty({ enum: MediaPurpose, example: MediaPurpose.PROFILE_PHOTO })
  @IsEnum(MediaPurpose)
  purpose!: MediaPurpose;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @Matches(/^[a-z]+\/[a-z0-9.+-]+$/, { message: 'contentType must be a valid MIME type' })
  contentType!: string;

  @ApiPropertyOptional({
    example: 204800,
    description: 'Declared size in bytes. Advisory — the real size is verified on confirm.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  sizeBytes?: number;
}

export class ConfirmUploadDto {
  @ApiProperty({ description: 'Media id returned by /media/upload-url' })
  @IsMongoId()
  mediaId!: string;
}
