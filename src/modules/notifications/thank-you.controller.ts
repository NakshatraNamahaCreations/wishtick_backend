import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { EditThankYouDto } from './dto/notification.dto';
import { toThankYouView, type ThankYouView } from './notification.views';
import { ThankYouService } from './thank-you.service';

@ApiTags('notifications')
@Controller('thank-you')
@ApiBearerAuth()
export class ThankYouController {
  constructor(private readonly thankYou: ThankYouService) {}

  @Get()
  @ApiOperation({ summary: 'Your thank-you notes (drafted from fulfilled gifts)' })
  async list(@CurrentUser('id') userId: string): Promise<ThankYouView[]> {
    return (await this.thankYou.list(userId)).map(toThankYouView);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Preview a thank-you note before it sends' })
  async get(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<ThankYouView> {
    return toThankYouView(await this.thankYou.get(id, userId));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit the note before it goes out' })
  @ApiResponseDoc({ status: 409, description: 'THANK_YOU_ALREADY_SENT' })
  async edit(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: EditThankYouDto,
  ): Promise<ThankYouView> {
    return toThankYouView(await this.thankYou.edit(id, userId, dto));
  }

  @Post(':id/send-now')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send the thank-you now instead of waiting' })
  async sendNow(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<ThankYouView> {
    return toThankYouView(await this.thankYou.sendNow(id, userId));
  }

  @Post(':id/skip')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Skip this thank-you note' })
  async skip(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<ThankYouView> {
    return toThankYouView(await this.thankYou.skip(id, userId));
  }
}
