// Minimal Alpaca client for paper options trading.
//
// Talks to Alpaca's REST API with the built-in fetch (Node 18+) so the example
// carries no broker SDK dependency. Swap in @alpacahq/alpaca-trade-api here if
// you would rather use the SDK; nothing else in the example needs to change.

export interface AlpacaConfig {
  keyId: string;
  secretKey: string;
  /** Trading API host. Defaults to the paper host. */
  baseUrl: string;
  /** Market data API host, e.g. https://data.alpaca.markets. */
  dataBaseUrl: string;
  /** Options data feed: "indicative" (free) or "opra" (real-time, paid). */
  feed: string;
  /**
   * How far above the live ask to set the buy limit, as a fraction. 0.02 means
   * the limit is priced 2% over the ask so the order is marketable but capped.
   */
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
  status: string;
  /** The live ask the limit was priced from, per share. */
  ask: number;
  /** The submitted limit price, per share. */
  limitPrice: number;
}

interface OptionQuote {
  /** Ask price. */
  ap: number;
  /** Bid price. */
  bp: number;
}

interface OptionQuotesResponse {
  quotes?: Record<string, OptionQuote | undefined>;
}

// Build the OCC option symbol Alpaca expects from the contract fields a signal
// provides, e.g. SPY + 260618 + C + 00746000 -> "SPY260618C00746000".
function toOccSymbol(req: OptionOrderRequest): string {
  const yymmdd = req.expirationDate.slice(2).replaceAll('-', '');
  const strike = Math.round(req.strikePrice * 1000)
    .toString()
    .padStart(8, '0');
  return `${req.underlyingSymbol.toUpperCase()}${yymmdd}${req.optionType}${strike}`;
}

// Options quote in $0.05 increments under $3.00 and $0.10 at or above it. Round
// the limit up to the next valid tick so a buy order stays marketable and the
// exchange won't reject it. Work in integer cents to avoid float drift.
function roundUpToTick(price: number): number {
  const tickCents = price < 3 ? 5 : 10;
  const priceCents = Math.round(price * 100);
  const roundedCents = Math.ceil(priceCents / tickCents) * tickCents;
  return roundedCents / 100;
}

export class AlpacaClient {
  private readonly authHeaders: Record<string, string>;

  constructor(private readonly config: AlpacaConfig) {
    this.authHeaders = {
      'APCA-API-KEY-ID': config.keyId,
      'APCA-API-SECRET-KEY': config.secretKey,
      'Content-Type': 'application/json',
    };
  }

  async placeOptionOrder(req: OptionOrderRequest): Promise<PlacedOrder> {
    const occSymbol = toOccSymbol(req);
    const ask = await this.getLatestAsk(occSymbol);
    const limitPrice = roundUpToTick(ask * (1 + this.config.limitSlippage));

    const response = await fetch(`${this.config.baseUrl}/v2/orders`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify({
        symbol: occSymbol,
        qty: req.quantity,
        side: 'buy',
        type: 'limit',
        time_in_force: 'day',
        limit_price: limitPrice,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Alpaca order failed (${response.status}): ${await response.text()}`,
      );
    }

    const order = (await response.json()) as PlacedOrder;
    return { ...order, ask, limitPrice };
  }

  // Fetch the contract's latest ask so the limit tracks the live market instead
  // of a fixed guess. Alpaca prices options per share of the underlying, so a
  // 1.20 ask is $120 for the 100-share contract.
  private async getLatestAsk(occSymbol: string): Promise<number> {
    const url = new URL(
      '/v1beta1/options/quotes/latest',
      this.config.dataBaseUrl,
    );
    url.searchParams.set('symbols', occSymbol);
    url.searchParams.set('feed', this.config.feed);

    const response = await fetch(url, { headers: this.authHeaders });

    if (!response.ok) {
      throw new Error(
        `Alpaca quote failed (${response.status}): ${await response.text()}`,
      );
    }

    const body = (await response.json()) as OptionQuotesResponse;
    const ask = body.quotes?.[occSymbol]?.ap;

    if (typeof ask !== 'number' || ask <= 0) {
      throw new Error(
        `No ask price for ${occSymbol} on the "${this.config.feed}" feed`,
      );
    }

    return ask;
  }
}
