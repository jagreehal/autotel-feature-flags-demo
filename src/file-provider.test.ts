import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { evaluate, fileProvider, parseFlags } from './file-provider.ts';
import type { FlagDefinition } from './file-provider.ts';

const flag = (rollout: Record<string, number>): FlagDefinition => ({ variants: { control: 'control', v2: 'v2' }, default: 'control', rules: [{ rollout }] });
const flagFile = (version: number, f: FlagDefinition) => JSON.stringify({ version, flags: { f } });

it('moves nobody out when a rollout grows', () => {
  const users = Array.from({ length: 500 }, (_, n) => `user-${n}`);
  const inAt = (percent: number) => users.filter((targetingKey) => evaluate('f', flag({ v2: percent }), { targetingKey }).variant === 'v2');
  const before = inAt(25);
  const after = new Set(inAt(50));

  expect(before.length).toBeGreaterThan(0);
  expect(after.size).toBeGreaterThan(before.length);
  expect(before.every((user) => after.has(user))).toBe(true);
});

it.each([
  ['an unknown default', flagFile(1, { ...flag({ v2: 1 }), default: 'nope' }), /no variant "nope"/],
  ['an unknown fixed variant', flagFile(1, { ...flag({}), rules: [{ variant: 'v3' }] }), /no variant "v3"/],
  ['an unknown rollout variant', flagFile(1, flag({ v3: 10 })), /no variant "v3"/],
  ['a name every object inherits', flagFile(1, flag({ constructor: 10 })), /no variant "constructor"/],
  ['a negative percentage', flagFile(1, flag({ v2: -1 })), /0-100/],
  ['a total over 100', flagFile(1, flag({ control: 60, v2: 60 })), /more than 100/],
  ['a bad version', flagFile(0, flag({ v2: 1 })), /version/],
])('rejects %s', (_, text, problem) => {
  expect(() => parseFlags(text)).toThrow(problem);
});

it('keeps the last good flags through a bad edit, and takes the next good one', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'flags-')), 'flags.json');
  const errors = vi.spyOn(console, 'error').mockReturnValue();
  writeFileSync(path, flagFile(1, flag({ v2: 100 })));
  const provider = fileProvider(path);
  const ask = () => provider.resolveStringEvaluation('f', 'control', { targetingKey: 'a' }, console);

  await vi.waitFor(() => {
    writeFileSync(path, flagFile(2, flag({ v3: 100 })));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('still on version 1'));
  }, { timeout: 5000, interval: 200 });

  expect(await ask()).toMatchObject({ value: 'v2', flagMetadata: { version: '1' } });

  await vi.waitFor(async () => {
    writeFileSync(path, flagFile(3, flag({ v2: 0 })));
    expect(await ask()).toMatchObject({ value: 'control', flagMetadata: { version: '3' } });
  }, { timeout: 5000, interval: 200 });

  errors.mockRestore();
});

it('still sees edits after the file is replaced, as git and many editors do', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'flags-')), 'flags.json');
  writeFileSync(path, flagFile(1, flag({ v2: 100 })));
  const provider = fileProvider(path);

  for (const version of [2, 3]) {
    await vi.waitFor(async () => {
      writeFileSync(`${path}.tmp`, flagFile(version, flag({ v2: 100 })));
      renameSync(`${path}.tmp`, path);
      expect(await provider.resolveStringEvaluation('f', 'control', { targetingKey: 'a' }, console)).toMatchObject({ flagMetadata: { version: String(version) } });
    }, { timeout: 4000, interval: 700 });
  }
}, 10_000);

it('answers a flag of the wrong type with the fallback', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'flags-')), 'flags.json');
  writeFileSync(path, flagFile(1, flag({ v2: 100 })));
  const answer = await fileProvider(path).resolveBooleanEvaluation('f', false, { targetingKey: 'a' }, console);

  expect(answer).toMatchObject({ value: false, errorCode: 'TYPE_MISMATCH' });
});
