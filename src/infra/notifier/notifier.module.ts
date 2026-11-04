import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import { ConsoleMailerAdapter } from './adapters/console-mailer.adapter';
import { ConsolePushAdapter } from './adapters/console-push.adapter';
import { ConsoleSmsAdapter } from './adapters/console-sms.adapter';
import { FcmPushAdapter } from './adapters/fcm-push.adapter';
import { HttpSmsAdapter } from './adapters/http-sms.adapter';
import { SesMailerAdapter } from './adapters/ses-mailer.adapter';
import { SmsGraphSmsAdapter } from './adapters/smsgraph-sms.adapter';
import { MAILER, type IMailer } from './mailer.port';
import { PUSH_SENDER, type IPushSender } from './push.port';
import { SMS_SENDER, type ISmsSender } from './sms.port';

/**
 * Driver selection is config-driven, as the port comments promised: adding a
 * provider is adding a `case`, and no consumer of MAILER / SMS_SENDER changes.
 * Console is the dev default; SES, the HTTP SMS gateway and SMSGraph (DLT) are
 * the real drivers.
 */
@Global()
@Module({
  providers: [
    ConsoleMailerAdapter,
    SesMailerAdapter,
    ConsoleSmsAdapter,
    HttpSmsAdapter,
    SmsGraphSmsAdapter,
    ConsolePushAdapter,
    FcmPushAdapter,
    {
      provide: MAILER,
      inject: [ConfigService, ConsoleMailerAdapter, SesMailerAdapter],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        console: ConsoleMailerAdapter,
        ses: SesMailerAdapter,
      ): IMailer =>
        config.get('delivery.mailerDriver', { infer: true }) === 'ses' ? ses : console,
    },
    {
      provide: SMS_SENDER,
      inject: [ConfigService, ConsoleSmsAdapter, HttpSmsAdapter, SmsGraphSmsAdapter],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        console: ConsoleSmsAdapter,
        http: HttpSmsAdapter,
        smsgraph: SmsGraphSmsAdapter,
      ): ISmsSender => {
        switch (config.get('delivery.smsDriver', { infer: true })) {
          case 'http':
            return http;
          case 'smsgraph':
            return smsgraph;
          default:
            return console;
        }
      },
    },
    {
      provide: PUSH_SENDER,
      inject: [ConfigService, ConsolePushAdapter, FcmPushAdapter],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        console: ConsolePushAdapter,
        fcm: FcmPushAdapter,
      ): IPushSender =>
        config.get('delivery.pushDriver', { infer: true }) === 'fcm' ? fcm : console,
    },
  ],
  exports: [MAILER, SMS_SENDER, PUSH_SENDER],
})
export class NotifierModule {}
