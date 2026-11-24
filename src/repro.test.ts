/** Runs the real script against a stub devtools that answers the way the real one does. */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const TRACE = 'a'.repeat(32);
const EUR = { currency: 'EUR', items: [{ sku: 'secret-sku', qty: 2, unitPrice: 2500 }], discountCode: 'SAVE10' };
const DOUBLE_DISCOUNT = 'Error: discount taken twice';
const NO_RATE = 'TypeError: no rate for USD in v2';

/** A fixed copy of pricing, so these tests do not depend on the demo's own. */
const PRICING = `
export const RATES = { GBP: 1, EUR: 1.17 };
export const DISCOUNTS = { SAVE10: 1000 };
export const ENGINES = { control: 1, v2: 2 };
export function quote(request, engine) {
  if (!RATES[request.currency]) { throw new TypeError('no rate for ' + request.currency + ' in ' + engine); }
  if (engine === 'v2') { throw new Error('discount taken twice'); }
  return { subtotal: 5850, discount: 1170, total: 4680 };
}
`;

let cwd = '';
let url = '';
let trace = { request: {}, variant: 'v2', error: '' };

const server = createServer((req, res) => {
  const span = {
    name: 'POST /checkout',
    startTime: 0,
    status: trace.error === '' ? { code: 'OK' } : { code: 'ERROR', message: trace.error },
    attributes: { 'service.version': 'abc1234', 'checkout.request': JSON.stringify(trace.request) },
  };

  const log = {
    resourceName: 'checkout-api',
    attributes: { 'event.name': 'feature_flag.evaluation', 'feature_flag.key': 'pricing-engine', 'feature_flag.result.variant': trace.variant, 'feature_flag.version': '1' },
  };

  // What pricing logs for the same flag: read from baggage, so never the one replayed.
  const downstream = { resourceName: 'pricing', attributes: { ...log.attributes, 'feature_flag.result.variant': 'control' } };
  res.end(JSON.stringify(req.url === '/api/query/traces' ? { traces: [{ spans: [span] }] } : { logs: [downstream, log] }));
});

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'repro-'));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'package.json'), '{ "type": "module" }');
  writeFileSync(join(cwd, 'src/pricing.ts'), PRICING);
  copyFileSync('src/repro.ts', join(cwd, 'src/repro.ts'));
  trace = { request: EUR, variant: 'v2', error: DOUBLE_DISCOUNT };

  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });

  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => { server.close(); });

/** In its own directory: no git, so the commit never matches, and no flags.json, so today's flags cannot matter. */
const repro = (...args: Array<string>) =>
  new Promise<{ code: number; report: unknown }>((done) => {
    execFile(resolve('node_modules/.bin/tsx'), ['src/repro.ts', TRACE, '--json', ...args], { cwd, env: { ...process.env, DEVTOOLS_URL: url } }, (error, stdout) => {
      done({ code: Number(error?.code ?? 0), report: JSON.parse(stdout) });
    });
  });

it('blames the variant when only it fails, under the variant the edge recorded', async () => {
  expect(await repro()).toMatchObject({
    code: 1,
    report: { verdict: 'variant-specific', reproduced: true, recordedVariant: 'v2', codeVersionMatches: false, results: { v2: { ok: false }, control: { ok: true, total: 4680 } } },
  });
});

it('does not blame the variant when every variant fails', async () => {
  trace = { request: { ...EUR, currency: 'USD' }, variant: 'v2', error: NO_RATE };
  expect(await repro()).toMatchObject({ code: 1, report: { verdict: 'shared', results: { v2: { ok: false }, control: { ok: false } } } });
});

it('says so when the failure does not reproduce', async () => {
  trace = { request: EUR, variant: 'control', error: 'TypeError: fetch failed' };
  expect(await repro()).toMatchObject({ code: 0, report: { verdict: 'not-reproduced', reproduced: false } });
});

it.each([
  ['a different error', { request: EUR, variant: 'v2', error: 'TypeError: fetch failed' }],
  ['a checkout that succeeded', { request: EUR, variant: 'v2', error: '' }],
  ['an engine this code does not have', { request: EUR, variant: 'v3', error: DOUBLE_DISCOUNT }],
])('claims nothing from %s', async (_, recorded) => {
  trace = recorded;
  expect(await repro()).toMatchObject({ code: 2, report: { verdict: 'insufficient-evidence', reproduced: null } });
});

it('--strict refuses to replay on another commit', async () => {
  const { code, report } = await repro('--strict');
  expect(code).toBe(2);
  expect(report).toMatchObject({ verdict: 'insufficient-evidence', codeVersionMatches: false });
  expect(report).not.toHaveProperty('results');
});

it('does not call a replay that could not run a reproduction', async () => {
  url = 'http://127.0.0.1:1';
  expect(await repro()).toMatchObject({ code: 2, report: { verdict: 'insufficient-evidence' } });
});

it('--generate-test writes a sanitised test of the business rule, once', async () => {
  const path = `src/regressions/${TRACE}.test.ts`;
  expect(await repro('--generate-test')).toMatchObject({ code: 1, report: { testFile: path } });

  const test = readFileSync(join(cwd, path), 'utf8');
  expect(test).toContain('toBe(result.subtotal - result.discount)');
  expect(test).toContain('"SAVE10"');
  expect(test).not.toContain('secret-sku');

  expect(await repro('--generate-test')).toMatchObject({ code: 1, report: { verdict: 'variant-specific', testSkipped: expect.stringContaining('EEXIST') } });
});

it('--generate-test writes nothing for a request pricing should reject', async () => {
  trace = { request: { ...EUR, currency: 'USD' }, variant: 'v2', error: NO_RATE };
  expect(await repro('--generate-test')).toMatchObject({ code: 1, report: { verdict: 'shared', testSkipped: expect.any(String) } });
  expect(existsSync(join(cwd, 'src/regressions'))).toBe(false);
});
