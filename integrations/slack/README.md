# Slack Desktop connection

A2A Notes uses the signed-in Slack Desktop app.
It does not use OAuth or direct Slack Web API calls.
The JSON manifests in this folder record older app configurations for rollback.
They do not configure the current connector.

Taskboard setup writes the workspace and local app endpoint.
The Settings page can change both values.
The default endpoint is `http://127.0.0.1:19322`.
Slack must run with its debugging port restricted to loopback.

The connector verifies the app account and direct message recipient.
It stores pending messages before delivery.
It saves the send checkpoint before dispatch.
It confirms the original message ID before recording success.
It never repeats an uncertain post.

The connector adds ✅ through the app's reaction control.
It confirms that the bound account added the reaction to the saved message.
Receipt does not approve actions or complete work.

This version supports text messages.
Small attachments travel in the original message data.
The complete message must fit within 39,000 bytes.
The adapter verifies the sender and original message before it returns file bytes.
The protocol checks each file hash.
Larger files fail before posting.
People search and history recovery use records available in the app.
Changed controls produce visible errors.

Taskboard bundles `integrations/a2a-notes/a2a-notes-0.11.2.tgz`.
The lockfile records its integrity.
This package update changes no running service.

Setup saves old OAuth settings in `config.before-slack-app.json` before the first migration.
The backup stays private in the service data folder.
Restore that config with the earlier package when rolling back.
Pause outgoing delivery before rollback.
Do not reuse app attachment checkpoints with the older API transport.

The A2A Notes source revision is `a134222b1dffaab525ba2388bf08c67f0ec833cd`.

The integrated package SHA256 is `b0d409828fa59122172d0b7965847540e9e1a588345fa47b06b5666878235fc4`.

## Optional native posting

Add `--send` to `a2a-notes desktop enable --url http://127.0.0.1:19322` to select native posting.
Restart A2A Notes after changing the setting.
The connector checks the current account and inspected Slack module hashes.
It calls Slack's native `apiCall` function with the approved message ID and content.
Slack handles credentials inside the app.
The request gets one SDK attempt.
A2A Notes controls further retries and honors Retry-After.

`DesktopDeliveries.begin` stores the attempt before dispatch in `desktop-deliveries.json`.
The connector saves the receipt before the service marks the note sent.
A restart checks the saved receipt before reading app message records.
An uncertain attempt cannot create another post.
A verified native echo can supply a lost receipt.
Known unavailability before posting permits app composer controls.
A native 429 or uncertain result cannot switch the same attempt to those controls.
Invalid credentials and policy failures stop delivery.
A changed note needs a new approval.
The adapter preserves small inline attachments and their hash checks.
It makes no direct Slack HTTP request and has no OAuth fallback.

## Human replies and approval

The person copies `A2A Reply/1 <note ID>` from the sent note.
They write the reply on the next line in the same conversation or its thread.
The service verifies the original recipient and preserves the audience.
Taskboard uses verified task metadata to find the originating task.
`A2A #430` and registered aliases let the owner address tasks from their verified self-conversation.
Ordinary Slack text creates no agent instruction or action approval.
The service keeps approval for unchanged queued content.
MCP clients retain the bound human approval form through `a2anotes_request_approval`.
Acknowledgement remains separate from acceptance and action approval.

Saved Web API upload progress stops before app-only delivery.
The adapter cannot replace an earlier shared file with an inline attachment.

Version 0.11.1 reads current avatar records for verified member names.
It resolves the saved DM before navigation and waits for account loading.
A cleared renderer context triggers a new verified debugger connection.
Taskboard setup preserves the selected native posting preference.

## Retry an approved note after failure before posting

The selected native sender now waits for readiness after navigation.
Use `tb mail retry-send <id> <hash>` to queue an unchanged approved note after a verified app failure before posting.
Only the user or controller can request this retry.
The service checks saved attempts before it queues the same message ID.
It retains the approval and saved file progress.
Uncertain delivery cannot use this operation.
The Inbox shows **Retry approved note** when the service permits retry.
The installed service must run 0.11.2 before this operation is available.
