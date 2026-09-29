import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TB_DIR } from '../config.ts';
const path = join(TB_DIR, 'mail-controller.token');
if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 });
export const controllerMailToken = readFileSync(path, 'utf8').trim();
export function isControllerToken(value: string | undefined) {
  return !!value && value.length === controllerMailToken.length && timingSafeEqual(Buffer.from(value), Buffer.from(controllerMailToken));
}
