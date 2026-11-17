"""A tiny status server: a liveness check and a snapshot of runtime counters.

It also gives orchestration (Docker, Fly, Render, etc.) something to probe.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


@dataclass
class RuntimeStats:
    """Counters the listener updates and the status endpoint reads."""

    started_at: str
    connected: bool
    trading_enabled: bool
    gateway_authenticated: bool | None = None
    """Whether the gateway answered its last keepalive as logged in. None in
    dry-run mode, where there is no gateway."""
    signals_received: int = 0
    orders_placed: int = 0
    orders_failed: int = 0
    last_signal_at: str | None = None

    def to_dict(self) -> dict[str, object]:
        # Same camelCase keys the Node examples expose.
        return {_camel(key): value for key, value in asdict(self).items()}


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.capitalize() for part in rest)


def create_status_server(stats: RuntimeStats, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - http.server API
            if self.path == "/health":
                self._json(200, {"ok": True})
            elif self.path == "/status":
                self._json(200, stats.to_dict())
            else:
                self._json(404, {"error": "not found"})

        def _json(self, status: int, body: object) -> None:
            payload = json.dumps(body, indent=2).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            pass  # keep request logs out of the signal log

    return ThreadingHTTPServer(("", port), Handler)
