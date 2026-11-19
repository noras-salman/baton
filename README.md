# Baton

A desktop task tracker where each task can be linked to a Claude Code session, so you can park pending work and resume that exact session later.

## Install

```bash
npm install
npm run dist        # builds dist/Baton-<version>-arm64.dmg
```

Open the DMG and drag Baton to Applications. The build is ad-hoc signed and not notarized, so it's meant for your own Mac. The first time you open a copy downloaded from elsewhere, right-click the app and choose Open.

## Develop

```bash
npm start
```

## How it works

- **Sessions** are read directly from your existing Claude Code setup: transcripts in `~/.claude/projects` and running sessions in `~/.claude/sessions`. There is no separate login.
- **Resume** opens Terminal or iTerm and runs `cd <project> && claude --resume <session-id>`, using your current Claude Code credentials.
- **Tasks** are stored in `~/.baton/tasks.json`. The app updates live when the file changes.
- **Links**: a task can link any number of Claude sessions and GitHub PRs. Each linked session keeps a snapshot of its latest conversation. Use "Refresh context" to capture them again later.
- **Pull requests**: your open PRs and PRs waiting on your review come from the GitHub CLI's existing login (`gh auth status`). The app needs no tokens of its own. Results are cached in `~/.baton/prs-cache.json` and refreshed every 5 minutes, or with ⌘R in the PR view.
- **Stacks**: a PR whose base branch is another open PR's branch is grouped into a stack, shown root to leaf with overall status. "+ Task" links the whole stack and every session that worked on it.
- **Ready to merge**: not a draft, approved (or no review required), checks passing, no conflicts, no unresolved threads. A PR in a stack only counts as ready when the whole stack is ready.
- **To address**: your PRs with an unresolved review thread where someone else commented last, or with changes requested.
- **Background watcher**: the app polls GitHub every 3 minutes, including while the window is closed, and sends macOS notifications when a PR or a whole stack becomes ready to merge, or when someone comments on or reviews your PRs. Each event is notified once, tracked in `~/.baton/pr-notify-state.json`. The installed app adds itself as a login item on first run; turn this off in the sidebar.
- **Notifications history**: every notification is kept in the Notifications view (`~/.baton/notifications.json`, newest 500) with unread state, the comments that triggered it, a deep link to the comment, and the PR's current status. The Dock icon shows the unread count. Clicking a macOS banner marks it read and opens it in Baton. The notification toggles only mute the banners; history is always recorded.
- **Settings tab**: choose which events notify you (ready PRs, ready stacks, failing checks, review requests with who asked, human comments, bot and AI-reviewer comments, approvals, changes requested, finished Claude sessions), banners, Dock badge, and muted repos and PRs. Turned-off types aren't recorded.
- **Claude session finished**: Baton watches `~/.claude/sessions` and notifies you when a session goes from running to waiting for you, if it ran longer than your threshold (default 30 s).
- **Start with Claude**: from any task (or "Create & start Claude" in the New task dialog), pick a project folder, describe what needs to be done, and choose Plan first / ask before changes / auto-accept edits. Baton opens a new `claude` session in your terminal with a prompt built from the task, its handoff notes, linked PRs and earlier sessions, and links the new session to the task.
- **PR ↔ session matching**: a session counts as linked to a PR if its transcript recorded that PR (Claude Code writes a `pr-link` entry when a session creates or touches one) or if the session ran on the PR's branch.

## `/task` inside Claude Code

Install it from the sidebar button, or run `npm run install-skill`. This writes `~/.claude/skills/task/SKILL.md`.

Then, in any Claude Code session:

```
/task                      # agent infers what's pending
/task follow up on PR review comments after CI passes
```

The agent writes a handoff summary (state, next steps, key files and decisions) and saves it as a task linked to the current session.

## CLI

```bash
node bin/baton.js add --title "..." [--session <id>]... [--pr <url>]... [--context "..."] [--priority high]
node bin/baton.js list
```
