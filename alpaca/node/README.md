# Signal Stream → Alpaca (Node + TypeScript)

A small, long-lived Node service that listens to Astronomer Signal Stream and
places an Alpaca **paper** options order for each signal.

It uses:

- [`@astronomer-app/signals`](https://www.npmjs.com/package/@astronomer-app/signals) to receive signals
- the built-in `node:http` module for a health/status server (no web framework)
- the built-in `fetch` to call Alpaca's REST API (no broker SDK)

## How it works

1. A status server starts on `PORT` with two endpoints:
   - `GET /health` — liveness check (`{ "ok": true }`)
   - `GET /status` — counters: signals received, orders placed/failed, last signal time
2. The Signal Stream listener connects and runs a callback for each signal.
3. For each signal, the service builds the option contract symbol, looks up its
   live quote, and submits a marketable limit order to buy it — priced a small
   cushion (`ORDER_LIMIT_SLIPPAGE`) above the ask.

Each signal fully specifies a contract with `symbol`, `optionType` (`C`/`P`),
`strikePrice`, and `expirationDate`. The example turns those into the OCC option
symbol Alpaca expects (e.g. `SPY260618C00746000`), fetches the latest quote for
it, and prices the limit off the ask. Alpaca quotes options per share, so a
`1.20` ask is `$120` for the 100-share contract. See `src/alpaca.ts`.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- `ASTRONOMER_SIGNAL_STREAM_KEY` — required.
- `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` — optional. Leave them blank to
  run in **dry-run** mode: signals are logged and no orders are sent. Fill them
  in with [Alpaca paper trading](https://alpaca.markets/) keys to place real
  paper orders.
- `ORDER_LIMIT_SLIPPAGE` — how far above the live ask to set the buy limit, as a
  fraction (`0.02` = 2%). Keeps the order marketable without chasing price.
  Defaults to `0.02`.
- `ALPACA_OPTIONS_FEED` — `indicative` (free, delayed) or `opra` (real-time,
  paid). Defaults to `indicative`.

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

## Going to production

This is an example. Before trading real money you will want to add, at minimum:

- **Idempotency** — track processed `signal.id`s so a reconnect cannot double-fill.
- **Position sizing and risk limits** — derive `ORDER_QUANTITY` from account
  equity and a cap on open positions instead of a constant.
- **Quote quality and guards** — the example prices off the free `indicative`
  feed, which is delayed and modified. Use the real-time `opra` feed, and reject
  orders when the quote is stale or the spread is too wide to trade sanely.

> ⚠️ `ALPACA_BASE_URL` defaults to paper trading. Pointing it at the live API
> places real orders with real money.
