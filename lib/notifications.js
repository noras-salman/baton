// Notification history: everything the PR watcher told you about, with read/unread state.
// Stored at ~/.baton/notifications.json, newest first.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./store');

const FILE = path.join(DATA_DIR, 'notifications.json');
const MAX = 500;

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(d.items) ? d.items : [];
  } catch {
    return [];
  }
}

function write(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: items.slice(0, MAX) }));
  fs.renameSync(tmp, FILE);
}

// note: { kind, url, link, title, body, repo, number, prTitle, authors }
function add(notes) {
  if (!notes.length) return [];
  const now = new Date().toISOString();
  const added = notes.map((n) => ({ id: crypto.randomUUID(), createdAt: now, read: false, ...n }));
  write([...added.reverse(), ...read()]);
  return added;
}

function setRead(ids, value = true) {
  const want = ids === 'all' ? null : new Set(ids);
  write(read().map((n) => (!want || want.has(n.id) ? { ...n, read: value } : n)));
}

function remove(ids) {
  const drop = new Set(ids);
  write(read().filter((n) => !drop.has(n.id)));
}

function clearAll() {
  write([]);
}

function clearRead() {
  write(read().filter((n) => !n.read));
}

const unreadCount = () => read().filter((n) => !n.read).length;

module.exports = { FILE, read, add, setRead, remove, clearAll, clearRead, unreadCount };
