import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import { BunnyStreamAdapter } from './adapters/bunny-stream.adapter';
import { PassthroughVideoAdapter } from './adapters/passthrough-video.adapter';
import { VIDEO, type IVideoProvider } from './video.port';

const logger = new Logger('VideoModule');

@Global()
@Module({
  providers: [
    BunnyStreamAdapter,
    PassthroughVideoAdapter,
    {
      provide: VIDEO,
      inject: [ConfigService, BunnyStreamAdapter, PassthroughVideoAdapter],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        stream: BunnyStreamAdapter,
        passthrough: PassthroughVideoAdapter,
      ): IVideoProvider => {
        const driver = config.get('video', { infer: true }).driver;
        logger.log(`Video driver: ${driver}`);
        return driver === 'bunny_stream' ? stream : passthrough;
      },
    },
  ],
  exports: [VIDEO],
})
export class VideoModule {}
