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

A2A Notes displays an explicit reply marker in each sent Slack note.
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

Taskboard installs the tested service from the local package in `integrations/a2a-notes/a2a-notes-0.8.1.tgz`.
The lockfile records the package integrity.
The source revision is `39e444e6d9483e824e8bd8d18f17ec2283e94a64` in the A2A Notes repository.
The package SHA256 is `897756bfa36f33b79f478600e3a4a5ba8d53ef33dd8e0391cd1356b7860f7b2c`.
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

## Owner requests and Slack Desktop events

The owner can address an active task with `A2A #430` on the first line.
The owner writes the request on the next line in their Slack self-conversation.
`A2A @controller` and registered task aliases use the same explicit format.
Native owner requests need no acceptance card for unchanged content and policy.
They do not approve outgoing actions.
Other people keep the current acceptance and destination checks.

A2A Notes 0.8.1 also provides an optional macOS connector for the installed Slack app.
The connector uses the Chrome DevTools Protocol through a loopback debugging port.
It verifies the port owner and current account before it accepts native WebSocket events.
Each new debugger connection rechecks the port owner.
It stores explicit DM events before it calls the existing receive function.
The saved event reference matches history polling, so both paths identify the same note.
Taskboard keeps its current verified routing and approval rules.

The connector does not need desktop clicks or screenshots.
It still uses Slack OAuth to verify new DM channels.
Outgoing delivery and files retain their existing API limits and durable queue.
The setup procedure is in the package's `docs/SLACK-DESKTOP.md`.
The optional setting remains off unless the user selects it.
The desktop connection is not a supported Slack integration API.

## Acknowledge received messages


The Inbox has an Acknowledge receipt button for eligible incoming messages.
`tb mail ack <id> <hash>` calls the same generic `a2anotes_ack` tool.
Acknowledgement does not accept held content or approve actions.
Verified native human replies acknowledge endpoint receipt automatically after the note is stored.

The Slack adapter adds ✅ to the original post. Its emoji name is `white_check_mark`.
The app manifests now list `reactions:write`. Apply the manifest and reconnect Slack before using reactions.
Changing this repository does not change the live app or token scopes.
The Inbox shows pending acknowledgement and permanent failures. It lets the owner retry after correcting a failure.

A confirmed reaction means endpoint receipt. Agent notification and completed work remain separate.
Manual reactions do not invoke tools or approve work.
This package update does not change the running service.

Taskboard writes its stable machine identity in originating metadata and saved routes.
A verified reply with a different machine identity stays unassigned. It cannot select a same-named local task automatically.
Older notes without machine metadata retain their existing local routing behavior.
Use one designated intake machine for each Slack identity. Remote forwarding remains outside this version.

Taskboard reports when it cannot select or notify an agent for an accepted note.
A2A Notes posts a fixed Slack notice without the original text or internal task details.
If a reported failure resolves, it posts a further notice.
Uncertain notices are checked before another post. The Inbox shows notice errors and a retry control.

Task callers must prove their own identity with the existing task token.
The shared server token alone cannot name a task for message operations.
The CLI reads the task token from the existing token file for older sessions.
