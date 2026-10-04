// Types for scripts/cwd-check.mjs, which the server imports (server/tmux-health.ts).
export interface FileEntry { pid: number; command: string; fd: string; inode?: number; path: string }
export type Exec = (cmd: string, args: string[]) => Promise<string>;
export interface TmuxServerFolder { pid: number; cwd: string | null; deleted: boolean }
export const STABLE_DIR: string;
export function parseLsof(text: string): FileEntry[];
export function processFolders(exec?: Exec): Promise<FileEntry[] | null>;
export function releasesInUse(files: FileEntry[], root: string): Map<string, { pid: number; command: string; fd: string }[]>;
export function planPrune(o: { ids: string[]; current?: string; previous?: string; newest?: number; inUse: Map<string, { pid: number; command: string; fd: string }[]> | null }): { keep: { id: string; reasons: string[] }[]; remove: string[] };
export function cwdOf(pid: number, exec?: Exec): Promise<{ path: string; deleted: boolean } | null>;
export function tmuxServerFolder(socket: string, tmuxBin?: string, exec?: Exec): Promise<TmuxServerFolder | null>;
export function tmuxRestartCommand(socket: string, tmuxBin?: string): string;
export function tmuxFolderProblem(s: TmuxServerFolder | null, socket: string, tmuxBin?: string): string | null;
