/**
 * The code behind the `pricing-engine` flag. Both engines ship in every build;
 * the flag picks one per request. That is trunk-based development: v2 merged
 * to main weeks before anyone outside the team saw it.
 */
export type Currency = 'GBP' | 'EUR';

export interface QuoteRequest {
  currency: Currency;
  items: Array<{ sku: string; qty: number; unitPrice: number }>;
  discountCode?: string;
}

export interface Quote {
  subtotal: number;
  discount: number;
  total: number;
}

/** Prices are GBP pence; quotes are in the basket's minor units. */
const RATES: Record<Currency, number> = { GBP: 1, EUR: 1.17 };
const DISCOUNTS: Record<string, number> = { SAVE10: 1000 };

export class QuoteError extends Error {
  override name = 'QuoteError';
}

function lines(request: QuoteRequest) {
  const rate = RATES[request.currency];
  const subtotal = request.items.reduce((sum, item) => sum + Math.round(item.unitPrice * item.qty * rate), 0);
  const discount = request.discountCode ? Math.round((DISCOUNTS[request.discountCode] ?? 0) * rate) : 0;

  return { subtotal, discount };
}

function control(request: QuoteRequest): Quote {
  const { subtotal, discount } = lines(request);

  return { subtotal, discount, total: subtotal - discount };
}

/** v2 lets each market run its own promotions. */
const MARKETS: Record<Currency, (subtotal: number, discount: number) => number> = {
  GBP: (subtotal) => subtotal,
  // EUR promotions apply the basket discount themselves...
  EUR: (subtotal, discount) => subtotal - discount,
};

function v2(request: QuoteRequest): Quote {
  const { subtotal, discount } = lines(request);
  const afterMarket = MARKETS[request.currency](subtotal, discount);

  // ...and the shared step still takes it off too. GBP never notices.
  return { subtotal, discount, total: afterMarket - discount };
}

export const ENGINES = { control, v2 };

export type Engine = keyof typeof ENGINES;

export function quote(request: QuoteRequest, engine: Engine): Quote {
  const result = (ENGINES[engine] ?? control)(request);

  // Never charge an amount the customer was not shown.
  if (result.total !== result.subtotal - result.discount) {
    throw new QuoteError(`total ${result.total} != subtotal ${result.subtotal} - discount ${result.discount}`);
  }

  return result;
}
