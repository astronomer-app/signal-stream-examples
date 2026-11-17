"""Interactive Brokers options orders through the Client Portal Gateway.

Looks up IBKR's contract ID (conid) for a Signal Stream contract, prices a
marketable limit off the live ask, runs the order through IBKR's what-if check,
then submits it and answers IBKR's confirmation questions. Uses only the
standard library: the gateway speaks plain REST and JSON.
"""

from __future__ import annotations

import http.client
import json
import math
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

IBKR_DEFAULT_GATEWAY_URL = "https://localhost:5000"

MONTHS = (
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
)  # fmt: skip

# Snapshot field IDs. Prices come back as strings, sometimes prefixed with a
# letter: "C" for a prior close, "H" for halted.
FIELD_ASK = "86"
FIELD_MARKET_DATA_AVAILABILITY = "6509"

# The first snapshot for a contract usually comes back empty; poll this many
# times, half a second apart, for the ask.
QUOTE_ATTEMPTS = 5
QUOTE_RETRY_DELAY_S = 0.5

# How many precautionary questions to confirm before giving up on an order.
MAX_ORDER_REPLIES = 5

# The gateway answers in well under a second when healthy. Give up on a call
# long before an order would be priced from a stale ask.
REQUEST_TIMEOUT_S = 15.0

# IBKR allows about 10 requests a second across the gateway session. Spacing
# every call at least this far apart stays under that however fast the gateway
# answers.
MIN_REQUEST_GAP_S = 0.12

# Statuses for an order IBKR took but will not work: "Inactive" means it was
# rejected or held, for example over trading permissions or a price cap.
DEAD_ORDER_STATUSES = frozenset({"inactive", "cancelled", "apicancelled"})

LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


class IbkrError(Exception):
    """A gateway call failed, or IBKR would not take the order."""


@dataclass(frozen=True)
class IbkrConfig:
    gateway_url: str
    """The Client Portal Gateway, e.g. "https://localhost:5000"."""
    account_id: str
    """The account to trade, e.g. "DU1234567". Not the login username."""
    limit_slippage: float
    """How far above the ask to set the limit, as a fraction."""
    preview: bool
    """Run each order through the what-if check before placing it."""


@dataclass(frozen=True)
class OptionOrderRequest:
    underlying_symbol: str
    option_type: Literal["C", "P"]
    strike_price: float
    expiration_date: str
    """ISO date, e.g. "2026-06-18"."""
    quantity: int
    client_order_id: str
    """Sent as IBKR's customer order ID (`cOID`). IBKR rejects a second order
    with the same cOID, so keying it to the signal stops a replayed signal from
    placing a duplicate."""


@dataclass(frozen=True)
class OrderPreview:
    """What the what-if check says an order will cost, before it is placed."""

    total: float
    """Total debit for the order in dollars, commission included."""
    commission: float
    warning: str | None


@dataclass(frozen=True)
class PlacedOrder:
    id: str
    conid: int
    """IBKR's contract ID for the option."""
    status: str
    ask: float
    """The ask the limit was priced from, per share."""
    delayed_quote: bool
    """True when the gateway served a delayed quote instead of a live one."""
    limit_price: float
    """The submitted limit price, per share."""
    preview: OrderPreview | None
    """The what-if result, or None when previewing is off."""
    confirmed_warnings: list[str]
    """Precautionary messages IBKR asked to confirm, which were confirmed."""


@dataclass(frozen=True)
class AuthStatus:
    authenticated: bool
    connected: bool
    competing: bool
    """Another session (TWS, the mobile app) has the same username logged in."""
    message: str | None = None


@dataclass(frozen=True)
class IbkrAccount:
    id: str
    title: str | None
    type: str | None
    currency: str | None


@dataclass(frozen=True)
class Quote:
    ask: float
    delayed: bool


def is_paper_account(account_id: str) -> bool:
    # IBKR paper accounts are issued with a "D" prefix (DU1234567); live
    # individual and advisor accounts start with U, F, or I.
    return account_id[:1].upper() == "D"


def resolve_gateway_url(override: str | None = None) -> str:
    return (override or IBKR_DEFAULT_GATEWAY_URL).rstrip("/")


def format_strike(strike: float) -> str:
    """600.0 -> "600", 602.5 -> "602.5", the way the signal and IBKR write it."""
    return str(int(strike)) if strike.is_integer() else str(strike)


def describe_error(error: BaseException) -> str:
    return str(error) or type(error).__name__


def _ssl_context(gateway_url: str) -> ssl.SSLContext | None:
    """The gateway serves HTTPS with a self-signed certificate. Skip
    verification only when it runs on this machine, and only for gateway
    requests: the Signal Stream connection keeps normal TLS. A gateway on
    another host should get a real certificate instead."""
    hostname = urllib.parse.urlsplit(gateway_url).hostname or ""
    if hostname not in LOCAL_HOSTS:
        return None
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def _parse_price(value: object) -> tuple[float, str] | None:
    """Parses "2.48" into (2.48, ""), and "C2.48" into (2.48, "C")."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value), ""
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"([A-Z]?)([\d,]*\.?\d+)", value.strip(), re.IGNORECASE)
    if not match:
        return None
    parsed = float(match.group(2).replace(",", ""))
    return (parsed, match.group(1).upper()) if math.isfinite(parsed) else None


def _read_quote(snapshot: dict[str, Any] | None) -> Quote | str | None:
    """Reads the ask from a snapshot, refusing prices that are not a live
    market. Returns the quote, a reason the ask is unusable, or None when no
    ask has arrived yet.

    Field 6509 starts with R (real-time), D (delayed), Z (frozen), Y (frozen
    delayed) or N (not subscribed). The ask itself can carry a prefix: C for
    the prior close, H for a halted contract.
    """
    price = _parse_price((snapshot or {}).get(FIELD_ASK))
    if price is None or price[0] <= 0:
        return None
    ask, prefix = price
    if prefix == "C":
        return "only a prior-close ask, no live quote"
    if prefix == "H":
        return "the contract is halted"
    availability = str((snapshot or {}).get(FIELD_MARKET_DATA_AVAILABILITY) or "")[:1]
    if availability in ("Z", "Y"):
        return "the quote is frozen, not live"
    return Quote(ask=ask, delayed=availability == "D")


def _parse_amount(value: object) -> float:
    """Parses "2,480.65 USD" into 2480.65, taking the first number in the text."""
    match = re.search(
        r"-?\d[\d,]*(?:\.\d+)?|-?\.\d+", value if isinstance(value, str) else ""
    )
    if not match:
        return 0.0
    parsed = float(match.group(0).replace(",", ""))
    return parsed if math.isfinite(parsed) else 0.0


def _error_message_of(body: object) -> str | None:
    """The gateway's `{"error": "..."}` message, if the body is one."""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, str) and error:
            return error
    return None


def _read_error(status: int, body: bytes) -> str:
    """The gateway reports failures as `{"error": "..."}` and answers 401 with
    an HTML page when the session has lapsed. Turn both into something
    readable."""
    if status == 401:
        return "401: gateway session is not authenticated; log in again"
    text = body.decode("utf-8", errors="replace")
    try:
        message = _error_message_of(json.loads(text))
    except ValueError:
        message = None  # Not JSON; report the body as it came.
    if message:
        return f"{status}: {message}"
    return f"{status}: {text[:300]}" if text else str(status)


def round_up_to_tick(price: float) -> float:
    """Options trade in $0.05 increments below $3.00 and $0.10 at or above it.
    Rounding up keeps the slippage cushion instead of rounding it away. Penny
    pilot names such as SPY also accept $0.01 below $3.00, so this is coarser
    than it needs to be there, never finer than the exchange allows."""
    tick_cents = 5 if price < 3 else 10
    price_cents = math.floor(price * 100 + 0.5)
    return math.ceil(price_cents / tick_cents) * tick_cents / 100


def to_contract_date(expiration_date: str) -> tuple[str, str]:
    """Splits "2026-06-18" into the forms IBKR's contract lookup wants: the
    month code ("JUN26") and the maturity date ("20260618")."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", expiration_date):
        raise IbkrError(
            f'Invalid expiration date "{expiration_date}"; expected YYYY-MM-DD'
        )
    try:
        expiration = date.fromisoformat(expiration_date)
    except ValueError as error:
        raise IbkrError(f'Invalid expiration date "{expiration_date}"') from error
    month = f"{MONTHS[expiration.month - 1]}{expiration.year % 100:02d}"
    return month, expiration.strftime("%Y%m%d")


class IbkrGateway:
    """A thin client for the Client Portal Gateway's REST API. The gateway
    holds the brokerage session; this process only needs to keep it alive and
    call it. Safe to share between threads."""

    def __init__(self, gateway_url: str):
        self._api_url = f"{gateway_url}/v1/api"
        context = _ssl_context(gateway_url)
        handlers = [urllib.request.HTTPSHandler(context=context)] if context else []
        self._opener = urllib.request.build_opener(*handlers)
        self._turn_lock = threading.Lock()
        self._next_request_at = 0.0

    def auth_status(self) -> AuthStatus:
        """Whether the gateway holds a logged-in session. A gateway that is
        running but not logged in answers 401, which is reported here as not
        logged in."""
        status, body = self.request("/iserver/auth/status", "POST")
        if status == 401:
            return AuthStatus(authenticated=False, connected=False, competing=False)
        if not 200 <= status < 300:
            raise IbkrError(
                f"IBKR auth status check failed ({_read_error(status, body)})"
            )
        data = _parse_json(body, "auth status check")
        if not isinstance(data, dict):
            data = {}
        message = data.get("message")
        return AuthStatus(
            authenticated=data.get("authenticated") is True,
            connected=data.get("connected") is True,
            competing=data.get("competing") is True,
            message=message if isinstance(message, str) else None,
        )

    def tickle(self) -> None:
        """Keeps the gateway session from timing out. IBKR closes an idle
        session after a few minutes; calling this about once a minute holds it
        open. A 401 means the session has already lapsed, which auth_status()
        reports."""
        status, body = self.request("/tickle", "POST")
        if not 200 <= status < 300 and status != 401:
            raise IbkrError(f"IBKR keepalive failed ({_read_error(status, body)})")

    def brokerage_accounts(self) -> list[str]:
        """The accounts this session can trade. IBKR requires this call before
        any order endpoint in each new brokerage session."""
        body = self.fetch_json("/iserver/accounts", "account lookup")
        accounts = body.get("accounts") if isinstance(body, dict) else None
        return (
            [a for a in accounts if isinstance(a, str)]
            if isinstance(accounts, list)
            else []
        )

    def portfolio_accounts(self) -> list[IbkrAccount]:
        """Account details for `python accounts.py`."""
        accounts = []
        for item in self.fetch_list("/portfolio/accounts", "portfolio account lookup"):
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                continue
            accounts.append(
                IbkrAccount(
                    id=item["id"],
                    title=_text(item.get("accountTitle")) or _text(item.get("desc")),
                    type=_text(item.get("type")),
                    currency=_text(item.get("currency")),
                )
            )
        return accounts

    def fetch_json(
        self, path: str, action: str, method: str = "GET", payload: object = None
    ) -> Any:
        """Sends a request and parses the JSON it returns. The gateway
        sometimes answers a failure with a 200 and `{"error": "..."}`, so that
        is treated as a failure too."""
        status, body = self.request(path, method, payload)
        if not 200 <= status < 300:
            raise IbkrError(f"IBKR {action} failed ({_read_error(status, body)})")
        data = _parse_json(body, action)
        error = _error_message_of(data)
        if error:
            raise IbkrError(f"IBKR {action} failed: {error}")
        return data

    def fetch_list(self, path: str, action: str) -> list[Any]:
        """Like fetch_json(), for endpoints that answer with a list."""
        data = self.fetch_json(path, action)
        if not isinstance(data, list):
            raise IbkrError(
                f"IBKR {action} returned an unexpected response: {json.dumps(data)[:300]}"
            )
        return data

    def request(
        self, path: str, method: str, payload: object = None
    ) -> tuple[int, bytes]:
        """Sends one request and returns its status and body. Error statuses
        come back as statuses; a gateway that cannot be reached raises."""
        self._wait_for_turn()
        headers = {"Accept": "application/json"}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode()
        request = urllib.request.Request(
            f"{self._api_url}{path}", data=data, headers=headers, method=method
        )
        endpoint = path.split("?")[0]
        try:
            with self._opener.open(request, timeout=REQUEST_TIMEOUT_S) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.read()
        except urllib.error.URLError as error:
            if isinstance(error.reason, TimeoutError):
                raise _timeout(endpoint) from error
            raise IbkrError(
                f"Connection to the IBKR gateway failed ({error.reason})"
            ) from error
        except TimeoutError as error:
            raise _timeout(endpoint) from error
        except (OSError, http.client.HTTPException) as error:
            raise IbkrError(
                f"IBKR gateway request to {endpoint} failed ({error!r})"
            ) from error

    def _wait_for_turn(self) -> None:
        """Holds each request until at least MIN_REQUEST_GAP_S after the one
        before it. The slot is claimed before waiting, so the keepalive and an
        order in progress queue up behind each other instead of racing."""
        with self._turn_lock:
            now = time.monotonic()
            turn = max(now, self._next_request_at)
            self._next_request_at = turn + MIN_REQUEST_GAP_S
        if turn > now:
            time.sleep(turn - now)


def _timeout(endpoint: str) -> IbkrError:
    return IbkrError(
        f"IBKR gateway did not answer {endpoint} within {REQUEST_TIMEOUT_S:g}s"
    )


def _parse_json(body: bytes, action: str) -> Any:
    try:
        return json.loads(body)
    except ValueError as error:
        raise IbkrError(f"IBKR {action} returned invalid JSON") from error


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


class IbkrClient:
    def __init__(self, config: IbkrConfig):
        if not math.isfinite(config.limit_slippage) or config.limit_slippage < 0:
            raise ValueError("ORDER_LIMIT_SLIPPAGE must be zero or greater")
        self._config = config
        self.gateway = IbkrGateway(config.gateway_url)
        self._session_ready = False
        self._underlying_conids: dict[str, str] = {}

    def place_option_order(self, req: OptionOrderRequest) -> PlacedOrder:
        if req.quantity <= 0:
            raise ValueError("ORDER_QUANTITY must be a positive integer")
        try:
            return self._place_order(req)
        except Exception:
            # IBKR ends the brokerage session at least daily, and a new one
            # needs the account and symbol lookups again. A failure may be the
            # first sign of that, so start the next order from a fresh session.
            self.reset_session()
            raise

    def open_session(self) -> None:
        """Checks IBKR_ACCOUNT_ID against the session's accounts. IBKR also
        requires this call to open the brokerage session before any order
        endpoint, so it runs at startup and again after each reset."""
        if self._session_ready:
            return
        accounts = self.gateway.brokerage_accounts()
        if self._config.account_id not in accounts:
            raise IbkrError(
                f"IBKR_ACCOUNT_ID {self._config.account_id} is not one of this "
                f"session's accounts ({', '.join(accounts) or 'none'})"
            )
        self._session_ready = True

    def reset_session(self) -> None:
        """Forgets the brokerage session, so the next order reopens it and
        repeats the symbol lookups IBKR wants once per session. Call it when
        the gateway reports it is no longer logged in."""
        self._session_ready = False
        self._underlying_conids.clear()

    def _place_order(self, req: OptionOrderRequest) -> PlacedOrder:
        self.open_session()

        conid = self._resolve_option_conid(req)
        quote = self._get_ask(conid)
        limit_price = round_up_to_tick(quote.ask * (1 + self._config.limit_slippage))

        order = {
            "acctId": self._config.account_id,
            "conid": conid,
            "cOID": req.client_order_id,
            "orderType": "LMT",
            "price": limit_price,
            "side": "BUY",
            "tif": "DAY",
            "quantity": req.quantity,
        }

        # The what-if check runs the real validation (buying power, trading
        # permissions, contract validity) and returns the cost without sending
        # anything to the market. A rejection here is a log line instead of a
        # live order you have to unwind.
        preview = self._what_if(order) if self._config.preview else None

        order_id, status, confirmed_warnings = self._submit(order)
        return PlacedOrder(
            id=order_id,
            conid=conid,
            status=status,
            ask=quote.ask,
            delayed_quote=quote.delayed,
            limit_price=limit_price,
            preview=preview,
            confirmed_warnings=confirmed_warnings,
        )

    def _resolve_option_conid(self, req: OptionOrderRequest) -> int:
        """IBKR identifies every contract by a numeric conid rather than an OCC
        symbol, so an option takes three lookups: the underlying's conid, the
        strikes listed for the expiration month, then the contracts at that
        strike, filtered to the exact expiration date. A month holds every
        weekly and daily expiration in it, so the date filter is what picks a
        0DTE contract."""
        underlying = req.underlying_symbol.upper()
        month, maturity_date = to_contract_date(req.expiration_date)
        if not math.isfinite(req.strike_price) or req.strike_price <= 0:
            raise IbkrError(f'Invalid strike price "{req.strike_price}"')
        strike = format_strike(req.strike_price)
        label = f"{underlying} {strike}{req.option_type}"

        underlying_conid = self._get_underlying_conid(underlying, month)

        # IBKR's documented flow calls strikes before info for options; it also
        # gives a clearer error than an empty info response when the strike is
        # not listed.
        strikes_query = urllib.parse.urlencode(
            {
                "conid": underlying_conid,
                "sectype": "OPT",
                "month": month,
                "exchange": "SMART",
            }
        )
        strikes = self.gateway.fetch_json(
            f"/iserver/secdef/strikes?{strikes_query}", "strike lookup"
        )
        side = (
            strikes.get("call" if req.option_type == "C" else "put")
            if isinstance(strikes, dict)
            else None
        )
        listed = side if isinstance(side, list) else []
        if not any(
            isinstance(s, (int, float)) and abs(s - req.strike_price) < 1e-6
            for s in listed
        ):
            raise IbkrError(
                f"{underlying} has no {strike}{req.option_type} listed in {month}"
            )

        # Unlike secdef/search, this endpoint spells the parameter "sectype".
        info_query = urllib.parse.urlencode(
            {
                "conid": underlying_conid,
                "sectype": "OPT",
                "month": month,
                "strike": strike,
                "right": req.option_type,
                "exchange": "SMART",
            }
        )
        contracts = self.gateway.fetch_list(
            f"/iserver/secdef/info?{info_query}", "contract lookup"
        )
        matches = [
            c
            for c in contracts
            if isinstance(c, dict)
            and c.get("maturityDate") == maturity_date
            and c.get("right") == req.option_type
            and _is_int(c.get("conid"))
            and (c.get("multiplier") is None or str(c.get("multiplier")) == "100")
        ]
        if not matches:
            raise IbkrError(f"No {label} contract expiring {req.expiration_date}")

        # After a split or special dividend, an adjusted series can list at the
        # same strike and date under its own trading class (AAPL1) with a
        # different deliverable. Only buy the standard class, named for the
        # underlying, and refuse rather than guess when that is not one
        # contract.
        standard = list(
            dict.fromkeys(
                int(c["conid"])
                for c in matches
                if (
                    c.get("tradingClass")
                    if c.get("tradingClass") is not None
                    else underlying
                )
                == underlying
            )
        )
        if not standard:
            classes = ", ".join(
                dict.fromkeys(str(c.get("tradingClass")) for c in matches)
            )
            raise IbkrError(
                f"Only adjusted {label} contracts expire {req.expiration_date} "
                f"(trading class {classes}); not buying a non-standard deliverable"
            )
        if len(standard) > 1:
            raise IbkrError(
                f"Found {len(standard)} {label} contracts expiring {req.expiration_date} "
                "and cannot tell which is standard"
            )
        return standard[0]

    def _get_underlying_conid(self, underlying: str, month: str) -> str:
        cached = self._underlying_conids.get(underlying)
        if cached:
            return cached

        query = urllib.parse.urlencode({"symbol": underlying, "secType": "STK"})
        results = self.gateway.fetch_list(
            f"/iserver/secdef/search?{query}", "symbol search"
        )

        # A search can match several listings (other exchanges, other
        # countries). Take the exact symbol that has US options listed for
        # this month.
        def lists_month(result: dict[str, Any]) -> bool:
            sections = result.get("sections")
            return isinstance(sections, list) and any(
                isinstance(section, dict)
                and section.get("secType") == "OPT"
                and month in str(section.get("months") or "").split(";")
                for section in sections
            )

        match = next(
            (
                r
                for r in results
                if isinstance(r, dict)
                and str(r.get("symbol") or "").upper() == underlying
                and r.get("conid")
                and lists_month(r)
            ),
            None,
        )
        if match is None:
            raise IbkrError(f"IBKR found no {underlying} options listed for {month}")

        conid = str(match["conid"])
        self._underlying_conids[underlying] = conid
        return conid

    def _get_ask(self, conid: int) -> Quote:
        """The first snapshot request for a contract only subscribes to it, and
        usually comes back without prices. Poll briefly until the ask
        arrives."""
        query = urllib.parse.urlencode(
            {"conids": conid, "fields": f"{FIELD_ASK},{FIELD_MARKET_DATA_AVAILABILITY}"}
        )
        problem: str | None = None
        for attempt in range(1, QUOTE_ATTEMPTS + 1):
            snapshots = self.gateway.fetch_list(
                f"/iserver/marketdata/snapshot?{query}", "quote"
            )
            snapshot = next(
                (
                    s
                    for s in snapshots
                    if isinstance(s, dict) and str(s.get("conid")) == str(conid)
                ),
                None,
            )
            quote = _read_quote(snapshot)
            if isinstance(quote, Quote):
                return quote
            problem = quote or problem
            if attempt < QUOTE_ATTEMPTS:
                time.sleep(QUOTE_RETRY_DELAY_S)

        if problem:
            raise IbkrError(f"No usable ask for conid {conid}: {problem}")
        raise IbkrError(
            f"No ask price for conid {conid}. Check the account has options market data "
            "(OPRA), shared with the paper account if you are paper trading."
        )

    def _what_if(self, order: dict[str, object]) -> OrderPreview:
        account = urllib.parse.quote(self._config.account_id, safe="")
        body = self.gateway.fetch_json(
            f"/iserver/account/{account}/orders/whatif",
            "what-if check",
            "POST",
            {"orders": [order]},
        )
        amount = body.get("amount") if isinstance(body, dict) else None
        amount = amount if isinstance(amount, dict) else {}
        warning = body.get("warn") if isinstance(body, dict) else None
        return OrderPreview(
            total=_parse_amount(amount.get("total")),
            commission=_parse_amount(amount.get("commission")),
            warning=_text(warning),
        )

    def _submit(self, order: dict[str, object]) -> tuple[str, str, list[str]]:
        """Submits the order and answers IBKR's precautionary questions. Each
        one must be confirmed through /iserver/reply before the order is sent;
        the example confirms them and reports what it confirmed. See the README
        before doing the same with real money.

        Returns the order ID, its status, and the confirmed messages.
        """
        account = urllib.parse.quote(self._config.account_id, safe="")
        confirmed_warnings: list[str] = []
        body = self.gateway.fetch_json(
            f"/iserver/account/{account}/orders",
            "order placement",
            "POST",
            {"orders": [order]},
        )

        # Each answer is either the placed order, or a question ("This order
        # will be routed...") that has to be confirmed before IBKR sends it.
        for round_number in range(MAX_ORDER_REPLIES + 1):
            reply = (body[0] if body else None) if isinstance(body, list) else body
            if not isinstance(reply, dict):
                raise IbkrError("IBKR returned an empty order response")
            if reply.get("error"):
                raise IbkrError(f"IBKR rejected the order: {reply['error']}")
            if reply.get("order_id"):
                order_id = str(reply["order_id"])
                status = str(reply.get("order_status") or "unknown")
                if status.lower() in DEAD_ORDER_STATUSES:
                    text = f", {reply['text']}" if reply.get("text") else ""
                    raise IbkrError(
                        f"IBKR took order {order_id} but will not work it (status: {status}{text})"
                    )
                return order_id, status, confirmed_warnings
            if not reply.get("id"):
                raise IbkrError(
                    f"Unexpected IBKR order response: {json.dumps(body)[:300]}"
                )

            if round_number == MAX_ORDER_REPLIES:
                break
            messages = reply.get("message")
            if isinstance(messages, list):
                confirmed_warnings.extend(str(m) for m in messages)
            reply_id = urllib.parse.quote(str(reply["id"]), safe="")
            body = self.gateway.fetch_json(
                f"/iserver/reply/{reply_id}",
                "order confirmation",
                "POST",
                {"confirmed": True},
            )

        raise IbkrError(
            f"IBKR asked for more than {MAX_ORDER_REPLIES} confirmations; order not placed"
        )
