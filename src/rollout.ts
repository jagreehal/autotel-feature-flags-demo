/**
 * Change a flag without a deploy, the way someone would in PostHog's UI.
 *
 *   pnpm rollout pricing-engine 100    # beta group: v2 for everyone in it
 *   pnpm rollout pricing-engine off    # kill switch: everyone gets the default
 *   pnpm rollout pricing-engine on     # undo the kill switch
 *
 * Every change bumps the flags' version, which autotel records as
 * feature_flag.version, so the traces show when behaviour changed even though
 * the code (service.version) did not.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { FlagFile } from './file-provider.ts';

const [key, setting] = process.argv.slice(2);
const file = JSON.parse(readFileSync('flags.json', 'utf8')) as FlagFile;
const flag = key ? file.flags[key] : undefined;

if (!flag || !setting) {
  console.error(`usage: pnpm rollout <${Object.keys(file.flags).join('|')}> <percent|off|on>`);
  process.exit(1);
}

if (setting === 'off' || setting === 'on') {
  flag.disabled = setting === 'off';
} else {
  const percent = Number(setting);
  const rule = flag.rules?.find((r) => r.rollout);
  const variant = rule && Object.keys(rule.rollout!)[0];

  if (!rule || !variant || !(percent >= 0 && percent <= 100)) {
    console.error(`${key} has no percentage rollout, or ${setting} is not 0-100`);
    process.exit(1);
  }

  rule.rollout = { [variant]: percent };
}

file.version += 1;

writeFileSync('flags.json', JSON.stringify(file, null, 2) + '\n');

console.log(`${key}: ${setting} (flags version ${file.version})`);
