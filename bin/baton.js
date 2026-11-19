#!/usr/bin/env node
// baton CLI — lets a running Claude Code session file a task linked to itself.
//
//   baton add --title "..." [--session <id>]... [--pr <url>]... [--context "..."] [--priority high]
//              (context/summary is read from stdin if piped)
//   baton list
//   baton install-skill      # installs the /task skill into ~/.claude/skills/task
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const sessions = require('../lib/sessions');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const val = next === undefined || next.startsWith('--') ? true : argv[++i];
      if (key === 'session' || key === 'pr') (args[key] = args[key] || []).push(val);
      else args[key] = val;
    } else args._.push(a);
  }
  return args;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

function prFromUrl(url) {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? { url, repo: m[1], number: Number(m[2]), title: '' } : null;
}

function cmdAdd(args) {
  const title = args.title || args._.slice(1).join(' ');
  if (!title) {
    console.error('error: --title is required');
    process.exit(1);
  }
  const summary = typeof args.context === 'string' ? args.context : readStdin();

  const ids = (args.session || []).filter((v) => typeof v === 'string' && v);
  if (!ids.length && process.env.CLAUDE_SESSION_ID) ids.push(process.env.CLAUDE_SESSION_ID);
  const linked = ids.map((id) => {
    const s = sessions.getSession(id);
    if (s) return sessions.sessionLink(s);
    return { id, cwd: typeof args.cwd === 'string' ? args.cwd : process.cwd(), title: '', gitBranch: '', context: null };
  });

  const prs = (args.pr || [])
    .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
    .map((u) => prFromUrl(u.trim()))
    .filter(Boolean);

  const task = store.addTask({
    title,
    notes: typeof args.notes === 'string' ? args.notes : '',
    priority: ['low', 'normal', 'high'].includes(args.priority) ? args.priority : 'normal',
    summary: summary || '',
    sessions: linked,
    prs,
  });
  const bits = [linked.length && `${linked.length} session(s)`, prs.length && `${prs.length} PR(s)`].filter(Boolean);
  console.log(`Task created: ${task.title} (${task.id})${bits.length ? ` linked to ${bits.join(' and ')}` : ''}`);
}

function cmdList() {
  for (const t of store.readTasks()) {
    const links = [...t.sessions.map((x) => `session ${x.id.slice(0, 8)}`), ...t.prs.map((p) => `${p.repo}#${p.number}`)];
    console.log(`[${t.status}] ${t.title}${links.length ? `  (${links.join(', ')})` : ''}`);
  }
}

function cmdInstallSkill() {
  const file = require('../lib/skill').install();
  console.log(`Installed /task skill -> ${file}`);
}

const args = parseArgs(process.argv.slice(2));
switch (args._[0]) {
  case 'add':
    cmdAdd(args);
    break;
  case 'list':
    cmdList();
    break;
  case 'hook':
    // Called by Claude Code hooks; must be quick, silent, and never block Claude.
    try {
      require('../lib/hooks').recordHook(readStdin());
    } catch {
      /* never fail the hook */
    }
    process.exit(0);
    break;
  case 'install-hooks':
    console.log(JSON.stringify(require('../lib/hooks').install()));
    break;
  case 'uninstall-hooks':
    console.log(JSON.stringify(require('../lib/hooks').uninstall()));
    break;
  case 'install-skill':
    cmdInstallSkill();
    break;
  default:
    console.log('usage: baton add --title "..." [--session id]... [--pr url]... [--context "..."] [--priority high]\n       baton list\n       baton install-skill');
    process.exit(args._[0] ? 1 : 0);
}
