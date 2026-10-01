// Who calls a messages route. The controller proves itself with the token in TB_DIR/mail-controller.token, which
// server/agents.ts gives only to the controller (TB_MAIL_CONTROLLER_TOKEN). The dashboard is a browser request from
// a Taskboard origin without x-tb-actor.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { PORT, TB_DIR, URL_BASE } from '../config.ts';

const path = join(TB_DIR, 'mail-controller.token');
if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 });
export const controllerMailToken = readFileSync(path, 'utf8').trim();
export function isControllerToken(value: string | undefined) {
  return !!value && value.length === controllerMailToken.length && timingSafeEqual(Buffer.from(value), Buffer.from(controllerMailToken));
}

const origins = new Set([URL_BASE, `http://localhost:${PORT}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
export function human(req: Request) {
  const origin = req.get('origin');
  if (origin) return origins.has(origin) && !req.get('x-tb-actor');
  try { return req.get('sec-fetch-site') === 'same-origin' && origins.has(new URL(req.get('referer') || '').origin); } catch { return false; }
}
