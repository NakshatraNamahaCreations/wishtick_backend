import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { AppConfig } from 'src/config/configuration';

const logger = new Logger('MongoModule');

@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const mongo = config.get('mongo', { infer: true });
        return {
          uri: mongo.uri,
          dbName: mongo.dbName,
          // Pool bounds are env-tuned (MONGO_MAX_POOL_SIZE / MONGO_MIN_POOL_SIZE)
          // so a load test can raise them per environment without a code change.
          maxPoolSize: mongo.maxPoolSize,
          minPoolSize: mongo.minPoolSize,
          serverSelectionTimeoutMS: 10_000,
          socketTimeoutMS: 45_000,
          retryWrites: true,
          autoIndex: config.get('app.env', { infer: true }) !== 'production',
          connectionFactory: (connection: Connection): Connection => {
            connection.on('connected', () => logger.log(`Mongo connected (db: ${mongo.dbName})`));
            connection.on('disconnected', () => logger.warn('Mongo disconnected'));
            connection.on('reconnected', () => logger.log('Mongo reconnected'));
            connection.on('error', (err: Error) => logger.error(`Mongo error: ${err.message}`));
            return connection;
          },
        };
      },
    }),
  ],
  exports: [MongooseModule],
})
export class MongoModule {}
