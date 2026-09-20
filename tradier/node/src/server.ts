import { createServer, type Server } from 'node:http';

// Counters the listener updates and the status endpoint reads. Keeping them in
// one object means the HTTP server and the signal listener share live state.
export interface RuntimeStats {
  startedAt: string;
  connected: boolean;
  tradingEnabled: boolean;
  signalsReceived: number;
  ordersPlaced: number;
  ordersFailed: number;
  lastSignalAt: string | null;
}

// A tiny status server built on the internal http module: a liveness check and
// a snapshot of what the listener has done so far. It also keeps the process
// alive and gives orchestration (Docker, Fly, Render, etc.) something to probe.
export function createStatusServer(stats: RuntimeStats): Server {
  return createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats, null, 2));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}
