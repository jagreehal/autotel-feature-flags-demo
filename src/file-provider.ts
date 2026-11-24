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
import { readFileSync, watchFile } from 'node:fs';
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

function problemsWith(key: string, { variants, default: fallback, rules = [] }: FlagDefinition): Array<string> {
  const rollouts = rules.map((rule) => rule.rollout ?? {});
  const named = [fallback, ...rules.map((rule) => rule.variant ?? fallback), ...rollouts.flatMap((r) => Object.keys(r))];
  const percents = rollouts.map((r) => Object.values(r));

  return [
    ...[...new Set(named)].flatMap((v) => (Object.hasOwn(variants, v) ? [] : [`${key}: no variant "${v}"`])),
    ...(percents.flat().every((p) => Number.isFinite(p) && p >= 0 && p <= 100) ? [] : [`${key}: a rollout percentage must be 0-100`]),
    ...(percents.some((p) => p.reduce((sum, n) => sum + n, 0) > 100) ? [`${key}: a rollout adds up to more than 100`] : []),
  ];
}

/** Accepts a file whose rules all name variants that exist. Throws otherwise. */
export function parseFlags(text: string): FlagFile {
  const file = JSON.parse(text) as FlagFile;
  const problems = Object.entries(file.flags).flatMap(([key, flag]) => problemsWith(key, flag));

  if (!Number.isInteger(file.version) || file.version < 1) { problems.push('version must be a whole number from 1'); }

  if (problems.length > 0) { throw new Error(problems.join('; ')); }

  return file;
}

export function fileProvider(path: string): Provider {
  let file = parseFlags(readFileSync(path, 'utf8'));
  // Polls the path, so edits that replace the file count too.
  watchFile(path, { interval: 250 }, () => {
    try {
      file = parseFlags(readFileSync(path, 'utf8'));
    } catch (error) {
      // A bad edit, or caught mid-write: the last good flags stay live.
      console.error(`${path} not reloaded, still on version ${file.version}: ${String(error)}`);
    }
  }).unref();

  const resolve = <T extends JsonValue>(key: string, fallback: T, context: EvaluationContext): ResolutionDetails<T> => {
    const flag = file.flags[key];

    if (!flag) { return { value: fallback, reason: 'ERROR', errorCode: ErrorCode.FLAG_NOT_FOUND }; }

    const { variant, reason } = evaluate(key, flag, context);
    const value = flag.variants[variant];

    if (typeof value !== typeof fallback) { return { value: fallback, reason: 'ERROR', errorCode: ErrorCode.TYPE_MISMATCH }; }

    return {
      value: value as T,
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
