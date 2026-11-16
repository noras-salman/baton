// Installs the /task skill into ~/.claude/skills/task, pointing it at this checkout's CLI.
const fs = require('fs');
const path = require('path');
const { CLAUDE_DIR } = require('./sessions');

// Inside the packaged app the CLI is unpacked from app.asar so plain `node` can run it.
const CLI = path.resolve(__dirname, '..', 'bin', 'baton.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const TEMPLATE = path.resolve(__dirname, '..', 'skill', 'SKILL.md');
const SKILL_FILE = path.join(CLAUDE_DIR, 'skills', 'task', 'SKILL.md');

function render() {
  return fs.readFileSync(TEMPLATE, 'utf8').replaceAll('__BATON_CLI__', CLI);
}

function status() {
  try {
    return { installed: true, current: fs.readFileSync(SKILL_FILE, 'utf8') === render(), path: SKILL_FILE };
  } catch {
    return { installed: false, current: false, path: SKILL_FILE };
  }
}

function install() {
  fs.mkdirSync(path.dirname(SKILL_FILE), { recursive: true });
  fs.writeFileSync(SKILL_FILE, render());
  return SKILL_FILE;
}

module.exports = { CLI, SKILL_FILE, status, install };
