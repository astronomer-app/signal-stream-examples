export const SCHWAB_API_BASE_URL = 'https://api.schwabapi.com';

export interface SchwabConfig {
  appKey: string;
  appSecret: string;
  refreshToken: string;
  accountHash: string;
  /** Override the API host. Schwab publishes exactly one. */
  baseUrl?: string;
  /** How far above the ask to set the limit, as a fraction. */
  limitSlippage: number;
}

export interface OptionOrderRequest {
  underlyingSymbol: string;
  optionType: 'C' | 'P';
  strikePrice: number;
  /** ISO date, e.g. "2026-06-18". */
  expirationDate: string;
  quantity: number;
}

export interface PlacedOrder {
  id: string;
  symbol: string;
  status: 'submitted';
  /** The ask the limit was priced from, per share. */
  ask: number;
  /** The submitted limit price, per share. */
  limitPrice: number;
  /** Whether Schwab flagged the quote as realtime for this account. */
  realtime: boolean;
}

export interface AccountNumber {
  accountNumber: string;
  hashValue: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface OptionQuote {
  assetMainType?: string;
  symbol?: string;
  realtime?: boolean;
  quote?: {
    askPrice?: number;
    bidPrice?: number;
    mark?: number;
    quoteTime?: number;
  };
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getSchwabBaseUrl(override?: string): string {
  return withoutTrailingSlash(override || SCHWAB_API_BASE_URL);
}

// Schwab authenticates the token endpoint with HTTP Basic, not a JSON body.
export function basicAuthHeader(appKey: string, appSecret: string): string {
  const encoded = Buffer.from(`${appKey}:${appSecret}`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Schwab option symbols are 21 characters, fixed width:
 *
 *   [underlying padded to 6][YYMMDD][C|P][strike * 1000 padded to 8]
 *
 * The padding is significant — "SPY" becomes "SPY   " with three trailing
 * spaces, and dropping them produces a symbol Schwab will not resolve.
 */
export function toSchwabOptionSymbol(req: OptionOrderRequest): string {
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
  if (underlying.length > 6) {
    throw new Error(`Underlying symbol "${underlying}" exceeds 6 characters`);
  }

  const yymmdd = `${year.slice(2)}${month}${day}`;
  const strike = Math.round(req.strikePrice * 1000)
    .toString()
    .padStart(8, '0');

  return `${underlying.padEnd(6, ' ')}${yymmdd}${req.optionType}${strike}`;
}

// Options trade in $0.05 increments below $3.00 and $0.10 at or above it.
// Rounding up keeps the slippage cushion instead of rounding it away.
export function roundUpToTick(price: number): number {
  const tickCents = price < 3 ? 5 : 10;
  const priceCents = Math.round(price * 100);
  return (Math.ceil(priceCents / tickCents) * tickCents) / 100;
}

async function readError(response: Response): Promise<string> {
  const body = await response.text();
  return body ? `${response.status}: ${body}` : String(response.status);
}

/**
 * Exchanges a refresh token for an access token. Schwab access tokens live 30
 * minutes; the refresh token behind them expires after 7 days and can only be
 * replaced by running the interactive authorization flow again.
 */
export async function requestAccessToken(
  config: Pick<SchwabConfig, 'appKey' | 'appSecret' | 'baseUrl'>,
  refreshToken: string,
): Promise<TokenResponse> {
  const baseUrl = getSchwabBaseUrl(config.baseUrl);
  const response = await fetch(`${baseUrl}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(config.appKey, config.appSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Schwab token refresh failed (${await readError(response)})`);
  }
  return (await response.json()) as TokenResponse;
}

export async function fetchAccountNumbers(
  baseUrl: string,
  accessToken: string,
): Promise<AccountNumber[]> {
  const response = await fetch(`${baseUrl}/trader/v1/accounts/accountNumbers`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Schwab account lookup failed (${await readError(response)})`);
  }
  return (await response.json()) as AccountNumber[];
}

export class SchwabClient {
  private readonly baseUrl: string;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private pendingRefresh: Promise<string> | null = null;

  constructor(private readonly config: SchwabConfig) {
    if (!Number.isFinite(config.limitSlippage) || config.limitSlippage < 0) {
      throw new Error('ORDER_LIMIT_SLIPPAGE must be zero or greater');
    }
    this.baseUrl = getSchwabBaseUrl(config.baseUrl);
  }

  async placeOptionOrder(req: OptionOrderRequest): Promise<PlacedOrder> {
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
      throw new Error('ORDER_QUANTITY must be a positive integer');
    }

    const symbol = toSchwabOptionSymbol(req);
    const quote = await this.getQuote(symbol);
    const ask = quote.quote?.askPrice;
    if (typeof ask !== 'number' || ask <= 0) {
      throw new Error(`No ask price for ${symbol}`);
    }

    const limitPrice = roundUpToTick(ask * (1 + this.config.limitSlippage));

    const order = {
      orderType: 'LIMIT',
      session: 'NORMAL',
      duration: 'DAY',
      orderStrategyType: 'SINGLE',
      price: limitPrice.toFixed(2),
      orderLegCollection: [
        {
          instruction: 'BUY_TO_OPEN',
          quantity: req.quantity,
          instrument: {
            symbol,
            assetType: 'OPTION',
          },
        },
      ],
    };

    const response = await this.authed(
      `/trader/v1/accounts/${encodeURIComponent(this.config.accountHash)}/orders`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order),
      },
    );

    if (!response.ok) {
      throw new Error(`Schwab order failed (${await readError(response)})`);
    }

    return {
      id: parseOrderId(response.headers.get('location')),
      symbol,
      status: 'submitted',
      ask,
      limitPrice,
      realtime: quote.realtime === true,
    };
  }

  private async getQuote(symbol: string): Promise<OptionQuote> {
    // The symbol's padding spaces must survive the query string. URLSearchParams
    // would encode them as "+", so build the query with %20 explicitly.
    const query = `symbols=${encodeURIComponent(symbol)}&fields=quote`;
    const response = await this.authed(`/marketdata/v1/quotes?${query}`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Schwab quote failed (${await readError(response)})`);
    }

    // Quotes come back as an object keyed by the requested symbol.
    const body = (await response.json()) as Record<string, OptionQuote>;
    const quote = body[symbol];
    if (!quote) {
      throw new Error(`Schwab returned no quote for ${symbol}`);
    }
    return quote;
  }

  /**
   * Issues a request with a valid access token, refreshing it when it has
   * expired and retrying once if Schwab rejects it anyway.
   */
  private async authed(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');

    headers.set('Authorization', `Bearer ${await this.getAccessToken()}`);
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (response.status !== 401) {
      return response;
    }

    // A token can be rejected before its advertised expiry. Force one refresh
    // and retry so a single stale token doesn't drop the signal.
    await response.body?.cancel();
    this.accessTokenExpiresAt = 0;
    headers.set('Authorization', `Bearer ${await this.getAccessToken()}`);
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }

  private getAccessToken(): Promise<string> {
    // Refresh a minute early so a token can't expire mid-flight.
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return Promise.resolve(this.accessToken);
    }
    // Concurrent signals share one refresh instead of racing to replace it.
    this.pendingRefresh ??= this.refreshAccessToken().finally(() => {
      this.pendingRefresh = null;
    });
    return this.pendingRefresh;
  }

  private async refreshAccessToken(): Promise<string> {
    const token = await requestAccessToken(this.config, this.config.refreshToken);
    this.accessToken = token.access_token;
    this.accessTokenExpiresAt = Date.now() + token.expires_in * 1000;
    return token.access_token;
  }
}

// Schwab returns 201 with the new order's URL in the Location header. The body
// is empty, so the order ID is the last path segment.
function parseOrderId(location: string | null): string {
  const id = location?.split('/').pop()?.trim();
  return id || 'unknown';
}
