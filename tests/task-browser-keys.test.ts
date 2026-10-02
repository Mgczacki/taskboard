// The macOS editing commands that the dashboard's browser view sends with a key (editCommands in server/task-browser.ts).
// Chrome runs Cmd+A, Cmd+Z and the Option and Cmd arrow keys only when the key event names the command.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-browser-keys-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false } }));
const { editCommands } = await import('../server/task-browser.ts');
const ALT = 1, CTRL = 2, META = 4, SHIFT = 8;

test('Cmd shortcuts name the editing command', () => {
  assert.deepEqual(editCommands('a', META), ['selectAll']);
  assert.deepEqual(editCommands('z', META), ['undo']);
  assert.deepEqual(editCommands('Z', META | SHIFT), ['redo']);
  assert.deepEqual(editCommands('ArrowLeft', META), ['moveToBeginningOfLine']);
  assert.deepEqual(editCommands('ArrowRight', META | SHIFT), ['moveToEndOfLineAndModifySelection']);
  assert.deepEqual(editCommands('Backspace', META), ['deleteToBeginningOfLine']);
});

test('Option shortcuts move and delete by word', () => {
  assert.deepEqual(editCommands('ArrowLeft', ALT), ['moveWordLeft']);
  assert.deepEqual(editCommands('ArrowRight', ALT | SHIFT), ['moveWordRightAndModifySelection']);
  assert.deepEqual(editCommands('Backspace', ALT), ['deleteWordBackward']);
});

test('other keys carry no command', () => {
  assert.deepEqual(editCommands('a', 0), []);
  assert.deepEqual(editCommands('a', CTRL), []);
  assert.deepEqual(editCommands('a', META | ALT), []);
  assert.deepEqual(editCommands('Enter', META), []);
});
