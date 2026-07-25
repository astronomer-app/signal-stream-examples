import { AstronomerSignals } from '@astronomer-app/signals';

import {
  ETradeClient,
  getETradeBaseUrl,
  type ETradeEnvironment,
} from './etrade.js';
import { createStatusServer, type RuntimeStats } from './server.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function readNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) {
    console.error(`${name} must be a number`);
    process.exit(1);
  }
  return value;
}

function readEnvironment(): ETradeEnvironment {
  const value = process.env.ETRADE_ENVIRONMENT ?? 'sandbox';
  if (value !== 'sandbox' && value !== 'live') {
    console.error('ETRADE_ENVIRONMENT must be "sandbox" or "live"');
    process.exit(1);
  }
  return value;
}

const signalKey = requireEnv('ASTRONOMER_SIGNAL_STREAM_KEY');
const signalBaseUrl = process.env.ASTRONOMER_SIGNAL_STREAM_BASE_URL;
const port = readNumber('PORT', 8080);
const quantity = readNumber('ORDER_QUANTITY', 1);
const limitSlippage = readNumber('ORDER_LIMIT_SLIPPAGE', 0.02);
const environment = readEnvironment();
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be an integer between 1 and 65535');
  process.exit(1);
}
if (!Number.isInteger(quantity) || quantity <= 0) {
  console.error('ORDER_QUANTITY must be a positive integer');
  process.exit(1);
}
if (limitSlippage < 0) {
  console.error('ORDER_LIMIT_SLIPPAGE must be zero or greater');
  process.exit(1);
}

const credentialNames = [
  'ETRADE_CONSUMER_KEY',
  'ETRADE_CONSUMER_SECRET',
  'ETRADE_ACCESS_TOKEN',
  'ETRADE_ACCESS_SECRET',
  'ETRADE_ACCOUNT_ID_KEY',
] as const;
const missingCredentials = credentialNames.filter(
  (name) => !process.env[name],
);
if (
  missingCredentials.length > 0 &&
  missingCredentials.length < credentialNames.length
) {
  console.error(
    `Incomplete E*TRADE configuration. Missing: ${missingCredentials.join(', ')}`,
  );
  console.error('Provide every E*TRADE credential or leave all of them blank.');
  process.exit(1);
}

// Trading is opt-in. With every E*TRADE credential set, signals place orders;
// without them the example runs as a dry run so you can see the flow first.
const tradingEnabled = missingCredentials.length === 0;
const etrade = tradingEnabled
  ? new ETradeClient({
      consumerKey: process.env.ETRADE_CONSUMER_KEY!,
      consumerSecret: process.env.ETRADE_CONSUMER_SECRET!,
      accessToken: process.env.ETRADE_ACCESS_TOKEN!,
      accessSecret: process.env.ETRADE_ACCESS_SECRET!,
      accountIdKey: process.env.ETRADE_ACCOUNT_ID_KEY!,
      environment,
      baseUrl: process.env.ETRADE_BASE_URL,
      limitSlippage,
    })
  : null;
const brokerBaseUrl = getETradeBaseUrl(
  environment,
  process.env.ETRADE_BASE_URL,
);

const stats: RuntimeStats = {
  startedAt: new Date().toISOString(),
  connected: false,
  tradingEnabled,
  signalsReceived: 0,
  ordersPlaced: 0,
  ordersFailed: 0,
  lastSignalAt: null,
};

const server = createStatusServer(stats);
server.listen(port, () => {
  console.log(`Status server listening on http://localhost:${port}`);
  console.log('  GET /health   liveness check');
  console.log('  GET /status   runtime counters');
  console.log(
    tradingEnabled
      ? `Trading enabled against ${brokerBaseUrl} (${environment})`
      : 'Trading disabled (no E*TRADE credentials) — running in dry-run mode',
  );
});

const client = new AstronomerSignals({
  apiKey: signalKey,
  baseUrl: signalBaseUrl,
});

const listener = client.signals.listen({
  onOpen() {
    stats.connected = true;
    console.log('Signal Stream connected.');
  },
  onClose() {
    stats.connected = false;
    console.log('Signal Stream closed.');
  },
  onError(error) {
    console.error('Signal Stream error:', error);
  },
  async onSignal(event) {
    const { signal } = event;
    stats.signalsReceived += 1;
    stats.lastSignalAt = new Date().toISOString();

    const label = `${signal.symbol} ${signal.strikePrice}${signal.optionType} exp ${signal.expirationDate}`;
    console.log(`Signal received: ${label}`);

    if (!etrade) {
      console.log(`  [dry run] would buy ${quantity}x ${label}`);
      return;
    }

    try {
      const order = await etrade.placeOptionOrder({
        signalId: signal.id,
        underlyingSymbol: signal.symbol,
        optionType: signal.optionType,
        strikePrice: signal.strikePrice,
        expirationDate: signal.expirationDate,
        quantity,
      });
      stats.ordersPlaced += 1;
      console.log(
        `  Order ${order.id} placed (${order.symbol}, limit ${order.limitPrice} vs ask ${order.ask}, ${order.quoteStatus}, status: ${order.status})`,
      );
    } catch (error) {
      stats.ordersFailed += 1;
      console.error(
        `  Order failed for ${label}:`,
        error instanceof Error ? error.message : error,
      );
    }
  },
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  console.log('\nShutting down...');
  try {
    await listener.close();
  } catch (error) {
    // The current Signal Stream client can reject close() with AbortError when
    // shutdown interrupts its reconnect delay. That abort is expected.
    if (!(error instanceof Error) || error.name !== 'AbortError') {
      console.error('Error closing Signal Stream:', error);
    }
  }
  server.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
