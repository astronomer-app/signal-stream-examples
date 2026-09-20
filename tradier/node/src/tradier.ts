export const TRADIER_PRODUCTION_BASE_URL = 'https://api.tradier.com';
export const TRADIER_SANDBOX_BASE_URL = 'https://sandbox.tradier.com';

export type TradierEnvironment = 'sandbox' | 'live';

export interface TradierConfig {
  accessToken: string;
  /** The account number, e.g. "VA000001". Not the login name. */
  accountId: string;
  /** Resolved API host — see getTradierBaseUrl. */
  baseUrl: string;
  /** How far above the ask to set the limit, as a fraction. */
  limitSlippage: number;
  /** Preview each order before placing it. */
  preview: boolean;
}

export interface OptionOrderRequest {
  underlyingSymbol: string;
  optionType: 'C' | 'P';
  strikePrice: number;
  /** ISO date, e.g. "2026-06-18". */
  expirationDate: string;
  quantity: number;
}

/** What Tradier says an order will cost, before it is actually placed. */
export interface OrderPreview {
  /** Total debit for the order in dollars, commission included. */
  cost: number;
  commission: number;
  fees: number;
  /** Buying power the order consumes. */
  marginChange: number;
}

export interface PlacedOrder {
  id: string;
  symbol: string;
  status: string;
  /** The ask the limit was priced from, per share. */
  ask: number;
  /** The submitted limit price, per share. */
  limitPrice: number;
  /** The preview Tradier returned, or null when previewing is off. */
  preview: OrderPreview | null;
}

export interface TradierAccount {
  account_number: string;
  type?: string;
  classification?: string;
  /** 0-5. Buying calls and puts to open requires at least level 2. */
  option_level?: number;
  status?: string;
}

interface TradierQuote {
  symbol?: string;
  type?: string;
  ask?: number;
  bid?: number;
  last?: number;
}

interface QuotesResponse {
  quotes?: {
    quote?: TradierQuote | TradierQuote[];
  };
}

interface OrderResponse {
  order?: {
    id?: number;
    status?: string;
    // Preview-only fields.
    commission?: number;
    cost?: number;
    fees?: number;
    order_cost?: number;
    margin_change?: number;
    result?: boolean;
  };
}

interface ProfileResponse {
  profile?: {
    id?: string;
    name?: string;
    account?: TradierAccount | TradierAccount[];
  };
}

/**
 * Tradier's JSON mirrors the XML it grew out of: a collection holding a single
 * member serializes as a bare object and only becomes an array at two or more.
 * A one-symbol quote request therefore returns `quotes.quote` as an object, not
 * a one-element array. Every list the API returns has to go through here before
 * it can be indexed or iterated.
 */
function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getTradierBaseUrl(
  environment: TradierEnvironment,
  override?: string,
): string {
  if (override) {
    return withoutTrailingSlash(override);
  }
  return environment === 'live'
    ? TRADIER_PRODUCTION_BASE_URL
    : TRADIER_SANDBOX_BASE_URL;
}

/**
 * Tradier identifies a contract by its OCC symbol:
 *
 *   [underlying][YYMMDD][C|P][strike * 1000 padded to 8]
 *
 * e.g. SPY + 260618 + C + 00746000 -> "SPY260618C00746000". Unlike Schwab's
 * 21-character variant, the underlying is not padded to a fixed width.
 */
export function toOccSymbol(req: OptionOrderRequest): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(req.expirationDate);
  if (!match) {
    throw new Error(
      `Invalid expiration date "${req.expirationDate}"; expected YYYY-MM-DD`,
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
    throw new Error(`Invalid expiration date "${req.expirationDate}"`);
  }

  if (!Number.isFinite(req.strikePrice) || req.strikePrice <= 0) {
    throw new Error(`Invalid strike price "${req.strikePrice}"`);
  }

  const underlying = req.underlyingSymbol.toUpperCase();
  const yymmdd = `${year.slice(2)}${month}${day}`;
  const strike = Math.round(req.strikePrice * 1000)
    .toString()
    .padStart(8, '0');

  return `${underlying}${yymmdd}${req.optionType}${strike}`;
}

// Options trade in $0.05 increments below $3.00 and $0.10 at or above it.
// Rounding up keeps the slippage cushion instead of rounding it away.
export function roundUpToTick(price: number): number {
  const tickCents = price < 3 ? 5 : 10;
  const priceCents = Math.round(price * 100);
  return (Math.ceil(priceCents / tickCents) * tickCents) / 100;
}

/**
 * Tradier reports failures as `{"errors": {"error": "..."}}` — a string for a
 * single error, an array for several. Unwrap it so a rejected order logs the
 * reason rather than a wall of JSON.
 */
async function readError(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as {
      errors?: { error?: string | string[] };
    };
    const errors = toArray(parsed.errors?.error);
    if (errors.length > 0) {
      return `${response.status}: ${errors.join('; ')}`;
    }
  } catch {
    // Not JSON — fall through and report the body as it came.
  }
  return body ? `${response.status}: ${body}` : String(response.status);
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
}

/**
 * Lists the accounts a token can trade. Used by `npm run accounts` to find the
 * account number for .env — sandbox and production tokens see different ones.
 */
export async function fetchAccounts(
  baseUrl: string,
  accessToken: string,
): Promise<TradierAccount[]> {
  const response = await fetch(`${baseUrl}/v1/user/profile`, {
    headers: authHeaders(accessToken),
  });

  if (!response.ok) {
    throw new Error(
      `Tradier profile lookup failed (${await readError(response)})`,
    );
  }

  const body = (await response.json()) as ProfileResponse;
  return toArray(body.profile?.account);
}

export class TradierClient {
  constructor(private readonly config: TradierConfig) {
    if (!Number.isFinite(config.limitSlippage) || config.limitSlippage < 0) {
      throw new Error('ORDER_LIMIT_SLIPPAGE must be zero or greater');
    }
  }

  async placeOptionOrder(req: OptionOrderRequest): Promise<PlacedOrder> {
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
      throw new Error('ORDER_QUANTITY must be a positive integer');
    }

    const occSymbol = toOccSymbol(req);
    const ask = await this.getAsk(occSymbol);
    const limitPrice = roundUpToTick(ask * (1 + this.config.limitSlippage));
    const params = buildOrderParams(req, occSymbol, limitPrice);

    // A preview runs the same validation as a real submission — buying power,
    // option level, contract validity — and returns the cost without sending
    // anything to the market. Tradier does not require it, but it turns a
    // rejection into a log line instead of a live order you have to unwind.
    const preview = this.config.preview
      ? await this.previewOrder(params)
      : null;

    const order = await this.postOrder(params, false);

    return {
      id: order.id === undefined ? 'unknown' : String(order.id),
      symbol: occSymbol,
      status: order.status ?? 'unknown',
      ask,
      limitPrice,
      preview,
    };
  }

  private async previewOrder(params: URLSearchParams): Promise<OrderPreview> {
    const order = await this.postOrder(params, true);
    return {
      // Tradier names the all-in debit `order_cost` and the raw fill value
      // `cost`; older responses only carry `cost`.
      cost: order.order_cost ?? order.cost ?? 0,
      commission: order.commission ?? 0,
      fees: order.fees ?? 0,
      marginChange: order.margin_change ?? 0,
    };
  }

  private async postOrder(
    params: URLSearchParams,
    preview: boolean,
  ): Promise<NonNullable<OrderResponse['order']>> {
    const body = new URLSearchParams(params);
    body.set('preview', String(preview));

    const response = await this.request(
      `/v1/accounts/${encodeURIComponent(this.config.accountId)}/orders`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
    );

    const action = preview ? 'preview' : 'placement';
    if (!response.ok) {
      throw new Error(
        `Tradier order ${action} failed (${await readError(response)})`,
      );
    }

    const parsed = (await response.json()) as OrderResponse;
    const order = parsed.order;
    // Tradier can answer 200 with a non-"ok" status, so the body decides.
    if (!order || order.status !== 'ok') {
      throw new Error(
        `Tradier rejected the order ${action}: ${JSON.stringify(parsed)}`,
      );
    }
    return order;
  }

  private async getAsk(occSymbol: string): Promise<number> {
    const query = new URLSearchParams({
      symbols: occSymbol,
      greeks: 'false',
    });

    const response = await this.request(`/v1/markets/quotes?${query}`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Tradier quote failed (${await readError(response)})`);
    }

    const body = (await response.json()) as QuotesResponse;
    // Unknown symbols come back under `unmatched_symbols` rather than as an
    // error, so match on the symbol instead of trusting the first entry.
    const quote = toArray(body.quotes?.quote).find(
      (candidate) => candidate.symbol === occSymbol,
    );
    if (!quote) {
      throw new Error(`Tradier returned no quote for ${occSymbol}`);
    }

    const ask = quote.ask;
    if (typeof ask !== 'number' || ask <= 0) {
      throw new Error(`No ask price for ${occSymbol}`);
    }
    return ask;
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(
      authHeaders(this.config.accessToken),
    )) {
      headers.set(key, value);
    }
    return fetch(`${this.config.baseUrl}${path}`, { ...init, headers });
  }
}

// Tradier wants both the underlying and the contract on an option order: the
// `symbol` field carries the underlying, `option_symbol` the OCC contract.
function buildOrderParams(
  req: OptionOrderRequest,
  occSymbol: string,
  limitPrice: number,
): URLSearchParams {
  return new URLSearchParams({
    class: 'option',
    symbol: req.underlyingSymbol.toUpperCase(),
    option_symbol: occSymbol,
    side: 'buy_to_open',
    quantity: String(req.quantity),
    type: 'limit',
    duration: 'day',
    price: limitPrice.toFixed(2),
  });
}
