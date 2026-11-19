const { app, BrowserWindow, ipcMain, clipboard, shell, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const store = require('../lib/store');
const sessions = require('../lib/sessions');
const skill = require('../lib/skill');
const github = require('../lib/github');
const prs = require('../lib/prs');
const notifications = require('../lib/notifications');
const hooks = require('../lib/hooks');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---- helpers --------------------------------------------------------------

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const asq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function resumeCommand(sessionId, cwd) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid session id');
  return `cd ${shq(cwd || require('os').homedir())} && claude --resume ${sessionId}`;
}

function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

async function openInTerminal(cmd, terminal) {
  if (terminal === 'iterm') {
    await osascript(`tell application "iTerm"
  activate
  set w to (create window with default profile)
  tell current session of w to write text ${asq(cmd)}
end tell`);
  } else {
    await osascript(`tell application "Terminal"
  activate
  do script ${asq(cmd)}
end tell`);
  }
}

// ---- IPC ------------------------------------------------------------------

ipcMain.handle('tasks:list', () => store.readTasks());
ipcMain.handle('tasks:save', (_e, task) => store.saveTask(task));
ipcMain.handle('tasks:delete', (_e, id) => store.deleteTask(id));

ipcMain.handle('sessions:list', () => sessions.listSessions({ limit: 300 }));
ipcMain.handle('sessions:link', (_e, id) => {
  const s = sessions.getSession(id);
  return s ? sessions.sessionLink(s) : null;
});
ipcMain.handle('session:resume', async (_e, { sessionId, cwd, terminal }) => {
  const live = sessions.getSession(sessionId)?.live;
  if (live) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Open anyway', 'Cancel'],
      defaultId: 1,
      message: 'This session is still running',
      detail: `It's open in ${live.entrypoint === 'claude-vscode' ? 'VS Code' : 'another terminal'} (pid ${live.pid}). Resuming it here as well gives two processes writing to one session.`,
    });
    if (response !== 0) return { ok: false, cancelled: true };
  }
  await openInTerminal(resumeCommand(sessionId, cwd), terminal);
  return { ok: true };
});
// Start a brand-new Claude Code session for a task. The session id is chosen here so the
// task can link to it immediately; the prompt goes through a file to avoid quoting issues.
const START_MODES = new Set(['plan', 'acceptEdits', 'default']);
ipcMain.handle('session:start', async (_e, { cwd, prompt, name, mode, terminal }) => {
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
  if (!prompt || !prompt.trim()) throw new Error('Nothing to send to Claude');
  const sessionId = require('crypto').randomUUID();
  const dir = path.join(store.DATA_DIR, 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.md`);
  fs.writeFileSync(file, prompt);
  const flags = [`--session-id ${sessionId}`];
  if (name) flags.push(`--name ${shq(String(name).slice(0, 80))}`);
  if (START_MODES.has(mode) && mode !== 'default') flags.push(`--permission-mode ${mode}`);
  const cmd = `cd ${shq(cwd)} && claude ${flags.join(' ')} "$(cat ${shq(file)})"`;
  await openInTerminal(cmd, terminal);
  return { sessionId, cwd };
});

ipcMain.handle('dialog:pickFolder', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: defaultPath || require('os').homedir() });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('session:command', (_e, { sessionId, cwd }) => resumeCommand(sessionId, cwd));
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
ipcMain.handle('open:folder', (_e, dir) => shell.openPath(dir));
ipcMain.handle('open:vscode', (_e, dir) =>
  new Promise((resolve) => execFile('open', ['-a', 'Visual Studio Code', dir], (err) => resolve(!err))),
);
ipcMain.handle('open:url', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

// ---- GitHub PRs: background poller + notifications ----------------------------
// Uses the local `gh` login. Runs in the main process so it keeps working with the window closed.
const PR_CACHE = path.join(store.DATA_DIR, 'prs-cache.json');
const PR_STATE = path.join(store.DATA_DIR, 'pr-notify-state.json');
const SETTINGS = path.join(store.DATA_DIR, 'settings.json');
const POLL_MS = 3 * 60 * 1000;

const readJSON = (f, dflt) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return dflt;
  }
};
const writeJSON = (f, v) => {
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, f);
};

function settings() {
  return readJSON(SETTINGS, {});
}
// What you want to be notified about (see lib/prs.js DEFAULT_PREFS).
const prefs = () => prs.prefsFrom(settings());

let prData = readJSON(PR_CACHE, null);
let prError = '';
let prInflight = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- notification history + Dock badge ----
function updateBadge() {
  const n = prefs().dockBadge ? notifications.unreadCount() : 0;
  if (app.dock) app.dock.setBadge(n ? String(n > 99 ? '99+' : n) : '');
}

// macOS only shows Dock badges and banners for apps that have asked for notification
// permission, and Electron asks on the first notification. Send one on first run so the
// permission prompt (and the Dock badge) don't wait for the first GitHub event.
function introduceNotifications() {
  const s = readJSON(SETTINGS, {});
  if (!app.isPackaged || s.notificationsIntroduced || !Notification.isSupported()) return;
  const n = notifications.unreadCount();
  new Notification({
    title: 'Baton notifications are on',
    body: n ? `You have ${n} unread. Baton will tell you when PRs are ready to merge or get comments.` : 'Baton will tell you when PRs are ready to merge or get comments.',
  }).show();
  writeJSON(SETTINGS, { ...s, notificationsIntroduced: true });
}

function notificationsChanged() {
  updateBadge();
  send('notifications:changed');
}

// Run fn once the window's UI is loaded (creating/showing the window if needed).
function whenUiReady(fn) {
  showWindow();
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(fn, 300));
  else fn();
}

// Electron can garbage-collect Notification objects, which drops their click handlers.
const liveNotes = new Set();
function notify(entry) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: entry.title, body: entry.body || '', silent: false });
  liveNotes.add(note);
  const forget = () => liveNotes.delete(note);
  note.on('click', () => {
    forget();
    notifications.setRead([entry.id]);
    notificationsChanged();
    whenUiReady(() => send('notifications:focus', entry.id));
  });
  note.on('close', forget);
  note.show();
  setTimeout(forget, 24 * 60 * 60 * 1000);
}

// Filters events by your preferences, records them, and shows banners.
function deliver(events) {
  const p = prefs();
  const added = notifications.add(prs.applyPrefs(events, p));
  if (p.banners) for (const n of added) notify(n);
  if (added.length) notificationsChanged();
}

// ---- Claude session watcher: notify when a session finishes a turn ------------------
// Claude Code writes ~/.claude/sessions/<pid>.json with status busy|idle for each live session.
const sessionSeen = new Map(); // sessionId -> { status, since }
const snip = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 240);

function checkSessions() {
  const live = sessions.liveSessions();
  const minSeconds = prefs().sessionMinSeconds;
  for (const [id, cur] of live) {
    const since = cur.statusUpdatedAt || Date.now();
    const prev = sessionSeen.get(id);
    sessionSeen.set(id, { status: cur.status, since });
    if (!prev || prev.status === cur.status) continue;
    if (prev.status !== 'busy' || cur.status === 'busy') continue;
    const ranFor = (since - prev.since) / 1000;
    if (ranFor < minSeconds) continue;
    // Give Claude Code a moment to flush the final message to the transcript.
    setTimeout(() => {
      const s = sessions.getSession(id);
      const title = (s && s.title) || cur.name || 'Claude session';
      const mins = ranFor >= 90 ? `${Math.round(ranFor / 60)} min` : `${Math.round(ranFor)} s`;
      deliver([
        {
          kind: 'session',
          sessionId: id,
          cwd: (s && s.cwd) || cur.cwd || '',
          gitBranch: (s && s.gitBranch) || '',
          ranFor,
          title: `Claude finished: ${title}`,
          body: snip(s && s.lastAssistant) || `Done after ${mins}. Waiting for you.`,
          lastPrompt: snip(s && s.lastPrompt),
        },
      ]);
    }, 1500);
  }
  for (const id of [...sessionSeen.keys()]) if (!live.has(id)) sessionSeen.delete(id);
}

// ---- "Claude needs you" events written by the Claude Code hooks (lib/hooks.js) ----------
const ATTENTION_HEAD = {
  permission: 'Claude needs permission',
  question: 'Claude has a question',
  plan: 'Claude has a plan to approve',
  input: 'Claude needs your input',
};
const lastAttention = new Map(); // `${session}|${reason}|${body}` -> time, to collapse repeats

function drainInbox() {
  let files = [];
  try {
    files = fs.readdirSync(hooks.INBOX).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return;
  }
  const events = [];
  for (const f of files) {
    const full = path.join(hooks.INBOX, f);
    try {
      events.push(JSON.parse(fs.readFileSync(full, 'utf8')));
    } catch {
      /* skip unreadable */
    }
    try {
      fs.unlinkSync(full);
    } catch {
      /* already gone */
    }
  }
  const now = Date.now();
  const notes = [];
  for (const ev of events) {
    if (now - new Date(ev.at).getTime() > 10 * 60 * 1000) continue; // stale (Baton wasn't running)
    const key = `${ev.sessionId}|${ev.reason}|${ev.body}`;
    if (now - (lastAttention.get(key) || 0) < 60 * 1000) continue;
    lastAttention.set(key, now);
    const s = sessions.getSession(ev.sessionId);
    const name = (s && s.title) || path.basename(ev.cwd || '') || 'Claude session';
    notes.push({
      kind: 'attention',
      reason: ev.reason,
      sessionId: ev.sessionId,
      cwd: (s && s.cwd) || ev.cwd || '',
      gitBranch: (s && s.gitBranch) || '',
      title: `${ATTENTION_HEAD[ev.reason] || 'Claude needs you'}: ${name}`,
      body: ev.body,
    });
  }
  if (notes.length) deliver(notes);
}

async function pollPRs() {
  if (prInflight) return prInflight;
  prInflight = (async () => {
    try {
      const data = prs.annotate(await github.fetchPRs());
      const { notes, state } = prs.diff(readJSON(PR_STATE, {}), data);
      writeJSON(PR_STATE, state);
      writeJSON(PR_CACHE, data);
      prData = data;
      prError = '';
      deliver(notes);
    } catch (e) {
      prError = e.message;
    } finally {
      prInflight = null;
      updateBadge(); // re-apply in case notification permission was granted since the last check
      send('prs:updated', { data: prData, error: prError });
    }
  })();
  return prInflight;
}

ipcMain.handle('github:cached', () => prData);

ipcMain.handle('notifications:list', () => notifications.read());
ipcMain.handle('notifications:setRead', (_e, { ids, read }) => {
  notifications.setRead(ids, read !== false);
  notificationsChanged();
});
ipcMain.handle('notifications:remove', (_e, ids) => {
  notifications.remove(ids);
  notificationsChanged();
});
ipcMain.handle('notifications:clearAll', () => {
  notifications.clearAll();
  notificationsChanged();
});
ipcMain.handle('notifications:clearRead', () => {
  notifications.clearRead();
  notificationsChanged();
});
ipcMain.handle('github:refresh', async () => {
  await pollPRs();
  return prError ? { error: prError, data: prData } : { data: prData };
});

ipcMain.handle('settings:get', () => ({
  ...settings(),
  notify: prefs(),
  // Repos you can mute: everything currently in your PR lists plus anything already muted.
  repos: [...new Set([...(prData ? [...prData.mine, ...prData.review].map((p) => p.repo) : []), ...prefs().mutedRepos])].sort(),
  openAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
  canLaunchAtLogin: app.isPackaged,
}));
ipcMain.handle('settings:set', (_e, patch) => {
  const { openAtLogin, notify, ...rest } = patch || {};
  if (typeof openAtLogin === 'boolean' && app.isPackaged) app.setLoginItemSettings({ openAtLogin, openAsHidden: true });
  const cur = settings();
  writeJSON(SETTINGS, { ...cur, ...rest, ...(notify ? { notify: { ...prefs(), ...notify } } : {}) });
  if (notify && 'dockBadge' in notify) updateBadge();
  send('settings:changed');
  return true;
});

ipcMain.handle('hooks:status', () => hooks.status());
ipcMain.handle('hooks:install', () => hooks.install());
ipcMain.handle('hooks:uninstall', () => hooks.uninstall());

ipcMain.handle('skill:status', () => skill.status());
ipcMain.handle('skill:install', () => skill.install());

// Push updates to the UI when the CLI (/task skill) writes tasks or sessions change.
function watch() {
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  const timers = {};
  const ping = (channel) => {
    clearTimeout(timers[channel]);
    timers[channel] = setTimeout(() => send(channel), 150);
  };
  fs.watch(store.DATA_DIR, (_ev, name) => name && name.startsWith('tasks.json') && ping('tasks:changed'));
  try {
    fs.watch(sessions.LIVE_DIR, () => {
      ping('sessions:changed');
      clearTimeout(timers.check);
      timers.check = setTimeout(checkSessions, 300);
    });
  } catch {
    /* no live sessions dir yet */
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

app.whenReady().then(() => {
  // First run of the installed app: start at login so PR notifications keep working.
  const s = readJSON(SETTINGS, {});
  if (app.isPackaged && !s.loginItemConfigured) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    writeJSON(SETTINGS, { ...s, loginItemConfigured: true });
  }
  const atLogin = app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;
  if (!atLogin) createWindow();
  watch();
  updateBadge();
  introduceNotifications();
  pollPRs();
  setInterval(pollPRs, POLL_MS);
  checkSessions(); // seed current statuses silently
  setInterval(checkSessions, 5000);
  fs.mkdirSync(hooks.INBOX, { recursive: true });
  drainInbox();
  try {
    let t;
    fs.watch(hooks.INBOX, () => {
      clearTimeout(t);
      t = setTimeout(drainInbox, 200);
    });
  } catch {
    /* fall back to polling below */
  }
  setInterval(drainInbox, 5000);
  app.on('activate', showWindow);
  app.on('browser-window-focus', updateBadge);
});
// Keep running in the background (Dock icon stays) so the PR watcher can notify you.
app.on('window-all-closed', () => {});
