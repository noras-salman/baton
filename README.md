# Baton

A desktop task tracker where each task can be linked to a Claude Code session, so you can park pending work and resume that exact session later.

## Run

```bash
npm install
npm start
```

## How it works

- **Sessions** are read directly from your existing Claude Code setup: transcripts in `~/.claude/projects` and running sessions in `~/.claude/sessions`. There is no separate login.
- **Resume** opens Terminal or iTerm and runs `cd <project> && claude --resume <session-id>`, using your current Claude Code credentials.
- **Tasks** are stored in `~/.baton/tasks.json`. The app updates live when the file changes.
- **Links**: a task can link any number of Claude sessions and GitHub PRs. Each linked session keeps a snapshot of its latest conversation. Use "Refresh context" to capture them again later.
- **Pull requests**: your open PRs and PRs waiting on your review come from the GitHub CLI's existing login (`gh auth status`). The app needs no tokens of its own. Results are cached in `~/.baton/prs-cache.json` and refreshed every 5 minutes, or with ⌘R in the PR view.
- **Stacks**: a PR whose base branch is another open PR's branch is grouped into a stack, shown root to leaf with overall status. "+ Task" links the whole stack and every session that worked on it.
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
