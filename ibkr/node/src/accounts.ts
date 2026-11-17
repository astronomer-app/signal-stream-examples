import {
  describeError,
  IbkrGateway,
  isPaperAccount,
  resolveGatewayUrl,
} from './ibkr.js';

/**
 * Checks the gateway session and prints the accounts it can trade, so you can
 * copy one into IBKR_ACCOUNT_ID. Which accounts appear depends on the username
 * you logged in to the gateway with: a paper username sees its paper account,
 * a live username its live ones.
 */
async function main(): Promise<void> {
  const gatewayUrl = resolveGatewayUrl(process.env.IBKR_GATEWAY_URL);
  const gateway = new IbkrGateway(gatewayUrl);

  console.log(`Checking the gateway at ${gatewayUrl}...\n`);
  const status = await gateway.authStatus();
  if (!status.authenticated) {
    console.log('The gateway is running but not logged in.');
    console.log(`Open ${gatewayUrl} in a browser, log in, and run this again.`);
    process.exit(1);
  }
  if (status.competing) {
    console.log(
      'Warning: another session is logged in with this username. Log it out',
    );
    console.log('(TWS, the mobile app, another gateway) or orders will fail.\n');
  }

  // /iserver/accounts opens the brokerage session the order endpoints need;
  // /portfolio/accounts adds the descriptions.
  const tradable = new Set(await gateway.brokerageAccounts());
  const accounts = await gateway.portfolioAccounts();

  if (accounts.length === 0) {
    console.log('No accounts found for this session.');
    return;
  }

  for (const account of accounts) {
    const paper = isPaperAccount(account.id);
    console.log(`IBKR_ACCOUNT_ID=${account.id}`);
    console.log(`  kind:      ${paper ? 'paper' : 'LIVE (needs IBKR_ALLOW_LIVE=true)'}`);
    console.log(`  title:     ${account.accountTitle || account.desc || 'unknown'}`);
    console.log(`  type:      ${account.type ?? 'unknown'}`);
    console.log(`  currency:  ${account.currency ?? 'unknown'}`);
    console.log(`  tradable:  ${tradable.has(account.id) ? 'yes' : 'no'}`);
    console.log();
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  console.error(
    'Is the Client Portal Gateway running? See "Run the gateway" in the README.',
  );
  process.exit(1);
});
