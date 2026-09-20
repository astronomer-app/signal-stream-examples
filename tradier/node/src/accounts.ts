import {
  fetchAccounts,
  getTradierBaseUrl,
  type TradierEnvironment,
} from './tradier.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readEnvironment(): TradierEnvironment {
  const value = process.env.TRADIER_ENVIRONMENT ?? 'sandbox';
  if (value !== 'sandbox' && value !== 'live') {
    throw new Error('TRADIER_ENVIRONMENT must be "sandbox" or "live"');
  }
  return value;
}

/**
 * Prints the accounts behind TRADIER_ACCESS_TOKEN so you can copy one into
 * TRADIER_ACCOUNT_ID. Tradier issues separate tokens for sandbox and
 * production, and each one sees a different set of account numbers, so run this
 * against the same environment the service will trade in.
 */
async function main(): Promise<void> {
  const accessToken = requireEnv('TRADIER_ACCESS_TOKEN');
  const environment = readEnvironment();
  const baseUrl = getTradierBaseUrl(environment, process.env.TRADIER_BASE_URL);

  console.log(`Fetching accounts from ${baseUrl} (${environment})...\n`);
  const accounts = await fetchAccounts(baseUrl, accessToken);

  if (accounts.length === 0) {
    console.log('No accounts found for this token.');
    return;
  }

  for (const account of accounts) {
    console.log(`TRADIER_ACCOUNT_ID=${account.account_number}`);
    console.log(`  type:         ${account.type ?? 'unknown'}`);
    console.log(`  status:       ${account.status ?? 'unknown'}`);
    console.log(`  option level: ${account.option_level ?? 'unknown'}`);
    console.log();
  }

  // Buying calls and puts to open is option level 2. A lower level authenticates
  // fine and then rejects every order, which is a confusing way to find out.
  const tradable = accounts.filter(
    (account) => (account.option_level ?? 0) >= 2,
  );
  if (tradable.length === 0) {
    console.log(
      'None of these accounts are approved for buying options (level 2+).',
    );
    console.log('Orders from this example will be rejected until one is.');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
