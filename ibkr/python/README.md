# Signal Stream → Interactive Brokers (Python)

A small, long-lived Python service that listens to Astronomer Signal Stream and
places an Interactive Brokers **paper** options order for each signal. It is a
port of [`ibkr/node`](../node) and behaves the same way.

It uses:

- `signal_stream.py`, a dependency-free Signal Stream client (see
  [SDK choice](#sdk-choice)), to receive signals
- IBKR's [Client Portal Web API](https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/),
  called through the standard library's `urllib` (no broker SDK)
- the standard library's `http.server` for a health/status server
- [`python-dotenv`](https://pypi.org/project/python-dotenv/) to load `.env`,
  the only package to install

## SDK choice

Astronomer publishes
[`@astronomer-app/signals`](https://www.npmjs.com/package/@astronomer-app/signals)
for Node but no Python package yet. `signal_stream.py` is a direct port of
that client's polling protocol (`GET /api/v1/signals/stream?cursor=…` with a
bearer key, starting from the `latest` cursor so no history is replayed) in
about 200 lines of standard-library Python. Copy it into your own project as-is
or swap it for the official client when one ships.

IBKR offers two APIs an individual account can trade through:

- **TWS API**: a socket protocol spoken by Trader Workstation or IB Gateway.
  IBKR publishes an official Python client for it, built around callbacks on a
  message-reader thread.
- **Client Portal Web API**: plain REST and JSON, served by a small Java
  gateway you run next to this service.

This example uses the Client Portal Web API, the same as the Node example, so
the whole broker integration is ordinary HTTP calls in `ibkr.py`. The gateway
serves HTTPS with a self-signed certificate. `ibkr.py` skips certificate checks
for gateway requests alone, and only when the gateway runs on `localhost`; the
Signal Stream connection keeps normal TLS.

There are no API keys. You log in to the gateway in a browser, with 2FA, and
the gateway holds the session. This service keeps that session alive and sends
requests through it.

## How it works

1. At startup, if trading is enabled, the service checks that the gateway is
   reachable and logged in, and that `IBKR_ACCOUNT_ID` is one of the session's
   accounts. It exits with instructions if not.
2. A status server starts on `PORT` with two endpoints:
   - `GET /health`: liveness check (`{ "ok": true }`)
   - `GET /status`: counters (signals received, orders placed/failed, last
     signal time) and whether the gateway session is still logged in
3. Every minute the service pings the gateway (`/tickle`) so the session does
   not time out, and logs loudly if it has lapsed. Once you log back in, the
   next order opens a fresh brokerage session; no restart needed.
4. The Signal Stream listener polls in a background thread and runs a callback
   for each signal. Signals are handled one at a time on that thread, and
   gateway requests are spaced at least 120ms apart, so a burst at the open
   stays under IBKR's limit of about 10 requests a second.
5. For each signal, the service:
   - looks up IBKR's contract ID (conid) for the option (see below)
   - fetches the current ask from `/iserver/marketdata/snapshot`, refusing a
     frozen, halted or prior-close quote
   - prices a marketable limit using `ORDER_LIMIT_SLIPPAGE`, rounded up to a
     valid exchange tick
   - runs the order through IBKR's what-if check, then submits a single `BUY`
     limit order and answers IBKR's confirmation questions

Each signal fully specifies a contract with `symbol`, `optionType` (`C`/`P`),
`strikePrice`, and `expirationDate`. IBKR quotes options per share, so a `1.20`
ask is `$120` for the 100-share contract. See `ibkr.py`.

### Finding the contract

IBKR identifies every contract by a numeric **conid**, not an OCC symbol, so an
option takes three lookups:

1. `/iserver/secdef/search`: the underlying's conid, and which months it has
   options in
2. `/iserver/secdef/strikes`: the strikes listed for the expiration month
3. `/iserver/secdef/info`: the contracts at that strike, filtered to the exact
   expiration date

A month (`OCT26`) holds every weekly and daily expiration in it, so step 3's
date filter is what picks out a 0DTE contract. Step 3 only buys the standard
100-share contract, whose trading class is the underlying's symbol. If only an
adjusted series (after a split or special dividend) matches, the signal is
refused rather than buying a different deliverable.
The underlying's conid is cached for the rest of the gateway session.

### Previewing and confirmations

`/orders/whatif` runs the same validation as a real order (buying power,
trading permissions, contract validity) and returns the cost without sending
anything to the market. The example runs it on every order by default and logs
the result. Set `ORDER_PREVIEW=false` to skip it.

Submitting an order can come back with a question instead of an order ID, such
as a warning that the order is outside the price band or has no market data.
IBKR will not send the order until the question is confirmed through
`/iserver/reply`. This example confirms each question and logs what it
confirmed:

```
Signal received: SPY 746C exp 2026-10-27
  What-if: total $255.65, commission $0.65
  Confirmed: You are submitting an order without market data...
  Order 1801 placed (conid 717261234, limit 2.55 vs ask 2.48, status: PreSubmitted)
```

### Duplicate orders

Each order carries a customer order ID (`cOID`) of `astronomer-<signal id>`.
IBKR rejects a second order with the same cOID, so a signal replayed after a
reconnect fails instead of buying twice.

## Setup

Requires Python 3.10 or newer.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

### Paper account

In IBKR Client Portal, open **Settings → Paper Trading Account** and create
one. It gets its own **username** and an account ID starting with `D`
(`DU1234567`). You choose paper or live by which username you log in to the
gateway with. The URL and the API are the same for both.

On the same settings page, turn on **sharing market data with the paper
account**. Without it the paper account has no options quotes, and every order
fails at the quote step. Real-time option quotes need an OPRA subscription on
the live account. Without one, IBKR serves delayed quotes when it has them, and
the service logs a note when it priced from one.

### Run the gateway

The Client Portal Gateway needs Java (8 update 192 or later).

1. Download the gateway from IBKR's
   [Client Portal Web API page](https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/)
   and unzip it.
2. Start it from the unzipped folder:

   ```bash
   bin/run.sh root/conf.yaml
   ```

3. Open [https://localhost:5000](https://localhost:5000), accept the browser's
   certificate warning, and log in with your **paper** username.

The browser should then show "Client login succeeds." Leave the gateway
running.

On macOS, AirPlay Receiver already listens on port 5000. Either turn it off
(System Settings → General → AirDrop & Handoff), or change `listenPort` in
`root/conf.yaml` to a free port such as `5001` and set
`IBKR_GATEWAY_URL=https://localhost:5001`.

Then list your accounts:

```bash
python accounts.py
```

This checks the gateway session and prints every account it can trade, marked
paper or live. Copy one into `IBKR_ACCOUNT_ID`.

Edit `.env`:

- `ASTRONOMER_SIGNAL_STREAM_KEY`: required.
- `IBKR_GATEWAY_URL`: where the gateway listens; defaults to
  `https://localhost:5000`.
- `IBKR_ACCOUNT_ID`: optional. Leave it blank to run in **dry-run** mode:
  signals are logged and no orders are sent, and no gateway is needed.
- `IBKR_ALLOW_LIVE`: defaults to `false`. A live account ID (anything not
  starting with `D`) is refused at startup unless this is `true`.
- `ORDER_QUANTITY`: contracts to buy per signal; defaults to `1`.
- `ORDER_LIMIT_SLIPPAGE`: how far above the live ask to set the buy limit, as a
  fraction (`0.02` = 2%). Keeps the order marketable without chasing price.
  Defaults to `0.02`.
- `ORDER_PREVIEW`: run each order through the what-if check first; defaults to
  `true`.

## Run

```bash
python main.py
```

Then, in another terminal:

```bash
curl localhost:8080/health
curl localhost:8080/status
```

Signals only arrive while the market is open, so outside trading hours the
service will sit connected with no activity. That is expected.

On Ctrl-C or `SIGTERM` the service stops taking signals and lets an order in
progress finish before it exits, so an order is never left between submission
and confirmation. Press Ctrl-C a second time to exit at once.

## Type checking

```bash
pip install -r requirements-dev.txt
mypy
```

## Gateway session notes

The gateway session is the part of this example most likely to stop working
unattended:

- **One session per username.** Logging in to TWS, the mobile app, or another
  gateway with the same username ends this one. A separate paper username helps
  here: you can watch the live account in TWS while the gateway trades paper.
- **Idle timeout.** IBKR closes a session that goes quiet for a few minutes.
  The service's keepalive every minute handles this.
- **Daily reset.** IBKR ends sessions at least once a day, and logging back in
  needs the browser and 2FA. `/status` reports `gatewayAuthenticated: false`
  and the logs say so when this happens. Orders fail until you log in again,
  then resume without a restart.

## Going to production

This is an example. Before trading real money you will want to add, at minimum:

- **Unattended login.** The browser login and its daily reset make the
  Client Portal Gateway a poor fit for a service nobody watches. For real money,
  look at IBKR's OAuth access to the Web API (available to some account types)
  or IB Gateway with the TWS API.
- **Confirmation policy.** The example confirms every question IBKR asks. In
  production, decide which message IDs you accept, suppress those up front with
  `/iserver/questions/suppress`, and treat any other question as a rejection.
- **Position sizing and risk limits.** Derive `ORDER_QUANTITY` from account
  equity and a cap on open positions instead of a constant.
- **Quote quality and guards.** The example refuses frozen, halted and
  prior-close quotes but trades on delayed ones. Reject delayed quotes too, and
  orders whose bid/ask spread is too wide to trade sanely.
- **Preview policy.** The example logs the what-if result and places the order
  regardless. In production, act on it: reject orders whose cost or margin
  impact exceeds a threshold.
- **Order lifecycle.** A placed limit order is not a fill. Track order status
  through `/iserver/account/orders` and decide what to do with day orders that
  never fill.

> ⚠️ With `IBKR_ALLOW_LIVE=true` and a live account ID, this service places
> orders with real money. Paper is the default.
