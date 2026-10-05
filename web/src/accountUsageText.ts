import { fmtWait } from './api';
import type { Account } from './components/Accounts';

const dataAge = (a: Account) => fmtWait(Math.round((Date.now() - Date.parse(a.usage?.at || '')) / 60000));
export const usageText = (a: Account) => a.usage && a.usageStale ? `usage unknown (data ${dataAge(a)} old)`
  : (a.usage?.windows || []).filter(w => !w.resetsAt || w.resetsAt > Date.now()).map(w => `${w.label} ${w.usedPct}%`).join(' · ');
