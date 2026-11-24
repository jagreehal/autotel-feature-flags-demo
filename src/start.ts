/** Runs both services; Ctrl-C stops both. */
import { spawn } from 'node:child_process';

for (const file of ['src/pricing-service.ts', 'src/checkout-api.ts']) {
  const child = spawn('tsx', [file], { stdio: 'inherit' });
  process.on('SIGINT', () => child.kill('SIGTERM'));
}
