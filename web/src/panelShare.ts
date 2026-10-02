// Which parts of a task the open task panel holds, so its Canvas window does not show them a second time.
// A tmux window has one size, so the panel and the window do not both attach a terminal to one task. A task browser
// streams to one view at a time, so they do not both show it either. TaskPanel mounts the terminal only on its Terminal
// tab and the browser only on its Browser tab, so the panel holds a part only while that tab is in front.
export type PanelTab = 'terminal' | 'log' | 'docs' | 'browser' | 'procs';

export function panelHolds(taskId: string, panelTaskId: string | null | undefined, panelTab: PanelTab | undefined): { terminal: boolean; browser: boolean } {
  const open = !!panelTaskId && panelTaskId === taskId;
  const tab = panelTab || 'terminal';
  return { terminal: open && tab === 'terminal', browser: open && tab === 'browser' };
}
