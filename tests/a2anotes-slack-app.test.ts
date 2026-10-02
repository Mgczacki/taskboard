// The Slack app of A2A Notes (server/a2anotes/slack-app.ts): the default, the overrides, the sign-in help, and the
// manifest files in integrations/slack that document the apps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'tb-a2a-slack-app-'));
process.env.TASKBOARD_DIR = join(root, 'server'); process.env.TASKBOARD_VAULT = join(root, 'vault');
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
const app = await import('../server/a2anotes/slack-app.ts');
const setup = await import('../server/a2anotes/setup.ts');
const machine = await import('../server/machine.ts');

const A2A = '8696283833057.12198817279122', TASKBOARD = '8696283833057.12177743257233';
const manifest = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'integrations', 'slack', name), 'utf8'));
// the user scopes that A2A Notes asks for at sign-in (a2a-notes src/slack.ts REQUIRED_SCOPES and OPTIONAL_SCOPES)
const SCOPES = ['chat:write', 'im:write', 'im:read', 'im:history', 'users:read', 'users:read.email', 'files:read', 'files:write'];

test('the default Slack app is the separate A2A Notes app in the Sekai workspace', () => {
  assert.equal(setup.SLACK_CLIENT_ID, A2A);
  assert.equal(setup.SLACK_TEAM_ID, 'T08LG8BQH1P');
  assert.deepEqual(app.chooseSlackApp({}, {}), { clientId: A2A, teamId: 'T08LG8BQH1P', source: 'default', name: 'A2A Notes' });
  assert.equal(app.redirectUrl(4460), 'http://localhost:4460/slack/callback');
});

test('the environment and then the Taskboard settings choose another app', () => {
  const env = { TASKBOARD_A2A_SLACK_CLIENT_ID: TASKBOARD, TASKBOARD_A2A_SLACK_TEAM_ID: 'TOTHER123' };
  assert.deepEqual(app.chooseSlackApp({}, env), { clientId: TASKBOARD, teamId: 'TOTHER123', source: 'environment', name: 'Taskboard' });
  assert.deepEqual(app.chooseSlackApp({ slackClientId: '123456.654321', slackTeamId: '' }, env), { clientId: '123456.654321', teamId: 'TOTHER123', source: 'settings', name: undefined });
  assert.deepEqual(app.chooseSlackApp({ slackClientId: '', slackTeamId: '' }, {}).source, 'default', 'empty settings use the default');
});

test('the Taskboard settings keep a valid client ID and team ID and refuse other text', () => {
  machine.update({ a2aSlackClientId: ` ${TASKBOARD} `, a2aSlackTeamId: 'T08LG8BQH1P' });
  assert.deepEqual(machine.get().a2aNotes, { slackClientId: TASKBOARD, slackTeamId: 'T08LG8BQH1P' });
  assert.equal(app.slackApp().clientId, TASKBOARD);
  assert.throws(() => machine.update({ a2aSlackClientId: 'xoxp-secret' }), /Slack client ID/);
  assert.throws(() => machine.update({ a2aSlackTeamId: 'sekai' }), /Slack team ID/);
  machine.update({ a2aSlackClientId: '', a2aSlackTeamId: '' });
  assert.equal(app.slackApp().clientId, A2A);
});

test('the sign-in help names the redirect URL, who can add it, and the other app', () => {
  const help = app.signInHelp(TASKBOARD, 'http://localhost:4460/slack/callback').join('\n');
  assert.match(help, /Taskboard Slack app \(client ID 8696283833057\.12177743257233\)/);
  assert.match(help, /must list this redirect URL: http:\/\/localhost:4460\/slack\/callback/);
  assert.match(help, /redirect_uri did not match any configured URIs/);
  assert.match(help, /owner or collaborator of the app/);
  assert.match(help, /OAuth & Permissions, Redirect URLs, Add New Redirect URL, Save URLs/);
  assert.match(help, /A2A Notes Slack app \(client ID 8696283833057\.12198817279122\)/);
  assert.doesNotMatch(app.signInHelp(A2A, 'http://localhost:4460/slack/callback').slice(2).join('\n'), /12198817279122/, 'the other app is the Taskboard app');
});

test('the A2A Notes app manifest has the A2A Notes callbacks and the scopes that A2A Notes asks for', () => {
  const m = manifest('a2a-notes-manifest.json');
  assert.ok(m.oauth_config.redirect_urls.includes('http://localhost:4460/slack/callback'));
  assert.ok(m.oauth_config.redirect_urls.includes('http://localhost:4461/slack/callback'), 'the port of a test server (setup.ts SERVICE_PORT)');
  assert.deepEqual([...m.oauth_config.scopes.user].sort(), [...SCOPES].sort());
  assert.equal(m.oauth_config.pkce_enabled, true);
  assert.doesNotMatch(JSON.stringify(m), /xox[a-z]-|client_secret|signing_secret/i, 'no secret in the file');
});

test('the Taskboard app manifest keeps the mail callbacks and adds the A2A Notes callbacks', () => {
  const urls: string[] = manifest('manifest.json').oauth_config.redirect_urls;
  for (const port of [4317, 4399, 4409, 4410]) assert.ok(urls.includes(`http://localhost:${port}/api/mail/slack/callback`));
  assert.ok(urls.includes('http://localhost:4460/slack/callback'));
  assert.ok(urls.includes('http://localhost:4461/slack/callback'));
});

test('the known apps point to manifest files that exist', () => {
  for (const known of app.KNOWN_SLACK_APPS) assert.ok(manifest(known.manifest.replace('integrations/slack/', '')).display_information.name);
});
