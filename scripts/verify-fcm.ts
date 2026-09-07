/* eslint-disable no-console */
/**
 * Proves the Firebase credential actually works, without needing a handset.
 *
 * The FCM adapter's doc comment says its network path has never run. This runs
 * it: the real adapter, the real key, a real OAuth exchange with Google, and a
 * real send to a deliberately invalid registration token.
 *
 * A bogus token is the point. Reaching FCM at all means the JWT signed and
 * Google accepted it — which is the half that can be wrong. FCM then answers
 * 400 for the token itself, which the adapter classifies as `unregistered`,
 * exactly as it would for a device that had uninstalled the app.
 *
 *   npm run verify:fcm
 */
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../src/config/configuration';
import { FcmPushAdapter } from '../src/infra/notifier/adapters/fcm-push.adapter';

async function main(): Promise<void> {
  // Loaded by `-r dotenv/config` in the npm script, as the sibling verify
  // scripts do. dotenv already strips the surrounding quotes and leaves the
  // `\n` escapes alone, which is exactly what the adapter expects.
  const env = process.env;
  const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].filter(
    (k) => !env[k],
  );
  if (missing.length > 0) {
    console.error(`Missing in .env: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log(`driver     ${env.PUSH_DRIVER ?? '(unset)'}`);
  console.log(`project    ${env.FIREBASE_PROJECT_ID}`);
  console.log(`account    ${env.FIREBASE_CLIENT_EMAIL}`);
  console.log('');

  const config = {
    get: () => ({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY,
    }),
  } as unknown as ConfigService<AppConfig, true>;

  const adapter = new FcmPushAdapter(config);

  try {
    const result = await adapter.send({
      tokens: ['not-a-real-registration-token'],
      title: 'Wishtick credential check',
      body: 'If you can read this on a phone, something is very wrong.',
      data: { type: 'account_security', refId: 'check' },
    });

    // Reaching here at all means the JWT signed and Google minted a token.
    if (result.unregistered.length === 1 && result.sent === 0) {
      console.log('PASS  Google accepted the credential.');
      console.log('      The bogus token came back as unregistered, which is');
      console.log('      what a real dead device looks like. A live token');
      console.log('      would have been delivered.');
      return;
    }
    console.log('UNEXPECTED', JSON.stringify(result));
    process.exit(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL  ${message}`);
    if (message.includes('auth returned 400')) {
      console.error('      A 400 from the OAuth endpoint is almost always the');
      console.error('      private key: check it is double-quoted and that its');
      console.error('      newlines are the two characters \\n, not real ones.');
    }
    if (message.includes('auth returned 401')) {
      console.error('      401 means the key signed but was rejected — usually a');
      console.error('      key that has been revoked in the Firebase console.');
    }
    process.exit(1);
  }
}

void main();
