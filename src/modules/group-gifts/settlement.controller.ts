import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { DistributeReturnDto, RequestTopUpDto, ShareUpiDto } from './dto/group-gift.dto';
import { SettlementService, type GroupGiftBalance } from './settlement.service';
import { toSettlementView, type SettlementView } from './settlement.views';

/**
 * Settling a group gift up (Figma `4092:174`, `4093:444`, `4099:936`,
 * `4099:976`, `4099:1075`, `4099:1199`, `4095:611`, `4095:1036`, `4095:1169`).
 *
 * Nothing here moves money. The host pays a contributor over UPI, or a
 * contributor pays the host, entirely outside the app — these endpoints record
 * who owes what and what each side says has happened. The design is explicit
 * about it: *"You are sending refund of ₹333 to each contributor outside
 * Wishtick. Once sent, mark each refund as 'Sent'."*
 */
@ApiTags('group-gifting')
@Controller()
@ApiBearerAuth()
export class SettlementController {
  constructor(private readonly settlements: SettlementService) {}

  @Get('group-gifts/:id/balance')
  @ApiOperation({
    summary: 'What the group owes or is owed',
    description:
      'Total cost counts the primary item, every extra gift, and every charge — so a ' +
      'delivery charge added after funding puts a funded group back into shortfall.',
  })
  balance(@Param('id') id: string): Promise<GroupGiftBalance> {
    return this.settlements.balance(id);
  }

  @Get('group-gifts/:id/settlements')
  @ApiOperation({ summary: 'Every open and closed balance on this group gift' })
  async list(@Param('id') id: string): Promise<SettlementView[]> {
    const rows = await this.settlements.listForGroupGift(id);
    return rows.map(toSettlementView);
  }

  @Post('group-gifts/:id/settlements/return')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Return a surplus to contributors (initiator only)',
    description:
      'Splits the surplus equally unless `custom` is supplied. Equal splits never lose a ' +
      'paisa — the remainder goes to the earliest contributors.',
  })
  @ApiResponseDoc({ status: 403, description: 'Only the initiator can do this' })
  @ApiResponseDoc({ status: 409, description: 'There is no surplus to return' })
  async distributeReturn(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: DistributeReturnDto,
  ): Promise<SettlementView[]> {
    const rows = await this.settlements.distributeReturn(id, userId, {
      custom: dto.custom,
      note: dto.note,
    });
    return rows.map(toSettlementView);
  }

  @Post('group-gifts/:id/settlements/top-up')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Ask the group for more money (initiator only)',
    description:
      'Raises the target by `additionalAmountMinor` and splits it across named members. ' +
      'The amount is supplied, not derived: the bill is agreed before anyone contributes, ' +
      'so more is only needed because the price moved outside Wishtick.',
  })
  @ApiResponseDoc({ status: 409, description: 'No members to ask' })
  async requestTopUp(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: RequestTopUpDto,
  ): Promise<SettlementView[]> {
    const rows = await this.settlements.requestTopUp(id, userId, {
      additionalAmountMinor: dto.additionalAmountMinor,
      note: dto.note,
    });
    return rows.map(toSettlementView);
  }

  @Post('settlements/:settlementId/upi')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Share the UPI ID you want to be paid on',
    description:
      'Only the person being paid may set it — nobody can redirect someone else’s money.',
  })
  @ApiResponseDoc({ status: 403, description: 'Only the receiver can share a UPI ID' })
  async shareUpi(
    @CurrentUser('id') userId: string,
    @Param('settlementId') settlementId: string,
    @Body() dto: ShareUpiDto,
  ): Promise<SettlementView> {
    const row = await this.settlements.shareUpi(
      settlementId,
      userId,
      dto.upiId,
      dto.saveToProfile ?? false,
    );
    return toSettlementView(row);
  }

  @Post('settlements/:settlementId/sent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark that you have paid (payer only)',
    description: 'A claim, not proof — only the receiver’s confirmation closes a settlement.',
  })
  @ApiResponseDoc({ status: 409, description: 'No UPI ID shared yet, or already settled' })
  async markSent(
    @CurrentUser('id') userId: string,
    @Param('settlementId') settlementId: string,
  ): Promise<SettlementView> {
    return toSettlementView(await this.settlements.markSent(settlementId, userId));
  }

  @Post('settlements/:settlementId/received')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm the money arrived (receiver only)',
    description:
      'Accepted even if the payer never marked it sent: people pay each other over UPI ' +
      'without opening the app, and having the money is what matters.',
  })
  @ApiResponseDoc({ status: 403, description: 'Only the receiver can confirm' })
  async confirmReceived(
    @CurrentUser('id') userId: string,
    @Param('settlementId') settlementId: string,
  ): Promise<SettlementView> {
    return toSettlementView(await this.settlements.confirmReceived(settlementId, userId));
  }
}
