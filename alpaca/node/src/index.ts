import { AstronomerSignals } from '@astronomer-app/signals';

import { AlpacaClient } from './alpaca.js';
import { createStatusServer, type RuntimeStats } from './server.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const signalKey = requireEnv('ASTRONOMER_SIGNAL_STREAM_KEY');
const signalBaseUrl = process.env.ASTRONOMER_SIGNAL_STREAM_BASE_URL;
const port = Number(process.env.PORT ?? 8080);
const quantity = Number(process.env.ORDER_QUANTITY ?? 1);
const limitSlippage = Number(process.env.ORDER_LIMIT_SLIPPAGE ?? 0.02);

// Trading is opt-in. With Alpaca keys set, signals place real paper orders;
// without them the example runs as a dry run so you can see the flow first.
const alpacaKeyId = process.env.ALPACA_API_KEY_ID;
const alpacaSecret = process.env.ALPACA_API_SECRET_KEY;
const alpacaBaseUrl =
  process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets';
const alpacaDataBaseUrl =
  process.env.ALPACA_DATA_BASE_URL ?? 'https://data.alpaca.markets';
const optionsFeed = process.env.ALPACA_OPTIONS_FEED ?? 'indicative';
const alpaca =
  alpacaKeyId && alpacaSecret
    ? new AlpacaClient({
        keyId: alpacaKeyId,
        secretKey: alpacaSecret,
        baseUrl: alpacaBaseUrl,
        dataBaseUrl: alpacaDataBaseUrl,
        feed: optionsFeed,
        limitSlippage,
      })
    : null;
const tradingEnabled = alpaca !== null;

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
      ? `Trading enabled against ${alpacaBaseUrl}`
      : 'Trading disabled (no Alpaca keys) — running in dry-run mode',
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

    if (!alpaca) {
      console.log(`  [dry run] would buy ${quantity}x ${label}`);
      return;
    }

    try {
      const order = await alpaca.placeOptionOrder({
        underlyingSymbol: signal.symbol,
        optionType: signal.optionType,
        strikePrice: signal.strikePrice,
        expirationDate: signal.expirationDate,
        quantity,
      });
      stats.ordersPlaced += 1;
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
  await listener.close();
  server.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
