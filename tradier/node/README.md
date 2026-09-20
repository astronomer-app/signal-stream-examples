# Signal Stream → Tradier (Node + TypeScript)

A small, long-lived Node service that listens to Astronomer Signal Stream and
places a Tradier **sandbox** options order for each signal.

It uses:

- [`@astronomer-app/signals`](https://www.npmjs.com/package/@astronomer-app/signals)
  to receive signals
- the built-in `fetch` for Tradier's Brokerage API (no broker SDK)
- the built-in `node:http` module for a health/status server

## SDK choice

Tradier does not publish an official Node SDK, and the API does not need one:
it is a bearer token, form-encoded request bodies, and JSON responses. This
example calls it directly with `fetch`, so the only runtime dependency is the
Signal Stream client itself.

That also makes this the simplest example in the repo to read. Unlike E\*TRADE
(OAuth 1.0a) and Schwab (OAuth 2.0 with a 7-day refresh token), Tradier tokens
are static — there is no authorization flow and no token refresh to manage.

## How it works

1. A status server starts on `PORT` with two endpoints:
   - `GET /health` — liveness check (`{ "ok": true }`)
   - `GET /status` — counters: signals received, orders placed/failed, last
     signal time
2. The Signal Stream listener connects and runs a callback for each signal.
3. For each signal, the service:
   - builds the OCC option symbol (`SPY260618C00746000`)
   - fetches the current ask from `/v1/markets/quotes`
   - prices a marketable limit using `ORDER_LIMIT_SLIPPAGE`, rounded up to a
     valid exchange tick
   - previews the order, then POSTs a single-leg `buy_to_open` limit order

Each signal fully specifies a contract with `symbol`, `optionType` (`C`/`P`),
`strikePrice`, and `expirationDate`. Tradier quotes options per share, so a
`1.20` ask is `$120` for the 100-share contract. See `src/tradier.ts`.

### Previewing

Tradier can validate an order without sending it, by posting the same body with
`preview=true`. The preview runs the real checks — buying power, option level,
contract validity — and returns the estimated cost, commission, and margin
impact. This example previews every order by default and logs what came back:

```
Signal received: SPY 746C exp 2026-06-18
  Preview: cost $253.65, commission $0.00, fees $0.65
  Order 20258740 placed (SPY260618C00746000, limit 2.55 vs ask 2.48, status: ok)
```

It costs one extra API call per signal. Set `ORDER_PREVIEW=false` to skip it.

## Setup

```bash
npm install
cp .env.example .env
```

Get a token from [dash.tradier.com/settings/api](https://dash.tradier.com/settings/api).
**Sandbox and production issue different tokens**, and a sandbox token will not
authenticate against production. Make sure the one in `.env` matches
`TRADIER_ENVIRONMENT`.

Then find your account number:

```bash
npm run accounts
```

This prints every account the token can reach, along with its option level, and
tells you if none are approved for buying options. Copy one into
`TRADIER_ACCOUNT_ID`.

Edit `.env`:

- `ASTRONOMER_SIGNAL_STREAM_KEY` — required.
- `TRADIER_ENVIRONMENT` — `sandbox` (default) or `live`.
- `TRADIER_ACCESS_TOKEN` / `TRADIER_ACCOUNT_ID` — optional. Leave both blank to
  run in **dry-run** mode: signals are logged and no orders are sent. A partial
  configuration fails fast, so a missing account cannot silently turn trading
  off.
- `ORDER_QUANTITY` — contracts to buy per signal; defaults to `1`.
- `ORDER_LIMIT_SLIPPAGE` — how far above the live ask to set the buy limit, as a
  fraction (`0.02` = 2%). Keeps the order marketable without chasing price.
  Defaults to `0.02`.
- `ORDER_PREVIEW` — preview each order before placing it; defaults to `true`.
- `TRADIER_BASE_URL` — optional API host override.

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

## Sandbox notes

The sandbox supports the full trading API against paper money, but two
differences matter for this example:

- **Quotes are delayed 15 minutes — in the sandbox only.** Production is
  real-time for equities and options, free to any Tradier Brokerage account
  holder ([market data](https://docs.tradier.com/docs/market-data)). The delay
  is a property of the token, not the endpoint, so no market data route avoids
  it here. Because the limit is priced off the ask, a sandbox fill is not a
  realistic rehearsal of the live one — use the sandbox to verify
  authentication, symbol construction, and request shape, not execution.
- **Rate limits are lower.** Market data endpoints allow 60 requests/minute in
  the sandbox versus 120 in production, per access token. Each signal here costs
  one quote call plus one or two order calls.

Tradier's JSON also has a quirk worth knowing before you extend this: a
collection holding a single item serializes as a bare object, and only becomes
an array at two or more. A one-symbol quote request returns `quotes.quote` as an
object, not a one-element array. `src/tradier.ts` normalizes this in `toArray`.

## Going to production

This is an example. Before trading real money you will want to add, at minimum:

- **Idempotency** — track processed `signal.id`s so a reconnect cannot
  double-fill, and reconcile against `/v1/accounts/{id}/orders` after ambiguous
  failures.
- **Position sizing and risk limits** — derive `ORDER_QUANTITY` from account
  equity and a cap on open positions instead of a constant.
- **Quote quality and guards** — reject orders when the quote is stale or the
  bid/ask spread is too wide to trade sanely. The example takes any ask it gets.
- **Preview policy** — the example logs the preview and places the order
  regardless. In production, act on it: reject orders whose cost or margin
  impact exceeds a threshold.
- **Order lifecycle** — a placed limit order is not a fill. Track order status
  and decide what to do with day orders that never fill.

> ⚠️ `TRADIER_ENVIRONMENT=live` places orders in the configured Tradier account
> with real money. Sandbox is the default.
