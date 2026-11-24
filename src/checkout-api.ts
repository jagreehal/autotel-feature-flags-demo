/**
 * The edge. Looks up who the user is, evaluates their flags once, and carries
 * the answers to pricing in baggage. autotel's OpenFeature hook records every
 * evaluation on the span that branched on it: no code at the call sites.
 */
import { createServer } from 'node:http';
import { OpenFeature } from '@openfeature/server-sdk';
import { context, propagation, trace } from 'autotel';
import type { TraceContext } from 'autotel';
import { startTelemetry } from './telemetry.ts';
import { fileProvider } from './file-provider.ts';
import { posthogClient, posthogProvider } from './posthog-provider.ts';
import { withFlagBaggage } from './flag-baggage.ts';
import { lookupUser } from './users.ts';
import type { Quote, QuoteRequest } from './pricing.ts';

startTelemetry('checkout-api');

const PRICING_URL = process.env.PRICING_URL ?? 'http://127.0.0.1:4101/quote';
const posthog = posthogClient();

await OpenFeature.setProviderAndWait(posthog ? posthogProvider(posthog) : fileProvider('flags.json'));

const flags = OpenFeature.getClient();

class PricingFailed extends Error {
  override name = 'PricingFailed';
}

async function checkout(ctx: TraceContext, userId: string, request: QuoteRequest) {
  const user = lookupUser(userId);
  ctx.setAttributes({
    'user.id': user.id,
    'app.user.group': user.group,
    'checkout.currency': request.currency,
    'checkout.item_count': request.items.length,
    'checkout.discount_code': request.discountCode ?? 'none',
    // What `pnpm repro` replays. A basket holds nothing personal; a real
    // request with names or addresses would record only what a replay needs.
    'checkout.request': JSON.stringify(request),
  });

  // Who the flags are evaluated for: the same targeting PostHog would use.
  const who = { targetingKey: user.id, group: user.group };
  const engine = await flags.getStringDetails('pricing-engine', 'control', who);
  const express = await flags.getBooleanDetails('express-shipping', false, who);

  const status = await context.with(withFlagBaggage([engine, express]), async () => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    propagation.inject(context.active(), headers);
    const response = await fetch(PRICING_URL, { method: 'POST', headers, body: JSON.stringify(request) });

    return { response, body: await response.text() };
  });

  // Product analytics with the flags it ran under and the trace that explains
  // it, so a PostHog insight broken down by `$feature/pricing-engine` links
  // straight to the request.
  posthog?.capture({
    distinctId: user.id,
    event: status.response.ok ? 'checkout completed' : 'checkout failed',
    properties: {
      '$feature/pricing-engine': engine.value,
      '$feature/express-shipping': express.value,
      $trace_id: ctx.traceId,
      currency: request.currency,
    },
  });

  if (!status.response.ok) { throw new PricingFailed(status.body); }

  const quote = JSON.parse(status.body) as Quote;
  ctx.setAttribute('checkout.total', quote.total);

  return { ...quote, delivery: express.value ? 'express' : 'standard' };
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/checkout') {
    res.writeHead(404).end();

    return;
  }

  let raw = '';

  for await (const chunk of req) { raw += chunk; }

  const userId = String(req.headers['x-user-id'] ?? 'anonymous');

  try {
    const result = await trace.run('POST /checkout', (ctx) => checkout(ctx, userId, JSON.parse(raw) as QuoteRequest));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(error instanceof PricingFailed ? 502 : 500).end(String(error));
  }
}).listen(4100, '127.0.0.1', () => console.log('checkout-api on http://127.0.0.1:4100'));

process.on('SIGTERM', async () => {
  await posthog?.shutdown();
  process.exit(0);
});
