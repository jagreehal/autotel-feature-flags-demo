/**
 * Simulated shoppers. 200 users, so each one keeps their group and rollout
 * bucket across requests, the way real users do.
 *
 *   pnpm traffic            # 10 checkouts a second until Ctrl-C
 *   pnpm traffic 300        # stop after 300
 */
import type { QuoteRequest } from './pricing.ts';

const limit = Number(process.argv[2] ?? Infinity);
const pick = <T>(items: Array<T>): T => items[Math.floor(Math.random() * items.length)];
const SKUS = [{ sku: 'mug', unitPrice: 1200 }, { sku: 'tee', unitPrice: 2500 }, { sku: 'cap', unitPrice: 1800 }];

let sent = 0;
const tally = new Map<number, number>();

async function one() {
  const userId = `user-${String(Math.floor(Math.random() * 200)).padStart(3, '0')}`;

  const request: QuoteRequest = {
    currency: Math.random() < 0.4 ? 'EUR' : 'GBP',
    items: Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => ({ ...pick(SKUS), qty: 1 + Math.floor(Math.random() * 2) })),
    discountCode: Math.random() < 0.3 ? 'SAVE10' : undefined,
  };

  const res = await fetch('http://127.0.0.1:4100/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId },
    body: JSON.stringify(request),
  });

  tally.set(res.status, (tally.get(res.status) ?? 0) + 1);
}

const timer = setInterval(() => {
  if (sent++ >= limit) {
    clearInterval(timer);

    return;
  }

  one().catch((error) => console.error(String(error)));
}, 100);

setInterval(() => console.log(`sent ${Math.min(sent, limit)}`, Object.fromEntries(tally)), 2000).unref();
