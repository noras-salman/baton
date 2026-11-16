---
name: task
description: Save something pending from this conversation as a task in Baton, linked to this Claude Code session so it can be resumed later. Use when the user says "add a task", "track this for later", "park this", or runs /task.
argument-hint: "[what's pending — optional, inferred from the conversation if omitted]"
allowed-tools: Bash(node __BATON_CLI__ add:*)
---

The user wants to park pending work from this session as a task in their Baton task tracker.

User's note (may be empty): $ARGUMENTS

1. Work out what is pending. Use the user's note if given; otherwise infer it from the recent conversation (unfinished steps, open questions, things deferred, follow-ups promised).
2. Write a short imperative title (under 80 characters).
3. Write a handoff summary for your future self resuming this session cold. Include:
   - the goal and current state (what's done, what's not)
   - the concrete next steps
   - key files, branches, PRs, commands, and any decisions or constraints already agreed
   - open questions or blockers
   Keep it to a tight markdown list of about 5 to 15 lines. Do not include secrets or tokens.
4. Run exactly this single Bash command. Do not use a heredoc, pipe, redirect, or temp file, because those trigger permission prompts. Pass the summary as one single-quoted `--context` argument; newlines inside the quotes are fine. The summary and title must not contain a single quote (') character, so rephrase to avoid apostrophes. Add `--priority high` only if the user signals urgency. If the pending work concerns specific GitHub pull requests, add one `--pr <url>` per PR (full https URL).

```bash
node __BATON_CLI__ add --session "${CLAUDE_SESSION_ID}" --title '<title>' --context '<summary>' [--pr <url> ...]
```

5. Reply with one line confirming the task title. Do not continue working on the pending item unless asked.
