import { join } from 'node:path';

export function credentialGuidance(home: string): string {
  const gcloud = join(home, '.config', 'gcloud');
  const adc = join(gcloud, 'application_default_credentials.json');
  const gh = join(home, '.config', 'gh');
  const gitConfig = join(home, '.gitconfig');
  return `## Google Cloud and GitHub sign-in
Use these same paths for the user, each agent, and the controller on this Mac:
- CLOUDSDK_CONFIG=${gcloud}
- GOOGLE_APPLICATION_CREDENTIALS=${adc}
- GH_CONFIG_DIR=${gh}
- GIT_CONFIG_GLOBAL=${gitConfig}

These paths are guidance. Taskboard does not set these variables for each process. Put them on every related command with \`env\`.
Before asking the user to sign in, run \`hostname\` and \`command -v gcloud gh git\`. Use the full CLI paths in the request.
State the host, full CLI path, full config folder path, and exact sign-in command that the user must run on that host.
State the exact command that you will run after sign-in. The user must use the same path settings.
Never run a sign-in command yourself. Never read, print, or copy credential values or access tokens.

For Google Cloud, check both the CLI login and Application Default Credentials (ADC). They use separate credentials.
Use \`env CLOUDSDK_CONFIG=${gcloud} <full-gcloud-path> auth login --force\` for the user's CLI sign-in.
Use \`env CLOUDSDK_CONFIG=${gcloud} GOOGLE_APPLICATION_CREDENTIALS=${adc} <full-gcloud-path> auth application-default login\` for the user's ADC sign-in.
Before sign-in, record the modification times of \`${join(gcloud, 'credentials.db')}\` and \`${adc}\` when those files exist.
After sign-in, compare those times and run these checks with the same paths:
- \`env CLOUDSDK_CONFIG=${gcloud} <full-gcloud-path> auth list --filter=status:ACTIVE --format='value(account)'\`
- \`env CLOUDSDK_CONFIG=${gcloud} <full-gcloud-path> auth print-access-token >/dev/null\`
- \`env CLOUDSDK_CONFIG=${gcloud} GOOGLE_APPLICATION_CREDENTIALS=${adc} <full-gcloud-path> auth application-default print-access-token >/dev/null\`
Never print a token. A successful ADC token check does not reveal the ADC account or refresh token expiry.

For GitHub, use \`env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR=${gh} <full-gh-path> auth login --hostname github.com\` for the user's sign-in.
Use \`env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR=${gh} <full-gh-path> auth status --active --hostname github.com\` to check the account.
Use \`env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR=${gh} GIT_CONFIG_GLOBAL=${gitConfig} <full-git-path> config --show-origin --get-all credential.https://github.com.helper\` to check Git's helper.
For Git commands that need GitHub access, set GH_CONFIG_DIR and GIT_CONFIG_GLOBAL with \`env\` on that command.
GitHub CLI can store a login in the macOS credential store. A config file time might not show that change.
Do not use \`gh auth status --show-token\`. The GitHub CLI status does not report token expiry.

Before retrying the original command, compare the host, CLI path, config path, file times, and account before and after sign-in.
If the expected source did not change, show the path and time difference to the user. Do not retry the original command.
If the login cannot be checked without reading a credential value, report that limit and stop.`;
}
