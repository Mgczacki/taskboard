import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore, type Message } from '../server/mail/store.ts';
import { MailService, PREFIX, CONTACT_PREFIX, decodeContact } from '../server/mail/service.ts';
import { SlackClient, SLACK_APP_ID } from '../server/mail/slack.ts';

const root = mkdtempSync(join(tmpdir(), 'tb-mail-tests-'));
const review = { verdict: 'communication' as const, reason: 'Ordinary information', at: new Date().toISOString() };
const draft = (store: MailStore) => store.add({ direction: 'outbox', source: 'user', from: 'U1', to: 'U2', subject: 'Status', body: 'The document is ready.' });

test('outbox keeps the recorded proposer after a store reload', () => {
  const s = new MailStore(join(root, 'proposer.json'));
  const m = s.add({ direction: 'outbox', source: 'user', from: 'U1', to: 'U2', subject: 'Status', body: 'Ready.', proposedBy: { actor: 'controller' } });
  assert.deepEqual(new MailStore(s.file).get(m.id).proposedBy, { actor: 'controller' });
});

test('approval requires exact content and review, and controller delegation is explicit', () => {
  const s = new MailStore(join(root, 'approval.json')); const m = draft(s);
  assert.throws(() => s.approve(m.id, 'user', m.hash), /review/);
  s.update(m.id, x => { x.review = review; });
  assert.throws(() => s.approve(m.id, 'user', 'stale'), /changed/);
  assert.throws(() => s.approve(m.id, 'controller', m.hash), /human/);
  s.change(d => { d.controllerApproval = true; });
  s.approve(m.id, 'controller', m.hash);
  s.update(m.id, x => { x.review = { ...review, verdict: 'action-request' }; delete x.approval; });
  assert.throws(() => s.approve(m.id, 'controller', m.hash), /human/);
  s.approve(m.id, 'user', m.hash);
  s.update(m.id, x => { x.review = { ...review, verdict: 'quarantine' }; delete x.approval; });
  assert.throws(() => s.approve(m.id, 'user', m.hash), /Quarantined/);
  s.update(m.id, x => { x.review = review; x.dismissedAt = 'now'; });
  assert.throws(() => s.approve(m.id, 'user', m.hash), /Restore/);
});

test('Slack import uses provider identity, ignores other text, and does not duplicate deliveries', async () => {
  const s = new MailStore(join(root, 'import.json'));
  s.change(d => { d.contacts.push({ user: 'U2', name: 'Other user', channel: 'D1', oldest: '0', status: 'active' }); });
  const event = { ts: '1', user: 'U2', bot_id: 'B_TASKBOARD', app_id: SLACK_APP_ID, text: PREFIX + JSON.stringify({ id: 'one', subject: 'Hello', body: 'Ordinary text', from: 'Uadmin' }) };
  const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async () => ({ messages: [event, { ...event, ts: '2', user: 'U3' }, { ...event, ts: '3', text: 'Ordinary Slack text' }, { ...event, ts: '4', app_id: 'A_OTHER_APP' }] }) } as unknown as SlackClient;
  const service = new MailService(s, slack); await service.sync(); await service.sync();
  assert.equal(s.read().messages.length, 1);
  assert.equal(s.read().messages[0].from, 'U2');
  assert.equal(s.read().messages[0].approval, undefined);
  assert.deepEqual(s.read().messages[0].routes, []);
});

test('outbox never sends before approval and holds uncertain delivery without replay', async () => {
  const s = new MailStore(join(root, 'send.json')); const m = draft(s);
  s.change(d => { d.contacts.push({ user: 'U2', name: 'Other user', channel: 'D1', oldest: '0', status: 'active' }); });
  let sends = 0;
  const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async () => { sends++; throw new Error('network lost'); } } as unknown as SlackClient;
  const service = new MailService(s, slack);
  await assert.rejects(service.send(m.id), /Approve/); assert.equal(sends, 0);
  s.update(m.id, x => { x.review = review; }); s.approve(m.id, 'user', m.hash);
  await assert.rejects(service.send(m.id), /uncertain/); assert.equal(sends, 1);
  await assert.rejects(service.send(m.id), /uncertain/); assert.equal(sends, 1);
  assert.equal(s.get(m.id).sentAt, undefined);
  assert.ok(s.get(m.id).sendStartedAt);
});

test('OAuth rejects a mismatched state before exchanging a code', async () => {
  let calls = 0;
  const client = new SlackClient(join(root, 'oauth.json'), (async () => { calls++; throw new Error('unexpected network call'); }) as typeof fetch);
  client.begin(4399);
  await assert.rejects(client.finish('wrong', 'code'), /expired/); assert.equal(calls, 0);
});

test.after(() => rmSync(root, { recursive: true, force: true }));

test('an interrupted history read resumes without losing or duplicating messages', async () => {
 const s=new MailStore(join(root,'history-recovery.json'));
 s.change(d=>{d.contacts.push({user:'U2',name:'Contact',channel:'D1',oldest:'0',status:'active'});});
 let offline=true;
 const event=(ts:string)=>({user:'U2',ts,text:PREFIX+JSON.stringify({id:'test-'+ts,subject:'Status',body:'Ready.'})});
 const slack={identity:()=>({user:'U1',team:'T1'}),call:async (method:string,params:Record<string,string>)=>{
  if(method==='conversations.list')return {channels:[]};
  if(!params.cursor)return {messages:[event('2')],has_more:true,response_metadata:{next_cursor:'page-two'}};
  if(offline)throw new Error('offline');
  return {messages:[event('1')],has_more:false};
 }} as unknown as SlackClient;
 await assert.rejects(new MailService(s,slack).sync(),/offline/);
 assert.equal(s.read().contacts[0].oldest,'0');assert.equal(s.read().messages.length,1);
 offline=false;
 const restartedStore=new MailStore(s.file);
 await new MailService(restartedStore,slack).sync();
 assert.equal(restartedStore.read().messages.length,2);
 assert.notEqual(restartedStore.read().contacts[0].oldest,'0');
 assert.ok(restartedStore.read().messages.every(m=>!m.approval&&m.routes.length===0));
});

test('contact requests need the other member to accept before messages flow', async () => {
 const s = new MailStore(join(root, 'contacts.json'));
 let acceptance = false;
 let requestText = '', requestBlocks = '';
 const slack = {identity:()=>({user:'U1',team:'T1'}),call:async (method:string, args?:Record<string,string>)=>{
  if(method==='users.info')return {user:{id:'U2',team_id:'T1',real_name:'Other'}};
  if(method==='conversations.open')return {channel:{id:'D1'}};
  if(method==='chat.postMessage'){requestText=args?.text||'';requestBlocks=args?.blocks||'';return {ts:'1'};}
  if(method==='conversations.list')return {channels:[{id:'D1',user:'U2'}]};
  if(method==='conversations.history')return {messages:acceptance?[{user:'U2',ts:'2',text:CONTACT_PREFIX+JSON.stringify({type:'accept',id:s.read().contacts[0].requestId})}]:[]};
  return {};
 }} as unknown as SlackClient;
 const service = new MailService(s,slack);
 await service.requestContact('U2');
 assert.equal(decodeContact(requestText)?.type,'request');
 assert.equal(JSON.parse(requestBlocks)[0].text.text,'Taskboard contact request. Open Taskboard Inbox to respond.');
 assert.equal(s.read().contacts[0].status,'requested');
 const m=draft(s);s.update(m.id,x=>{x.review=review;});s.approve(m.id,'user',m.hash);
 await assert.rejects(service.send(m.id),/accept/);
 acceptance=true;await service.sync();
 assert.equal(s.read().contacts[0].status,'active');
 assert.ok(Number(s.read().contacts[0].oldest)>=2);
});

test('contact scan limits Slack history calls and skips an unreadable conversation', async () => {
 const s = new MailStore(join(root, 'contact-scan.json'));
 const channels = Array.from({ length: 30 }, (_, i) => ({ id: `D${i}`, user: `U${i + 2}` }));
 let histories = 0;
 const slack = { identity: () => ({ user: 'U1', team: 'T1' }), call: async (method: string, args?: Record<string, string>) => {
  if (method === 'conversations.list') return { channels };
  if (method === 'conversations.history') {
   histories++;
   if (args?.channel === 'D0') throw new Error('Slack: channel_not_found');
   return { messages: args?.channel === 'D1' ? [{ user: 'U3', ts: '2', text: CONTACT_PREFIX + JSON.stringify({ type: 'request', id: '00000000-0000-0000-0000-000000000001' }) }] : [] };
  }
  if (method === 'users.info') return { user: { id: 'U3', team_id: 'T1', real_name: 'Requester' } };
  return {};
 } } as unknown as SlackClient;
 const service = new MailService(s, slack);
 await service.sync();
 assert.equal(histories, 25);
 assert.equal(Object.keys(s.read().requestCursors || {}).length, 25);
 assert.equal(s.read().requests?.[0].name, 'Requester');
 await service.sync();
 assert.equal(histories, 25);
 (service as any).lastRequestScanAt = 0;
 await service.sync();
 assert.equal(Object.keys(s.read().requestCursors || {}).length, 30);
});
