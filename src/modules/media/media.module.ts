import { Module, type MiddlewareConsumer, type NestModule, type Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { AppConfig } from 'src/config/configuration';
import { LocalUploadRawBodyMiddleware } from './local-upload-raw-body.middleware';
import { LocalUploadController } from './local-upload.controller';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { Media, MediaSchema } from './schemas/media.schema';

/**
 * The local upload controller is registered only for the local driver: mounting
 * a public, unauthenticated PUT endpoint that anyone could probe has no business
 * existing on an instance that stores to S3.
 */
const localControllers = (): Type<unknown>[] =>
  (process.env.STORAGE_DRIVER ?? 'local') === 'local' ? [LocalUploadController] : [];

@Module({
  imports: [MongooseModule.forFeature([{ name: Media.name, schema: MediaSchema }])],
  controllers: [MediaController, ...localControllers()],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule implements NestModule {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  configure(consumer: MiddlewareConsumer): void {
    if (this.config.get('storage.driver', { infer: true }) !== 'local') return;

    // Registered for every route but active only on the local upload PUT — see
    // the middleware for why it cannot be path-scoped here.
    consumer.apply(LocalUploadRawBodyMiddleware).forRoutes('{*path}');
  }
}
