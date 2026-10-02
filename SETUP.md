# Set up Taskboard on your Mac

This guide covers a new installation for a team member.

Status: checked against this checkout on October 1, 2026. Messages with other people use A2A Notes, which Taskboard installs.

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
Run the install script in Terminal, without sudo. Its last line says "Installed and running" or names the problem and the next step.
If the server does not answer later, run `pnpm doctor`, or click **Start server** in the Taskboard app.

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

## Connect Slack for messages

Taskboard sends and receives messages with other people through A2A Notes (https://github.com/Mgczacki/a2a-notes). A2A Notes is a separate project. Taskboard installs it and runs it as its own service on your Mac. The recipient does not need Taskboard: a message shows its subject, its text, and a **Get A2A Notes** link in Slack.

Use the live address on port 4317. A page with a Sandbox banner is a separate test installation.

1. Open **Settings**. Under **Integrations**, find **A2A Notes (Slack)**.
2. Select **Set up A2A Notes**. Taskboard does these steps:
   - It writes the A2A Notes settings in `~/.a2a-notes` with the team's Taskboard Slack app.
   - It starts the service with the LaunchAgent `com.a2anotes.service`, so the service runs after you sign in to your Mac.
   - It makes one client token for each role and writes them to `~/.taskboard/a2anotes.json`.
   - It sets the message checks to Claude with your controller account.
3. Select **Connect Slack**. Confirm that Slack shows the Sekai workspace, read the permissions, and select **Allow**. Slack returns you to the Settings page.
4. Confirm that the card shows **Connected as** followed by your Slack name.

The Taskboard Slack app must list `http://localhost:4460/slack/callback` as a redirect URL. If Slack requires administrator approval, ask your workspace administrator to approve the Taskboard app. Each member signs in with their own Slack account. Do not copy another person's credentials.

After a Taskboard release with a newer A2A Notes version, the card shows **Restart A2A Notes**. After a change of the controller account, it shows **Update A2A Notes**.

## Send a message

- Open **Inbox**, then **Sent**.
- Type a name or an email in **To** and choose the person.
- Enter a subject and one or two sentences for the reader. Select **Create draft**.
- Wait for the message check. Then select **Approve this version** and **Send**.

In Terminal, a task uses `tb mail draft <to> --subject <text> --context <why> --ask <request>`. `<to>` is a name, an exact email, a Slack member ID, or an A2A Notes address. Add `--file <outbox file>` for a supporting file, or `--agent-file <outbox file>` for a request to the reader's agent. `tb mail` lists all commands.

A task can also send a note to you only: `tb mail submit <subject> <body>`. The note stays on your Mac and shows in **Inbox**, under **Messages**.

Each message shows the other person's Slack name and picture. A reply to a message that a task sent suggests that task.

## Approval levels and cards

Open **Settings** and find **Messages from other people**. Choose one level for incoming messages and one for outgoing messages. Level 2 is the default for both.

- Level 1: you approve every message.
- Level 2: the controller approves ordinary messages to or from trusted people. You approve a message when the check finds a problem or is not sure.
- Level 3: the controller also approves trusted messages that the check is unsure about.

A2A Notes enforces these levels. Agents and the controller cannot change them. A change to a higher level asks you to confirm first. Add the people that you trust under **Trusted people** on the same page.

The checks are Claude with no tools and the fixed rules of A2A Notes. A message with prompt injection or malicious content stays in quarantine at every level. A draft with flagged text needs your approval.

The approval cards appear at the top right of the dashboard. **Approve** sends a draft, or approves an incoming message and gives it to the task that the controller proposed. **Remove flagged text** removes the flagged sentences from a draft. **Send back** returns the card with your comment: the agent that wrote a draft receives it, and the controller receives comments about incoming messages.

Document reviews appear under **Documents to review**.

## If setup fails

- If **Set up A2A Notes** fails, read the message on the card. The service log is `~/.a2a-notes/service.log`.
- If Slack sign-in expires, select **Connect Slack** on the A2A Notes card again.
- If a message is missing, select **Check Slack now** in Inbox. A2A Notes scans 40 conversations at a time, so a new message can take more than one scan.
- If delivery is uncertain, select **Check and send**. A2A Notes looks for the message in Slack before it sends again.
