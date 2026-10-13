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
It saves the send checkpoint before clicking Send.
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

Taskboard bundles `integrations/a2a-notes/a2a-notes-0.10.0.tgz`.
The lockfile records its integrity.
No release or live Slack send is part of this change.

Setup saves old OAuth settings in `config.before-slack-app.json` before the first migration.
The backup stays private in the service data folder.
Restore that config with the earlier package when rolling back.
Pause outgoing delivery before rollback.
Do not reuse app attachment checkpoints with the older API transport.

The A2A Notes source revision is `868243a6eecde8f7c7860bfbfe212da3c860e1d2`.
