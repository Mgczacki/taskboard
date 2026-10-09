import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentCard } from '../server/a2anotes/card-view.ts';

test('generic incoming cards cannot disclose text before acceptance or after approval revocation', () => {
  const privateText = 'Private message text';
  for (const state of ['pending', 'approved', 'failed']) {
    const card = { id: 'card', action: 'mail-in', state, summary: privateText, detail: privateText,
      payload: { message: 'message', hash: 'hash', stage: 'incoming', direction: 'in', audience: 'person',
        body: privateText, subject: privateText, quality: { flags: [{ text: privateText }] }, files: [privateText] } } as any;
    const view = agentCard(card);
    assert.equal(JSON.stringify(view).includes(privateText), false);
    assert.equal((view.payload as any).message, 'message');
    assert.equal(view.state, state);
    assert.equal(card.payload.body, privateText, 'the dashboard card keeps its text');
  }
});

test('outgoing drafts and other approval kinds keep their existing views', () => {
  for (const action of ['mail-out', 'git-merge', 'permit']) {
    const card = { action, detail: 'The exact action' } as any;
    assert.equal(agentCard(card), card);
  }
});
