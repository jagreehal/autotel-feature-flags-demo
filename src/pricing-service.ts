/**
 * Downstream. Reads `pricing-engine` through OpenFeature like any service would,
 * but the provider only reads the request's baggage: the API already decided,
 * so this service cannot disagree with it mid-rollout.
 */
import { createServer } from 'node:http';
import { OpenFeature } from '@openfeature/server-sdk';
import { context, propagation, trace } from 'autotel';
import { featureFlagBaggageProvider } from 'autotel/feature-flags';
import { startTelemetry } from './telemetry.ts';
import { quote, QuoteError } from './pricing.ts';
import type { Engine, QuoteRequest } from './pricing.ts';

startTelemetry('pricing');

await OpenFeature.setProviderAndWait(featureFlagBaggageProvider());

const flags = OpenFeature.getClient();

createServer(async (req, res) => {
  let raw = '';

  for await (const chunk of req) { raw += chunk; }

  const parent = propagation.extract(context.active(), req.headers);

  try {
    const result = await context.with(parent, () =>
      trace.run('POST /quote', async (ctx) => {
        const request = JSON.parse(raw) as QuoteRequest;
        const engine = (await flags.getStringValue('pricing-engine', 'control')) as Engine;
        const result = quote(request, engine);
        ctx.setAttribute('pricing.total', result.total);

        return result;
      }),
    );

    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(error instanceof QuoteError ? 422 : 500).end(String(error));
  }
}).listen(4101, '127.0.0.1', () => console.log('pricing on http://127.0.0.1:4101'));
