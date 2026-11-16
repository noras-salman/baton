// Reads Claude Code sessions straight from the existing local setup (~/.claude).
// No auth involved: transcripts are plain JSONL files on disk.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const LIVE_DIR = path.join(CLAUDE_DIR, 'sessions');

// Transcripts can be 100MB+, so only the head and tail of each file are read.
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 512 * 1024;

const cache = new Map(); // file -> { mtimeMs, size, info }

function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.toString('utf8', 0, n);
}

function parseLines(text, dropFirst, dropLast) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partial line */
    }
  }
  return out;
}

const NOISE_TAGS = /<(ide_opened_file|ide_selection|system-reminder|command-message|command-args|local-command-stdout|local-command-caveat|pasted_content)[^>]*>[\s\S]*?<\/\1>/g;

function cleanText(s) {
  return String(s || '')
    .replace(NOISE_TAGS, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .replace(/\s+\n/g, '\n')
    .trim();
}

// Returns human-written text of a user/assistant record, or '' for tool calls/results.
function messageText(rec) {
  const c = rec.message && rec.message.content;
  if (typeof c === 'string') return cleanText(c);
  if (!Array.isArray(c)) return '';
  return cleanText(
    c
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n'),
  );
}

function isRealUserPrompt(rec) {
  if (rec.type !== 'user' || rec.isSidechain || rec.isMeta) return false;
  if (rec.toolUseResult) return false;
  const c = rec.message && rec.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return false;
  return true;
}

function extract(records, info, fromTail) {
  for (const r of records) {
    if (!info.cwd && r.cwd) info.cwd = r.cwd;
    if (r.gitBranch && (fromTail || !info.gitBranch)) info.gitBranch = r.gitBranch;
    if (r.type === 'custom-title' && (r.customTitle || r.title)) info.customTitle = r.customTitle || r.title;
    if (r.type === 'ai-title' && r.aiTitle) info.aiTitle = r.aiTitle;
    if (r.type === 'summary' && r.summary) info.summary = r.summary;
    if (r.type === 'last-prompt' && r.lastPrompt) info.lastPrompt = cleanText(r.lastPrompt);
    if (r.type === 'pr-link' && r.prUrl) {
      info.prUrl = r.prUrl;
      info.prUrls.add(r.prUrl);
    }
    if (r.timestamp && !info.startedAt && !fromTail) info.startedAt = r.timestamp;

    if (isRealUserPrompt(r)) {
      const t = messageText(r);
      if (t) {
        if (!info.firstPrompt && !fromTail) info.firstPrompt = t;
        info.recent.push({ role: 'user', text: t, ts: r.timestamp });
      }
    } else if (r.type === 'assistant' && !r.isSidechain) {
      const t = messageText(r);
      if (t) info.recent.push({ role: 'assistant', text: t, ts: r.timestamp });
    }
  }
}

function scanFile(file, stat) {
  const fd = fs.openSync(file, 'r');
  try {
    const info = {
      id: path.basename(file, '.jsonl'),
      file,
      size: stat.size,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      recent: [],
      prUrls: new Set(),
    };
    if (stat.size <= HEAD_BYTES + TAIL_BYTES) {
      extract(parseLines(readRange(fd, 0, stat.size), false, false), info, false);
    } else {
      extract(parseLines(readRange(fd, 0, HEAD_BYTES), false, true), info, false);
      const headRecent = info.recent;
      info.recent = [];
      extract(parseLines(readRange(fd, stat.size - TAIL_BYTES, TAIL_BYTES), true, false), info, true);
      if (!info.recent.length) info.recent = headRecent;
    }
    info.title = info.customTitle || info.aiTitle || info.summary || truncate(info.firstPrompt, 80) || '(untitled session)';
    info.recent = dedupe(info.recent).slice(-8).map((m) => ({ ...m, text: truncate(m.text, 4000) }));
    info.lastAssistant = [...info.recent].reverse().find((m) => m.role === 'assistant')?.text || '';
    info.prUrls = [...info.prUrls];
    info.hasConversation = Boolean(info.firstPrompt || info.recent.length);
    return info;
  } finally {
    fs.closeSync(fd);
  }
}

function dedupe(msgs) {
  const out = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && prev.text === m.text) continue;
    out.push(m);
  }
  return out;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Finds every PR the session created or touched. Transcripts are append-only, so after the
// first full pass only newly appended bytes are scanned.
const PR_RE = /"prUrl":"(https:\/\/[^"]+)"/g;
function scanPrLinks(file, size, prev) {
  let offset = prev && prev.offset <= size ? prev.offset : 0;
  const urls = new Set(offset ? prev.urls : []);
  let chunk = 8 * 1024 * 1024;
  const fd = fs.openSync(file, 'r');
  try {
    while (offset < size) {
      const len = Math.min(chunk, size - offset);
      const text = readRange(fd, offset, len);
      const end = text.lastIndexOf('\n');
      if (end === -1) {
        if (offset + len >= size) break; // incomplete trailing line; pick it up next time
        chunk *= 2; // a single line longer than the chunk (e.g. inline images)
        continue;
      }
      chunk = 8 * 1024 * 1024;
      const complete = text.slice(0, end + 1);
      if (complete.includes('"pr-link"')) for (const m of complete.matchAll(PR_RE)) urls.add(m[1]);
      offset += Buffer.byteLength(complete);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { offset, urls: [...urls] };
}

function liveSessions() {
  const live = new Map();
  let files = [];
  try {
    files = fs.readdirSync(LIVE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return live;
  }
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, f), 'utf8'));
      if (!s.sessionId || !s.pid) continue;
      try {
        process.kill(s.pid, 0); // throws if the process is gone
      } catch (e) {
        if (e.code !== 'EPERM') continue;
      }
      live.set(s.sessionId, { pid: s.pid, status: s.status, entrypoint: s.entrypoint, name: s.name, cwd: s.cwd });
    } catch {
      /* ignore */
    }
  }
  return live;
}

function listSessions({ limit = 200 } = {}) {
  const entries = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      try {
        const stat = fs.statSync(file);
        entries.push({ file, stat });
      } catch {
        /* vanished */
      }
    }
  }
  entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const live = liveSessions();
  const out = [];
  for (const { file, stat } of entries) {
    if (out.length >= limit) break;
    let hit = cache.get(file);
    if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size) {
      try {
        const prev = hit;
        hit = { mtimeMs: stat.mtimeMs, size: stat.size, info: scanFile(file, stat) };
        hit.pr = scanPrLinks(file, stat.size, prev && prev.pr);
        hit.info.prUrls = [...new Set([...hit.info.prUrls, ...hit.pr.urls])];
        cache.set(file, hit);
      } catch {
        continue;
      }
    }
    if (!hit.info.hasConversation) continue;
    const l = live.get(hit.info.id);
    out.push({ ...hit.info, live: l || null, cwd: hit.info.cwd || (l && l.cwd) || '' });
  }
  return out;
}

function getSession(id) {
  return listSessions({ limit: 100000 }).find((s) => s.id === id) || null;
}

// Link record stored on a task; the context snapshot survives even if the transcript is deleted.
function sessionLink(session) {
  return {
    id: session.id,
    cwd: session.cwd,
    title: session.title,
    gitBranch: session.gitBranch || '',
    context: { lastPrompt: session.lastPrompt || '', recent: session.recent.slice(-6), capturedAt: new Date().toISOString() },
  };
}

module.exports = { CLAUDE_DIR, PROJECTS_DIR, LIVE_DIR, listSessions, getSession, sessionLink };
