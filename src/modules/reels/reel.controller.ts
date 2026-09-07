import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CreateReelDto, ModerateWishDto, ShareReelDto, SubmitWishDto } from './dto/reel.dto';
import { ReelService } from './reel.service';
import type { ReelCollectionView } from './reel.views';

@ApiTags('reels')
@Controller('reels')
@ApiBearerAuth()
export class ReelController {
  constructor(private readonly reels: ReelService) {}

  @Post()
  @ApiOperation({ summary: 'Start a birthday reel collection (releases at local midnight)' })
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateReelDto,
  ): Promise<ReelCollectionView> {
    return this.reels.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Reels you started or are the recipient of' })
  list(@CurrentUser('id') userId: string): Promise<ReelCollectionView[]> {
    return this.reels.listMine(userId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One reel — metadata only until released, then the compiled video',
  })
  get(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<ReelCollectionView> {
    return this.reels.getForUser(id, userId);
  }

  @Post(':id/wishes')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a wish (text, or a confirmed audio/video media id)' })
  @ApiResponseDoc({ status: 400, description: 'WISH_DURATION_EXCEEDED / WISH_MEDIA_INVALID' })
  @ApiResponseDoc({ status: 409, description: 'REEL_NOT_ACCEPTING_WISHES' })
  submitWish(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: SubmitWishDto,
  ): Promise<{ id: string; kind: string; moderationStatus: string }> {
    return this.reels.submitWish(id, userId, dto);
  }

  @Post(':id/wishes/:wishId/moderate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject a wish (initiator)' })
  moderate(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('wishId') wishId: string,
    @Body() dto: ModerateWishDto,
  ): Promise<{ id: string; moderationStatus: string }> {
    return this.reels.moderateWish(id, wishId, userId, dto.decision);
  }

  @Post(':id/regenerate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recompile after moderation removals (initiator)' })
  regenerate(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<ReelCollectionView> {
    return this.reels.regenerate(id, userId);
  }

  @Post(':id/share')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Configure the public share link (initiator)' })
  share(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ShareReelDto,
  ): Promise<ReelCollectionView> {
    return this.reels.configureShare(id, userId, dto);
  }
}
