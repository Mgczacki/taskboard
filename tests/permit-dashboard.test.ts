import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermitSettings } from '../web/src/components/PermitSettings.tsx';
import { refusalText } from '../web/src/refusalText.ts';
import { statusAfterCards, DISMISSED_STATUS } from '../server/card-close.ts';

test('the dashboard renders reviewed settings apart from the command', () => {
  const markup = renderToStaticMarkup(createElement(PermitSettings, { step: {
    command: 'echo reviewed', cwd: '/work/attached', timeoutSeconds: 30, network: false, state: 'pending',
    env: { GH_CONFIG_DIR: '/config/gh' }, envPaths: { GH_CONFIG_DIR: '/real/config/gh' }, unsetEnv: ['GH_TOKEN'], reviewRule: 'environment-values-in-command',
  } }));
  assert.match(markup, /Nonsecret environment settings/);
  assert.match(markup, /GH_CONFIG_DIR/);
  assert.match(markup, /\/config\/gh/);
  assert.match(markup, /Resolved path/);
  assert.match(markup, /\/real\/config\/gh/);
  assert.match(markup, /Remove from the child environment/);
  assert.match(markup, /GH_TOKEN/);
  assert.match(markup, /environment-values-in-command/);
  assert.match(markup, /Approval runs this exact command once/);
  assert.ok(!markup.includes('echo reviewed'));
  assert.equal(renderToStaticMarkup(createElement(PermitSettings, { step: { command: 'pwd', cwd: '/work', timeoutSeconds: 30, network: false, state: 'pending' } })), '');
});

test('the dashboard explains directory conflicts without suggesting a bypass', () => {
  const correction = 'Use --cwd with this task\'s attached worktree: /work/attached. Run tb scope to inspect the attached worktrees.';
  const text = refusalText({ detail: 'Refused directory', payload: { command: 'pwd', canPermit: false, diagnostic: {
    rule: 'cwd-overlaps-other-worktree', cwd: '/work', conflictingWorktree: '/work/other', conflictingTask: 'the worktree of task #217', correction,
  } } });
  assert.equal(text.who, 'Taskboard refused this working directory.');
  assert.match(text.where, /cwd-overlaps-other-worktree/);
  assert.match(text.where, /Resolved cwd: \/work/);
  assert.match(text.where, /task #217/);
  assert.match(text.where, /\/work\/other/);
  assert.equal(text.todo, correction);
  assert.equal(text.command, 'pwd');
});


test('validation refusals explain the correction without an execution instruction', () => {
  const text = refusalText({ detail: 'Protected path: /vault/tasks', payload: {
    canPermit: false, permitValidation: true, reason: 'Protected path: /vault/tasks',
    correction: 'Use --cwd with a project folder.',
  } });
  assert.match(text.who, /Nothing ran/);
  assert.equal(text.where, 'Protected path: /vault/tasks');
  assert.equal(text.todo, 'Use --cwd with a project folder.');
  assert.equal(text.command, '');
  assert.deepEqual(statusAfterCards({ status: 'needs-you', ask: 'Refused: correct the permit request.', statusSource: text.where },
    { open: 0, refusalDismissed: true }), { status: 'working', ask: '', statusSource: DISMISSED_STATUS });
});
