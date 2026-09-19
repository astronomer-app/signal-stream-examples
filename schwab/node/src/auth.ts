import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  basicAuthHeader,
  fetchAccountNumbers,
  getSchwabBaseUrl,
} from './schwab.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Pulls the authorization code out of the URL the browser landed on.
 *
 * Schwab requires an HTTPS callback, and nothing is listening on
 * https://127.0.0.1 — so the browser shows an error page while the address bar
 * holds everything needed. Parsing the whole URL (rather than asking for the
 * code alone) also decodes the %40 that terminates every Schwab code.
 */
function extractCode(pasted: string): string {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new Error('That is not a URL. Paste the entire redirected address.');
  }

  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error(`No "code" parameter found in ${url.origin}${url.pathname}`);
  }
  return code;
}

async function main(): Promise<void> {
  const appKey = requireEnv('SCHWAB_APP_KEY');
  const appSecret = requireEnv('SCHWAB_APP_SECRET');
  const callbackUrl = requireEnv('SCHWAB_CALLBACK_URL');
  const baseUrl = getSchwabBaseUrl(process.env.SCHWAB_BASE_URL);

  const authorizeUrl = new URL(`${baseUrl}/v1/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', appKey);
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
  authorizeUrl.searchParams.set('response_type', 'code');

  console.log('Open this URL and sign in to Schwab:');
  console.log(authorizeUrl.toString());
  console.log(
    '\nAfter you approve, the browser redirects to your callback URL and shows',
  );
  console.log('an error page. That is expected — nothing is listening there.');
  console.log('Copy the full address from the address bar.');

  const readline = createInterface({ input, output });
  const pasted = await readline.question('\nPaste the redirected URL: ');
  readline.close();

  const code = extractCode(pasted);

  const response = await fetch(`${baseUrl}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(appKey, appSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Schwab token exchange failed (${response.status}): ${await response.text()}`,
    );
  }

  const token = (await response.json()) as {
    access_token: string;
    refresh_token: string;
  };

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  console.log('\nAdd this to .env:');
  console.log(`SCHWAB_REFRESH_TOKEN=${token.refresh_token}`);
  console.log(
    `\nSchwab expires refresh tokens after 7 days — around ${expiresAt.toDateString()}.`,
  );
  console.log('Run `npm run auth` again before then.');

  try {
    const accounts = await fetchAccountNumbers(baseUrl, token.access_token);
    console.log('\nAvailable accounts:');
    for (const account of accounts) {
      console.log(`- ${account.accountNumber}: ${account.hashValue}`);
    }
    console.log('\nSet SCHWAB_ACCOUNT_HASH to the hash of the account to trade.');
    console.log('Schwab requires the hash — the plain account number is rejected.');
  } catch (error) {
    console.warn(
      '\nTokens were issued, but the account lookup failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
