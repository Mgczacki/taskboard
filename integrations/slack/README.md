# Slack app manifests

These files record the settings of the Slack apps that Taskboard uses. They do not change a live Slack app. An owner or collaborator of the app changes the live app at api.slack.com/apps. A push of this repository does not change it.

- `a2a-notes-manifest.json`: the A2A Notes app, client ID `8696283833057.12198817279122`, in the Sekai workspace (team `T08LG8BQH1P`). A2A Notes setup uses this app by default (`server/a2anotes/slack-app.ts`).
- `manifest.json`: the first Taskboard app, client ID `8696283833057.12177743257233`. It lists the Taskboard mail callbacks (`/api/mail/slack/callback`). The file also lists the A2A Notes callbacks. The live app has them only after an owner adds them.

A2A Notes signs in with the redirect URL `http://localhost:<port>/slack/callback`:

- port 4460 for the real Taskboard
- port 4461 for a test server
- the port in `TASKBOARD_A2A_PORT`, when it is set

The Slack app must list that exact URL under OAuth & Permissions, Redirect URLs. If it does not, Slack shows "redirect_uri did not match any configured URIs".

To use another app, set the client ID and team ID on the Settings page (Integrations, A2A Notes, Choose the Slack app). You can also set `TASKBOARD_A2A_SLACK_CLIENT_ID` and `TASKBOARD_A2A_SLACK_TEAM_ID`. The Settings page value has priority.
