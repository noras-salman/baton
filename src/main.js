const { app, BrowserWindow, ipcMain, clipboard, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const store = require('../lib/store');
const sessions = require('../lib/sessions');
const skill = require('../lib/skill');
const github = require('../lib/github');

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

// GitHub PRs via the local `gh` login. Last result is cached on disk so startup is instant.
const PR_CACHE = path.join(store.DATA_DIR, 'prs-cache.json');
let prInflight = null;
ipcMain.handle('github:cached', () => {
  try {
    return JSON.parse(fs.readFileSync(PR_CACHE, 'utf8'));
  } catch {
    return null;
  }
});
ipcMain.handle('github:refresh', async () => {
  prInflight = prInflight || github.fetchPRs().finally(() => (prInflight = null));
  try {
    const data = await prInflight;
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    fs.writeFileSync(PR_CACHE, JSON.stringify(data));
    return { data };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('skill:status', () => skill.status());
ipcMain.handle('skill:install', () => skill.install());

// Push updates to the UI when the CLI (/task skill) writes tasks or sessions change.
function watch() {
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  let t;
  const ping = (channel) => {
    clearTimeout(t);
    t = setTimeout(() => win && !win.isDestroyed() && win.webContents.send(channel), 150);
  };
  fs.watch(store.DATA_DIR, (_ev, name) => name && name.startsWith('tasks.json') && ping('tasks:changed'));
  try {
    fs.watch(sessions.LIVE_DIR, () => ping('sessions:changed'));
  } catch {
    /* no live sessions dir yet */
  }
}

app.whenReady().then(() => {
  createWindow();
  watch();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => app.quit());
