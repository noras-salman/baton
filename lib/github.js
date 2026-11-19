// Fetches your open PRs using the GitHub CLI's existing login (gh auth) — no new credentials.
const { execFile } = require('child_process');
const fs = require('fs');

// Apps launched from Finder get a minimal PATH, so look in the usual install locations.
function ghPath() {
  for (const p of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']) {
    if (fs.existsSync(p)) return p;
  }
  return 'gh';
}

const AUTHOR = 'author { login __typename }';
const PR_FIELDS = `
  ... on PullRequest {
    number title url isDraft createdAt updatedAt
    headRefName baseRefName mergeable reviewDecision
    additions deletions
    ${AUTHOR}
    repository { nameWithOwner }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    reviewThreads(first: 60) {
      nodes { id isResolved comments(last: 1) { nodes { id ${AUTHOR} body url createdAt } } }
    }
    reviews(last: 15) { nodes { id state ${AUTHOR} body url submittedAt } }
    comments(last: 15) { nodes { id ${AUTHOR} body url createdAt } }
  }`;

// Small pages: large PR searches with nested threads tend to 502 on GitHub's side.
const PAGE = 15;
const searchQuery = (q, after) => `
query {
  viewer { login }
  search(query: "${q}", type: ISSUE, first: ${PAGE}${after ? `, after: "${after}"` : ''}) {
    pageInfo { hasNextPage endCursor }
    nodes { ${PR_FIELDS} }
  }
}`;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(ghPath(), args, { maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (err, out, stderr) => {
      if (err) {
        const msg = err.code === 'ENOENT' ? 'GitHub CLI (gh) not found. Install it with `brew install gh`.' : (stderr || err.message).trim();
        return reject(new Error(msg));
      }
      resolve(out);
    });
  });
}

const isBot = (a) => !a || a.__typename === 'Bot' || /\[bot\]$/.test(a.login || '');
// Bots plus AI review accounts that run as regular users (e.g. "*-review-agent").
const isAutomated = (a) => isBot(a) || /(^|[-_])(bot|agent|ai)([-_]|$)|review-?agent|copilot|coderabbit/i.test(a?.login || '');
// Plain-text preview of a markdown/HTML comment body.
const snippet = (s) =>
  String(s || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);

function normalize(n, viewer) {
  if (!n || !n.url) return null;
  const threads = n.reviewThreads?.nodes || [];
  const unresolved = threads.filter((t) => !t.isResolved);
  // A thread needs a response when someone other than you spoke last.
  const awaiting = unresolved.filter((t) => {
    const last = t.comments?.nodes?.[0];
    return last && last.author?.login !== viewer;
  });

  // Every comment from someone else that could be "new" — used for notifications.
  const incoming = [];
  for (const t of threads) {
    const c = t.comments?.nodes?.[0];
    if (c && c.author?.login !== viewer) incoming.push({ id: c.id, author: c.author?.login || 'ghost', bot: isAutomated(c.author), body: snippet(c.body), url: c.url, at: c.createdAt, kind: 'review comment' });
  }
  for (const r of n.reviews?.nodes || []) {
    if (r.author?.login === viewer) continue;
    if (!r.body && r.state !== 'CHANGES_REQUESTED' && r.state !== 'APPROVED') continue;
    const kind = r.state === 'CHANGES_REQUESTED' ? 'requested changes' : r.state === 'APPROVED' ? 'approved' : 'reviewed';
    incoming.push({ id: r.id, author: r.author?.login || 'ghost', bot: isAutomated(r.author), body: snippet(r.body), url: r.url, at: r.submittedAt, kind });
  }
  for (const c of n.comments?.nodes || []) {
    if (c.author?.login === viewer || isBot(c.author)) continue; // skip CI/deploy bot chatter on the conversation tab
    incoming.push({ id: c.id, author: c.author?.login || 'ghost', bot: isAutomated(c.author), body: snippet(c.body), url: c.url, at: c.createdAt, kind: 'comment' });
  }
  incoming.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return {
    url: n.url,
    number: n.number,
    title: n.title,
    repo: n.repository?.nameWithOwner || '',
    author: n.author?.login || '',
    draft: n.isDraft,
    branch: n.headRefName,
    base: n.baseRefName,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    mergeable: n.mergeable, // MERGEABLE | CONFLICTING | UNKNOWN
    reviewDecision: n.reviewDecision, // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
    checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null, // SUCCESS | FAILURE | PENDING | ERROR | EXPECTED
    unresolvedThreads: unresolved.length,
    awaitingReply: awaiting.length,
    incoming: incoming.slice(-40),
    additions: n.additions,
    deletions: n.deletions,
  };
}

async function search(q, max) {
  const prs = [];
  let after = null;
  let viewer = '';
  while (prs.length < max) {
    const out = await run(['api', 'graphql', '-f', `query=${searchQuery(q, after)}`]);
    const { data, errors } = JSON.parse(out);
    if (!data && errors) throw new Error(errors.map((e) => e.message).join('; '));
    viewer = data.viewer.login;
    prs.push(...data.search.nodes.map((n) => normalize(n, viewer)).filter(Boolean));
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return { viewer, prs: prs.slice(0, max) };
}

async function fetchPRs() {
  const [mine, review] = await Promise.all([
    search('is:open is:pr author:@me archived:false sort:updated-desc', 100),
    search('is:open is:pr review-requested:@me archived:false sort:updated-desc', 60),
  ]);
  return { viewer: mine.viewer, mine: mine.prs, review: review.prs, fetchedAt: new Date().toISOString() };
}

module.exports = { fetchPRs };
