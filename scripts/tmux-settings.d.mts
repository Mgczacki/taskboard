// Types for scripts/tmux-settings.mjs, which the server imports (server/tmux.ts).
export type Run = (args: string[]) => Promise<string>;
export const MARK: string;
export const OPTIONS: [string, string, string][];
export const TERMINAL_FEATURES: string[];
export const COPY_BINDINGS: string;
export const SETTINGS_VERSION: string;
export function bellHook(token: string, urlBase: string): string;
export function readMark(run: Run): Promise<string | null>;
export function compareSettings(run: Run, token: string, urlBase: string): Promise<string[] | null>;
export function applySettings(run: Run, token: string, urlBase: string, bindingsFile: string): Promise<void>;
export function loadBindings(run: Run, bindingsFile: string): Promise<void>;
export function bindingsFileIn(tbDir: string): string;
