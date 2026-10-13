import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SlackTransport, NotesService, Store, type AppConnection, type AppSnapshot} from 'a2a-notes';

test('the bundled app transport accepts an owner request and confirms receipt without API credentials', async () => {
  const dir=mkdtempSync(join(tmpdir(),'tb-app-transport-'));
  writeFileSync(join(dir,'slack-credentials.json'),'invalid old credentials that must stay unread');
  const s:AppSnapshot={team:'TEXAMPLE',user:'UMARIO01',channel:'DSELF01',peers:[{id:'DSELF01',user:'UMARIO01'}],people:[{id:'UMARIO01',name:'Mario',realName:'Mario',title:'',active:true}],editor:true,draft:'',messages:[{channel:'DSELF01',user:'UMARIO01',text:'A2A #7\nPlease read the report.',ts:'1791936000.001',reactions:[]}]};
  let posts=0, reactions=0;
  const app:AppConnection={async snapshot(){return structuredClone(s);},async navigate(){},async compose(){},async submit(){posts++;},async react(ts,name){assert.equal(ts,s.messages[0].ts);s.messages[0].reactions.push({name,users:[s.user]});reactions++;},async close(){}};
  const transport=new SlackTransport(join(dir,'account.json'),{teamId:s.team},undefined,{open:async()=>app});
  await transport.connect(); assert.equal(transport.fileField,'Slack');
  const service=new NotesService({store:new Store(dir),transport,scanIntervalMs:0,retryIntervalMs:0});
  await service.scanNow(); await service.scanNow();
  const notes=service.list({name:'person',role:'person'},{direction:'incoming'}).messages;
  assert.equal(notes.length,1); assert.equal(notes[0].owner_message,true); assert.equal(notes[0].acknowledgement?.status,'confirmed');
  assert.equal(reactions,1); assert.equal(posts,0); await service.stop();
});
