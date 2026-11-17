"""Signal Stream -> Interactive Brokers: place an options order for each signal."""

from __future__ import annotations

import io
import os
import signal as os_signal
import sys
import threading
from datetime import datetime, timezone

from dotenv import load_dotenv

from config import fail, read_bool, read_float, read_int, require_env
from ibkr import (
    IbkrClient,
    IbkrConfig,
    OptionOrderRequest,
    describe_error,
    format_strike,
    is_paper_account,
    resolve_gateway_url,
)
from server import RuntimeStats, create_status_server
from signal_stream import PollResponse, SignalEvent, SignalStreamClient

# The gateway drops an idle session after a few minutes; a keepalive about once
# a minute holds it open.
KEEPALIVE_INTERVAL_S = 60.0


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class TrackedSignalStream(SignalStreamClient):
    """The listener calls on_open once and on_close only when it stops, so
    neither notices an outage. Track the polls themselves instead: `connected`
    in /status means the last poll reached Signal Stream."""

    def __init__(self, api_key: str, base_url: str | None, stats: RuntimeStats):
        super().__init__(api_key, base_url)
        self._stats = stats

    def poll_once(self, cursor: str) -> PollResponse:
        try:
            response = super().poll_once(cursor)
        except Exception:
            self._stats.connected = False
            raise
        self._stats.connected = True
        return response


def check_gateway(ibkr: IbkrClient, gateway_url: str, stats: RuntimeStats) -> None:
    """Checks the gateway and the account before listening, so a logged-out
    session or a wrong IBKR_ACCOUNT_ID fails at startup rather than on the
    first signal of the day."""
    try:
        status = ibkr.gateway.auth_status()
    except Exception as error:  # noqa: BLE001 - exit with the reason
        print(f"Could not reach the IBKR gateway at {gateway_url}.", file=sys.stderr)
        fail(describe_error(error))
    stats.gateway_authenticated = status.authenticated
    if not status.authenticated:
        print(
            f"The gateway at {gateway_url} is running but not logged in.",
            file=sys.stderr,
        )
        fail(f"Open {gateway_url} in a browser and log in, then restart.")
    if status.competing:
        print(
            "Warning: another session is logged in with this username. IBKR allows "
            "one brokerage session per username, so orders may fail until it logs out.",
            file=sys.stderr,
        )
    try:
        ibkr.open_session()
    except Exception as error:  # noqa: BLE001 - exit with the reason
        print(describe_error(error), file=sys.stderr)
        fail("Run `python accounts.py` to list the accounts you can use.")


def keep_alive(
    ibkr: IbkrClient,
    gateway_url: str,
    stats: RuntimeStats,
    stop: threading.Event,
    interval_s: float = KEEPALIVE_INTERVAL_S,
) -> None:
    """Pings the gateway every interval until stop is set, and reports when the
    session lapses. Run this in a thread."""
    while not stop.wait(interval_s):
        try:
            ibkr.gateway.tickle()
            status = ibkr.gateway.auth_status()
            if not status.authenticated:
                # The next order after you log back in opens a new session.
                ibkr.reset_session()
                if stats.gateway_authenticated:
                    print(
                        f"Gateway session lapsed. Log in again at {gateway_url}; "
                        "orders will fail until you do.",
                        file=sys.stderr,
                    )
            stats.gateway_authenticated = status.authenticated
        except Exception as error:  # noqa: BLE001 - keep pinging
            ibkr.reset_session()
            stats.gateway_authenticated = False
            print(f"Gateway keepalive failed: {describe_error(error)}", file=sys.stderr)


def main() -> None:
    load_dotenv()
    # Print each line as it happens, even when output goes to a pipe or a log
    # collector rather than a terminal.
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(line_buffering=True)

    signal_key = require_env("ASTRONOMER_SIGNAL_STREAM_KEY")
    signal_base_url = os.environ.get("ASTRONOMER_SIGNAL_STREAM_BASE_URL")
    port = read_int("PORT", 8080)
    quantity = read_int("ORDER_QUANTITY", 1)
    limit_slippage = read_float("ORDER_LIMIT_SLIPPAGE", 0.02)
    preview = read_bool("ORDER_PREVIEW", True)
    allow_live = read_bool("IBKR_ALLOW_LIVE", False)
    if not 1 <= port <= 65535:
        fail("PORT must be an integer between 1 and 65535")
    if quantity <= 0:
        fail("ORDER_QUANTITY must be a positive integer")
    if not limit_slippage >= 0:
        fail("ORDER_LIMIT_SLIPPAGE must be zero or greater")

    gateway_url = resolve_gateway_url(os.environ.get("IBKR_GATEWAY_URL"))
    # IBKR issues account IDs in upper case (DU1234567).
    account_id = os.environ.get("IBKR_ACCOUNT_ID", "").strip().upper()

    # Trading is opt-in. With an account set, signals place orders through the
    # gateway; without one the example runs as a dry run so you can watch the
    # flow first. The gateway decides paper or live by which username logged
    # in to it, so a live account ID is refused unless IBKR_ALLOW_LIVE says
    # otherwise.
    trading_enabled = account_id != ""
    live_account = trading_enabled and not is_paper_account(account_id)
    if live_account and not allow_live:
        print(
            f'IBKR_ACCOUNT_ID {account_id} is a live account (paper accounts start with "D").',
            file=sys.stderr,
        )
        fail("Set IBKR_ALLOW_LIVE=true to place real-money orders.")

    ibkr = (
        IbkrClient(IbkrConfig(gateway_url, account_id, limit_slippage, preview))
        if trading_enabled
        else None
    )
    stats = RuntimeStats(
        started_at=now_iso(), connected=False, trading_enabled=trading_enabled
    )
    if ibkr:
        check_gateway(ibkr, gateway_url, stats)

    # Set on Ctrl-C or SIGTERM. Stops the keepalive, the listener, and any
    # signals still waiting to be handled.
    stop = threading.Event()
    if ibkr:
        threading.Thread(
            target=keep_alive, args=(ibkr, gateway_url, stats, stop), daemon=True
        ).start()

    try:
        server = create_status_server(stats, port)
    except OSError as error:
        fail(f"Could not start the status server on port {port}: {error}")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"Status server listening on http://localhost:{port}")
    print("  GET /health   liveness check")
    print("  GET /status   runtime counters")
    if live_account:
        print(f"LIVE trading enabled in {account_id} via {gateway_url}")
        print("Orders placed by this process use real money.")
    elif trading_enabled:
        print(f"Paper trading enabled in {account_id} via {gateway_url}")
    else:
        print("Trading disabled (no IBKR_ACCOUNT_ID) — dry-run mode")
    if trading_enabled and not preview:
        print("What-if checks disabled (ORDER_PREVIEW=false)")

    # Set while an order is being placed, so shutdown can say it is waiting.
    order_in_progress = threading.Event()

    def handle_signal(event: SignalEvent) -> None:
        sig = event.signal
        stats.signals_received += 1
        stats.last_signal_at = now_iso()

        contract = f"{format_strike(sig.strike_price)}{sig.option_type}"
        label = f"{sig.symbol} {contract} exp {sig.expiration_date}"
        print(f"Signal received: {label}")

        if stop.is_set():
            print("  Skipped: shutting down")
            return

        if ibkr is None:
            print(f"  [dry run] would buy {quantity}x {label}")
            return

        order_in_progress.set()
        try:
            order = ibkr.place_option_order(
                OptionOrderRequest(
                    underlying_symbol=sig.symbol,
                    option_type=sig.option_type,
                    strike_price=sig.strike_price,
                    expiration_date=sig.expiration_date,
                    quantity=quantity,
                    client_order_id=f"astronomer-{sig.id}",
                )
            )
        except Exception as error:  # noqa: BLE001 - one bad order must not stop the listener
            stats.orders_failed += 1
            print(
                f"  Order failed for {label}: {describe_error(error)}", file=sys.stderr
            )
            return
        finally:
            order_in_progress.clear()

        stats.orders_placed += 1
        if order.preview:
            print(
                f"  What-if: total ${order.preview.total:.2f}, "
                f"commission ${order.preview.commission:.2f}"
            )
            if order.preview.warning:
                print(f"  What-if warning: {order.preview.warning}")
        for warning in order.confirmed_warnings:
            print(f"  Confirmed: {warning}")
        if order.delayed_quote:
            print("  Note: the ask came from a delayed quote.")
        print(
            f"  Order {order.id} placed (conid {order.conid}, limit {order.limit_price:g} "
            f"vs ask {order.ask:g}, status: {order.status})"
        )

    # The listener calls this on its own thread for one signal at a time, so a
    # burst at the open becomes a short queue rather than a spike of gateway
    # requests that trips IBKR's rate limits. It must not raise: the listener
    # would treat that as a failed poll and deliver the same signals again.
    def on_signal(event: SignalEvent) -> None:
        try:
            handle_signal(event)
        except Exception as error:  # noqa: BLE001 - see above
            print(f"Signal handler failed: {describe_error(error)}", file=sys.stderr)

    def on_open() -> None:
        print("Signal Stream connected.")

    def on_close() -> None:
        stats.connected = False
        print("Signal Stream closed.")

    def on_error(error: Exception) -> None:
        print(f"Signal Stream error: {error}", file=sys.stderr)

    client = TrackedSignalStream(signal_key, signal_base_url, stats)
    listener = threading.Thread(
        target=client.listen,
        args=(on_signal,),
        kwargs={
            "on_open": on_open,
            "on_close": on_close,
            "on_error": on_error,
            "stop": stop,
        },
        daemon=True,
    )
    listener.start()

    # Stops taking signals and lets an order in progress finish, so it is never
    # cut off between submission and confirmation. Signals still queued behind
    # it are skipped. A second Ctrl-C exits at once.
    def shutdown(*_: object) -> None:
        os_signal.signal(os_signal.SIGINT, os_signal.SIG_DFL)
        os_signal.signal(os_signal.SIGTERM, os_signal.SIG_DFL)
        print("\nShutting down...")
        stop.set()
        if order_in_progress.is_set():
            print("Waiting for the order in progress to finish...")

    os_signal.signal(os_signal.SIGINT, shutdown)
    os_signal.signal(os_signal.SIGTERM, shutdown)

    # Wait in the main thread so the signal handlers run promptly.
    while listener.is_alive():
        listener.join(timeout=0.5)
    server.shutdown()


if __name__ == "__main__":
    main()
