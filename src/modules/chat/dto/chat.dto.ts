import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ChatType } from '../chat.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class PostMessageDto {
  @ApiPropertyOptional({ description: 'Message text. Required unless attachments are present.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @Transform(trim)
  body?: string;

  @ApiPropertyOptional({ description: 'The message this one replies to.' })
  @IsOptional()
  @IsMongoId()
  replyToId?: string;

  @ApiPropertyOptional({ description: 'Confirmed media ids to attach.', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsMongoId({ each: true })
  attachmentMediaIds?: string[];

  @ApiPropertyOptional({
    default: false,
    description:
      'In a wishlist chat, hide this message from the owner — surprise-gift chatter they must not see.',
  })
  @IsOptional()
  @IsBoolean()
  surprise?: boolean;
}

export class EditMessageDto {
  @ApiPropertyOptional()
  @IsString()
  @MaxLength(4000)
  @Transform(trim)
  body!: string;
}

export class ReactionDto {
  @ApiPropertyOptional({ description: 'A single emoji.' })
  @IsString()
  @MaxLength(16)
  emoji!: string;
}

export class ReadDto {
  @ApiPropertyOptional({ description: 'Mark read up to this message. Defaults to the latest.' })
  @IsOptional()
  @IsMongoId()
  messageId?: string;
}

export class ListMessagesQueryDto {
  @ApiPropertyOptional({ description: 'Return messages older than this id (cursor).' })
  @IsOptional()
  @IsMongoId()
  before?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ListChatsQueryDto {
  @ApiPropertyOptional({ enum: ChatType })
  @IsOptional()
  @IsEnum(ChatType)
  type?: ChatType;
}
