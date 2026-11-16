// Task store shared by the Electron app and the `baton` CLI (used by the /task skill).
// Plain JSON file at ~/.baton/tasks.json, written atomically.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DATA_DIR = process.env.BATON_HOME || path.join(os.homedir(), '.baton');

// One-time move from the app's previous name.
const LEGACY_DIR = path.join(os.homedir(), '.cnotes');
if (!process.env.BATON_HOME && !fs.existsSync(DATA_DIR) && fs.existsSync(LEGACY_DIR)) {
  try {
    fs.renameSync(LEGACY_DIR, DATA_DIR);
  } catch {
    /* fall through: start fresh rather than crash */
  }
}
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readTasks() {
  try {
    const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    return Array.isArray(data.tasks) ? data.tasks.map(normalize) : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// Upgrades v1 tasks (single `session` + `context`) to multi-link shape.
function normalize(t) {
  if (!t || Array.isArray(t.sessions)) return { prs: [], summary: '', ...t };
  const { session, context, ...rest } = t;
  const sessions = session ? [{ ...session, context: context ? { recent: context.recent || [], lastPrompt: context.lastPrompt || '', capturedAt: context.capturedAt } : null }] : [];
  return { ...rest, sessions, prs: rest.prs || [], summary: (context && context.summary) || '' };
}

function writeTasks(tasks) {
  ensureDir();
  const tmp = `${TASKS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks }, null, 2));
  fs.renameSync(tmp, TASKS_FILE);
}

function newTask(fields) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: '',
    notes: '',
    status: 'todo', // todo | doing | done
    priority: 'normal', // low | normal | high
    summary: '', // agent handoff written by the /task skill
    sessions: [], // [{ id, cwd, title, gitBranch, context: { recent: [{role,text}], lastPrompt, capturedAt } }]
    prs: [], // [{ url, number, title, repo }]
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

function addTask(fields) {
  const tasks = readTasks();
  const task = newTask(fields);
  tasks.unshift(task);
  writeTasks(tasks);
  return task;
}

function saveTask(task) {
  const tasks = readTasks();
  const i = tasks.findIndex((t) => t.id === task.id);
  const updated = { ...normalize(task), updatedAt: new Date().toISOString() };
  if (i === -1) {
    if (!updated.id) delete updated.id;
    tasks.unshift(newTask(updated));
    updated.id = tasks[0].id;
  }
  else tasks[i] = updated;
  writeTasks(tasks);
  return i === -1 ? tasks[0] : updated;
}

function deleteTask(id) {
  writeTasks(readTasks().filter((t) => t.id !== id));
}

module.exports = { normalize, DATA_DIR, TASKS_FILE, readTasks, writeTasks, addTask, saveTask, deleteTask };
