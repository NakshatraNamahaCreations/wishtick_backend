import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { PersonWishlistsService } from './person-wishlists.service';
import type { WishlistView } from './wishlist.views';

@ApiTags('wishlists')
@Controller()
@ApiBearerAuth()
export class PersonWishlistsController {
  constructor(private readonly lists: PersonWishlistsService) {}

  @Get('people/:userId/wishlists')
  @ApiOperation({
    summary: "Somebody's wishlists that you may see",
    description:
      'For their profile: the lists they share with WishMates, their public ones, and any ' +
      'you were added to. Private ones never appear; your own profile lists none here.',
  })
  listFor(
    @CurrentUser('id') viewerId: string,
    @Param('userId') userId: string,
  ): Promise<WishlistView[]> {
    return this.lists.listFor(viewerId, userId);
  }
}
