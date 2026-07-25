import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  createETradeSdk,
  getETradeBaseUrl,
  type ETradeEnvironment,
} from './etrade.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readEnvironment(): ETradeEnvironment {
  const value = process.env.ETRADE_ENVIRONMENT ?? 'sandbox';
  if (value !== 'sandbox' && value !== 'live') {
    throw new Error('ETRADE_ENVIRONMENT must be "sandbox" or "live"');
  }
  return value;
}

async function main(): Promise<void> {
  const consumerKey = requireEnv('ETRADE_CONSUMER_KEY');
  const consumerSecret = requireEnv('ETRADE_CONSUMER_SECRET');
  const environment = readEnvironment();
  const baseUrl = getETradeBaseUrl(
    environment,
    process.env.ETRADE_BASE_URL,
  );
  const api = createETradeSdk({
    consumerKey,
    consumerSecret,
    accessToken: '',
    accessSecret: '',
    environment,
    baseUrl,
  });

  console.log(`Requesting an OAuth token from ${baseUrl}...`);
  const requestToken = await api.requestToken();
  console.log('\nOpen this URL and authorize the application:');
  console.log(requestToken.url);
  console.log('\nThe request token expires after five minutes.');

  const readline = createInterface({ input, output });
  const verifier = (
    await readline.question('Enter the verification code: ')
  ).trim();
  readline.close();
  if (!verifier) {
    throw new Error('A verification code is required');
  }

  const access = await api.getAccessToken({
    key: requestToken.oauth_token,
    secret: requestToken.oauth_token_secret,
    code: verifier,
  });

  console.log('\nAdd these daily access credentials to .env:');
  console.log(`ETRADE_ACCESS_TOKEN=${access.oauth_token}`);
  console.log(`ETRADE_ACCESS_SECRET=${access.oauth_token_secret}`);

  api.settings.accessToken = access.oauth_token;
  api.settings.accessSecret = access.oauth_token_secret;
  try {
    const accounts = await api.listAccounts();
    console.log('\nAvailable accounts:');
    for (const account of accounts) {
      console.log(
        `- ${account.accountName || account.accountDesc}: ${account.accountIdKey}`,
      );
    }
    console.log('\nSet ETRADE_ACCOUNT_ID_KEY to the account you want to use.');
  } catch (error) {
    console.warn(
      '\nThe access token was created, but account lookup failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
