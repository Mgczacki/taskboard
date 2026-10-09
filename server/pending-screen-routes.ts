import type express from 'express';
import * as pending from './pending.ts';

// Screen actions come from the dashboard. They never enqueue text for a later turn.
export function mountPendingScreenRoutes(app: express.Express, io: {
  originOk: (origin?: string) => boolean;
  replyStatus: (taskId: string, id: string) => unknown;
}) {
  const dashboard = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const origin = req.get('origin');
    if (!origin || !io.originOk(origin) || req.get('x-tb-actor') || req.get('x-taskboard-token'))
      return res.status(403).json({ error: 'Use the notification card on the Taskboard dashboard.' });
    next();
  };
  const fail = (res: express.Response, e: unknown) => res.status(e instanceof pending.AnswerError ? e.status : 400)
    .json({ error: e instanceof Error ? e.message : String(e) });
  app.post('/api/pending/:id/hide', dashboard, (req, res) => {
    try { pending.hide(String(req.params.id)); res.json({}); } catch (e) { fail(res, e); }
  });
  app.post('/api/pending/:id/inspect', dashboard, async (req, res) => {
    try { res.json(await pending.inspect(String(req.params.id))); } catch (e) { fail(res, e); }
  });
  // Same-origin GET requests omit Origin. Use POST to read receipts from older clients.
  app.post('/api/pending/:id/reply/status', dashboard, (req, res) => {
    const item = pending.get(String(req.params.id));
    if (!item || item.agent !== 'codex' || item.kind !== 'unknown' || item.source !== 'screen')
      return res.status(404).json({ error: 'This Unknown prompt card does not exist.' });
    res.json(io.replyStatus(item.taskId, item.id));
  });
  // Refuse old clients that would queue a follow-up behind the question.
  app.post('/api/pending/:id/reply', dashboard, (_req, res) => {
    res.status(409).json({ error: 'This text cannot answer an unparsed screen question. Read question on the current card, or open terminal and press Shift+Left. Taskboard queued nothing.' });
  });
}
