/**
 * Replay a request from its trace, under the flags it actually ran with.
 *
 *   pnpm repro <traceId>                    # against the code you have now
 *   pnpm repro <traceId> --strict           # only on the commit that served it
 *   pnpm -s repro <traceId> --json          # for CI and agents
 *   pnpm repro <traceId> --generate-test    # a failing test to fix against
 *
 * Reads the trace back from devtools: the code version that served it, the
 * flag evaluations the edge made (with reason and flags version), and the
 * request. Then runs the pricing code locally with the recorded variant, and
 * with every other variant, so you see whether the variant decides the outcome.
 *
 * It replays the *recorded* variants, not today's flags: someone may have
 * changed the rollout since, and re-evaluating would give a different answer.
 *
 * It replays pricing, a pure function of the request and the variant. It does
 * not replay the network, the clock or any stored state.
 *
 * Exits 1 while the recorded failure reproduces, 0 when it does not, and 2 when
 * there is not enough evidence to say, so it doubles as a regression check.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DISCOUNTS, ENGINES, quote, RATES } from './pricing.ts';
import type { Engine, QuoteRequest } from './pricing.ts';

const DEVTOOLS = process.env.DEVTOOLS_URL ?? 'http://127.0.0.1:4318';
const USAGE = 'usage: pnpm repro <traceId> [--strict] [--json] [--generate-test]   (copy a trace id from devtools, or ask the autotel MCP server for a failing checkout)';

type Attributes = Record<string, string | number | boolean | undefined>;

type ReplayResult = { ok: true; total: number } | { ok: false; error: string };

interface Report {
  verdict: 'variant-specific' | 'shared' | 'not-reproduced' | 'insufficient-evidence';
  /** null when there is not enough evidence to say. */
  reproduced: boolean | null;
  reason: string;
  codeVersionMatches?: boolean;
  recordedVariant?: string;
  recordedError?: string;
  flags?: Array<{ key: string; variant: string; reason: string; provider: string; version: string }>;
  results?: Record<string, ReplayResult>;
  testFile?: string;
  /** Why --generate-test wrote nothing. */
  testSkipped?: string;
}

interface Options {
  traceId: string;
  strict: boolean;
  withTest: boolean;
  say: (line: string) => void;
}

async function query<T>(signal: 'traces' | 'logs', traceId: string): Promise<T> {
  const res = await fetch(`${DEVTOOLS}/api/query/${signal}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `trace_id = ${traceId}` }),
  }).catch((error: unknown) => { throw new Error(`cannot reach devtools at ${DEVTOOLS}: is \`pnpm devtools\` running?`, { cause: error }); });

  if (!res.ok) { throw new Error(`devtools answered ${res.status} for ${signal}: is \`pnpm devtools\` running?`); }

  return (await res.json()) as T;
}

/** undefined when git fails, which for `diff --quiet` means there are changes. */
function git(args: string): string | undefined {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

function attempt(request: QuoteRequest, engine: Engine): ReplayResult {
  try {
    return { ok: true, total: quote(request, engine).total };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Only what pricing reads. undefined when it is not a request pricing should accept, so no total is right. */
function sanitise({ currency, items, discountCode }: QuoteRequest): QuoteRequest | undefined {
  const valid = Object.hasOwn(RATES, currency) && Array.isArray(items) && items.every((i) => Number.isFinite(i.qty) && Number.isFinite(i.unitPrice));

  if (!valid) { return undefined; }

  return {
    currency,
    items: items.map(({ qty, unitPrice }, n) => ({ sku: `item-${n + 1}`, qty, unitPrice })),
    discountCode: discountCode !== undefined && Object.hasOwn(DISCOUNTS, discountCode) ? discountCode : undefined,
  };
}

/** Writes the test and returns its path, or throws why it did not. */
function generateTest(traceId: string, request: QuoteRequest, report: Report): string {
  // Evidence that the test can fail.
  if (report.reproduced !== true) { throw new Error('the failure does not reproduce'); }

  const engine = report.recordedVariant as Engine;
  const safe = sanitise(request);

  if (!safe) { throw new Error('pricing should not accept this request, so decide what it should do and write that test by hand'); }

  const replayed = attempt(safe, engine);

  if (replayed.ok || replayed.error !== report.recordedError) { throw new Error('the failure depends on something sanitising removed'); }

  const path = `src/regressions/${traceId}.test.ts`;
  mkdirSync('src/regressions', { recursive: true });

  // wx: never overwrite a test someone has edited.
  writeFileSync(path, `/** From \`pnpm repro ${traceId} --generate-test\`. Asserts the business rule, not what production returned. */
import { expect, it } from 'vitest';
import { quote } from '../pricing.ts';
import type { QuoteRequest } from '../pricing.ts';

const flags = ${JSON.stringify({ 'pricing-engine': engine }, null, 2)} as const;

const request: QuoteRequest = ${JSON.stringify(safe, null, 2)};

it('charges the subtotal less the discount', () => {
  const result = quote(request, flags['pricing-engine']);

  expect(result.total).toBe(result.subtotal - result.discount);
});
`, { flag: 'wx' });

  return path;
}

const outcome = (r: ReplayResult): string => (r.ok ? `ok      total ${r.total}` : `FAILS   ${r.error}`);

const insufficient = (reason: string): Report => ({ verdict: 'insufficient-evidence', reproduced: null, reason });

function judge(recorded: Engine, recordedError: string | undefined, results: Record<string, ReplayResult>): Report {
  const replayed = results[recorded];

  if (replayed.ok) {
    return { verdict: 'not-reproduced', reproduced: false, reason: 'The recorded failure does not occur in this replay: it may be fixed, or its cause may lie outside what is replayed.' };
  }

  if (replayed.error !== recordedError) {
    return insufficient(`${recorded} fails, but not with the recorded error (${recordedError}).`);
  }

  const others = Object.keys(results).filter((engine) => engine !== recorded && !results[engine].ok);

  return others.length > 0
    ? { verdict: 'shared', reproduced: true, reason: `Reproduced, but ${others.join(', ')} fails for this request too: the flag alone does not explain it.` }
    : { verdict: 'variant-specific', reproduced: true, reason: `Reproduced. Only the ${recorded} branch fails for this request.` };
}

/** A test that cannot be written must not hide the verdict. */
function tryGenerateTest(traceId: string, request: QuoteRequest, report: Report): Pick<Report, 'testFile' | 'testSkipped'> {
  try {
    return { testFile: generateTest(traceId, request, report) };
  } catch (error) {
    return { testSkipped: (error as Error).message };
  }
}

async function readTrace(traceId: string) {
  const { traces } = await query<{ traces: Array<{ spans: Array<{ name: string; startTime: number; status: { code: string; message?: string }; attributes: Attributes }> }> }>('traces', traceId);
  const checkout = traces[0]?.spans.find((s) => s.name === 'POST /checkout');

  if (!checkout) { throw new Error(`No checkout span in trace ${traceId}.`); }

  const { logs } = await query<{ logs: Array<{ resourceName: string; attributes: Attributes }> }>('logs', traceId);

  // The edge's evaluations are the source of truth; downstream services read the same answers from baggage.
  const flags = logs
    .filter((l) => l.attributes['event.name'] === 'feature_flag.evaluation' && l.resourceName === 'checkout-api')
    .map(({ attributes: x }) => ({
      key: String(x['feature_flag.key']),
      // A failed evaluation has no variant; the value is what the request ran with.
      variant: String(x['feature_flag.result.variant'] ?? x['feature_flag.result.value']),
      reason: String(x['feature_flag.result.reason']),
      provider: String(x['feature_flag.provider.name']),
      version: String(x['feature_flag.version'] ?? 'unknown'),
    }));

  return { checkout, flags };
}

/** Why the code here is not the code that served the request, if it is not. */
function codeDiffers(ranOn: string): string | undefined {
  const head = git('rev-parse HEAD');

  if (head?.startsWith(ranOn) !== true) { return `you are on ${head?.slice(0, 7) ?? 'an unknown commit'}: git checkout ${ranOn} to replay the exact code`; }

  return git('diff --quiet HEAD -- src') === undefined ? 'src has uncommitted changes' : undefined;
}

/** What the trace lacks for a replay to mean anything. */
function missingEvidence(checkout: Awaited<ReturnType<typeof readTrace>>['checkout'], recorded: string | undefined): string | undefined {
  if (recorded === undefined) { return 'The trace has no pricing-engine evaluation to replay.'; }

  if (!Object.hasOwn(ENGINES, recorded)) { return `This code has no ${recorded} engine to replay.`; }

  if (checkout.attributes['checkout.request'] === undefined) { return 'The trace did not record the request.'; }

  return checkout.status.code === 'ERROR' ? undefined : 'The recorded checkout succeeded: there is no failure to reproduce.';
}

async function main({ traceId, strict, withTest, say }: Options): Promise<Report> {
  const { checkout, flags } = await readTrace(traceId);
  const a = checkout.attributes;
  const differs = codeDiffers(String(a['service.version']));
  const warning = differs === undefined ? '' : `  ⚠ ${differs}`;

  say(`\nWhat was running at ${new Date(checkout.startTime).toISOString()}`);

  say(`  code       ${a['service.version']} (${a['deployment.environment.name']})${warning}`);

  say(`  user       ${a['user.id']} (group ${a['app.user.group']})`);

  for (const f of flags) { say(`  flag       ${f.key} = ${f.variant}  (${f.reason}, ${f.provider} v${f.version})`); }

  say(`  request    ${a['checkout.request']}\n`);

  const recorded = flags.find((f) => f.key === 'pricing-engine')?.variant;
  const recordedError = checkout.status.message;
  const evidence = { codeVersionMatches: differs === undefined, recordedVariant: recorded, recordedError, flags };
  const missing = missingEvidence(checkout, recorded);

  if (missing !== undefined) { return { ...insufficient(missing), ...evidence }; }

  if (strict && differs !== undefined) { return { ...insufficient(`--strict: ${differs}.`), ...evidence }; }

  const engine = recorded as Engine;
  const request = JSON.parse(String(a['checkout.request'])) as QuoteRequest;
  const engines = new Set([engine, ...(Object.keys(ENGINES) as Array<Engine>)]);
  const results = Object.fromEntries([...engines].map((e) => [e, attempt(request, e)]));

  say('Replaying locally (▶ = what the user got)');

  for (const [name, r] of Object.entries(results)) { say(`  ${name === engine ? '▶' : ' '} ${name.padEnd(8)} ${outcome(r)}`); }

  const report: Report = { ...judge(engine, recordedError, results), ...evidence, results };

  return withTest ? { ...report, ...tryGenerateTest(traceId, request, report) } : report;
}

let json = process.argv.includes('--json');

let report: Report;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { strict: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, 'generate-test': { type: 'boolean', default: false } },
  });

  const [traceId] = positionals;
  json = values.json;

  // It goes into a query and a file name.
  if (!/^[0-9a-f]{32}$/.test(traceId)) { throw new Error(USAGE); }

  report = await main({ traceId, strict: values.strict, withTest: values['generate-test'], say: json ? () => {} : console.log });
} catch (error) {
  // Exit code 2: a replay that could not run is not a reproduction.
  report = insufficient(error instanceof Error ? error.message : String(error));
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n${report.reason}`);

  if (report.testFile !== undefined) { console.log(`Wrote ${report.testFile}: it fails until the bug is fixed.`); }

  if (report.testSkipped !== undefined) { console.log(`No test written: ${report.testSkipped}.`); }

  console.log();
}

process.exitCode = report.reproduced === null ? 2 : Number(report.reproduced);
