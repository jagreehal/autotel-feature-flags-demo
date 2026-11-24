import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FLAG_TTL_MS, posthogProvider } from './posthog-provider.ts';

beforeEach(() => void vi.useFakeTimers());

afterEach(() => void vi.useRealTimers());

const setup = () => {
  const getFeatureFlag = vi.fn<Parameters<typeof posthogProvider>[0]['getFeatureFlag']>();
  const provider = posthogProvider({ getFeatureFlag });

  const ask = (group = 'beta', targetingKey = 'user-1') =>
    provider.resolveBooleanEvaluation('express-shipping', true, { targetingKey, group }, console);

  return { getFeatureFlag, provider, ask };
};

it('asks PostHog once per flag, user and group, and caches off as well as on', async () => {
  const { getFeatureFlag, ask } = setup();
  getFeatureFlag.mockResolvedValue(false);
  expect(await ask()).toMatchObject({ value: false, variant: 'false', reason: 'targeting_match' });
  expect(await ask()).toMatchObject({ value: false, variant: 'false', reason: 'cached' });
  expect(getFeatureFlag).toHaveBeenCalledTimes(1);

  await ask('internal');
  await ask('beta', 'user-2');
  expect(getFeatureFlag).toHaveBeenCalledTimes(3);
});

it('picks up a kill switch once the TTL passes', async () => {
  const { getFeatureFlag, ask } = setup();
  getFeatureFlag.mockResolvedValue(true);
  await ask();
  getFeatureFlag.mockResolvedValue(false);
  expect((await ask()).value).toBe(true);
  vi.advanceTimersByTime(FLAG_TTL_MS + 1);
  expect((await ask()).value).toBe(false);
});

it('gives a user a multivariate flag does not match the caller\'s default, not false', async () => {
  const { getFeatureFlag, provider } = setup();
  getFeatureFlag.mockResolvedValue(false);
  const ask = () => provider.resolveStringEvaluation('pricing-engine', 'control', { targetingKey: 'user-1', group: 'everyone' }, console);

  expect(await ask()).toMatchObject({ value: 'control', variant: 'control', reason: 'default' });
  expect(await ask()).toMatchObject({ value: 'control', variant: 'control', reason: 'cached' });
  expect(getFeatureFlag).toHaveBeenCalledTimes(1);
});

it('does not cache a missing answer', async () => {
  const { getFeatureFlag, ask } = setup();
  getFeatureFlag.mockResolvedValueOnce(undefined).mockResolvedValue(false);
  expect(await ask()).toMatchObject({ value: true, errorCode: 'FLAG_NOT_FOUND' });
  expect((await ask()).value).toBe(false);
});
