// The global options of the tmux server of the agents (tmux -L <TASKBOARD_TMUX_SOCKET>, default taskboard).
// server/tmux.ts applies them, and pnpm doctor (scripts/doctor.mjs) checks and repairs them, with the same list.
//
// A tmux server keeps its options only while it runs. A new tmux server starts with the tmux defaults (status bar on,
// mouse off, escape-time 10, history-limit 2000, remain-on-exit off). On 4 October 2026 the user ended the tmux server
// while Taskboard ran. Taskboard kept an in-memory flag that said "configured", so the next tmux server kept the
// defaults, and every console showed a green status bar. Now the tmux server itself carries the state: after the
// options are set, the user option MARK holds SETTINGS_VERSION. A tmux server without that value gets the options again.
//
// Each function takes run(args): it runs `tmux -L <socket> <args...>` and returns stdout, or throws when tmux fails.
// Applying twice gives the same result: set-option replaces a value, and the terminal-features entries are only
// appended when they are missing. The bell hook holds the Taskboard token: no function here prints or returns it.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MARK = '@tb-configured';

// [set-option flags, option, value]. escape-time 0 keeps Esc instant (Claude Code and Codex use Esc to interrupt).
// window-size latest lets the most recently active client decide the size when several windows attach.
// Mouse wheel: programs that ask for mouse events (Claude Code's full-screen view) scroll themselves; otherwise
// tmux scrolls its own history. A drag selection is copied to the browser clipboard through OSC 52.
export const OPTIONS = [
  ['-g', 'escape-time', '0'],
  ['-g', 'history-limit', '5000'],
  ['-g', 'status', 'off'],
  ['-g', 'window-size', 'latest'],
  ['-g', 'extended-keys', 'on'],
  ['-g', 'focus-events', 'on'],
  ['-g', 'default-terminal', 'tmux-256color'],
  ['-g', 'mouse', 'on'],
  ['-g', 'set-clipboard', 'on'],
  ['-g', 'remain-on-exit', 'on'],
  ['-gw', 'monitor-bell', 'on'],
  ['-g', 'bell-action', 'any'],
  ['-g', 'visual-bell', 'off'],
];
// entries of the server option terminal-features (an array)
export const TERMINAL_FEATURES = ['xterm*:extkeys:RGB', 'xterm*:clipboard'];

// Mouse selection for programs that do not read the mouse themselves (Codex; Claude Code handles its own):
// tmux's defaults copy into its own buffer and drop the highlight the moment the mouse is released. These bindings
// keep the selection highlighted and copy it to the macOS clipboard (pbcopy). A click clears the highlight without
// leaving copy mode, so a drag can select older text. Esc leaves copy mode.
// A click that moves a few pixels is a drag and puts the pane in copy mode, where typed keys are copy-mode commands.
// So typing leaves copy mode: each printable key (and Space, Enter, BSpace, Tab) cancels it and goes on to the program.
// Written to a file and loaded with source-file because the nested commands do not pass well as arguments.
const keyArg = (k) => k === "'" ? `"'"` : `'${k}'`;
const TYPED = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)); // ! through ~
export const COPY_BINDINGS = `
bind -T root DoubleClick1Pane select-pane -t = \\; if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send -M } { copy-mode -H ; send -X select-word ; send -X copy-pipe-no-clear "pbcopy" }
bind -T root TripleClick1Pane select-pane -t = \\; if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send -M } { copy-mode -H ; send -X select-line ; send -X copy-pipe-no-clear "pbcopy" }
${['copy-mode', 'copy-mode-vi'].map(t => `
bind -T ${t} MouseDragEnd1Pane send -X copy-pipe-no-clear "pbcopy"
bind -T ${t} DoubleClick1Pane select-pane \\; send -X select-word \\; send -X copy-pipe-no-clear "pbcopy"
bind -T ${t} TripleClick1Pane select-pane \\; send -X select-line \\; send -X copy-pipe-no-clear "pbcopy"
bind -T ${t} MouseDown1Pane select-pane \\; send -X clear-selection
bind -T ${t} Escape send -X cancel
${TYPED.map(k => `bind -T ${t} ${keyArg(k)} { send -X cancel ; send -l ${keyArg(k)} }`).join('\n')}
${['Space', 'Enter', 'BSpace', 'Tab'].map(k => `bind -T ${t} ${k} { send -X cancel ; send ${k} }`).join('\n')}`).join('')}
`;

const HOOK_PATH = '/api/hooks/bell';
// The alert-bell hook posts the bell to the Taskboard server at urlBase with the token.
export const bellHook = (token, urlBase) =>
  `run-shell -b "curl -s -m 3 -X POST -H 'x-taskboard-token: ${token}' '${urlBase}${HOOK_PATH}?session=#{session_name}' >/dev/null 2>&1"`;

// Changes when the list above changes, so a tmux server configured by an older Taskboard is configured again.
// The token and the port are not part of it: compareSettings checks the hook itself.
export const SETTINGS_VERSION = createHash('sha256')
  .update(JSON.stringify([OPTIONS, TERMINAL_FEATURES, COPY_BINDINGS, bellHook('TOKEN', 'URL')])).digest('hex').slice(0, 12);

const quiet = async (run, args) => { try { return await run(args); } catch { return null; } };

// The value of MARK on the tmux server: null when no tmux server runs or tmux did not answer, '' when it is not set.
export const readMark = async (run) => {
  const v = await quiet(run, ['show-options', '-gqv', MARK]);
  return v === null ? null : v.trim();
};

// The names of the settings whose live value differs from the expected value. [] means all match.
// null means no tmux server runs (or tmux did not answer). The names never include the token.
export async function compareSettings(run, token, urlBase) {
  if (await readMark(run) === null) return null;
  const differ = [];
  for (const [flags, name, value] of OPTIONS) {
    const v = await quiet(run, ['show-options', `${flags}qv`, name]);
    if (v === null || v.trim() !== value) differ.push(name);
  }
  const features = (await quiet(run, ['show-options', '-sv', 'terminal-features'])) || '';
  for (const f of TERMINAL_FEATURES) if (!features.split('\n').includes(f)) differ.push(`terminal-features ${f}`);
  const hooks = (await quiet(run, ['show-hooks', '-g', 'alert-bell'])) || '';
  if (!hooks.includes(`x-taskboard-token: ${token}`) || !hooks.includes(`${urlBase}${HOOK_PATH}`)) differ.push('alert-bell hook');
  // tmux 3.7c prints nothing for list-keys with a key name, so the whole table is read
  const keys = (await quiet(run, ['list-keys', '-T', 'copy-mode'])) || '';
  if (!/MouseDragEnd1Pane\s+send-keys -X copy-pipe-no-clear/.test(keys)) differ.push('copy-mode bindings');
  if ((await readMark(run)) !== SETTINGS_VERSION) differ.push(MARK);
  return differ;
}

// Sets every option, the hook and the bindings, and MARK last: a tmux server whose configuration stopped half way
// has no MARK and is configured again. bindingsFile is the file that the bindings are written to for source-file.
export async function applySettings(run, token, urlBase, bindingsFile) {
  for (const [flags, name, value] of OPTIONS) await quiet(run, ['set-option', flags, name, value]);
  const features = (await quiet(run, ['show-options', '-sv', 'terminal-features'])) || '';
  for (const f of TERMINAL_FEATURES) if (!features.split('\n').includes(f)) await quiet(run, ['set-option', '-as', 'terminal-features', f]);
  await quiet(run, ['set-hook', '-g', 'alert-bell', bellHook(token, urlBase)]);
  await loadBindings(run, bindingsFile);
  await quiet(run, ['set-option', '-g', MARK, SETTINGS_VERSION]);
}

export async function loadBindings(run, bindingsFile) {
  writeFileSync(bindingsFile, COPY_BINDINGS);
  await quiet(run, ['source-file', bindingsFile]);
}

export const bindingsFileIn = (tbDir) => join(tbDir, 'tmux-copy.conf');
