import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BLOG_SLUG_PATTERN, BlogStatus } from '../blog.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Everything an editor can set on a post. Publishing has its own calls. */
export class CreateBlogPostDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsString()
  @Length(1, 200)
  @Transform(trim)
  title!: string;

  @ApiPropertyOptional({ description: 'Made from the title when left out.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(BLOG_SLUG_PATTERN, {
    message: 'slug is lower-case letters and digits joined by hyphens',
  })
  slug?: string;

  @ApiPropertyOptional({ maxLength: 400 })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  @Transform(trim)
  excerpt?: string;

  @ApiPropertyOptional({ description: "The editor's own document, to reopen it as written." })
  @IsOptional()
  @IsObject()
  contentJson?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'The body as HTML; sanitized before it is stored.' })
  @IsOptional()
  @IsString()
  @MaxLength(400_000)
  contentHtml?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverUrl?: string | null;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  coverAlt?: string;

  @ApiPropertyOptional({ maxLength: 40, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(trim)
  category?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ maxLength: 70 })
  @IsOptional()
  @IsString()
  @MaxLength(70)
  @Transform(trim)
  seoTitle?: string;

  @ApiPropertyOptional({ maxLength: 170 })
  @IsOptional()
  @IsString()
  @MaxLength(170)
  @Transform(trim)
  seoDescription?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  authorName?: string;
}

export class UpdateBlogPostDto extends PartialType(CreateBlogPostDto) {}

export class PublishBlogPostDto {
  @ApiPropertyOptional({ description: 'A future time schedules it; left out, it goes live now.' })
  @IsOptional()
  @IsISO8601()
  publishAt?: string;
}

export class AdminBlogListQueryDto {
  @ApiPropertyOptional({ enum: Object.values(BlogStatus) })
  @IsOptional()
  @IsIn(Object.values(BlogStatus))
  status?: BlogStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class PublicBlogListQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  tag?: string;
}
