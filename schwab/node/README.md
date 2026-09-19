# Signal Stream → Charles Schwab (Node + TypeScript)

A small, long-lived Node service that listens to Astronomer Signal Stream and
places a Charles Schwab options order for each signal.

It uses:

- [`@astronomer-app/signals`](https://www.npmjs.com/package/@astronomer-app/signals)
  to receive signals
- the built-in `fetch` for Schwab's Trader and Market Data APIs (no broker SDK)
- the built-in `node:http` module for a health/status server

> ⚠️ **Schwab has no paper environment.** The Trader API reaches live accounts
> only, so there is nowhere to rehearse an order. This example therefore stays
> in dry-run mode until you *both* supply credentials and set
> `SCHWAB_TRADING_ENABLED=true`.

## SDK choice

Schwab does not publish an official Node SDK. Rather than pin a third-party
wrapper on the path that holds your OAuth credentials, this example calls the
REST API directly with `fetch` — the Trader API is plain JSON over bearer
tokens, and the whole client is about 250 lines. The only runtime dependency is
the Signal Stream client itself.

## How it works

1. A status server starts on `PORT` with two endpoints:
   - `GET /health` — liveness check (`{ "ok": true }`)
   - `GET /status` — counters: signals received, orders placed/failed, last
     signal time
2. The Signal Stream listener connects and runs a callback for each signal.
3. For each signal, the service:
   - builds Schwab's 21-character option symbol (`SPY   260618C00746000`)
   - fetches the current ask from the Market Data API
   - prices a marketable limit using `ORDER_LIMIT_SLIPPAGE`, rounded to a valid
     exchange tick
   - POSTs a single-leg `BUY_TO_OPEN` limit order and reads the new order ID out
     of the response's `Location` header

Access tokens are refreshed in-process: they last 30 minutes, so the client
renews one a minute before expiry and retries once if Schwab rejects a token
early. Concurrent signals share a single refresh rather than racing.

## Setup

```bash
npm install
cp .env.example .env
```

Register an app in the
[Schwab developer portal](https://developer.schwab.com/) against the **Accounts
and Trading Production** and **Market Data Production** products. Approval takes
a few days — the app must reach `Ready For Use`, not `Approved - Pending`.

Schwab requires an **HTTPS** callback URL. `https://127.0.0.1` works and needs
no local server; see the auth step below. Put the app's credentials in `.env`:

```dotenv
SCHWAB_APP_KEY=...
SCHWAB_APP_SECRET=...
SCHWAB_CALLBACK_URL=https://127.0.0.1
```

Then run the authorization flow:

```bash
npm run auth
```

Open the printed URL, sign in, and approve. The browser will redirect to your
callback and show an error page — that is expected, nothing is listening there.
Copy the **entire address** out of the address bar and paste it back into the
prompt. The command prints `SCHWAB_REFRESH_TOKEN` and the account hashes
available to you.

```dotenv
SCHWAB_REFRESH_TOKEN=...
SCHWAB_ACCOUNT_HASH=...
```

Schwab addresses accounts by hash, never by the display account number.

`npm run auth` lists taxable and retirement accounts alike, so pointing this at
an eligible Roth or Traditional IRA is just a different `SCHWAB_ACCOUNT_HASH`.
Schwab permits options in IRAs approved for options trading, and every order
here is a single-leg `BUY_TO_OPEN` paid in full — a debit, not a borrow, which
is the category IRAs allow. Options approval is per-account, so the IRA needs
its own.

**Refresh tokens expire after 7 days.** There is no way to extend one
programmatically — `npm run auth` has to be run again, by hand, every week.

To watch signals without sending broker requests, leave all four Schwab
credential variables blank. A partial configuration fails fast so a missing
token or account hash cannot silently turn trading off.

Other settings:

- `SCHWAB_TRADING_ENABLED` — must be `true` to place orders; defaults to `false`.
- `ORDER_QUANTITY` — contracts to buy per signal; defaults to `1`.
- `ORDER_LIMIT_SLIPPAGE` — fraction added to the ask for the buy limit
  (`0.02` = 2%); defaults to `0.02`.
- `SCHWAB_BASE_URL` — optional API host override.

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

- **Durable idempotency and reconciliation** — Schwab's order endpoint takes no
  client-supplied order ID, so a retry after an ambiguous failure can duplicate
  a position. Persist processed signal IDs and reconcile against
  `GET /accounts/{hash}/orders` before retrying anything.
- **Position sizing and risk limits** — derive quantity from account equity and
  enforce caps on open positions and daily losses.
- **Quote quality and guards** — quotes carry a `realtime` flag that depends on
  your account's market-data agreements. Reject delayed or stale quotes and
  wide spreads instead of pricing a limit off them.
- **Refresh token operations** — the 7-day expiry is a standing operational
  task. Alert before it lapses, because the service stops trading the moment it
  does.
- **Order status follow-up** — a 201 means accepted, not filled. Poll or stream
  order status to know what actually happened.

> ⚠️ There is no sandbox to fall back on. `SCHWAB_TRADING_ENABLED=true` places
> orders in a live Schwab account with real money.
