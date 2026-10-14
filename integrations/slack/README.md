# Slack Desktop connection

A2A Notes uses the signed-in Slack Desktop app.
It does not use OAuth or direct Slack Web API calls.
It calls the app's own API client inside the app.
It never changes the open conversation, types in the composer, or clicks a Slack control.
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

The connector adds ✅ with the app's `reactions.add` call.
It reads the saved message first. An existing reaction from the bound account counts as confirmation.
Receipt does not approve actions or complete work.

This version supports text messages.
Small attachments travel in the original message data.
The complete message must fit within 39,000 bytes.
The adapter verifies the sender and original message before it returns file bytes.
The protocol checks each file hash.
Larger files fail before posting.
People search reads up to 2,000 members with `users.list`.
History recovery reads the 50 latest records of up to 20 direct conversations.
A changed app interface produces a visible error before posting.

Taskboard bundles `integrations/a2a-notes/a2a-notes-0.12.0.tgz`.
The lockfile records its integrity.
This package update changes no running service.

Setup saves old OAuth settings in `config.before-slack-app.json` before the first migration.
The backup stays private in the service data folder.
Restore that config with the earlier package when rolling back.
Pause outgoing delivery before rollback.
Do not reuse app attachment checkpoints with the older API transport.

The A2A Notes source revision is `2e382e74dd49d1a5efea0743f0c9718000ad3d14`.

The integrated package SHA256 is `172d27744057fbcc0f941b93fb032ab68ba5b92454c27c13505806fdcf60535f`.

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
Native posting is the only posting path.
Unavailability before posting stops the note before posting.
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
It resolves the saved DM and waits for account loading.
A cleared renderer context triggers a new verified debugger connection.
Taskboard setup preserves the selected native posting preference.

## Retry an approved note after failure before posting

The native sender waits up to 20 seconds for readiness.
Use `tb mail retry-send <id> <hash>` to queue an unchanged approved note after a verified app failure before posting.
Only the user or controller can request this retry.
The service checks saved attempts before it queues the same message ID.
It retains the approval and saved file progress.
Uncertain delivery cannot use this operation.
The Inbox shows **Retry approved note** when the service permits retry.
The installed service must run 0.11.2 before this operation is available.

## Current message records and native receipts

Version 0.11.3 reads the current Slack Message component from `msg`.
The adapter checks the original channel and timestamp before it confirms receipt.
When native sending is selected, the app SDK adds the receipt reaction.
An existing own reaction also confirms receipt.
Reaction limits use a separate saved deadline from message posting.
Neither receipt confirmation nor message text grants approval.

## Background Slack access

Version 0.12.0 stops operating the Slack window.
The adapter no longer navigates, types in the composer, or clicks controls.
Reads use only `conversations.info`, `conversations.open`, `conversations.history`, `users.info`, and `users.list`.
Delivery notices use the native `chat.postMessage` call with the operation ID as the client message ID.
Without native sending, the service reads and confirms receipt, but it does not post.
