const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('api', {
  listTasks: invoke('tasks:list'),
  saveTask: invoke('tasks:save'),
  deleteTask: invoke('tasks:delete'),
  listSessions: invoke('sessions:list'),
  sessionLink: invoke('sessions:link'),
  resume: invoke('session:resume'),
  resumeCommand: invoke('session:command'),
  copy: invoke('clipboard:write'),
  openFolder: invoke('open:folder'),
  openVSCode: invoke('open:vscode'),
  openUrl: invoke('open:url'),
  cachedPRs: invoke('github:cached'),
  refreshPRs: invoke('github:refresh'),
  skillStatus: invoke('skill:status'),
  installSkill: invoke('skill:install'),
  on: (channel, fn) => {
    if (['tasks:changed', 'sessions:changed'].includes(channel)) ipcRenderer.on(channel, () => fn());
  },
});
