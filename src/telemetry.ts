import { execSync } from 'node:child_process';
import { init } from 'autotel';

/** The commit that is running: with flags, half of "what was deployed". */
function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'uncommitted';
  }
}

export function startTelemetry(service: string): void {
  init({
    service,
    version: process.env.GIT_SHA ?? gitSha(),
    environment: 'demo',
    // Streams to `pnpm devtools` on :4318.
    devtools: true,
    // Keep every trace: a demo has no volume to sample away.
    sampling: 'development',
  });
}
