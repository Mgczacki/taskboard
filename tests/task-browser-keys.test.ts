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
const { editCommands, keyEvent } = await import('../server/task-browser.ts');
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

// A native key code made Chrome on macOS repeat a Meta or Shift key down without end; the Windows code of Meta (91)
// is keypad 8 there. Cmd+V then opened the macOS window About This Mac (task 200).
test('key events carry no native key code', () => {
  const keys = [
    { down: true, key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers: SHIFT },
    { down: false, key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers: 0 },
    { down: true, key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0 },
    { down: true, key: 'a', code: 'KeyA', keyCode: 65, modifiers: META },
    { down: true, key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 },
    { down: true, key: 'Control', code: 'ControlLeft', keyCode: 17, modifiers: CTRL },
  ];
  for (const k of keys) {
    const e = keyEvent(k);
    assert.ok(e, k.key);
    assert.equal('nativeVirtualKeyCode' in e, false, k.key);
    assert.equal(e.windowsVirtualKeyCode, k.keyCode);
  }
});

test('Cmd pressed alone does not go to the page', () => {
  assert.equal(keyEvent({ down: true, key: 'Meta', code: 'MetaLeft', keyCode: 91, modifiers: META }), null);
  assert.equal(keyEvent({ down: false, key: 'Meta', code: 'MetaLeft', keyCode: 91, modifiers: 0 }), null);
  assert.equal(keyEvent({ down: true, key: 'Meta', code: 'MetaRight', keyCode: 93, modifiers: META }), null);
});

test('Cmd shortcuts for the page keep the Meta bit and their command', () => {
  assert.deepEqual(keyEvent({ down: true, key: 'a', code: 'KeyA', keyCode: 65, modifiers: META }),
    { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: META, commands: ['selectAll'] });
  assert.deepEqual(keyEvent({ down: true, key: 'k', code: 'KeyK', keyCode: 75, modifiers: META }),
    { type: 'rawKeyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: META });
  assert.deepEqual(keyEvent({ down: true, key: 'b', code: 'KeyB', keyCode: 66, modifiers: 0 }),
    { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 0, text: 'b', unmodifiedText: 'b' });
});

// AltGr on Windows and Linux reports Ctrl and Alt with the character it makes (@ on a German layout is AltGr+Q).
test('an AltGr character types its text without Ctrl and Alt', () => {
  assert.deepEqual(keyEvent({ down: true, key: '@', code: 'KeyQ', keyCode: 81, modifiers: CTRL | ALT, altGraph: true }),
    { type: 'keyDown', key: '@', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 0, text: '@', unmodifiedText: '@' });
  // without the flag, Ctrl and Alt with a character that is not a letter or a digit count as AltGr
  assert.deepEqual(keyEvent({ down: true, key: '€', code: 'KeyE', keyCode: 69, modifiers: CTRL | ALT | SHIFT }),
    { type: 'keyDown', key: '€', code: 'KeyE', windowsVirtualKeyCode: 69, modifiers: SHIFT, text: '€', unmodifiedText: '€' });
  assert.deepEqual(keyEvent({ down: false, key: '@', code: 'KeyQ', keyCode: 81, modifiers: CTRL | ALT, altGraph: true }),
    { type: 'keyUp', key: '@', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 0 });
});

test('Ctrl+Alt with a letter stays a shortcut', () => {
  assert.deepEqual(keyEvent({ down: true, key: 't', code: 'KeyT', keyCode: 84, modifiers: CTRL | ALT }),
    { type: 'rawKeyDown', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: CTRL | ALT });
  // Meta with Ctrl and Alt is never AltGr
  assert.deepEqual(keyEvent({ down: true, key: '@', code: 'KeyQ', keyCode: 81, modifiers: CTRL | ALT | META }),
    { type: 'rawKeyDown', key: '@', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: CTRL | ALT | META });
});
