import { inspect } from 'node:util';
import { performance } from 'node:perf_hooks';

type WaitOptions = {
  description: string;
  timeoutMs?: number;
  intervalMs?: number;
  state?: () => string | Promise<string>;
};

// A missing condition is a test failure. The last value and the caller's state explain what was missing.
export async function waitFor<T>(check: () => T | Promise<T>, options: WaitOptions): Promise<NonNullable<Exclude<T, false>>> {
  const { description, timeoutMs = 60_000, intervalMs = 100, state } = options;
  const end = performance.now() + timeoutMs;
  let last: unknown;
  let lastError: unknown;
  do {
    try {
      last = await check();
      if (last) return last as NonNullable<Exclude<T, false>>;
    } catch (error) {
      lastError = error;
    }
    if (performance.now() >= end) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(1, end - performance.now()))));
  } while (true);
  let detail = '';
  if (state) {
    try { detail = `\nState: ${await state()}`; }
    catch (error) { detail = `\nState check failed: ${inspect(error)}`; }
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}. Last value: ${inspect(last, { depth: 2, maxStringLength: 3000 })}${lastError ? `\nLast error: ${inspect(lastError)}` : ''}${detail}`);
}
