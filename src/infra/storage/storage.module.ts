import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import { LocalStorageAdapter } from './adapters/local-storage.adapter';
import { S3StorageAdapter } from './adapters/s3-storage.adapter';
import { STORAGE, type IStorageProvider } from './storage.port';

const logger = new Logger('StorageModule');

@Global()
@Module({
  providers: [
    LocalStorageAdapter,
    S3StorageAdapter,
    {
      provide: STORAGE,
      inject: [ConfigService, LocalStorageAdapter, S3StorageAdapter],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        local: LocalStorageAdapter,
        s3: S3StorageAdapter,
      ): IStorageProvider => {
        const driver = config.get('storage.driver', { infer: true });

        // Local storage on a production instance would put user uploads on an
        // ephemeral pod disk: they vanish on the next deploy and are invisible
        // to every other replica. Fail the boot rather than lose files quietly.
        if (driver === 'local' && config.get('app.isProduction', { infer: true })) {
          throw new Error(
            'STORAGE_DRIVER=local is not usable in production — set STORAGE_DRIVER=s3',
          );
        }

        logger.log(`Storage driver: ${driver}`);
        return driver === 's3' ? s3 : local;
      },
    },
  ],
  exports: [STORAGE, LocalStorageAdapter],
})
export class StorageModule {}
