import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import type { ItemView } from 'src/modules/wishlists/wishlist.views';
import { ImportProductDto } from './dto/product.dto';
import { ProductImportService } from './product-import.service';

/**
 * Lives in ProductsModule but mounts under /wishlists, because the dependency
 * runs that way: products know about wishlists, and wishlists must not know
 * about affiliate networks. Putting this route in WishlistsModule would make
 * the two modules import each other.
 */
@ApiTags('products')
@Controller('wishlists')
@ApiBearerAuth()
export class ProductImportController {
  constructor(private readonly imports: ProductImportService) {}

  @Post(':id/items/from-product')
  @ApiOperation({
    summary: 'Add a catalogue product to a wishlist',
    description:
      'Copies the title, price, image, and link onto the item as they are right now. Later ' +
      'upstream changes are flagged on the item, never applied to it.',
  })
  @ApiResponseDoc({ status: 404, description: 'PRODUCT_NOT_FOUND / WISHLIST_NOT_FOUND' })
  @ApiResponseDoc({ status: 403, description: 'FORBIDDEN — owner only' })
  importProduct(
    @CurrentUser('id') userId: string,
    @Param('id') wishlistId: string,
    @Body() dto: ImportProductDto,
  ): Promise<ItemView> {
    return this.imports.importToWishlist(wishlistId, { userId }, dto);
  }
}
