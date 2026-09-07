import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ResolveUrlDto, SearchProductsQueryDto } from './dto/product.dto';
import type { NormalizedProduct, ProviderCategory, ResultFreshness } from './product.types';
import { ProductsService, type SearchResponse } from './products.service';
import { UrlResolverService, type ResolvedUrlProduct } from './url-resolver.service';

/** Every search may cost a vendor API call, and the quota is per-account. */
const SEARCH_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

/**
 * Tighter: this endpoint makes our server fetch a URL the caller chose. Even
 * with the SSRF guard, it must not be a free scanning tool.
 */
const RESOLVE_URL_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('products')
@Controller('products')
@ApiBearerAuth()
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly urls: UrlResolverService,
  ) {}

  @Get('search')
  @Throttle(SEARCH_THROTTLE)
  @ApiOperation({
    summary: 'Search the product catalogue',
    description:
      'Cached 6h. `freshness` is live | cached | stale — `stale` means the provider is down ' +
      'and these are last-known results rather than an error.',
  })
  @ApiResponseDoc({ status: 503, description: 'PRODUCT_SEARCH_UNAVAILABLE — down with no cache' })
  search(@Query() query: SearchProductsQueryDto): Promise<SearchResponse> {
    return this.products.search({
      q: query.q,
      category: query.category,
      minPriceMinor: query.minPriceMinor,
      maxPriceMinor: query.maxPriceMinor,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    });
  }

  @Get('categories')
  @ApiOperation({ summary: 'Categories the catalogue can be browsed by' })
  getCategories(): Promise<{ categories: ProviderCategory[]; freshness: ResultFreshness }> {
    return this.products.getCategories();
  }

  @Post('resolve-url')
  @HttpCode(HttpStatus.OK)
  @Throttle(RESOLVE_URL_THROTTLE)
  @ApiOperation({
    summary: 'Resolve a pasted product URL',
    description:
      'Asks the provider first; falls back to reading Open Graph tags. The fetch is SSRF-guarded ' +
      'by resolved address, and every redirect hop is re-checked.',
  })
  @ApiResponseDoc({ status: 400, description: 'URL_NOT_ALLOWED' })
  @ApiResponseDoc({ status: 422, description: 'PRODUCT_URL_UNSUPPORTED / PRODUCT_URL_UNREACHABLE' })
  resolveUrl(@Body() dto: ResolveUrlDto): Promise<ResolvedUrlProduct> {
    return this.urls.resolve(dto.url);
  }

  /**
   * One product by our own id, for a caller holding an item's
   * `sourceProductId` rather than a provider reference.
   *
   * Declared ahead of `:provider/:externalId` — both are two segments, and
   * Nest matches in declaration order, so the other route would otherwise
   * swallow this one with `provider: 'id'`.
   */
  @Get('id/:productId')
  @ApiOperation({
    summary: 'One product, by catalogue id',
    description:
      "Resolves the id to its provider reference and answers exactly as the provider route does — " +
      'so a saved wishlist item can show the seller, rating and specifications its snapshot never carried.',
  })
  @ApiResponseDoc({ status: 404, description: 'PRODUCT_NOT_FOUND' })
  getDetailsById(
    @Param('productId') productId: string,
  ): Promise<{ product: NormalizedProduct; freshness: ResultFreshness }> {
    return this.products.getDetailsById(productId);
  }

  @Get(':provider/:externalId')
  @ApiOperation({
    summary: 'One product',
    description: 'Falls back to our stored snapshot when the provider is unavailable.',
  })
  @ApiResponseDoc({ status: 404, description: 'PRODUCT_NOT_FOUND / PRODUCT_PROVIDER_UNKNOWN' })
  getDetails(
    @Param('provider') provider: string,
    @Param('externalId') externalId: string,
  ): Promise<{ product: NormalizedProduct; freshness: ResultFreshness }> {
    return this.products.getDetails(provider, externalId);
  }
}
