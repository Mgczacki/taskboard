import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SlackClient, SLACK_TEAM_ID, SLACK_SCOPES } from '../server/mail/slack.ts';
import { savePrivate } from '../server/mail/store.ts';
const root = mkdtempSync(join(tmpdir(), 'mail-refresh-'));
const credentials = {user:'U1', team:SLACK_TEAM_ID, access:'old-access', refresh:'old-refresh', expires:0};
const ok = (data: object) => new Response(JSON.stringify({ok:true,...data}), {status:200});

test('concurrent calls rotate once, persist new credentials, and survive a new client', async () => {
  const file=join(root,'refresh.json'); savePrivate(file,credentials);
  let refreshes=0, requests=0;
  const fetcher: typeof fetch=async (url, init) => {
    if(String(url).endsWith('/oauth.v2.access')) {
      refreshes++; assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'),'old-refresh');
      await new Promise(r=>setTimeout(r,20));
      return ok({access_token:'new-access',refresh_token:'new-refresh',expires_in:43200});
    }
    requests++; assert.equal((init?.headers as Record<string,string>).authorization,'Bearer new-access');
    return ok({user_id:'U1'});
  };
  const client=new SlackClient(file,fetcher);
  await Promise.all([client.call('auth.test'),client.call('auth.test')]);
  await new SlackClient(file,fetcher).call('auth.test');
  assert.equal(refreshes,1); assert.equal(requests,3);
  const saved=JSON.parse(readFileSync(file,'utf8')); assert.equal(saved.refresh,'new-refresh'); assert.ok(saved.expires>Date.now());
  assert.equal(statSync(file).mode & 0o777,0o600);
});

test('failed refresh preserves credentials and later recovers', async () => {
 const file=join(root,'retry.json'); savePrivate(file,credentials); let fail=true, calls=0;
 const client=new SlackClient(file,async url=> {
  if(String(url).endsWith('/oauth.v2.access')) {if(fail) throw new TypeError('offline'); return ok({access_token:'fresh',refresh_token:'rotated',expires_in:43200});}
  calls++; return ok({});
 });
 await assert.rejects(client.call('auth.test'),/offline/); assert.equal(calls,0);
 assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),credentials);
 fail=false; await client.call('auth.test'); assert.equal(calls,1);
});

test('disconnect during refresh cannot restore credentials or send a request', async () => {
 const file=join(root,'disconnect.json'); savePrivate(file,credentials);
 let release!:()=>void; const gate=new Promise<void>(r=>release=r); let entered!:()=>void; const started=new Promise<void>(r=>entered=r);
 const client=new SlackClient(file,async url=> {
  assert.ok(String(url).endsWith('/oauth.v2.access')); entered(); await gate;
  return ok({access_token:'fresh',refresh_token:'rotated',expires_in:43200});
 });
 const work=client.call('auth.test'); await started; client.disconnect(); release();
 await assert.rejects(work,/disconnected/); assert.equal(existsSync(file),false);
});

test('rate limits stop requests until Retry-After expires', async () => {
 const file=join(root,'rate.json'); savePrivate(file,{...credentials,expires:Date.now()+3600000});
 let calls=0; const client=new SlackClient(file,async ()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'1'}});});
 await assert.rejects(client.call('auth.test'),/rate limit/);
 await assert.rejects(client.call('auth.test'),/rate limit/); assert.equal(calls,1);
 await new Promise(r=>setTimeout(r,1050));
 await assert.rejects(client.call('auth.test'),/rate limit/); assert.equal(calls,2);
});

test('new sign-in recovers from an invalid refresh token without an app secret', async () => {
 const file=join(root,'reauth.json'); savePrivate(file,credentials);
 const client=new SlackClient(file,async (_url,init)=> {
  const params=new URLSearchParams(String(init?.body)); assert.equal(params.has('client_secret'),false);
  if(params.get('grant_type')==='refresh_token') return new Response(JSON.stringify({ok:false,error:'invalid_refresh_token'}));
  assert.ok(params.get('code_verifier'));
  return ok({team:{id:SLACK_TEAM_ID},authed_user:{id:'U1',access_token:'new',refresh_token:'refresh',expires_in:43200,scope:SLACK_SCOPES.join(',')}});
 });
 await assert.rejects(client.call('auth.test'),/invalid_refresh_token/);
 const url=new URL(client.begin(4409)); await client.finish(url.searchParams.get('state')!,'new-code');
 assert.equal(JSON.parse(readFileSync(file,'utf8')).access,'new');
});
test.after(()=>rmSync(root,{recursive:true,force:true}));
