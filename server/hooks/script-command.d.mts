export function commandWords(source: string): { commands: string[][]; hasInputOperator: boolean; inputCommands: { words: string[]; body?: string }[] };
export function commandCalls(source: string): string[][];
export function gitOperation(words: string[]): { sub: string | undefined; args: string[] };
export function gitReadOnly(words: string[]): boolean;
export function runsScript(words: string[], script: string): boolean;
export function runsShellScript(source: string, script: string): boolean;
export function productionWrite(words: string[]): boolean;
export function pathArguments(words: string[]): string[];
export function runsServerStop(source: string, tbDir: string): boolean;
