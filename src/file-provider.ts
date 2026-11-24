/**
 * A flag provider backed by flags.json, standing in for PostHog / LaunchDarkly
 * so the demo runs with no account. It does what theirs do: group rules,
 * percentage rollouts sticky per user, a kill switch, and a version that
 * changes every time someone edits the flags.
 *
 * The file is re-read when it changes, so `pnpm rollout` changes behaviour in
 * running services with no restart and no deploy.
 */
import { createHash } from 'node:crypto';
import { readFileSync, watch } from 'node:fs';
import { ErrorCode } from '@openfeature/server-sdk';
import type { EvaluationContext, JsonValue, Provider, ResolutionDetails } from '@openfeature/server-sdk';

export interface Rule {
  /** Only users in this group. Omitted: everyone. */
  group?: string;
  /** Everyone the rule matches gets this variant. */
  variant?: string;
  /** Percent of matched users per variant, sticky per user. */
  rollout?: Record<string, number>;
}

export interface FlagDefinition {
  variants: Record<string, JsonValue>;
  default: string;
  disabled?: boolean;
  rules?: Array<Rule>;
}

export interface FlagFile {
  version: number;
  flags: Record<string, FlagDefinition>;
}

/** 0–99, the same for one user and flag on every evaluation. */
export function bucket(flagKey: string, targetingKey: string): number {
  return createHash('sha256').update(`${flagKey}:${targetingKey}`).digest().readUInt32BE(0) % 100;
}

/** Which variant this context gets, and why, in OpenTelemetry's reason vocabulary. */
export function evaluate(
  key: string,
  flag: FlagDefinition,
  context: EvaluationContext,
): { variant: string; reason: string } {
  if (flag.disabled) { return { variant: flag.default, reason: 'disabled' }; }

  for (const rule of flag.rules ?? []) {
    if (rule.group !== undefined && context.group !== rule.group) { continue; }

    if (rule.variant) { return { variant: rule.variant, reason: 'targeting_match' }; }

    if (rule.rollout) {
      const roll = bucket(key, context.targetingKey ?? '');
      let upTo = 0;

      for (const [variant, percent] of Object.entries(rule.rollout)) {
        upTo += percent;

        if (roll < upTo) { return { variant, reason: 'split' }; }
      }

      return { variant: flag.default, reason: 'split' };
    }
  }

  return { variant: flag.default, reason: 'default' };
}

export function fileProvider(path: string): Provider {
  let file = JSON.parse(readFileSync(path, 'utf8')) as FlagFile;
  watch(path, () => {
    try {
      file = JSON.parse(readFileSync(path, 'utf8')) as FlagFile;
    } catch {
      // Caught mid-write: keep the last good flags, the next event brings the rest.
    }
  }).unref();

  const resolve = <T extends JsonValue>(key: string, fallback: T, context: EvaluationContext): ResolutionDetails<T> => {
    const flag = file.flags[key];

    if (!flag) { return { value: fallback, reason: 'ERROR', errorCode: ErrorCode.FLAG_NOT_FOUND }; }

    const { variant, reason } = evaluate(key, flag, context);

    return {
      value: flag.variants[variant] as T,
      variant,
      reason,
      // OpenFeature names these for OpenTelemetry's feature_flag.set.id and feature_flag.version.
      flagMetadata: { flagSetId: 'checkout', version: String(file.version) },
    };
  };

  return {
    metadata: { name: 'flags.json' },
    runsOn: 'server',
    resolveBooleanEvaluation: async (key, fallback, context) => resolve(key, fallback, context),
    resolveStringEvaluation: async (key, fallback, context) => resolve(key, fallback, context),
    resolveNumberEvaluation: async (key, fallback, context) => resolve(key, fallback, context),
    resolveObjectEvaluation: async (key, fallback, context) => resolve(key, fallback, context),
  };
}
