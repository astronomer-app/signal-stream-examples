import {
  Agent,
  fetch,
  Headers,
  type RequestInit,
  type Response,
} from 'undici';

export const IBKR_DEFAULT_GATEWAY_URL = 'https://localhost:5000';

export interface IbkrConfig {
  /** The Client Portal Gateway, e.g. "https://localhost:5000". */
  gatewayUrl: string;
  /** The account to trade, e.g. "DU1234567". Not the login username. */
  accountId: string;
  /** How far above the ask to set the limit, as a fraction. */
  limitSlippage: number;
  /** Run each order through the what-if check before placing it. */
  preview: boolean;
}

export interface OptionOrderRequest {
  underlyingSymbol: string;
  optionType: 'C' | 'P';
  strikePrice: number;
  /** ISO date, e.g. "2026-06-18". */
  expirationDate: string;
  quantity: number;
  /**
   * Sent as IBKR's customer order ID (`cOID`). IBKR rejects a second order
   * with the same cOID, so keying it to the signal stops a replayed signal
   * from placing a duplicate.
   */
  clientOrderId: string;
}

/** What the what-if check says an order will cost, before it is placed. */
export interface OrderPreview {
  /** Total debit for the order in dollars, commission included. */
  total: number;
  commission: number;
  /** The check's warning text, if it returned one. */
  warning: string | null;
}

export interface PlacedOrder {
  id: string;
  /** IBKR's contract ID for the option. */
  conid: number;
  status: string;
  /** The ask the limit was priced from, per share. */
  ask: number;
  /** True when the gateway served a delayed quote instead of a live one. */
  delayedQuote: boolean;
  /** The submitted limit price, per share. */
  limitPrice: number;
  /** The what-if result, or null when previewing is off. */
  preview: OrderPreview | null;
  /** Precautionary messages IBKR asked to confirm, which were confirmed. */
  confirmedWarnings: string[];
}

export interface AuthStatus {
  authenticated: boolean;
  connected: boolean;
  /** Another session (TWS, the mobile app) has the same username logged in. */
  competing: boolean;
  message?: string;
}

export interface IbkrAccount {
  id: string;
  accountTitle?: string;
  desc?: string;
  type?: string;
  currency?: string;
}

interface SecdefSearchResult {
  conid?: string | number;
  symbol?: string;
  description?: string;
  sections?: { secType?: string; months?: string }[];
}

interface StrikesResponse {
  call?: number[];
  put?: number[];
}

interface SecdefInfo {
  conid?: number;
  maturityDate?: string;
  strike?: number;
  right?: string;
  multiplier?: string | number;
  tradingClass?: string;
}

type Snapshot = Record<string, string | number | undefined>;

interface WhatIfResponse {
  amount?: { amount?: string; commission?: string; total?: string };
  warn?: string | null;
  error?: string | null;
}

// An order submission answers with either the placed order, or a precautionary
// question ("This order will be routed...") that has to be confirmed through
// /iserver/reply before the order is actually sent.
interface OrderReply {
  order_id?: string;
  order_status?: string;
  text?: string;
  id?: string;
  message?: string[];
  error?: string;
}

const MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

// Snapshot field IDs. Prices come back as strings, sometimes prefixed with a
// letter: "C" for a prior close, "H" for halted.
const FIELD_ASK = '86';
const FIELD_MARKET_DATA_AVAILABILITY = '6509';

// The first snapshot for a contract usually comes back empty; poll this many
// times, half a second apart, for the ask.
const QUOTE_ATTEMPTS = 5;

// How many precautionary questions to confirm before giving up on an order.
const MAX_ORDER_REPLIES = 5;

// The gateway answers in well under a second when healthy. Give up on a call
// long before an order would be priced from a stale ask.
const REQUEST_TIMEOUT_MS = 15_000;

// IBKR allows about 10 requests a second across the gateway session. Spacing
// every call at least this far apart stays under that however fast the
// gateway answers.
const MIN_REQUEST_GAP_MS = 120;

// Statuses for an order IBKR took but will not work: "Inactive" means it was
// rejected or held, for example over trading permissions or a price cap.
const DEAD_ORDER_STATUSES = new Set(['inactive', 'cancelled', 'apicancelled']);

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPaperAccount(accountId: string): boolean {
  // IBKR paper accounts are issued with a "D" prefix (DU1234567); live
  // individual and advisor accounts start with U, F, or I.
  return /^D/i.test(accountId);
}

export function resolveGatewayUrl(override?: string): string {
  return withoutTrailingSlash(override || IBKR_DEFAULT_GATEWAY_URL);
}

/**
 * The gateway serves HTTPS with a self-signed certificate. Skip verification
 * only when it runs on this machine, and only for gateway requests: the Signal
 * Stream connection keeps normal TLS. A gateway on another host should get a
 * real certificate instead.
 */
function createDispatcher(gatewayUrl: string): Agent | undefined {
  const { hostname } = new URL(gatewayUrl);
  const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  return isLocal
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;
}

/** Parses "2.48" into 2.48, and "C2.48" into 2.48 with the prefix "C". */
function parsePrice(
  value: string | number | undefined,
): { value: number; prefix: string } | null {
  if (typeof value === 'number') {
    return { value, prefix: '' };
  }
  const match = /^([A-Z]?)([\d,]*\.?\d+)$/i.exec(value?.trim() ?? '');
  if (!match) {
    return null;
  }
  const parsed = Number(match[2].replace(/,/g, ''));
  return Number.isFinite(parsed)
    ? { value: parsed, prefix: match[1].toUpperCase() }
    : null;
}

/**
 * Reads the ask from a snapshot, refusing prices that are not a live market.
 * Field 6509 starts with R (real-time), D (delayed), Z (frozen), Y (frozen
 * delayed) or N (not subscribed). The ask itself can carry a prefix: C for the
 * prior close, H for a halted contract.
 */
function readQuote(
  snapshot: Snapshot | undefined,
): { ask: number; delayed: boolean } | { problem: string | null } {
  const price = parsePrice(snapshot?.[FIELD_ASK]);
  if (!price || price.value <= 0) {
    return { problem: null };
  }
  if (price.prefix === 'C') {
    return { problem: 'only a prior-close ask, no live quote' };
  }
  if (price.prefix === 'H') {
    return { problem: 'the contract is halted' };
  }
  const availability = String(
    snapshot?.[FIELD_MARKET_DATA_AVAILABILITY] ?? '',
  ).charAt(0);
  if (availability === 'Z' || availability === 'Y') {
    return { problem: 'the quote is frozen, not live' };
  }
  return { ask: price.value, delayed: availability === 'D' };
}

/** Parses "2,480.65 USD" into 2480.65, taking the first number in the text. */
function parseAmount(value: string | undefined): number {
  const match = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/.exec(value ?? '');
  const parsed = match ? Number(match[0].replace(/,/g, '')) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The gateway's `{"error": "..."}` message, if the body is one. */
function errorMessageOf(body: unknown): string | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { error } = body as { error?: unknown };
    if (typeof error === 'string' && error) {
      return error;
    }
  }
  return null;
}

/** Releases a response's connection without reading what it sent. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed or closed; nothing left to release.
  }
}

/**
 * undici reports a network or TLS failure as "fetch failed" and puts the
 * reason (connection refused, a certificate error) in `cause`.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { cause } = error;
  if (!(cause instanceof Error)) {
    return error.message;
  }
  const first =
    cause instanceof AggregateError && cause.errors[0] instanceof Error
      ? cause.errors[0].message
      : '';
  const detail =
    cause.message || first || (cause as { code?: string }).code || cause.name;
  return `${error.message} (${detail})`;
}

/**
 * The gateway reports failures as `{"error": "..."}` and answers 401 with an
 * HTML page when the session has lapsed. Turn both into something readable.
 */
async function readError(response: Response): Promise<string> {
  if (response.status === 401) {
    await discardBody(response);
    return '401: gateway session is not authenticated; log in again';
  }
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) {
      return `${response.status}: ${parsed.error}`;
    }
  } catch {
    // Not JSON — fall through and report the body as it came.
  }
  return body ? `${response.status}: ${body.slice(0, 300)}` : String(response.status);
}

// Options trade in $0.05 increments below $3.00 and $0.10 at or above it.
// Rounding up keeps the slippage cushion instead of rounding it away. Penny
// pilot names such as SPY also accept $0.01 below $3.00, so this is coarser
// than it needs to be there, never finer than the exchange allows.
export function roundUpToTick(price: number): number {
  const tickCents = price < 3 ? 5 : 10;
  const priceCents = Math.round(price * 100);
  return (Math.ceil(priceCents / tickCents) * tickCents) / 100;
}

/**
 * Splits "2026-06-18" into the forms IBKR's contract lookup wants: the month
 * code ("JUN26") and the maturity date ("20260618").
 */
export function toContractDate(expirationDate: string): {
  month: string;
  maturityDate: string;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expirationDate);
  if (!match) {
    throw new Error(
      `Invalid expiration date "${expirationDate}"; expected YYYY-MM-DD`,
    );
  }

  const [, year, month, day] = match;
  const expiration = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  if (
    expiration.getUTCFullYear() !== Number(year) ||
    expiration.getUTCMonth() + 1 !== Number(month) ||
    expiration.getUTCDate() !== Number(day)
  ) {
    throw new Error(`Invalid expiration date "${expirationDate}"`);
  }

  return {
    month: `${MONTHS[Number(month) - 1]}${year.slice(2)}`,
    maturityDate: `${year}${month}${day}`,
  };
}

/**
 * A thin client for the Client Portal Gateway's REST API. The gateway holds
 * the brokerage session; this process only needs to keep it alive and call it.
 */
export class IbkrGateway {
  private readonly dispatcher: Agent | undefined;
  private nextRequestAt = 0;

  constructor(private readonly gatewayUrl: string) {
    this.dispatcher = createDispatcher(gatewayUrl);
  }

  /**
   * Whether the gateway holds a logged-in session. A gateway that is running
   * but not logged in answers 401, which is reported here as not logged in.
   */
  async authStatus(): Promise<AuthStatus> {
    const response = await this.request('/iserver/auth/status', {
      method: 'POST',
    });
    if (response.status === 401) {
      await discardBody(response);
      return { authenticated: false, connected: false, competing: false };
    }
    if (!response.ok) {
      throw new Error(
        `IBKR auth status check failed (${await readError(response)})`,
      );
    }
    const body = (await response.json()) as Partial<AuthStatus>;
    return {
      authenticated: body.authenticated === true,
      connected: body.connected === true,
      competing: body.competing === true,
      message: body.message,
    };
  }

  /**
   * Keeps the gateway session from timing out. IBKR closes an idle session
   * after a few minutes; calling this about once a minute holds it open. A 401
   * means the session has already lapsed, which authStatus() reports.
   */
  async tickle(): Promise<void> {
    const response = await this.request('/tickle', { method: 'POST' });
    if (!response.ok && response.status !== 401) {
      throw new Error(`IBKR keepalive failed (${await readError(response)})`);
    }
    await discardBody(response);
  }

  /**
   * The accounts this session can trade. IBKR requires this call before any
   * order endpoint in each new brokerage session.
   */
  async brokerageAccounts(): Promise<string[]> {
    const body = await this.json<{ accounts?: string[] }>(
      '/iserver/accounts',
      'account lookup',
    );
    return body.accounts ?? [];
  }

  /** Account details for `npm run accounts`. */
  async portfolioAccounts(): Promise<IbkrAccount[]> {
    return this.list<IbkrAccount>(
      '/portfolio/accounts',
      'portfolio account lookup',
    );
  }

  /**
   * Sends a request and parses the JSON it returns. The gateway sometimes
   * answers a failure with a 200 and `{"error": "..."}`, so that is treated as
   * a failure too.
   */
  async json<T>(
    path: string,
    action: string,
    init: RequestInit = { method: 'GET' },
  ): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) {
      throw new Error(`IBKR ${action} failed (${await readError(response)})`);
    }
    const body: unknown = await response.json();
    const error = errorMessageOf(body);
    if (error) {
      throw new Error(`IBKR ${action} failed: ${error}`);
    }
    return body as T;
  }

  /** Like json(), for endpoints that answer with an array. */
  async list<T>(path: string, action: string): Promise<T[]> {
    const body = await this.json<unknown>(path, action);
    if (!Array.isArray(body)) {
      throw new Error(
        `IBKR ${action} returned an unexpected response: ${JSON.stringify(body).slice(0, 300)}`,
      );
    }
    return body as T[];
  }

  async request(path: string, init: RequestInit): Promise<Response> {
    await this.waitForTurn();
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    try {
      return await fetch(`${this.gatewayUrl}/v1/api${path}`, {
        ...init,
        headers,
        dispatcher: this.dispatcher,
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(
          `IBKR gateway did not answer ${path.split('?')[0]} within ${REQUEST_TIMEOUT_MS / 1000}s`,
        );
      }
      throw error;
    }
  }

  /**
   * Holds each request until at least MIN_REQUEST_GAP_MS after the one before
   * it. The slot is claimed before waiting, so the keepalive and an order in
   * progress queue up behind each other instead of racing.
   */
  private async waitForTurn(): Promise<void> {
    const now = Date.now();
    const turn = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = turn + MIN_REQUEST_GAP_MS;
    if (turn > now) {
      await sleep(turn - now);
    }
  }
}

export class IbkrClient {
  private readonly gateway: IbkrGateway;
  private sessionReady = false;
  private readonly underlyingConids = new Map<string, string>();

  constructor(private readonly config: IbkrConfig) {
    if (!Number.isFinite(config.limitSlippage) || config.limitSlippage < 0) {
      throw new Error('ORDER_LIMIT_SLIPPAGE must be zero or greater');
    }
    this.gateway = new IbkrGateway(config.gatewayUrl);
  }

  get gatewayClient(): IbkrGateway {
    return this.gateway;
  }

  async placeOptionOrder(req: OptionOrderRequest): Promise<PlacedOrder> {
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
      throw new Error('ORDER_QUANTITY must be a positive integer');
    }

    try {
      return await this.placeOrder(req);
    } catch (error) {
      // IBKR ends the brokerage session at least daily, and a new one needs
      // the account and symbol lookups again. A failure may be the first sign
      // of that, so start the next order from a fresh session.
      this.resetSession();
      throw error;
    }
  }

  /**
   * Checks IBKR_ACCOUNT_ID against the session's accounts. IBKR also requires
   * this call to open the brokerage session before any order endpoint, so it
   * runs at startup and again after each reset.
   */
  async openSession(): Promise<void> {
    if (this.sessionReady) {
      return;
    }
    const accounts = await this.gateway.brokerageAccounts();
    if (!accounts.includes(this.config.accountId)) {
      throw new Error(
        `IBKR_ACCOUNT_ID ${this.config.accountId} is not one of this session's accounts (${accounts.join(', ') || 'none'})`,
      );
    }
    this.sessionReady = true;
  }

  /**
   * Forgets the brokerage session, so the next order reopens it and repeats
   * the symbol lookups IBKR wants once per session. Call it when the gateway
   * reports it is no longer logged in.
   */
  resetSession(): void {
    this.sessionReady = false;
    this.underlyingConids.clear();
  }

  private async placeOrder(req: OptionOrderRequest): Promise<PlacedOrder> {
    await this.openSession();

    const conid = await this.resolveOptionConid(req);
    const { ask, delayed } = await this.getAsk(conid);
    const limitPrice = roundUpToTick(ask * (1 + this.config.limitSlippage));

    const order = {
      acctId: this.config.accountId,
      conid,
      cOID: req.clientOrderId,
      orderType: 'LMT',
      price: limitPrice,
      side: 'BUY',
      tif: 'DAY',
      quantity: req.quantity,
    };

    // The what-if check runs the real validation — buying power, trading
    // permissions, contract validity — and returns the cost without sending
    // anything to the market. A rejection here is a log line instead of a live
    // order you have to unwind.
    const preview = this.config.preview ? await this.whatIf(order) : null;

    const { orderId, status, confirmedWarnings } = await this.submit(order);

    return {
      id: orderId,
      conid,
      status,
      ask,
      delayedQuote: delayed,
      limitPrice,
      preview,
      confirmedWarnings,
    };
  }

  /**
   * IBKR identifies every contract by a numeric conid rather than an OCC
   * symbol, so an option takes three lookups: the underlying's conid, the
   * strikes listed for the expiration month, then the contracts at that strike,
   * filtered to the exact expiration date. A month holds every weekly and daily
   * expiration in it, so the date filter is what picks a 0DTE contract.
   */
  private async resolveOptionConid(req: OptionOrderRequest): Promise<number> {
    const underlying = req.underlyingSymbol.toUpperCase();
    const { month, maturityDate } = toContractDate(req.expirationDate);
    if (!Number.isFinite(req.strikePrice) || req.strikePrice <= 0) {
      throw new Error(`Invalid strike price "${req.strikePrice}"`);
    }

    const underlyingConid = await this.getUnderlyingConid(underlying, month);

    // IBKR's documented flow calls strikes before info for options; it also
    // gives a clearer error than an empty info response when the strike is not
    // listed.
    const strikesQuery = new URLSearchParams({
      conid: underlyingConid,
      sectype: 'OPT',
      month,
      exchange: 'SMART',
    });
    const strikes = await this.gateway.json<StrikesResponse>(
      `/iserver/secdef/strikes?${strikesQuery}`,
      'strike lookup',
    );
    const listed = (req.optionType === 'C' ? strikes.call : strikes.put) ?? [];
    if (!listed.some((strike) => Math.abs(strike - req.strikePrice) < 1e-6)) {
      throw new Error(
        `${underlying} has no ${req.strikePrice}${req.optionType} listed in ${month}`,
      );
    }

    // Unlike secdef/search, this endpoint spells the parameter "sectype".
    const infoQuery = new URLSearchParams({
      conid: underlyingConid,
      sectype: 'OPT',
      month,
      strike: String(req.strikePrice),
      right: req.optionType,
      exchange: 'SMART',
    });
    const contracts = await this.gateway.list<SecdefInfo>(
      `/iserver/secdef/info?${infoQuery}`,
      'contract lookup',
    );
    const matches = contracts.filter(
      (candidate) =>
        candidate.maturityDate === maturityDate &&
        candidate.right === req.optionType &&
        typeof candidate.conid === 'number' &&
        (candidate.multiplier === undefined ||
          String(candidate.multiplier) === '100'),
    );
    const label = `${underlying} ${req.strikePrice}${req.optionType}`;
    if (matches.length === 0) {
      throw new Error(`No ${label} contract expiring ${req.expirationDate}`);
    }

    // After a split or special dividend, an adjusted series can list at the
    // same strike and date under its own trading class (AAPL1) with a
    // different deliverable. Only buy the standard class, named for the
    // underlying, and refuse rather than guess when that is not one contract.
    const standard = [
      ...new Set(
        matches
          .filter(
            (candidate) => (candidate.tradingClass ?? underlying) === underlying,
          )
          .map((candidate) => candidate.conid as number),
      ),
    ];
    if (standard.length === 0) {
      const classes = [...new Set(matches.map((c) => c.tradingClass))];
      throw new Error(
        `Only adjusted ${label} contracts expire ${req.expirationDate} (trading class ${classes.join(', ')}); not buying a non-standard deliverable`,
      );
    }
    if (standard.length > 1) {
      throw new Error(
        `Found ${standard.length} ${label} contracts expiring ${req.expirationDate} and cannot tell which is standard`,
      );
    }
    return standard[0];
  }

  private async getUnderlyingConid(
    underlying: string,
    month: string,
  ): Promise<string> {
    const cached = this.underlyingConids.get(underlying);
    if (cached) {
      return cached;
    }

    const query = new URLSearchParams({ symbol: underlying, secType: 'STK' });
    const results = await this.gateway.list<SecdefSearchResult>(
      `/iserver/secdef/search?${query}`,
      'symbol search',
    );

    // A search can match several listings (other exchanges, other countries).
    // Take the exact symbol that has US options listed for this month.
    const match = results.find(
      (result) =>
        result.symbol?.toUpperCase() === underlying &&
        result.conid !== undefined &&
        result.sections?.some(
          (section) =>
            section.secType === 'OPT' &&
            (section.months ?? '').split(';').includes(month),
        ),
    );
    if (!match?.conid) {
      throw new Error(`IBKR found no ${underlying} options listed for ${month}`);
    }

    const conid = String(match.conid);
    this.underlyingConids.set(underlying, conid);
    return conid;
  }

  /**
   * The first snapshot request for a contract only subscribes to it, and
   * usually comes back without prices. Poll briefly until the ask arrives.
   */
  private async getAsk(
    conid: number,
  ): Promise<{ ask: number; delayed: boolean }> {
    const query = new URLSearchParams({
      conids: String(conid),
      fields: `${FIELD_ASK},${FIELD_MARKET_DATA_AVAILABILITY}`,
    });

    let problem: string | null = null;
    for (let attempt = 1; attempt <= QUOTE_ATTEMPTS; attempt += 1) {
      const snapshots = await this.gateway.list<Snapshot>(
        `/iserver/marketdata/snapshot?${query}`,
        'quote',
      );
      const quote = readQuote(
        snapshots.find((candidate) => String(candidate.conid) === String(conid)),
      );
      if ('ask' in quote) {
        return quote;
      }
      problem = quote.problem ?? problem;
      if (attempt < QUOTE_ATTEMPTS) {
        await sleep(500);
      }
    }

    throw new Error(
      problem
        ? `No usable ask for conid ${conid}: ${problem}`
        : `No ask price for conid ${conid}. Check the account has options market data (OPRA), shared with the paper account if you are paper trading.`,
    );
  }

  private async whatIf(order: Record<string, unknown>): Promise<OrderPreview> {
    const body = await this.gateway.json<WhatIfResponse>(
      `/iserver/account/${encodeURIComponent(this.config.accountId)}/orders/whatif`,
      'what-if check',
      { method: 'POST', body: JSON.stringify({ orders: [order] }) },
    );
    return {
      total: parseAmount(body.amount?.total),
      commission: parseAmount(body.amount?.commission),
      warning: body.warn || null,
    };
  }

  /**
   * Submits the order and answers IBKR's precautionary questions. Each one
   * must be confirmed through /iserver/reply before the order is sent; the
   * example confirms them and reports what it confirmed. See the README before
   * doing the same with real money.
   */
  private async submit(order: Record<string, unknown>): Promise<{
    orderId: string;
    status: string;
    confirmedWarnings: string[];
  }> {
    const confirmedWarnings: string[] = [];
    let body = await this.gateway.json<OrderReply[] | OrderReply>(
      `/iserver/account/${encodeURIComponent(this.config.accountId)}/orders`,
      'order placement',
      { method: 'POST', body: JSON.stringify({ orders: [order] }) },
    );

    for (let round = 0; ; round += 1) {
      const reply = Array.isArray(body) ? body[0] : body;
      if (!reply) {
        throw new Error('IBKR returned an empty order response');
      }
      if (reply.error) {
        throw new Error(`IBKR rejected the order: ${reply.error}`);
      }
      if (reply.order_id) {
        const status = reply.order_status ?? 'unknown';
        if (DEAD_ORDER_STATUSES.has(status.toLowerCase())) {
          throw new Error(
            `IBKR took order ${reply.order_id} but will not work it (status: ${status}${reply.text ? `, ${reply.text}` : ''})`,
          );
        }
        return { orderId: reply.order_id, status, confirmedWarnings };
      }
      if (!reply.id) {
        throw new Error(
          `Unexpected IBKR order response: ${JSON.stringify(body)}`,
        );
      }

      if (round === MAX_ORDER_REPLIES) {
        throw new Error(
          `IBKR asked for more than ${MAX_ORDER_REPLIES} confirmations; order not placed`,
        );
      }
      confirmedWarnings.push(...(reply.message ?? []));
      body = await this.gateway.json<OrderReply[] | OrderReply>(
        `/iserver/reply/${encodeURIComponent(reply.id)}`,
        'order confirmation',
        { method: 'POST', body: JSON.stringify({ confirmed: true }) },
      );
    }
  }
}
