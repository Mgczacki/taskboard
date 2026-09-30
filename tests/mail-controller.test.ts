import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

test('controller launches and restarts with mailbox access, ordinary task does not', async () => {
 const root=mkdtempSync(join(tmpdir(),'tb-mail-controller-'));
 const app=express(); app.use(express.json());
 const server=app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.once('listening',r));
 process.env.TASKBOARD_PORT=String((server.address() as {port:number}).port);
 process.env.TASKBOARD_DIR=join(root,'server'); process.env.TASKBOARD_VAULT=join(root,'vault');
 process.env.CLAUDE_CONFIG_DIR=join(root,'claude'); mkdirSync(process.env.CLAUDE_CONFIG_DIR,{recursive:true});
 process.env.TASKBOARD_TMUX_SOCKET='tbmail-fixture-'+process.pid;
 const bin=join(root,'bin');mkdirSync(bin,{recursive:true});
 const cli=resolve('bin/tb');
 // This program replaces the agent CLI. It makes no model calls.
 writeFileSync(join(bin,'claude'), `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');
const expected=fs.readFileSync(path.join(path.dirname(process.env.TB_TOKEN_FILE),'mail-controller.token'),'utf8').trim();
cp.execFile(process.execPath,[${JSON.stringify(cli)},'mail','list'],{env:process.env},(error,stdout)=>{
const record={task:process.env.TASK_ID,hasToken:!!process.env.TB_MAIL_CONTROLLER_TOKEN,matches:process.env.TB_MAIL_CONTROLLER_TOKEN===expected,allowed:!error,args:process.argv.slice(2)};
fs.appendFileSync(path.join(process.env.TASKBOARD_VAULT,'probe.jsonl'),JSON.stringify(record)+'\\n');
});
setInterval(()=>{},1000);
`,{mode:0o700});
 process.env.PATH=bin+':'+process.env.PATH;
 mkdirSync(join(root,'server'),{recursive:true});
 writeFileSync(join(root,'server','machine.json'),JSON.stringify({controller:{autostart:false,remoteControl:false},permissions:{trustWorkspaces:false}}));
 const {mountMail}=await import('../server/mail/routes.ts');const stop=mountMail(app,{background:false});
 const agents=await import('../server/agents.ts');const tasks=await import('../server/store.ts');const tmux=await import('../server/tmux.ts');
 const records=()=>existsSync(join(root,'vault','probe.jsonl'))?readFileSync(join(root,'vault','probe.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)):[];
 const withoutArgs=(r:Record<string,unknown>)=>{const {args,...rest}=r;return rest;};
 const waitFor=async (count:number)=>{for(let i=0;i<100;i++){if(records().length>=count)return;await new Promise(r=>setTimeout(r,100));}throw new Error('Fixture did not finish');};
 try {
  agents.writeClaudeSettings();
  const first=await agents.startController();await waitFor(1);
  assert.deepEqual(records()[0].args.slice(records()[0].args.indexOf('--model'),records()[0].args.indexOf('--model')+2),['--model','claude-sonnet-5-5']);
  assert.ok(records()[0].args.includes('--dangerously-skip-permissions'));
  assert.ok(!records()[0].args.includes('--permission-mode'));
  assert.deepEqual(withoutArgs(records()[0]),{task:'controller',hasToken:true,matches:true,allowed:true});
  const key=JSON.parse(agents.controllerLaunchKey('claude'));assert.equal(key.mail,1);
  assert.equal(key.model,'claude-sonnet-5-5');
  const old={...key};delete old.mail;assert.notEqual(JSON.stringify(old),first.launchedAs);
  const machine=await import('../server/machine.ts');
  machine.update({controllerModels:{claude:'claude-sonnet-5'}});
  assert.notEqual(agents.controllerLaunchKey('claude'),first.launchedAs);
  await tmux.killSession(first.session);
  await agents.startController();await waitFor(2);
  assert.deepEqual(records()[1].args.slice(records()[1].args.indexOf('--model'),records()[1].args.indexOf('--model')+2),['--model','claude-sonnet-5']);
  assert.deepEqual(withoutArgs(records()[1]),withoutArgs(records()[0]));
  machine.update({dangerouslySkipPermissions:false});
  assert.notEqual(agents.controllerLaunchKey('claude'),tasks.get('controller')?.launchedAs);
  await tmux.killSession(first.session);
  await agents.startController();await waitFor(3);
  assert.ok(!records()[2].args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(records()[2].args.slice(records()[2].args.indexOf('--permission-mode'),records()[2].args.indexOf('--permission-mode')+2),['--permission-mode','auto']);
  const task=tasks.create({id:'ordinary',num:1,title:'Fixture',agent:'claude',status:'idle',cwd:root,folder:root,session:'ordinary',sessionId:randomUUID(),desc:''});
  await agents.resumeTask(task);await waitFor(4);
  assert.ok(!records()[3].args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(withoutArgs(records()[3]),{task:'ordinary',hasToken:false,matches:false,allowed:false});
 } finally {
  await tmux.killSession('ordinary');await tmux.killSession('tb-controller');
  stop();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});
 }
});
