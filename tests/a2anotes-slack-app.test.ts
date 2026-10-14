import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseSlackWorkspace, DEFAULT_SLACK_TEAM_ID} from '../server/a2anotes/slack-app.ts';
import {slackAppConfig} from '../server/a2anotes/setup.ts';
test('workspace selection uses saved settings, environment, then the default', () => {
  assert.equal(chooseSlackWorkspace({},{}).teamId,DEFAULT_SLACK_TEAM_ID);
  assert.equal(chooseSlackWorkspace({}, {TASKBOARD_A2A_SLACK_TEAM_ID:'TOTHER01'}).teamId,'TOTHER01');
  assert.equal(chooseSlackWorkspace({slackTeamId:'TSAVED01'}, {TASKBOARD_A2A_SLACK_TEAM_ID:'TOTHER01'}).teamId,'TSAVED01');
  assert.throws(()=>chooseSlackWorkspace({slackTeamId:'not-a-team'},{}),/workspace ID/);
});
test('app migration and endpoint changes preserve explicit native posting and content checks',()=>{
  const config={port:4460,slack:{teamId:'TOLD01',clientId:'old-app',redirectUri:'http://localhost/callback',acknowledgementEmoji:'white_check_mark'},
    desktop:{url:'http://127.0.0.1:19322',enabled:true,send:true},reviewCommand:['review'],bodyCheckCommand:['body-check']};
  const next=slackAppConfig(config,'TNEW01','http://127.0.0.1:19323');
  assert.deepEqual(next.desktop,{url:'http://127.0.0.1:19323',send:true});
  assert.deepEqual(next.slack,{teamId:'TNEW01',desktopUrl:'http://127.0.0.1:19323',acknowledgementEmoji:'white_check_mark'});
  assert.deepEqual(next.reviewCommand,config.reviewCommand);assert.deepEqual(next.bodyCheckCommand,config.bodyCheckCommand);
  assert.equal(slackAppConfig({...config,desktop:{send:false}},'TNEW01','http://127.0.0.1:19323').desktop.send,false);
  assert.equal(slackAppConfig({...config,desktop:{enabled:false}},'TNEW01','http://127.0.0.1:19323').desktop,undefined);
  assert.throws(()=>slackAppConfig({...config,desktop:{send:'true'}},'TNEW01','http://127.0.0.1:19323'),/boolean/);
});
