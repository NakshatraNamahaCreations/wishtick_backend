import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { OrderStage } from '../order.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CourierWebhookDto {
  @ApiProperty({
    example: 'WTK-20260714-1989',
    description: "Wishtick's own order reference, as given to the courier.",
  })
  @IsString()
  @MaxLength(64)
  @Transform(trim)
  reference!: string;

  @ApiProperty({ enum: OrderStage, description: 'The stage the parcel has reached.' })
  @IsEnum(OrderStage)
  stage!: OrderStage;

  @ApiPropertyOptional({ description: 'When it happened at the carrier. Defaults to now.' })
  @IsOptional()
  @IsDateString({ strict: true })
  occurredAt?: string;

  @ApiPropertyOptional({
    example: 'Delhivery',
    description: 'Defaults to the :provider path param.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  courier?: string;

  @ApiPropertyOptional({ example: '90147091018' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  trackingNumber?: string;

  @ApiPropertyOptional({ description: "The carrier's own tracking page." })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Transform(trim)
  trackingUrl?: string;

  @ApiPropertyOptional({ example: 'Standard Delivery' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  deliveryMethod?: string;

  @ApiPropertyOptional({ description: 'Start of the promised delivery window.' })
  @IsOptional()
  @IsDateString({ strict: true })
  estimatedDeliveryFrom?: string;

  @ApiPropertyOptional({ description: 'End of the promised delivery window.' })
  @IsOptional()
  @IsDateString({ strict: true })
  estimatedDeliveryTo?: string;

  @ApiPropertyOptional({ description: 'Anything the carrier wants shown on the row.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}
