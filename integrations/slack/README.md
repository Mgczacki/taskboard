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


## Replies and queued delivery

A2A Notes 0.6.1 displays an explicit reply marker in each sent Slack note.
The person copies that first line and writes the reply on the next line.
The reply can arrive in the direct message conversation or its thread.

The service verifies the sender against the original recipient.
It preserves the original audience and runs the current incoming checks.
Taskboard uses verified local metadata to find the originating task.
Ordinary Slack text creates no agent instruction or action approval.

Outgoing approval stores a durable queued note.
A Slack 429 sets the next attempt from Retry-After.
Later 429 responses use capped exponential backoff with jitter.
A queued note keeps the approval for unchanged content.
Taskboard shows the next attempt and final failure in the Inbox.
The graph also shows delivery status.

The adapter records which Slack method failed.
An uncertain post triggers a lookup and does not trigger another post.
Saved upload progress prevents the adapter from sharing a file twice.
Invalid credentials stop delivery.
Changed content or policy stops delivery.

Taskboard installs the tested service from the local package in `integrations/a2a-notes/a2a-notes-0.6.1.tgz`.
The lockfile records the package integrity.
The source revision is `78ebe80873bfc97d9223a1ca0f4b3f6be8831a7a` in the A2A Notes repository.
A future service update must replace that package and update the lockfile.
The existing Slack app needs no new callback endpoint.

## Human approval in a coding client

The service exposes `a2anotes_request_approval` for interactive MCP clients.
Register that client with `a2a-notes token add <name> --role agent --human-approval`.
Its host must support form elicitation and show the form to the human.
Both modern and legacy form capability declarations work.
The agent keeps its existing role.
It cannot approve directly or change the service policy.

The form binds the human decision to one note and content hash.
Outgoing approval enters the existing durable queue.
Incoming acceptance keeps the existing audience rules.
Taskboard reads that acceptance and delivers a verified reply to its originating task.
Neither acceptance nor reply text authorizes actions.

Existing Taskboard role tokens remain unchanged.
The dashboard continues to use its existing approval path.
This package update changes no running service or live configuration.
