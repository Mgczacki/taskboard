// The Slack app that A2A Notes signs in with. Setup writes its client ID and team ID into the A2A Notes config.json
// (server/a2anotes/setup.ts), and A2A Notes sends the browser to Slack with that client ID and the redirect URL
// http://localhost:<port>/slack/callback. Slack refuses the sign-in ("redirect_uri did not match any configured URIs")
// when the app does not list that exact URL under OAuth & Permissions, Redirect URLs. Only an owner or collaborator of
// the app can add it there. The files in integrations/slack only document the apps: a change to them does not change
// a live Slack app.
//
// The client ID and team ID come from, in this order:
// 1. the Taskboard settings (machine.json a2aNotes.slackClientId and a2aNotes.slackTeamId, on the Settings page)
// 2. the environment variables TASKBOARD_A2A_SLACK_CLIENT_ID and TASKBOARD_A2A_SLACK_TEAM_ID
// 3. the default below
import * as machine from '../machine.ts';

export interface KnownSlackApp { clientId: string; name: string; manifest: string }
// The first Taskboard Slack app. It was made for the Taskboard mail sign-in: integrations/slack/manifest.json lists the
// /api/mail/slack/callback URLs. The A2A Notes callback (4460 and 4461) is in that file too, but the live app has it
// only after an owner of the app adds it in Slack. It is not the default for A2A Notes.
export const TASKBOARD_SLACK_APP: KnownSlackApp = { clientId: '8696283833057.12177743257233', name: 'Taskboard', manifest: 'integrations/slack/manifest.json' };
// The separate Slack app for A2A Notes (Taskboard task 123), and the default. Its redirect URL is
// http://localhost:4460/slack/callback (integrations/slack/a2a-notes-manifest.json).
export const A2A_NOTES_SLACK_APP: KnownSlackApp = { clientId: '8696283833057.12198817279122', name: 'A2A Notes', manifest: 'integrations/slack/a2a-notes-manifest.json' };
export const KNOWN_SLACK_APPS = [TASKBOARD_SLACK_APP, A2A_NOTES_SLACK_APP];
export const DEFAULT_SLACK_CLIENT_ID = A2A_NOTES_SLACK_APP.clientId;
// the Sekai workspace
export const DEFAULT_SLACK_TEAM_ID = 'T08LG8BQH1P';

export const CLIENT_ID_PATTERN = /^\d{6,20}\.\d{6,20}$/;
export const TEAM_ID_PATTERN = /^T[A-Z0-9]{6,20}$/;

export interface SlackApp { clientId: string; teamId: string; source: 'settings' | 'environment' | 'default'; name?: string }

export function chooseSlackApp(saved: { slackClientId?: string; slackTeamId?: string } = {}, env: NodeJS.ProcessEnv = process.env): SlackApp {
  const fromEnv = { clientId: env.TASKBOARD_A2A_SLACK_CLIENT_ID?.trim() || '', teamId: env.TASKBOARD_A2A_SLACK_TEAM_ID?.trim() || '' };
  const clientId = saved.slackClientId || fromEnv.clientId || DEFAULT_SLACK_CLIENT_ID;
  const teamId = saved.slackTeamId || fromEnv.teamId || DEFAULT_SLACK_TEAM_ID;
  const source = saved.slackClientId || saved.slackTeamId ? 'settings' : fromEnv.clientId || fromEnv.teamId ? 'environment' : 'default';
  return { clientId, teamId, source, name: appName(clientId) };
}
export const slackApp = () => chooseSlackApp(machine.get().a2aNotes);
export const appName = (clientId: string) => KNOWN_SLACK_APPS.find(a => a.clientId === clientId)?.name;
export const redirectUrl = (port: number) => `http://localhost:${port}/slack/callback`;

// The plain message for a failed sign-in: the redirect URL the app must list, who can add it, and the other known app.
export function signInHelp(clientId: string, redirect: string) {
  const name = appName(clientId);
  const app = name ? `the ${name} Slack app (client ID ${clientId})` : `the Slack app with client ID ${clientId}`;
  const lines = [
    `A2A Notes signs in with ${app}. That app must list this redirect URL: ${redirect}`,
    `If Slack shows "redirect_uri did not match any configured URIs", the app does not list it. An owner or collaborator of the app can add it at api.slack.com/apps: open the app, then OAuth & Permissions, Redirect URLs, Add New Redirect URL, Save URLs.`,
  ];
  const others = KNOWN_SLACK_APPS.filter(a => a.clientId !== clientId);
  for (const other of others) lines.push(`You can also use the ${other.name} Slack app (client ID ${other.clientId}). Enter that client ID below, save it, and click Use this Slack app.`);
  return lines;
}
