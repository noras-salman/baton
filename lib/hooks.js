// Claude Code hooks that tell Baton when a session is waiting on you (permission prompt,
// a question, a plan to approve). The hook runs `baton hook`, which drops an event file into
// ~/.baton/inbox; the app picks it up and notifies you.
const fs = require('fs');
const path = require('path');
const { CLAUDE_DIR } = require('./sessions');
const { CLI } = require('./skill');
const { DATA_DIR } = require('./store');

const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const INBOX = path.join(DATA_DIR, 'inbox');
const MARK = /baton\.js'? hook/; // identifies our hook entries
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const command = () => `node ${shq(CLI)} hook || true`;

// Which events we hook. Notification types are filtered inside `baton hook`.
const WANTED = {
  Notification: null, // permission_prompt, elicitation_dialog
  PreToolUse: 'AskUserQuestion|ExitPlanMode', // Claude asks you something / has a plan for approval
};

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Can't parse ${SETTINGS}: ${e.message}`);
  }
}

function isOurs(group) {
  return (group.hooks || []).some((h) => typeof h.command === 'string' && MARK.test(h.command));
}

function status() {
  const hooks = readSettings().hooks || {};
  const installed = Object.keys(WANTED).every((ev) => (hooks[ev] || []).some(isOurs));
  const current = installed && Object.keys(WANTED).every((ev) => (hooks[ev] || []).some((g) => isOurs(g) && g.hooks.some((h) => h.command === command())));
  return { installed, current, settingsFile: SETTINGS };
}

function write(settings) {
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.baton-backup`);
  const tmp = `${SETTINGS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS);
}

function install() {
  const settings = readSettings();
  const hooks = { ...(settings.hooks || {}) };
  for (const [event, matcher] of Object.entries(WANTED)) {
    const others = (hooks[event] || []).filter((g) => !isOurs(g));
    const ours = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: command(), timeout: 10 }] };
    hooks[event] = [...others, ours];
  }
  write({ ...settings, hooks });
  return status();
}

function uninstall() {
  const settings = readSettings();
  if (!settings.hooks) return status();
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length) hooks[event] = kept;
  }
  const next = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  write(next);
  return status();
}

// ---- called by Claude Code (via `baton hook`) with the event JSON on stdin ----
const clip = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function eventFromHook(input) {
  const base = { sessionId: input.session_id, cwd: input.cwd || '' };
  if (input.hook_event_name === 'Notification') {
    const type = input.notification_type || (/permission/i.test(input.message || '') ? 'permission_prompt' : '');
    if (type === 'permission_prompt') return { ...base, reason: 'permission', body: clip(input.message) || 'Claude needs your permission to continue.' };
    if (type === 'elicitation_dialog') return { ...base, reason: 'input', body: clip(input.message) || 'Claude is asking for input.' };
    return null; // idle_prompt etc. are covered by "session finished"
  }
  if (input.hook_event_name === 'PreToolUse') {
    const ti = input.tool_input || {};
    if (input.tool_name === 'AskUserQuestion') {
      const qs = Array.isArray(ti.questions) ? ti.questions : [];
      return { ...base, reason: 'question', body: clip(qs.map((q) => q.question).filter(Boolean).join('  ·  ')) || 'Claude has a question for you.' };
    }
    if (input.tool_name === 'ExitPlanMode') return { ...base, reason: 'plan', body: clip(String(ti.plan || '').replace(/^#+\s*/gm, '')) || 'Claude has a plan ready for your approval.' };
  }
  return null;
}

function recordHook(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const ev = eventFromHook(input);
  if (!ev || !ev.sessionId) return null;
  fs.mkdirSync(INBOX, { recursive: true });
  const file = path.join(INBOX, `${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...ev, at: new Date().toISOString() }));
  fs.renameSync(`${file}.tmp`, file); // atomic: the app never sees half a file
  return ev;
}

module.exports = { INBOX, SETTINGS, status, install, uninstall, recordHook, eventFromHook };
