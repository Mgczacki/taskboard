import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseSlackWorkspace, DEFAULT_SLACK_TEAM_ID} from '../server/a2anotes/slack-app.ts';
test('workspace selection uses saved settings, environment, then the default', () => {
  assert.equal(chooseSlackWorkspace({},{}).teamId,DEFAULT_SLACK_TEAM_ID);
  assert.equal(chooseSlackWorkspace({}, {TASKBOARD_A2A_SLACK_TEAM_ID:'TOTHER01'}).teamId,'TOTHER01');
  assert.equal(chooseSlackWorkspace({slackTeamId:'TSAVED01'}, {TASKBOARD_A2A_SLACK_TEAM_ID:'TOTHER01'}).teamId,'TSAVED01');
  assert.throws(()=>chooseSlackWorkspace({slackTeamId:'not-a-team'},{}),/workspace ID/);
});
