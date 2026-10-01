// The browsers and processes of the tasks in one Canvas view. A group owns no browser and no process: each row is an
// item of one task and names that task. A click on a row opens the owning task. Stop acts on that one item.
// When a task leaves the group, the next read leaves its items out. Deleting a group stops nothing.
import type { Group, Task } from '../api';
import { useStore } from '../api';
import { RuntimeList, canRun, type RuntimeTab } from './TaskRuntime';
import { countText, sumCounts } from '../runtimeText';

export function GroupRuntime({ tasks, group, onOpen }: { tasks: Task[]; group?: Group; onOpen: (taskId: string, tab: RuntimeTab) => void }) {
  const counts = useStore().runtime;
  const local = tasks.filter(canRun);
  const now = countText(sumCounts(counts, local.map(t => t.id)));
  return (
    <div className="grt">
      <div className="grt-head">
        <b>{group ? `Browsers and processes of the tasks in “${group.name}”` : 'Browsers and processes of the tasks in this view'}</b>
        <span className="sub">{local.length} {local.length === 1 ? 'task' : 'tasks'}{now ? '' : ' · nothing running'}{group ? '. Each task owns its own items. Deleting the group stops nothing.' : ''}</span>
      </div>
      {local.length ? <RuntimeList tasks={local} showOwner onOpen={onOpen} pictures />
        : <div className="sub">No tasks on this machine in this view.</div>}
    </div>
  );
}
