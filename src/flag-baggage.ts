/**
 * Evaluate once at the edge, carry the answer downstream.
 *
 * If every service asks the flag provider itself, one request can see `v2` in
 * the API and `control` in pricing: a rollout changed between the two calls, or
 * the services cache differently. With trunk-based development flags change all
 * day, so that is not rare. The API evaluates, puts each answer in W3C baggage,
 * and downstream services read the same answer through OpenFeature as usual,
 * from a provider that only reads baggage. autotel records the evaluation in
 * both services, so the trace shows they agreed.
 *
 * Ships in autotel/feature-flags as `featureFlagBaggage()` and
 * `featureFlagBaggageProvider()` from the next release; swap this file for
 * those imports then. Only use the baggage provider in services behind an edge
 * that sets it: baggage is a request header, so a public service reading flags
 * from it lets a client pick its own variants.
 */
import { ErrorCode } from '@openfeature/server-sdk';
import type { EvaluationDetails, FlagValue, JsonValue, Provider, ResolutionDetails } from '@openfeature/server-sdk';
import { context, propagation } from 'autotel';

const PREFIX = 'feature_flag.';

interface Carried {
  value: FlagValue;
  variant?: string;
  version?: string;
}

/** The active context plus one baggage entry per evaluation. */
export function withFlagBaggage(evaluations: Array<EvaluationDetails<FlagValue>>) {
  let baggage = propagation.getBaggage(context.active()) ?? propagation.createBaggage();

  for (const e of evaluations) {
    const carried: Carried = { value: e.value, variant: e.variant, version: e.flagMetadata.version?.toString() };
    baggage = baggage.setEntry(PREFIX + e.flagKey, { value: JSON.stringify(carried) });
  }

  return propagation.setBaggage(context.active(), baggage);
}

/** Answers from the request's baggage only: the edge already decided. */
export function baggageProvider(): Provider {
  const resolve = <T extends JsonValue>(key: string, fallback: T): ResolutionDetails<T> => {
    const entry = propagation.getBaggage(context.active())?.getEntry(PREFIX + key);

    if (!entry) { return { value: fallback, reason: 'ERROR', errorCode: ErrorCode.FLAG_NOT_FOUND }; }

    const carried = JSON.parse(entry.value) as Carried;

    return {
      value: carried.value as T,
      variant: carried.variant,
      reason: 'cached',
      flagMetadata: carried.version ? { flagSetId: 'checkout', version: carried.version } : {},
    };
  };

  return {
    metadata: { name: 'baggage' },
    runsOn: 'server',
    resolveBooleanEvaluation: async (key, fallback) => resolve(key, fallback),
    resolveStringEvaluation: async (key, fallback) => resolve(key, fallback),
    resolveNumberEvaluation: async (key, fallback) => resolve(key, fallback),
    resolveObjectEvaluation: async (key, fallback) => resolve(key, fallback),
  };
}
