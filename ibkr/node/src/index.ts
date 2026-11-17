import { AstronomerSignals, type SignalEvent } from '@astronomer-app/signals';

import { createStatusServer, type RuntimeStats } from './server.js';
import {
  describeError,
  IbkrClient,
  isPaperAccount,
  resolveGatewayUrl,
  type AuthStatus,
} from './ibkr.js';

// The gateway drops an idle session after a few minutes; a keepalive about
// once a minute holds it open.
const KEEPALIVE_INTERVAL_MS = 60_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
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

const signalKey = requireEnv('ASTRONOMER_SIGNAL_STREAM_KEY');
const signalBaseUrl = process.env.ASTRONOMER_SIGNAL_STREAM_BASE_URL;
const port = readNumber('PORT', 8080);
const quantity = readNumber('ORDER_QUANTITY', 1);
const limitSlippage = readNumber('ORDER_LIMIT_SLIPPAGE', 0.02);
const preview = readBoolean('ORDER_PREVIEW', true);
const allowLive = readBoolean('IBKR_ALLOW_LIVE', false);
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

const gatewayUrl = resolveGatewayUrl(process.env.IBKR_GATEWAY_URL);
// IBKR issues account IDs in upper case (DU1234567).
const accountId = (process.env.IBKR_ACCOUNT_ID ?? '').trim().toUpperCase();

// Trading is opt-in. With an account set, signals place orders through the
// gateway; without one the example runs as a dry run so you can watch the flow
// first. The gateway decides paper or live by which username logged in to it,
// so a live account ID is refused unless IBKR_ALLOW_LIVE says otherwise.
const tradingEnabled = accountId !== '';
const liveAccount = tradingEnabled && !isPaperAccount(accountId);
if (liveAccount && !allowLive) {
  console.error(
    `IBKR_ACCOUNT_ID ${accountId} is a live account (paper accounts start with "D").`,
  );
  console.error('Set IBKR_ALLOW_LIVE=true to place real-money orders.');
  process.exit(1);
}

const ibkr = tradingEnabled
  ? new IbkrClient({ gatewayUrl, accountId, limitSlippage, preview })
  : null;

const stats: RuntimeStats = {
  startedAt: new Date().toISOString(),
  connected: false,
  tradingEnabled,
  gatewayAuthenticated: null,
  signalsReceived: 0,
  ordersPlaced: 0,
  ordersFailed: 0,
  lastSignalAt: null,
};

// Check the gateway and the account before listening, so a logged-out session
// or a wrong IBKR_ACCOUNT_ID fails at startup rather than on the first signal
// of the day.
if (ibkr) {
  let status: AuthStatus;
  try {
    status = await ibkr.gatewayClient.authStatus();
  } catch (error) {
    console.error(`Could not reach the IBKR gateway at ${gatewayUrl}.`);
    console.error(describeError(error));
    process.exit(1);
  }
  stats.gatewayAuthenticated = status.authenticated;
  if (!status.authenticated) {
    console.error(`The gateway at ${gatewayUrl} is running but not logged in.`);
    console.error(`Open ${gatewayUrl} in a browser and log in, then restart.`);
    process.exit(1);
  }
  if (status.competing) {
    console.warn(
      'Warning: another session is logged in with this username. IBKR allows one brokerage session per username, so orders may fail until it logs out.',
    );
  }
  try {
    await ibkr.openSession();
  } catch (error) {
    console.error(describeError(error));
    console.error('Run `npm run accounts` to list the accounts you can use.');
    process.exit(1);
  }
}

const keepalive = ibkr
  ? setInterval(async () => {
      try {
        await ibkr.gatewayClient.tickle();
        const status = await ibkr.gatewayClient.authStatus();
        if (!status.authenticated) {
          // The next order after you log back in opens a new session.
          ibkr.resetSession();
          if (stats.gatewayAuthenticated) {
            console.error(
              `Gateway session lapsed. Log in again at ${gatewayUrl}; orders will fail until you do.`,
            );
          }
        }
        stats.gatewayAuthenticated = status.authenticated;
      } catch (error) {
        ibkr.resetSession();
        stats.gatewayAuthenticated = false;
        console.error('Gateway keepalive failed:', describeError(error));
      }
    }, KEEPALIVE_INTERVAL_MS)
  : null;

const server = createStatusServer(stats);
server.listen(port, () => {
  console.log(`Status server listening on http://localhost:${port}`);
  console.log('  GET /health   liveness check');
  console.log('  GET /status   runtime counters');
  if (liveAccount) {
    console.log(`LIVE trading enabled in ${accountId} via ${gatewayUrl}`);
    console.log('Orders placed by this process use real money.');
  } else if (tradingEnabled) {
    console.log(`Paper trading enabled in ${accountId} via ${gatewayUrl}`);
  } else {
    console.log('Trading disabled (no IBKR_ACCOUNT_ID) — dry-run mode');
  }
  if (tradingEnabled && !preview) {
    console.log('What-if checks disabled (ORDER_PREVIEW=false)');
  }
});

async function handleSignal(event: SignalEvent): Promise<void> {
  const { signal } = event;
  stats.signalsReceived += 1;
  stats.lastSignalAt = new Date().toISOString();

  const label = `${signal.symbol} ${signal.strikePrice}${signal.optionType} exp ${signal.expirationDate}`;
  console.log(`Signal received: ${label}`);

  if (closing) {
    console.log('  Skipped: shutting down');
    return;
  }

  if (!ibkr) {
    console.log(`  [dry run] would buy ${quantity}x ${label}`);
    return;
  }

  try {
    const order = await ibkr.placeOptionOrder({
      underlyingSymbol: signal.symbol,
      optionType: signal.optionType,
      strikePrice: signal.strikePrice,
      expirationDate: signal.expirationDate,
      quantity,
      clientOrderId: `astronomer-${signal.id}`,
    });
    stats.ordersPlaced += 1;
    if (order.preview) {
      console.log(
        `  What-if: total $${order.preview.total.toFixed(2)}, commission $${order.preview.commission.toFixed(2)}`,
      );
      if (order.preview.warning) {
        console.log(`  What-if warning: ${order.preview.warning}`);
      }
    }
    for (const warning of order.confirmedWarnings) {
      console.log(`  Confirmed: ${warning}`);
    }
    if (order.delayedQuote) {
      console.log('  Note: the ask came from a delayed quote.');
    }
    console.log(
      `  Order ${order.id} placed (conid ${order.conid}, limit ${order.limitPrice} vs ask ${order.ask}, status: ${order.status})`,
    );
  } catch (error) {
    stats.ordersFailed += 1;
    console.error(`  Order failed for ${label}:`, describeError(error));
  }
}

// The Signal Stream client hands over each signal without waiting for the one
// before it to finish. Handle them one at a time, so a burst at the open
// becomes a short queue rather than a spike of gateway requests that trips
// IBKR's rate limits. Shutdown waits on the queue, so an order in progress
// finishes instead of being cut off between submission and confirmation.
let signalQueue: Promise<void> = Promise.resolve();
let pendingSignals = 0;
let closing = false;

// The Signal Stream client calls onOpen once and onClose only when the listener
// stops, so neither notices an outage. Track the polls themselves instead:
// `connected` in /status means the last poll reached Signal Stream.
const client = new AstronomerSignals({
  apiKey: signalKey,
  baseUrl: signalBaseUrl,
  fetch: async (input, init) => {
    try {
      const response = await fetch(input, init);
      stats.connected = response.ok;
      return response;
    } catch (error) {
      stats.connected = false;
      throw error;
    }
  },
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
  onSignal(event) {
    pendingSignals += 1;
    signalQueue = signalQueue
      .then(() => handleSignal(event))
      .catch((error: unknown) => {
        console.error('Signal handler failed:', describeError(error));
      })
      .finally(() => {
        pendingSignals -= 1;
      });
  },
});

// Stops taking signals, lets an order in progress finish, then exits. Signals
// still queued behind it are skipped. A second Ctrl-C exits at once.
async function shutdown(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  console.log('\nShutting down...');
  if (keepalive) {
    clearInterval(keepalive);
  }
  try {
    await listener.close();
  } catch (error) {
    // The current Signal Stream client can reject close() with AbortError when
    // shutdown interrupts its reconnect delay. That abort is expected.
    if (!(error instanceof Error) || error.name !== 'AbortError') {
      console.error('Error closing Signal Stream:', error);
    }
  }
  if (pendingSignals > 0) {
    console.log('Waiting for the order in progress to finish...');
  }
  await signalQueue;
  server.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
