# Signal Stream → E*TRADE (Node + TypeScript)

A small, long-lived Node service that listens to Astronomer Signal Stream and
places an E*TRADE **sandbox** options order for each signal.

It uses:

- [`@astronomer-app/signals`](https://www.npmjs.com/package/@astronomer-app/signals)
  to receive signals
- [`e-trade-api`](https://www.npmjs.com/package/e-trade-api) for E*TRADE's
  OAuth 1.0 flow, quotes, and order APIs
- the built-in `node:http` module for a health/status server

## SDK choice

E*TRADE provides an official downloadable
[Node sample client](https://developer.etrade.com/support/downloads), but does
not publish a Node SDK to npm. The official download is version 1 from October
2022 and uses several obsolete dependencies. This example instead pins
`e-trade-api@0.3.0`, npm's latest typed E*TRADE client. It is a third-party
package, not an official E*TRADE SDK.

## How it works

1. A status server starts on `PORT` with two endpoints:
   - `GET /health` — liveness check (`{ "ok": true }`)
   - `GET /status` — counters: signals received, orders placed/failed, last
     signal time
2. The Signal Stream listener connects and runs a callback for each signal.
3. For each signal, the service:
   - turns its contract fields into E*TRADE's option quote symbol
     (`SPY:2026:6:18:CALL:746`)
   - fetches the current ask
   - builds a marketable limit order using `ORDER_LIMIT_SLIPPAGE`
   - previews the order, then places it with the returned preview ID

E*TRADE requires a successful preview before placement. A preview ID must be
used within three minutes. The example also derives E*TRADE's `clientOrderId`
from the Signal Stream signal ID, making repeated deliveries recognizable to
the broker.

## Setup

```bash
npm install
cp .env.example .env
```

Get a sandbox consumer key and secret through
[E*TRADE's developer setup](https://developer.etrade.com/getting-started), then
put them in `.env`:

```dotenv
ETRADE_CONSUMER_KEY=...
ETRADE_CONSUMER_SECRET=...
ETRADE_ENVIRONMENT=sandbox
```

E*TRADE uses an interactive OAuth flow. Generate the daily access credentials:

```bash
npm run auth
```

Open the printed URL, authorize the app, and paste the verification code into
the terminal. The command prints `ETRADE_ACCESS_TOKEN`,
`ETRADE_ACCESS_SECRET`, and the available `ETRADE_ACCOUNT_ID_KEY` values for
you to copy into `.env`.

The request token expires after five minutes. Access tokens expire at midnight
US Eastern and become inactive after two idle hours. The example automatically
renews an inactive token when a quote reports an authentication error, but the
interactive flow must still be repeated each trading day.

To watch signals without sending broker requests, leave all five E*TRADE
credential variables blank. A partial E*TRADE configuration fails fast so a
missing account or token cannot silently turn trading off.

Other settings:

- `ORDER_QUANTITY` — contracts to buy per signal; defaults to `1`.
- `ORDER_LIMIT_SLIPPAGE` — fraction added to the ask for the buy limit
  (`0.02` = 2%); defaults to `0.02`.
- `ETRADE_BASE_URL` — optional API host override.

## Run

```bash
npm run dev    # watch mode
# or
npm start
```

Then, in another terminal:

```bash
curl localhost:8080/health
curl localhost:8080/status
```

Signals only arrive while the market is open, so outside trading hours the
service will sit connected with no activity — that is expected.

E*TRADE's sandbox returns fixed fixture data and can return contracts or order
details different from those submitted. Use it to verify authentication and
request shape, not execution behavior.

## Going to production

This is an example. Before trading real money you will want to add, at minimum:

- **Durable idempotency and reconciliation** — persist processed signal IDs and
  verify broker order status after reconnects and ambiguous API failures.
- **Position sizing and risk limits** — derive quantity from account equity and
  enforce caps on open positions and daily losses.
- **Quote quality and guards** — E*TRADE returns delayed data unless the account
  has accepted the market-data agreement. Reject stale quotes and wide spreads.
- **Preview policy** — inspect preview warnings, disclosures, commissions, and
  buying-power impact instead of placing every successful preview automatically.
- **Daily OAuth operations** — securely distribute fresh tokens before the
  trading session and alert when renewal or authorization fails.

> ⚠️ `ETRADE_ENVIRONMENT=live` places orders in the configured E*TRADE account
> with real money. Sandbox is the default.
