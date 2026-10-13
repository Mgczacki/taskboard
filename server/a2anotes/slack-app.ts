// Workspace selection for the signed-in Slack Desktop connection.
import * as machine from '../machine.ts';
export const DEFAULT_SLACK_TEAM_ID = 'T08LG8BQH1P';
export function chooseSlackWorkspace(saved: {slackTeamId?: string} = {}, env: NodeJS.ProcessEnv = process.env) {
  const teamId = saved.slackTeamId || env.TASKBOARD_A2A_SLACK_TEAM_ID || DEFAULT_SLACK_TEAM_ID;
  if (!/^T[A-Z0-9]+$/.test(teamId)) throw new Error('Use a Slack workspace ID.');
  return {teamId};
}
export const slackApp = () => chooseSlackWorkspace(machine.get().a2aNotes);
