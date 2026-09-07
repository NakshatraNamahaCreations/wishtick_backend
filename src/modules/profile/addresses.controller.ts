import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { AddressesService, type AddressView } from './addresses.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

/**
 * The user's saved delivery addresses (`2293:25`, `324:1295`, `324:1340`).
 *
 * Home's "Where To Deliver?" header reads the default, checkout picks one by
 * id, and the Profile address book manages the lot.
 */
@ApiTags('profile')
@Controller('me/addresses')
@ApiBearerAuth()
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  @ApiOperation({ summary: 'Saved addresses, default first' })
  list(@CurrentUser('id') userId: string): Promise<AddressView[]> {
    return this.addresses.list(userId);
  }

  @Post()
  @ApiOperation({
    summary: 'Save an address',
    description: 'The first address saved becomes the default automatically.',
  })
  @ApiResponseDoc({ status: 400, description: 'VALIDATION_FAILED — bad pincode, or cap reached' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateAddressDto): Promise<AddressView> {
    return this.addresses.create(userId, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an address',
    description:
      'Send isDefault:true to promote it; the previous default is demoted in the same call.',
  })
  @ApiResponseDoc({ status: 404, description: 'NOT_FOUND — unknown or not yours' })
  @ApiResponseDoc({ status: 400, description: 'VALIDATION_FAILED — cannot clear the only default' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ): Promise<AddressView> {
    return this.addresses.update(userId, id, dto);
  }

  @Post(':id/default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Make this the address orders default to',
    description: 'The promotion on its own — the previous default is demoted in the same call.',
  })
  @ApiResponseDoc({ status: 404, description: 'NOT_FOUND — unknown or not yours' })
  setDefault(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<AddressView> {
    return this.addresses.setDefault(userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove an address',
    description: 'Removing the default promotes the next-oldest address.',
  })
  @ApiResponseDoc({ status: 404, description: 'NOT_FOUND — unknown or not yours' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<void> {
    return this.addresses.remove(userId, id);
  }
}
