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
  return { notifyReady: true, notifyComments: true, ...readJSON(SETTINGS, {}) };
}

let prData = readJSON(PR_CACHE, null);
let prError = '';
let prInflight = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- notification history + Dock badge ----
function updateBadge() {
  const n = notifications.unreadCount();
  if (app.dock) app.dock.setBadge(n ? String(n > 99 ? '99+' : n) : '');
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
      // Everything goes into the history; the toggles only control the macOS banner.
      const added = notifications.add(notes);
      const s = settings();
      for (const n of added) {
        if ((n.kind === 'ready' && s.notifyReady) || (n.kind === 'comment' && s.notifyComments)) notify(n);
      }
      if (added.length) notificationsChanged();
    } catch (e) {
      prError = e.message;
    } finally {
      prInflight = null;
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
  openAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
  canLaunchAtLogin: app.isPackaged,
}));
ipcMain.handle('settings:set', (_e, patch) => {
  const { openAtLogin, ...rest } = patch || {};
  if (typeof openAtLogin === 'boolean' && app.isPackaged) app.setLoginItemSettings({ openAtLogin, openAsHidden: true });
  writeJSON(SETTINGS, { ...readJSON(SETTINGS, {}), ...rest });
  return true;
});

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
    fs.watch(sessions.LIVE_DIR, () => ping('sessions:changed'));
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
  pollPRs();
  setInterval(pollPRs, POLL_MS);
  app.on('activate', showWindow);
});
// Keep running in the background (Dock icon stays) so the PR watcher can notify you.
app.on('window-all-closed', () => {});
