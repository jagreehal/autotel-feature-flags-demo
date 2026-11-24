/**
 * The same provider seam, answered by PostHog. Set POSTHOG_KEY and the services
 * evaluate flags in PostHog instead of flags.json; nothing else changes, and
 * autotel records PostHog's answers exactly as it records the file's.
 *
 * PostHog has no official OpenFeature provider for Node, so this is the
 * smallest one that works.
 */
import { ErrorCode } from '@openfeature/server-sdk';
import type { EvaluationContext, JsonValue, Provider, ResolutionDetails } from '@openfeature/server-sdk';
import { Keyv } from 'keyv';
import { PostHog } from 'posthog-node';

/** How long a rollout or kill switch can take to reach a user already cached. */
export const FLAG_TTL_MS = 30_000;

export function posthogClient(): PostHog | undefined {
  const key = process.env.POSTHOG_KEY;

  return key ? new PostHog(key, { host: process.env.POSTHOG_HOST }) : undefined;
}

export function posthogProvider(posthog: Pick<PostHog, 'getFeatureFlag'>): Provider {
  // shortcut: in-process, and Keyv drops expired entries only when read, so pass it a shared or bounded store when users are many.
  const cache = new Keyv<string | boolean>({ ttl: FLAG_TTL_MS });

  const resolve = async <T extends JsonValue>(key: string, fallback: T, context: EvaluationContext): Promise<ResolutionDetails<T>> => {
    const distinctId = context.targetingKey ?? 'anonymous';
    const group = String(context.group ?? '');
    // Everything the answer depends on: a user who changes group must not keep the old group's answer.
    const cacheKey = JSON.stringify([key, distinctId, group]);
    const cached = await cache.get(cacheKey);

    const answer =
      cached ??
      // The group rule in flags.json is a person property in PostHog: target `group = beta`.
      (await posthog.getFeatureFlag(key, distinctId, { personProperties: { group } }));

    // No answer (PostHog down, or no such flag) is not cached, so the next request asks again.
    if (answer === undefined) { return { value: fallback, reason: 'ERROR', errorCode: ErrorCode.FLAG_NOT_FOUND }; }

    // Multivariate flags answer with the variant name, boolean flags with true/false.
    const value = (typeof fallback === 'boolean' ? answer !== false : answer) as T;

    if (cached === undefined) { await cache.set(cacheKey, answer); }

    return { value, variant: String(answer), reason: cached === undefined ? 'targeting_match' : 'cached' };
  };

  return {
    metadata: { name: 'posthog' },
    runsOn: 'server',
    resolveBooleanEvaluation: (key, fallback, context) => resolve(key, fallback, context),
    resolveStringEvaluation: (key, fallback, context) => resolve(key, fallback, context),
    resolveNumberEvaluation: (key, fallback, context) => resolve(key, fallback, context),
    resolveObjectEvaluation: (key, fallback, context) => resolve(key, fallback, context),
  };
}
