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
  startSession: invoke('session:start'),
  pickFolder: invoke('dialog:pickFolder'),
  copy: invoke('clipboard:write'),
  openFolder: invoke('open:folder'),
  openVSCode: invoke('open:vscode'),
  openUrl: invoke('open:url'),
  cachedPRs: invoke('github:cached'),
  refreshPRs: invoke('github:refresh'),
  mergePR: invoke('github:merge'),
  disableAutoMerge: invoke('github:disableAutoMerge'),
  listNotifications: invoke('notifications:list'),
  setNotificationsRead: invoke('notifications:setRead'),
  removeNotifications: invoke('notifications:remove'),
  clearReadNotifications: invoke('notifications:clearRead'),
  clearAllNotifications: invoke('notifications:clearAll'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  hooksStatus: invoke('hooks:status'),
  installHooks: invoke('hooks:install'),
  uninstallHooks: invoke('hooks:uninstall'),
  skillStatus: invoke('skill:status'),
  installSkill: invoke('skill:install'),
  on: (channel, fn) => {
    if (['tasks:changed', 'sessions:changed', 'prs:updated', 'prs:focus', 'notifications:changed', 'notifications:focus', 'settings:changed'].includes(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
