// Runs the adapter tests against an a2a-notes checkout (github.com/Mgczacki/a2a-notes) with its dependencies
// installed. A2A_NOTES_SOURCE names the folder; the default is ~/a2a-notes. Without a checkout the tests are skipped,
// because Taskboard does not depend on the package to install or run.
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const source = resolve(process.env.A2A_NOTES_SOURCE || join(homedir(), 'a2a-notes'));
if (existsSync(join(source, 'src', 'daemon.ts')) && existsSync(join(source, 'node_modules'))) {
  process.env.A2A_NOTES_SOURCE = source;
  await import('./a2anotes-adapter.suite.ts');
} else test('A2A Notes adapter', { skip: `No a2a-notes checkout with dependencies at ${source}. Clone github.com/Mgczacki/a2a-notes, run pnpm install, or set A2A_NOTES_SOURCE.` }, () => {});
