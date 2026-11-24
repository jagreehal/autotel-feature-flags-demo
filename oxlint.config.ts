import autoAntiSlop from 'auto-anti-slop';
import { defineConfig } from 'oxlint';

export default defineConfig({
  ...autoAntiSlop,
  // Scripts and services here print to the terminal on purpose.
  rules: { ...autoAntiSlop.rules, 'no-console': 'off' },
});
