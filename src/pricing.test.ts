import { describe, expect, it } from 'vitest';
import { quote } from './pricing.ts';
import type { QuoteRequest } from './pricing.ts';
import { evaluate } from './file-provider.ts';
import type { FlagDefinition } from './file-provider.ts';

const basket = (currency: QuoteRequest['currency'], discountCode?: string): QuoteRequest => ({
  currency,
  items: [{ sku: 'tee', qty: 2, unitPrice: 2500 }],
  discountCode,
});

describe('pricing engines', () => {
  it('agree whenever v2 has no EUR discount to double-apply', () => {
    for (const request of [basket('GBP'), basket('GBP', 'SAVE10'), basket('EUR')]) {
      expect(quote(request, 'v2')).toEqual(quote(request, 'control'));
    }
  });

  // Documents the planted bug: delete it when you fix v2.
  it('v2 takes an EUR discount off twice, and the guard refuses the quote', () => {
    expect(() => quote(basket('EUR', 'SAVE10'), 'v2')).toThrow(/total 3510 != subtotal 5850 - discount 1170/);
  });
});

describe('flags.json evaluation', () => {
  const flag: FlagDefinition = {
    variants: { control: 'control', v2: 'v2' },
    default: 'control',
    rules: [{ group: 'internal', variant: 'v2' }, { group: 'beta', rollout: { v2: 50 } }],
  };

  it('targets a group, splits a rollout, and falls back to the default', () => {
    expect(evaluate('f', flag, { targetingKey: 'a', group: 'internal' })).toEqual({ variant: 'v2', reason: 'targeting_match' });
    expect(evaluate('f', flag, { targetingKey: 'a', group: 'beta' }).reason).toBe('split');
    expect(evaluate('f', flag, { targetingKey: 'a', group: 'everyone' })).toEqual({ variant: 'control', reason: 'default' });
  });

  it('keeps a user in the same rollout bucket, and the kill switch wins', () => {
    const first = evaluate('f', flag, { targetingKey: 'user-7', group: 'beta' });
    expect(evaluate('f', flag, { targetingKey: 'user-7', group: 'beta' })).toEqual(first);
    expect(evaluate('f', { ...flag, disabled: true }, { targetingKey: 'a', group: 'internal' })).toEqual({ variant: 'control', reason: 'disabled' });
  });
});
