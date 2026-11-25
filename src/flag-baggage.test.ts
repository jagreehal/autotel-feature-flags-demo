/** The wiring between the edge and pricing: featureFlagBaggage() out, a header, featureFlagBaggageProvider() in. */
import { OpenFeature } from '@openfeature/server-sdk';
import { context, init, propagation } from 'autotel';
import { featureFlagBaggage, featureFlagBaggageProvider } from 'autotel/feature-flags';
import { beforeAll, expect, it } from 'vitest';

beforeAll(async () => {
  init({ service: 'flag-baggage-test' });
  await OpenFeature.setProviderAndWait(featureFlagBaggageProvider());
});

const flags = OpenFeature.getClient();

const send = (variant: string) => {
  const headers: Record<string, string> = {};
  propagation.inject(featureFlagBaggage([{ flagKey: 'pricing-engine', value: variant, variant, flagMetadata: { version: 1 } }]), headers);

  return headers;
};

const receive = (headers: Record<string, string>) =>
  context.with(propagation.extract(context.active(), headers), async () => {
    await new Promise((done) => { setTimeout(done, Math.random() * 10); });

    return flags.getStringValue('pricing-engine', 'control');
  });

it('never leaks one request\'s flags into another', async () => {
  const sent = Array.from({ length: 50 }, (_, n) => (n % 2 === 0 ? 'v2' : 'control'));

  expect(await Promise.all(sent.map((variant) => receive(send(variant))))).toEqual(sent);
  expect(await flags.getStringValue('pricing-engine', 'control')).toBe('control');
});

it.each([
  ['missing', {}],
  ['malformed', { baggage: 'autotel.feature_flags=%7Bbroken' }],
  ['the wrong type', { baggage: 'autotel.feature_flags=%7B%22pricing-engine%22%3A%7B%22value%22%3A5%7D%7D' }],
])('falls back when baggage is %s', async (_, headers) => {
  expect(await receive(headers)).toBe('control');
});
