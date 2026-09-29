# Set up Taskboard on your Mac

This guide covers a new installation for a team member.

Status: checked against this checkout on September 29, 2026. The Slack Inbox feature must be included in the release you install.

Taskboard runs one server and one controller on each Mac. Each member connects their own Slack account.

You do not need AWS services for messaging.

## Before you start

Have these items ready:

- A Mac with Homebrew installed.
- A Claude account that supports Claude Code.
- Membership in the Sekai Slack workspace for messages between users.
- The branch or commit your team has approved for installation.

Claude Code is required for the message checks in this version. You can also use Codex for coding tasks.

The steps below use Claude Code for your first task. Complete the steps in Terminal yourself.

## Install the required programs

Run these commands:

```sh
brew install node@22 pnpm tmux
brew install --cask claude-code
export PATH="$(brew --prefix node@22)/bin:$PATH"
node --version
pnpm --version
tmux -V
claude --version
```

Use Node 22.12 or newer within Node 22. Keep the PATH line in your shell configuration if another Node version takes precedence.

The Claude installation command follows the [official Claude setup guide](https://support.claude.com/en/articles/14552382-your-first-day-in-claude-code).

## Sign in to Claude Code

Run `claude`. Use `/login` if it asks you to sign in.

Complete sign-in in your browser. Exit Claude Code when sign-in finishes.

Check the account:

```sh
claude auth status
```

The result should show `loggedIn: true`.

## Install Taskboard

If `~/taskboard` already exists, use that checkout. Do not clone over an existing folder.

For a new checkout:

```sh
git clone https://github.com/Mgczacki/taskboard.git ~/taskboard
cd ~/taskboard
```

Switch to the branch or commit your team approved before continuing.

Run these commands from the checkout:

```sh
pnpm install --frozen-lockfile
pnpm release
sh scripts/install-launchd.sh
```

`pnpm release` builds the current checkout and starts Taskboard. Run it yourself, outside an agent task.

The login service starts Taskboard when you log in to your Mac. It also restarts the server if it stops.

Open [Taskboard](http://127.0.0.1:4317) in your browser.

To install the optional Mac app, run:

```sh
pnpm app
```

Open `~/Applications/Taskboard.app`. The app uses the same local server as the browser.

## Check your account and first task

- Open **Accounts**.
- Check that your Claude account shows as signed in.
- Use **Sign in** if the account needs authentication.
- Open **Controller** from the sidebar.
- Ask the controller which machine it manages.
- Select **New task**.
- Choose a project folder that you own.
- Select your signed-in Claude account.
- Ask for a short description of the project without file changes.
- Confirm that the task opens and returns a result.

## Connect Slack

Use the live address on port 4317. A page with a Sandbox banner is a separate test installation.

This version uses the team's existing Taskboard app in Sekai. New members do not create another Slack app.

- Open **Inbox**.
- Expand **Slack connection and approval settings**.
- Select **Connect Slack**.
- Confirm that Slack shows the Sekai workspace and the Taskboard app.
- Read the permissions and select **Allow**.
- Return to Taskboard.
- Confirm that the settings show **Connected as** followed by your Slack name and member ID.

If Slack requires administrator approval, ask your workspace administrator to approve the existing Taskboard app.

Each member must complete their own authorization. Do not copy another person's credentials.

The Slack permissions allow Taskboard to find people, read direct messages, send messages, upload files, and download files.

Taskboard scans direct conversations for Taskboard messages from workspace members. It stores only messages with the Taskboard format.

Existing Slack connections must authorize the new file permissions before files can move through Inbox. Disconnect Slack, then connect it again.

Taskboard sends message text to Claude for its separate content check. The checking process cannot use tools.

## Choose a recipient

Open **Sent**. The **To** menu lists members of the Sekai Slack workspace. Browse the menu or search inside it.

You can prepare a draft for any active member. Taskboard checks the member again before it sends the message.

Taskboard does not send contact requests. The recipient does not need Taskboard to read the Slack preview and use the setup link.

## Test with another member

The sender must connect Slack. The recipient can install Taskboard after the message arrives.

- Open **Sent**.
- Choose the other member from the **To** menu.
- Enter a subject and a harmless test message.
- Select **Save draft for approval**.
- Wait for the controller's content check.
- Select **Approve**.
- Select **Send approved message**.
- Ask the other member to read the Slack preview. The message footer links to this setup guide.
- If they use Taskboard, ask them to open **Messages** and select **Sync Slack and check messages**.
- Confirm that the message appears in their Inbox after the scan reaches that conversation.

To send a document, choose a TXT, MD, PDF, or DOCX file in Outbox. Taskboard limits each file to 10 MiB.

The recipient's controller reads each incoming file as data. The user must approve a reviewed file and choose a task before that task receives it.

Suspicious files stay in quarantine. Taskboard does not run incoming files.

Taskboard sends message bodies over 30,000 bytes as text files. The body limit is 256 KiB.

Taskboard also polls Slack every 60 seconds while the server runs. Each scan reads at most 25 direct conversations. It can take more than one scan to find a new message.

## Use approval and dismissal

Controller approval starts disabled. You can allow it for ordinary communication in Inbox settings.

Requests for actions require your approval. Suspicious messages stay blocked.

Approval does not route a message to an agent. Give your controller a separate command naming the message and destination task.

**Dismiss** hides an item without accepting it or sending feedback. **Show dismissed** lets you find messages and restore them.

Document reviews appear under **Documents to review**. Use **Dismissed** there to find dismissed documents.

A new document review request shows the document again, even if you dismissed its previous version.

## If setup fails

- If Inbox is missing, confirm that your installed release includes the Slack Inbox feature.
- If Slack sign-in expires, return to Inbox and select **Connect Slack** again.
- If review fails, check your Claude sign-in, then select **Retry controller review**.
- If a message is missing, select **Sync Slack and check messages**. Allow time for Taskboard to scan older direct conversations.
- If delivery is uncertain, check Slack before preparing another draft. Taskboard does not resend automatically.
- If a Slack connection stops working, disconnect it and complete **Connect Slack** again.
- If Taskboard does not open, inspect `~/.taskboard/server.log`.

Tasks and documents live in `~/AgentVault`. Server settings and credentials live in `~/.taskboard`.

Keep those folders when you update Taskboard. Never share credential files when asking for help.

Next action: choose a workspace member in **Sent** and test delivery.
