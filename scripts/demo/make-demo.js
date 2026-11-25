#!/usr/bin/env node
// Builds a fully fictional Baton + Claude Code setup for screenshots and demos.
//
//   node scripts/demo/make-demo.js <dir>
//   BATON_HOME=<dir>/baton CLAUDE_CONFIG_DIR=<dir>/claude BATON_OFFLINE=1 npm start
//
// Nothing here comes from a real account: repo "acme/rocket", teammates @maya,
// @devon, @priya, and the conversations are all made up.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(process.argv[2] || '/tmp/baton-demo');
const claudeDir = path.join(root, 'claude');
const batonDir = path.join(root, 'baton');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
fs.mkdirSync(batonDir, { recursive: true });

// Keep lib/* pointed at the demo dirs.
process.env.BATON_HOME = batonDir;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
const prs = require('../../lib/prs');

const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60 * 1000).toISOString();
const ME = 'alex';
const HOME = '/Users/alex';
const REPO = 'acme/rocket';
const CWD = `${HOME}/code/rocket`;
const pr = (n) => `https://github.com/${REPO}/pull/${n}`;

// ---- Claude Code sessions -------------------------------------------------------------
const SESSIONS = [
  {
    id: '6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b',
    title: 'Checkout v2: payment intents',
    branch: 'checkout/1-payment-intents',
    minutesAgo: 1,
    prs: [pr(141), pr(142), pr(143)],
    live: 'busy',
    convo: [
      ['user', 'Split checkout v2 into a stack: payment intents API, then the form, then receipts. Keep each PR small.'],
      ['assistant', 'Plan:\n1. **#141** adds `POST /payment-intents` and the idempotency key table\n2. **#142** wires `CheckoutForm` to it and handles 3-D Secure\n3. **#143** shows the receipt page\n\nStarting with the API layer.'],
      ['user', 'Maya asked for retries on 409s in #142. Can you handle that?'],
      ['assistant', 'Added a retry with backoff for `409 Conflict` in `useCreateIntent`, plus a test that replays the same idempotency key. Pushed to `checkout/2-form`; CI is running.'],
    ],
  },
  {
    id: '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d',
    title: 'Flaky invoice export test',
    branch: 'fix/invoice-export-flake',
    minutesAgo: 34,
    prs: [pr(138)],
    live: 'idle',
    convo: [
      ['user', 'invoice export test fails about 1 in 10 runs on CI. find out why'],
      ['assistant', 'The test sorts invoices by `created_at`, but two fixtures share the same timestamp, so Postgres returns them in either order. Sorting by `(created_at, id)` makes it deterministic. Ran it 200 times locally with no failures.'],
    ],
  },
  {
    id: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
    title: 'Slow invoice PDFs',
    branch: 'main',
    minutesAgo: 190,
    prs: [],
    convo: [
      ['user', 'invoice PDFs take 6s to render for big customers'],
      ['assistant', 'Most of the time is spent loading every line item’s product image at full size. Thumbnails would cut it to under a second. I stopped before changing the image pipeline since it’s shared with the storefront.'],
    ],
  },
  {
    id: '9e8d7c6b-5a4f-4e3d-b2c1-a0f9e8d7c6b5',
    title: 'Exchange rate caching',
    branch: 'perf/cache-fx-rates',
    minutesAgo: 75,
    prs: [pr(140)],
    convo: [
      ['user', 'cache exchange rates for an hour instead of fetching per request'],
      ['assistant', 'Added an in-memory cache with a 1-hour TTL and a fallback to the last good value if the provider is down. PR #140 is open.'],
    ],
  },
];

function transcript(s) {
  const lines = [];
  let t = s.minutesAgo + s.convo.length * 6;
  let parent = null;
  s.convo.forEach(([role, text], i) => {
    const uuid = `${s.id.slice(0, 8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
    lines.push({
      type: role,
      uuid,
      parentUuid: parent,
      sessionId: s.id,
      cwd: CWD,
      gitBranch: s.branch,
      entrypoint: 'claude-vscode',
      isSidechain: false,
      timestamp: ago(t),
      message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
    });
    parent = uuid;
    t -= 6;
  });
  lines.push({ type: 'ai-title', aiTitle: s.title, sessionId: s.id });
  lines.push({ type: 'last-prompt', lastPrompt: [...s.convo].reverse().find(([r]) => r === 'user')[1], sessionId: s.id });
  for (const url of s.prs) lines.push({ type: 'pr-link', prUrl: url, prNumber: Number(url.split('/').pop()), prRepository: REPO, sessionId: s.id, timestamp: ago(s.minutesAgo) });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

const projDir = path.join(claudeDir, 'projects', CWD.replace(/\//g, '-'));
fs.mkdirSync(projDir, { recursive: true });
for (const s of SESSIONS) {
  const file = path.join(projDir, `${s.id}.jsonl`);
  fs.writeFileSync(file, transcript(s));
  const mtime = new Date(NOW - s.minutesAgo * 60 * 1000);
  fs.utimesSync(file, mtime, mtime);
}

// "Live" sessions need a running pid; borrow long-lived system processes.
const livePids = ['launchd', 'loginwindow', 'Dock', 'Finder', 'systemd', 'init']
  .map((name) => {
    try {
      return Number(execSync(`pgrep -x ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n')[0]);
    } catch {
      return 0;
    }
  })
  .filter(Boolean);
if (!livePids.includes(1)) livePids.unshift(1);
SESSIONS.filter((s) => s.live).forEach((s, i) => {
  const pid = livePids[i];
  fs.writeFileSync(
    path.join(claudeDir, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId: s.id, cwd: CWD, status: s.live, statusUpdatedAt: NOW - 60000, entrypoint: 'claude-vscode', kind: 'interactive', name: s.title }),
  );
});

// ---- Pull requests ---------------------------------------------------------------------
const OPTS = { methods: ['SQUASH', 'MERGE', 'REBASE'], defaultMethod: 'SQUASH', autoMergeAllowed: true, deletesBranch: true };
const base = (o) => ({
  repo: REPO,
  author: ME,
  draft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: 'APPROVED',
  checks: 'SUCCESS',
  unresolvedThreads: 0,
  awaitingReply: 0,
  incoming: [],
  additions: 120,
  deletions: 14,
  headSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  autoMerge: null,
  mergeOptions: OPTS,
  createdAt: ago(60 * 26),
  ...o,
  url: pr(o.number),
});
const mine = [
  base({ number: 141, title: 'Checkout v2 [1/3]: Add the payment intents API', branch: 'checkout/1-payment-intents', base: 'main', updatedAt: ago(3), additions: 412, deletions: 18 }),
  base({ number: 142, title: 'Checkout v2 [2/3]: Wire the checkout form to payment intents', branch: 'checkout/2-form', base: 'checkout/1-payment-intents', updatedAt: ago(2), checks: 'PENDING', reviewDecision: 'CHANGES_REQUESTED', unresolvedThreads: 1, awaitingReply: 1, additions: 286, deletions: 41 }),
  base({ number: 143, title: 'Checkout v2 [3/3]: Show a receipt after checkout', branch: 'checkout/3-receipts', base: 'checkout/2-form', updatedAt: ago(9), reviewDecision: 'REVIEW_REQUIRED', additions: 198, deletions: 6 }),
  base({ number: 138, title: 'Fix the flaky invoice export test', branch: 'fix/invoice-export-flake', base: 'main', updatedAt: ago(30), additions: 12, deletions: 3 }),
  base({ number: 140, title: 'Cache exchange rates for an hour', branch: 'perf/cache-fx-rates', base: 'main', updatedAt: ago(12), checks: 'PENDING', reviewDecision: 'REVIEW_REQUIRED', additions: 88, deletions: 9 }),
  base({ number: 133, title: 'Upgrade the API to Node 22', branch: 'chore/node-22', base: 'main', updatedAt: ago(60 * 30), draft: true, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'CONFLICTING', additions: 54, deletions: 47 }),
];
const review = [
  base({ number: 145, author: 'maya', title: 'Search [1/2]: Index products by SKU and title', branch: 'search/1-index', base: 'main', updatedAt: ago(20), reviewDecision: 'REVIEW_REQUIRED' }),
  base({ number: 146, author: 'maya', title: 'Search [2/2]: Add typo-tolerant product search', branch: 'search/2-fuzzy', base: 'search/1-index', updatedAt: ago(18), reviewDecision: 'REVIEW_REQUIRED', checks: 'PENDING' }),
  base({ number: 139, author: 'devon', title: 'Send the weekly digest at 9am in each user’s time zone', branch: 'digest/timezones', base: 'main', updatedAt: ago(45), reviewDecision: 'REVIEW_REQUIRED', unresolvedThreads: 2 }),
  base({ number: 144, author: 'priya', title: 'Retry webhooks with exponential backoff', branch: 'webhooks/backoff', base: 'main', updatedAt: ago(70), reviewDecision: 'APPROVED' }),
  base({ number: 136, author: 'priya', title: 'Move feature flags to the config service', branch: 'flags/config-service', base: 'main', updatedAt: ago(60 * 20), draft: true, reviewDecision: 'REVIEW_REQUIRED' }),
];
const prData = prs.annotate({ viewer: ME, mine, review, fetchedAt: new Date().toISOString() });
fs.writeFileSync(path.join(batonDir, 'prs-cache.json'), JSON.stringify(prData));

fs.writeFileSync(
  path.join(batonDir, 'demo-conversations.json'),
  JSON.stringify({
    [pr(142)]: {
      url: pr(142),
      description: {
        author: ME,
        at: ago(60 * 5),
        body: '## What\nThe checkout form now creates a **payment intent** before charging, so a double click can no longer charge twice.\n\n## How\n- `useCreateIntent` sends an idempotency key per cart\n- 3-D Secure challenges open in a modal\n- Errors map to friendly messages\n\nPart 2 of 3 in the Checkout v2 stack.',
      },
      comments: [],
      reviews: [
        { id: 'r1', login: 'review-bot', bot: true, state: 'COMMENTED', at: ago(60 * 4), url: pr(142), body: 'Checked against the checkout guidelines.\n\n| Check | Result |\n|---|---|\n| Idempotency key per cart | ✅ |\n| 3-D Secure handled | ✅ |\n| Retries on `409` | ⚠️ missing |' },
        { id: 'r2', login: 'maya', bot: false, state: 'CHANGES_REQUESTED', at: ago(60 * 3), url: pr(142), body: 'Looks great overall. One thing before this merges: we need to retry on `409 Conflict`.' },
      ],
      threads: [
        {
          id: 't1',
          resolved: false,
          outdated: false,
          path: 'src/checkout/useCreateIntent.ts',
          line: 42,
          comments: [
            { id: 'c1', login: 'maya', bot: false, at: ago(60 * 3), url: pr(142), body: 'If the intent already exists the API returns `409`. Can we retry with the **same** idempotency key instead of failing?' },
            { id: 'c2', login: ME, bot: false, at: ago(4), url: pr(142), body: 'Good catch. Added a retry with backoff in the latest push:\n```ts\nif (res.status === 409) return retry(key);\n```' },
          ],
        },
        { id: 't2', resolved: true, outdated: false, path: 'src/checkout/CheckoutForm.tsx', line: 88, comments: [{ id: 'c3', login: 'devon', bot: false, at: ago(60 * 4), url: pr(142), body: 'Nit: disable the button while the intent is being created.' }] },
      ],
    },
  }),
);

// ---- Tasks -----------------------------------------------------------------------------
const link = (s) => ({
  id: s.id,
  cwd: CWD,
  title: s.title,
  gitBranch: s.branch,
  context: { lastPrompt: s.convo.filter(([r]) => r === 'user').pop()[1], recent: s.convo.slice(-4).map(([role, text]) => ({ role, text })), capturedAt: ago(s.minutesAgo) },
});
const prRef = (p) => ({ url: p.url, number: p.number, title: p.title, repo: REPO });
const task = (o) => ({ notes: '', priority: 'normal', summary: '', sessions: [], prs: [], folder: CWD, createdAt: ago(o.age || 60), updatedAt: ago(o.age ? o.age / 2 : 30), ...o });
const tasks = [
  task({
    id: 't-checkout',
    title: 'Ship Checkout v2',
    status: 'doing',
    priority: 'high',
    age: 60 * 6,
    notes: 'Merge the stack bottom-up once Maya approves #142.',
    summary:
      '- **Goal:** replace direct charges with payment intents, in a 3-PR stack\n- **Done:** #141 approved; #142 now retries on `409` (CI running)\n- **Next:** reply to Maya on the retry thread, then get #143 reviewed\n- **Watch out:** refunds still use the legacy charge path until v2 ships',
    sessions: [link(SESSIONS[0])],
    prs: [mine[0], mine[1], mine[2]].map(prRef),
  }),
  task({ id: 't-invoices', title: 'Speed up invoice PDFs for large customers', status: 'todo', age: 60 * 3, notes: 'Invoices with 500+ line items take ~6s to render. Get it under 1s.\n- Use thumbnails instead of full-size product images\n- Don’t change how the storefront loads images; that pipeline is shared', sessions: [link(SESSIONS[2])], summary: '- Rendering loads every product image at full size\n- **Next:** generate thumbnails; check with the storefront team first, the image pipeline is shared' }),
  task({ id: 't-flaky', title: 'Land the invoice export flake fix', status: 'doing', age: 50, sessions: [link(SESSIONS[1])], prs: [prRef(mine[3])] }),
  task({ id: 't-ratelimit', title: 'Rate-limit the public API', status: 'todo', priority: 'low', age: 60 * 30, notes: '100 requests per minute per key; return `Retry-After`.' }),
  task({ id: 't-guide', title: 'Write the Node 22 upgrade notes', status: 'done', age: 60 * 50 }),
];
fs.writeFileSync(path.join(batonDir, 'tasks.json'), JSON.stringify({ version: 1, tasks }, null, 2));

// ---- Notifications ---------------------------------------------------------------------
const notes = [
  { kind: 'attention', reason: 'question', sessionId: SESSIONS[0].id, cwd: CWD, title: 'Claude has a question: Checkout v2: payment intents', body: 'Should refunds go through the new payment intents API, or keep the legacy charge path until v2 ships?', minutes: 1 },
  { kind: 'comment', url: pr(142), link: pr(142), repo: REPO, number: 142, prTitle: mine[1].title, prUrls: [pr(142)], title: '@maya requested changes on #142', body: 'Looks great overall. One thing before this merges: we need to retry on 409 Conflict.', comments: [{ author: 'maya', kind: 'requested changes', body: 'Looks great overall. One thing before this merges: we need to retry on `409 Conflict`.', url: pr(142), at: ago(180) }], minutes: 180 },
  { kind: 'ready', url: pr(138), link: pr(138), repo: REPO, number: 138, prTitle: mine[3].title, prUrls: [pr(138)], title: 'Ready to merge: rocket#138', body: mine[3].title, minutes: 28 },
  { kind: 'session', sessionId: SESSIONS[1].id, cwd: CWD, ranFor: 412, title: 'Claude finished: Flaky invoice export test', body: SESSIONS[1].convo[1][1], lastPrompt: SESSIONS[1].convo[0][1], minutes: 33 },
  { kind: 'review', url: pr(139), link: pr(139), repo: REPO, number: 139, prTitle: review[2].title, prUrls: [pr(139)], author: 'devon', title: 'Review requested by @devon: rocket#139', body: review[2].title, minutes: 45, read: true },
  { kind: 'ci', url: pr(133), link: `${pr(133)}/checks`, repo: REPO, number: 133, prTitle: mine[5].title, prUrls: [pr(133)], title: 'Checks failing on rocket#133', body: mine[5].title, minutes: 60 * 26, read: true },
];
fs.writeFileSync(
  path.join(batonDir, 'notifications.json'),
  JSON.stringify({ version: 1, items: notes.map(({ minutes, read, ...n }, i) => ({ id: `n${i}`, createdAt: ago(minutes), read: Boolean(read), ...n })) }),
);
fs.writeFileSync(path.join(batonDir, 'settings.json'), JSON.stringify({ notify: { banners: false }, defaultFolder: CWD, loginItemConfigured: true, notificationsIntroduced: true }));

console.log(`Demo data written to ${root}`);
console.log(`  BATON_HOME=${batonDir} CLAUDE_CONFIG_DIR=${claudeDir} BATON_OFFLINE=1 npm start`);
