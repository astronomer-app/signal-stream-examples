import { AstronomerSignals } from '@astronomer-app/signals';

import { createStatusServer, type RuntimeStats } from './server.js';
import {
  getTradierBaseUrl,
  TradierClient,
  type TradierEnvironment,
} from './tradier.js';

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

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  if (value !== 'true' && value !== 'false') {
    console.error(`${name} must be "true" or "false"`);
    process.exit(1);
  }
  return value === 'true';
}

function readEnvironment(): TradierEnvironment {
  const value = process.env.TRADIER_ENVIRONMENT ?? 'sandbox';
  if (value !== 'sandbox' && value !== 'live') {
    console.error('TRADIER_ENVIRONMENT must be "sandbox" or "live"');
    process.exit(1);
  }
  return value;
}

const signalKey = requireEnv('ASTRONOMER_SIGNAL_STREAM_KEY');
const signalBaseUrl = process.env.ASTRONOMER_SIGNAL_STREAM_BASE_URL;
const port = readNumber('PORT', 8080);
const quantity = readNumber('ORDER_QUANTITY', 1);
const limitSlippage = readNumber('ORDER_LIMIT_SLIPPAGE', 0.02);
const preview = readBoolean('ORDER_PREVIEW', true);
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

const environment = readEnvironment();
const brokerBaseUrl = getTradierBaseUrl(
  environment,
  process.env.TRADIER_BASE_URL,
);

// Trading is opt-in. With both Tradier credentials set, signals place orders in
// the configured account; without them the example runs as a dry run so you can
// watch the flow first. A half-filled configuration is a mistake, not a dry
// run, so it fails fast rather than silently trading nothing.
const credentialNames = ['TRADIER_ACCESS_TOKEN', 'TRADIER_ACCOUNT_ID'] as const;
const missingCredentials = credentialNames.filter((name) => !process.env[name]);
if (
  missingCredentials.length > 0 &&
  missingCredentials.length < credentialNames.length
) {
  console.error(
    `Incomplete Tradier configuration. Missing: ${missingCredentials.join(', ')}`,
  );
  console.error('Provide both Tradier credentials or leave both blank.');
  process.exit(1);
}

const tradingEnabled = missingCredentials.length === 0;
const tradier = tradingEnabled
  ? new TradierClient({
      accessToken: process.env.TRADIER_ACCESS_TOKEN!,
      accountId: process.env.TRADIER_ACCOUNT_ID!,
      baseUrl: brokerBaseUrl,
      limitSlippage,
      preview,
    })
  : null;

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
  if (tradingEnabled && environment === 'live') {
    console.log(`LIVE trading enabled against ${brokerBaseUrl}`);
    console.log('Orders placed by this process use real money.');
  } else if (tradingEnabled) {
    console.log(`Paper trading enabled against ${brokerBaseUrl}`);
  } else {
    console.log('Trading disabled (no Tradier credentials) — dry-run mode');
  }
  if (tradingEnabled && !preview) {
    console.log('Order previews disabled (ORDER_PREVIEW=false)');
  }
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

    if (!tradier) {
      console.log(`  [dry run] would buy ${quantity}x ${label}`);
      return;
    }

    try {
      const order = await tradier.placeOptionOrder({
        underlyingSymbol: signal.symbol,
        optionType: signal.optionType,
        strikePrice: signal.strikePrice,
        expirationDate: signal.expirationDate,
        quantity,
      });
      stats.ordersPlaced += 1;
      if (order.preview) {
        console.log(
          `  Preview: cost $${order.preview.cost.toFixed(2)}, commission $${order.preview.commission.toFixed(2)}, fees $${order.preview.fees.toFixed(2)}`,
        );
      }
      console.log(
        `  Order ${order.id} placed (${order.symbol}, limit ${order.limitPrice} vs ask ${order.ask}, status: ${order.status})`,
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
