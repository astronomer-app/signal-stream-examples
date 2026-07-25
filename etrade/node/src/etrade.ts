import { createHash } from 'node:crypto';

import {
  ETrade,
  type ETradeError,
  type OrderDetail,
  type PreviewId,
  type QuoteData,
} from 'e-trade-api';

export type ETradeEnvironment = 'sandbox' | 'live';

export interface ETradeConfig {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
  accountIdKey: string;
  environment: ETradeEnvironment;
  /** Override the standard sandbox/live API host. */
  baseUrl?: string;
  /** How far above the ask to set the limit, as a fraction. */
  limitSlippage: number;
}

export interface OptionOrderRequest {
  signalId: string;
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
  previewId: number;
  quoteStatus: string;
}

interface OptionContract {
  symbol: string;
  callPut: 'CALL' | 'PUT';
  expiryYear: number;
  expiryMonth: number;
  expiryDay: number;
  strikePrice: number;
}

type OneOrMany<T> = T | T[];

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getETradeBaseUrl(
  environment: ETradeEnvironment,
  override?: string,
): string {
  if (override) {
    return withoutTrailingSlash(override);
  }
  return environment === 'live'
    ? 'https://api.etrade.com'
    : 'https://apisb.etrade.com';
}

export function createETradeSdk(
  config: Pick<
    ETradeConfig,
    | 'consumerKey'
    | 'consumerSecret'
    | 'accessToken'
    | 'accessSecret'
    | 'environment'
    | 'baseUrl'
  >,
): ETrade {
  const baseUrl = getETradeBaseUrl(config.environment, config.baseUrl);
  const apiUrl = `${baseUrl}/v1/`;

  return new ETrade({
    mode: config.environment === 'live' ? 'prod' : 'dev',
    key: config.consumerKey,
    secret: config.consumerSecret,
    accessToken: config.accessToken,
    accessSecret: config.accessSecret,
    // The SDK defaults OAuth to the live host even in dev mode. Override all
    // hosts together so sandbox keys stay entirely on E*TRADE's sandbox.
    urls: {
      oauth: `${baseUrl}/oauth/`,
      prod: apiUrl,
      dev: apiUrl,
    },
  });
}

function parseContract(req: OptionOrderRequest): OptionContract {
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

  return {
    symbol: req.underlyingSymbol.toUpperCase(),
    callPut: req.optionType === 'C' ? 'CALL' : 'PUT',
    expiryYear: Number(year),
    expiryMonth: Number(month),
    expiryDay: Number(day),
    strikePrice: req.strikePrice,
  };
}

// E*TRADE quote symbols use underlier:year:month:day:optionType:strikePrice.
function toQuoteSymbol(contract: OptionContract): string {
  return [
    contract.symbol,
    contract.expiryYear,
    contract.expiryMonth,
    contract.expiryDay,
    contract.callPut,
    contract.strikePrice,
  ].join(':');
}

// Round a buy limit upward to a cent so the slippage cushion is never rounded
// away. E*TRADE's mandatory preview performs the final exchange tick validation.
function roundUpToCent(price: number): number {
  return Math.ceil((price - Number.EPSILON) * 100) / 100;
}

function toArray<T>(value: OneOrMany<T> | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isAuthenticationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const apiError = error as ETradeError;
  const detail = `${apiError.message} ${
    apiError.raw === undefined ? '' : JSON.stringify(apiError.raw)
  }`;
  return (
    apiError.code === 401 ||
    apiError.code === 403 ||
    /oauth|access token|token_rejected|signature_invalid/i.test(detail)
  );
}

export class ETradeClient {
  private readonly api: ETrade;

  constructor(private readonly config: ETradeConfig) {
    if (!Number.isFinite(config.limitSlippage) || config.limitSlippage < 0) {
      throw new Error('ORDER_LIMIT_SLIPPAGE must be zero or greater');
    }
    this.api = createETradeSdk(config);
  }

  async placeOptionOrder(req: OptionOrderRequest): Promise<PlacedOrder> {
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
      throw new Error('ORDER_QUANTITY must be a positive integer');
    }

    const contract = parseContract(req);
    const quoteSymbol = toQuoteSymbol(contract);
    const quote = await this.getQuoteWithSessionRecovery(quoteSymbol);
    const ask = this.getAsk(quote, quoteSymbol);
    const limitPrice = roundUpToCent(
      ask * (1 + this.config.limitSlippage),
    );
    const clientOrderId = createHash('sha256')
      .update(req.signalId)
      .digest('hex')
      .slice(0, 20);

    const order = [
      {
        allOrNone: false,
        priceType: 'LIMIT',
        limitPrice,
        stopPrice: 0,
        orderTerm: 'GOOD_FOR_DAY',
        marketSession: 'REGULAR',
        Instrument: [
          {
            Product: {
              ...contract,
              securityType: 'OPTN',
            },
            orderAction: 'BUY_OPEN',
            quantityType: 'QUANTITY',
            quantity: req.quantity,
            orderedQuantity: req.quantity,
          },
        ],
      },
    ] satisfies Partial<OrderDetail>[];

    // E*TRADE requires every order to be previewed, then placed with the
    // returned preview ID within three minutes.
    const preview = await this.api.previewOrder({
      accountIdKey: this.config.accountIdKey,
      orderType: 'OPTN',
      clientOrderId,
      order,
    });
    const previewIds = toArray(
      preview.PreviewIds as OneOrMany<PreviewId> | undefined,
    );
    if (previewIds.length === 0) {
      throw new Error(`E*TRADE preview returned no preview ID for ${quoteSymbol}`);
    }

    const placed = await this.api.placeOrder({
      accountIdKey: this.config.accountIdKey,
      orderType: 'OPTN',
      clientOrderId,
      previewIds,
      order,
    });
    const orderIds = toArray(
      placed.OrderIds as OneOrMany<{ orderId: number }> | undefined,
    );
    const orderId = orderIds[0]?.orderId;
    if (orderId === undefined) {
      throw new Error(`E*TRADE placed ${quoteSymbol} but returned no order ID`);
    }

    return {
      id: String(orderId),
      symbol: quoteSymbol,
      status: 'submitted',
      ask,
      limitPrice,
      previewId: previewIds[0].previewId,
      quoteStatus: String(quote.quoteStatus ?? 'UNKNOWN'),
    };
  }

  private async getQuoteWithSessionRecovery(
    quoteSymbol: string,
  ): Promise<QuoteData> {
    try {
      return await this.getQuote(quoteSymbol);
    } catch (error) {
      if (!isAuthenticationError(error)) {
        throw error;
      }

      // Access tokens become inactive after two idle hours. They can be renewed
      // until midnight US Eastern, when a fresh interactive OAuth flow is due.
      await this.api.renewAccessToken({
        key: this.config.accessToken,
        secret: this.config.accessSecret,
      });
      return this.getQuote(quoteSymbol);
    }
  }

  private getQuote(quoteSymbol: string): Promise<QuoteData> {
    return this.api.getQuotes({
      symbols: quoteSymbol,
      detailFlag: 'OPTIONS',
    });
  }

  private getAsk(quote: QuoteData, quoteSymbol: string): number {
    // E*TRADE returns Option for detailFlag=OPTIONS and All for the default
    // detail set. Accept either because sandbox fixtures vary.
    const optionAsk = (quote.Option as { ask?: number } | undefined)?.ask;
    const allAsk = (quote.All as { ask?: number } | undefined)?.ask;
    const ask = Number(optionAsk ?? allAsk);

    if (!Number.isFinite(ask) || ask <= 0) {
      throw new Error(
        `No ask price for ${quoteSymbol} (quote status: ${
          quote.quoteStatus ?? 'unknown'
        })`,
      );
    }
    return ask;
  }
}
