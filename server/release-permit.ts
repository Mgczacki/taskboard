// The release permit. The user's approval of a release card (tb release-request) writes it to
// <TB_DIR>/release-permits/<task id>.json. server/hooks/guard.mjs reads it before the task's release command runs and
// deletes it when it lets that command run. guard.mjs runs from ~/.taskboard/hooks without the server code, so it keeps
// its own copy of RELEASE_REF; tests/guard-release.test.mjs checks that both copies accept the same refs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// a branch, tag or commit that scripts/release.mjs accepts after --ref. It goes into a shell line there
// (git archive <ref> | tar), so it has no shell characters and does not start with -.
export const RELEASE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
// The permit expires five minutes after the approval. The task usually learns of the approval from
// tb release-result --wait within two seconds; the rest is time to start the command. While a permit is valid,
// the server refuses other release and restart cards (releaseInFlight in server/index.ts).
export const PERMIT_MS = 5 * 60_000;
export interface ReleasePermit { taskId: string; ref: string | null; approvedAt: number; expiresAt: number }

export const releaseCommand = (ref: string | null) => ref ? `pnpm release --ref ${ref}` : 'pnpm release';

export function checkRef(ref: unknown): string | null {
  if (ref === undefined || ref === null || ref === '') return null;
  if (typeof ref !== 'string' || !RELEASE_REF.test(ref)) throw new Error(`The release ref must be a branch, tag or commit name of letters, digits, ".", "_", "/" and "-" that starts with a letter or digit. Got: ${JSON.stringify(ref)}.`);
  return ref;
}

export function writePermit(tbDir: string, taskId: string, ref: string | null, now = Date.now()): ReleasePermit {
  const dir = join(tbDir, 'release-permits');
  mkdirSync(dir, { recursive: true });
  const permit: ReleasePermit = { taskId, ref, approvedAt: now, expiresAt: now + PERMIT_MS };
  writeFileSync(join(dir, taskId + '.json'), JSON.stringify(permit), { mode: 0o600 });
  return permit;
}
