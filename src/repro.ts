/**
 * Replay a request from its trace, under the flags it actually ran with.
 *
 *   pnpm repro <traceId>
 *
 * Reads the trace back from devtools: the code version that served it, the
 * flag evaluations the edge made (with reason and flags version), and the
 * request. Then runs the pricing code locally with those exact variants, and
 * with every other variant, so you see whether the flag is the cause.
 *
 * It replays the *recorded* variants, not today's flags: someone may have
 * changed the rollout since, and re-evaluating would give a different answer.
 *
 * Exits 1 while the bug reproduces, so it doubles as a regression check.
 */
import { execSync } from 'node:child_process';
import { ENGINES, quote } from './pricing.ts';
import type { Engine, QuoteRequest } from './pricing.ts';

const DEVTOOLS = process.env.DEVTOOLS_URL ?? 'http://127.0.0.1:4318';
const traceId = process.argv[2];

if (!traceId) {
  console.error('usage: pnpm repro <traceId>   (copy one from devtools, or ask the autotel MCP server for a failing checkout)');
  process.exit(2);
}

type Attributes = Record<string, string | number | boolean | undefined>;

async function query<T>(signal: 'traces' | 'logs'): Promise<T> {
  const res = await fetch(`${DEVTOOLS}/api/query/${signal}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `trace_id = ${traceId}` }),
  });

  if (!res.ok) { throw new Error(`devtools answered ${res.status} for ${signal}: is \`pnpm devtools\` running?`); }

  return (await res.json()) as T;
}

const { traces } = await query<{ traces: Array<{ spans: Array<{ name: string; startTime: number; attributes: Attributes }> }> }>('traces');
const checkout = traces[0]?.spans.find((s) => s.name === 'POST /checkout');

if (!checkout) {
  console.error(`No checkout span in trace ${traceId}.`);
  process.exit(2);
}

const { logs } = await query<{ logs: Array<{ resourceName: string; attributes: Attributes }> }>('logs');

// The edge's evaluations are the source of truth; downstream services read the same answers from baggage.
const flags = logs.filter((l) => l.attributes['event.name'] === 'feature_flag.evaluation' && l.resourceName === 'checkout-api');

const a = checkout.attributes;
const ranOn = String(a['service.version']);
let here = 'unknown';

try {
  here = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {}

console.log(`\nWhat was running at ${new Date(checkout.startTime).toISOString()}`);

console.log(`  code       ${ranOn} (${a['deployment.environment.name']})${ranOn === here || here === 'unknown' ? '' : `  ⚠ you are on ${here}: git checkout ${ranOn} to replay the exact code`}`);

console.log(`  user       ${a['user.id']} (group ${a['app.user.group']})`);

for (const f of flags) {
  const x = f.attributes;
  console.log(`  flag       ${x['feature_flag.key']} = ${x['feature_flag.result.variant'] ?? x['feature_flag.result.value']}  (${x['feature_flag.result.reason']}, ${x['feature_flag.provider.name']} v${x['feature_flag.version']})`);
}

const request = JSON.parse(String(a['checkout.request'])) as QuoteRequest;

console.log(`  request    ${JSON.stringify(request)}\n`);

const recorded = flags.find((f) => f.attributes['feature_flag.key'] === 'pricing-engine')?.attributes['feature_flag.result.variant'] as Engine | undefined;

if (!recorded) {
  console.error('The trace has no pricing-engine evaluation to replay.');
  process.exit(2);
}

function run(engine: Engine): string | undefined {
  try {
    const q = quote(request, engine);
    console.log(`  ${engine === recorded ? '▶' : ' '} ${engine.padEnd(8)} ok      total ${q.total}`);
  } catch (error) {
    console.log(`  ${engine === recorded ? '▶' : ' '} ${engine.padEnd(8)} FAILS   ${(error as Error).message}`);

    return (error as Error).message;
  }
}

console.log('Replaying locally (▶ = what the user got)');

const failure = run(recorded);

for (const engine of Object.keys(ENGINES) as Array<Engine>) { if (engine !== recorded) { run(engine); } }

console.log(failure ? `\nReproduced. Only the ${recorded} branch fails for this request.\n` : '\nDoes not reproduce on this code: fixed, or the cause is outside pricing.\n');

process.exit(failure ? 1 : 0);
