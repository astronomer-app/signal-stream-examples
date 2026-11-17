"""A minimal Signal Stream client for Python.

Astronomer publishes ``@astronomer-app/signals`` for Node but no Python
package yet, so this module implements the same wire protocol the Node client
uses: poll ``GET /api/v1/signals/stream?cursor=...`` with a bearer key. The
first request uses the ``latest`` cursor so a new process does not replay
historical signals.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Literal

DEFAULT_BASE_URL = "https://www.astronomerapp.com"
STREAM_PATH = "/api/v1/signals/stream"
DEFAULT_POLL_INTERVAL_S = 15.0
MIN_RECONNECT_DELAY_S = 1.0
MAX_RECONNECT_DELAY_S = 30.0
REQUEST_TIMEOUT_S = 30.0


@dataclass(frozen=True)
class Signal:
    id: str
    symbol: str
    option_type: Literal["C", "P"]
    strike_price: float
    expiration_date: str
    """ISO date, e.g. "2026-06-18"."""


@dataclass(frozen=True)
class SignalEvent:
    type: str
    created_at: str
    signal: Signal


@dataclass(frozen=True)
class PollResponse:
    events: list[SignalEvent]
    next_cursor: str | None
    retry_after_s: float | None
    window_open: bool | None


class SignalStreamError(Exception):
    def __init__(self, message: str, retry_after_s: float | None = None):
        super().__init__(message)
        self.retry_after_s = retry_after_s


def parse_event(data: Any) -> SignalEvent:
    if not isinstance(data, dict):
        raise SignalStreamError("Received malformed Signal Stream event")
    signal = data.get("signal")
    if (
        data.get("type") != "signal.created"
        or not isinstance(data.get("createdAt"), str)
        or not isinstance(signal, dict)
        or not isinstance(signal.get("id"), str)
        or not isinstance(signal.get("symbol"), str)
        or signal.get("optionType") not in ("C", "P")
        or not isinstance(signal.get("strikePrice"), (int, float))
        or isinstance(signal.get("strikePrice"), bool)
        or not isinstance(signal.get("expirationDate"), str)
    ):
        raise SignalStreamError("Received malformed Signal Stream event")
    return SignalEvent(
        type=data["type"],
        created_at=data["createdAt"],
        signal=Signal(
            id=signal["id"],
            symbol=signal["symbol"],
            option_type=signal["optionType"],
            strike_price=float(signal["strikePrice"]),
            expiration_date=signal["expirationDate"],
        ),
    )


def parse_poll_response(data: Any) -> PollResponse:
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        raise SignalStreamError("Received malformed Signal Stream response")
    next_cursor = data.get("nextCursor")
    if not (next_cursor is None or isinstance(next_cursor, str)):
        next_cursor = None
    retry_after_ms = data.get("retryAfterMs")
    retry_after_s = (
        retry_after_ms / 1000
        if isinstance(retry_after_ms, (int, float))
        and not isinstance(retry_after_ms, bool)
        and retry_after_ms > 0
        else None
    )
    window = data.get("window")
    window_open = window.get("open") is True if isinstance(window, dict) else None
    return PollResponse(
        events=[parse_event(e) for e in data["events"]],
        next_cursor=next_cursor,
        retry_after_s=retry_after_s,
        window_open=window_open,
    )


def _retry_after_from_headers(headers: Any) -> float | None:
    value = headers.get("Retry-After") if headers is not None else None
    if not value:
        return None
    try:
        seconds = int(value)
    except ValueError:
        return None
    return float(seconds) if seconds > 0 else None


class SignalStreamClient:
    """Polls Signal Stream and invokes callbacks; mirrors the Node client."""

    def __init__(self, api_key: str, base_url: str | None = None):
        if not api_key:
            raise ValueError("SignalStreamClient requires an api_key")
        self._api_key = api_key
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")

    def poll_once(self, cursor: str) -> PollResponse:
        query = urllib.parse.urlencode({"cursor": cursor})
        request = urllib.request.Request(
            f"{self._base_url}{STREAM_PATH}?{query}",
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self._api_key}",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as resp:
                body = resp.read()
        except urllib.error.HTTPError as error:
            raise SignalStreamError(
                f"Signal Stream request failed with status {error.code}",
                _retry_after_from_headers(error.headers),
            ) from error
        except urllib.error.URLError as error:
            raise SignalStreamError(
                f"Signal Stream request failed: {error.reason}"
            ) from error
        try:
            data = json.loads(body)
        except ValueError as error:
            raise SignalStreamError("Signal Stream returned invalid JSON") from error
        return parse_poll_response(data)

    def listen(
        self,
        on_signal: Callable[[SignalEvent], None],
        *,
        on_open: Callable[[], None] | None = None,
        on_close: Callable[[], None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
        stop: threading.Event | None = None,
    ) -> None:
        """Block and poll until ``stop`` is set. Run this in a thread."""
        stop = stop or threading.Event()
        cursor = "latest"
        opened = False
        attempt = 0
        try:
            while not stop.is_set():
                try:
                    response = self.poll_once(cursor)
                    if not opened:
                        opened = True
                        if on_open:
                            on_open()
                    for event in response.events:
                        on_signal(event)
                    cursor = response.next_cursor or cursor
                    attempt = 0
                    stop.wait(response.retry_after_s or DEFAULT_POLL_INTERVAL_S)
                except Exception as error:  # noqa: BLE001 - keep polling on any error
                    if stop.is_set():
                        return
                    if on_error:
                        on_error(error)
                    stop.wait(_error_retry_delay(error, attempt))
                    attempt += 1
        finally:
            if on_close:
                on_close()


def _error_retry_delay(error: Exception, attempt: int) -> float:
    if isinstance(error, SignalStreamError) and error.retry_after_s is not None:
        return float(error.retry_after_s)
    return min(MAX_RECONNECT_DELAY_S, MIN_RECONNECT_DELAY_S * float(2**attempt))
