// Captures the landing-page screenshots from the demo data (no real accounts involved).
//
//   node scripts/demo/make-demo.js /tmp/baton-demo
//   BATON_HOME=/tmp/baton-demo/baton CLAUDE_CONFIG_DIR=/tmp/baton-demo/claude BATON_OFFLINE=1 \
//     npx electron scripts/demo/screenshots.js docs/assets/screens
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const outDir = path.resolve(process.argv[2] || 'docs/assets/screens');
fs.mkdirSync(outDir, { recursive: true });
// A throwaway profile so saved UI preferences (filters, pane widths) start from defaults.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'baton-shots-')));

const clickView = (v) => `document.querySelector('[data-view=${v}]').click();`;
const pick = (text) => `[...document.querySelectorAll('#list .item')].find((i) => i.textContent.includes(${JSON.stringify(text)})).click();`;
const button = (text) => `[...document.querySelectorAll('#detail button, dialog[open] button')].find((b) => b.textContent.includes(${JSON.stringify(text)})).click();`;
const closeDialogs = `document.querySelectorAll('dialog[open]').forEach((d) => d.close());`;

const SCENES = [
  ['tasks', `${clickView('open')} ${pick('Ship Checkout v2')}`],
  ['pull-requests', `${clickView('prs')} setTimeout(() => { ${pick('Wire the checkout form')} }, 200);`, 1600],
  ['conversation', `${clickView('prs')} ${pick('Wire the checkout form')} setTimeout(() => { const h = [...document.querySelectorAll('#detail h3')].find((x) => x.textContent.startsWith('Conversation')); document.querySelector('#detail').scrollTop = h.closest('.card').offsetTop - 20; }, 900);`, 1500],
  ['notifications', `${clickView('notifications')} ${pick('Claude has a question')}`],
  ['start-claude', `${clickView('open')} ${pick('Speed up invoice PDFs')} setTimeout(() => { ${button('Start with Claude')} }, 200);`],
  ['merge', `${clickView('prs')} ${pick('flaky invoice export')} setTimeout(() => { ${button('Merge')} }, 300);`],
  ['reviews', `${clickView('reviews')} ${pick('typo-tolerant')} setTimeout(() => { ${button('Approve')} }, 300);`],
  ['session', `${clickView('sessions')} ${pick('Flaky invoice export test')}`],
  ['settings', `${clickView('settings')}`],
];

app.on('browser-window-created', (_e, win) => {
  win.setSize(1440, 900);
  win.webContents.on('console-message', (e) => e.level === 'error' && console.log('[renderer]', e.message));
  win.webContents.once('did-finish-load', async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(1500);
    for (const [name, js, wait = 900] of SCENES) {
      await win.webContents.executeJavaScript(`${closeDialogs} ${js}`);
      await sleep(wait);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
      console.log('captured', name, img.getSize());
    }
    app.exit(0);
  });
});

require('../../src/main.js');
