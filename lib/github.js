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
    headRefName headRefOid baseRefName mergeable reviewDecision
    autoMergeRequest { enabledAt mergeMethod }
    additions deletions
    ${AUTHOR}
    repository { nameWithOwner squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod }
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
    headSha: n.headRefOid,
    autoMerge: n.autoMergeRequest ? { since: n.autoMergeRequest.enabledAt, method: n.autoMergeRequest.mergeMethod } : null,
    mergeOptions: n.repository
      ? {
          methods: [
            n.repository.squashMergeAllowed && 'SQUASH',
            n.repository.mergeCommitAllowed && 'MERGE',
            n.repository.rebaseMergeAllowed && 'REBASE',
          ].filter(Boolean),
          defaultMethod: n.repository.viewerDefaultMergeMethod,
          autoMergeAllowed: n.repository.autoMergeAllowed,
          deletesBranch: n.repository.deleteBranchOnMerge, // repo deletes head branches itself
        }
      : null,
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

// Merge (or queue auto-merge for) a PR. --match-head-commit makes GitHub refuse if the branch
// moved since Baton showed it to you. Runs outside any checkout so --delete-branch only
// touches the remote branch.
const FLAG = { SQUASH: '--squash', MERGE: '--merge', REBASE: '--rebase' };
async function mergePR(url, { method, deleteBranch, auto, headSha }) {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) throw new Error('Not a GitHub pull request URL');
  if (!FLAG[method]) throw new Error(`Unknown merge method ${method}`);
  const args = ['pr', 'merge', url, FLAG[method]];
  if (auto) args.push('--auto');
  if (deleteBranch) args.push('--delete-branch');
  if (headSha) args.push('--match-head-commit', headSha);
  return new Promise((resolve, reject) => {
    execFile(ghPath(), args, { cwd: require('os').tmpdir(), timeout: 120000 }, (err, out, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
      resolve((out || stderr || '').trim());
    });
  });
}

async function disableAutoMerge(url) {
  return new Promise((resolve, reject) =>
    execFile(ghPath(), ['pr', 'merge', url, '--disable-auto'], { cwd: require('os').tmpdir(), timeout: 60000 }, (err, out, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(out.trim()),
    ),
  );
}

// Full conversation for one PR: description, review threads, reviews, and comments.
const CONVO_QUERY = `
query($url: URI!) {
  resource(url: $url) {
    ... on PullRequest {
      body createdAt author { login }
      comments(first: 100) { nodes { id author { login __typename } body createdAt url } }
      reviews(first: 100) { nodes { id state author { login __typename } body submittedAt url } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line
          comments(first: 50) { nodes { id author { login __typename } body createdAt url } }
        }
      }
    }
  }
}`;

const cleanBody = (s) => String(s || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '').trim();
const who = (a) => ({ login: a?.login || 'ghost', bot: isAutomated(a) });

async function fetchPRConversation(url) {
  const out = await run(['api', 'graphql', '-f', `query=${CONVO_QUERY}`, '-F', `url=${url}`]);
  const { data, errors } = JSON.parse(out);
  const pr = data && data.resource;
  if (!pr) throw new Error((errors || []).map((e) => e.message).join('; ') || 'PR not found');
  return {
    url,
    fetchedAt: new Date().toISOString(),
    description: { author: pr.author?.login || 'ghost', at: pr.createdAt, body: cleanBody(pr.body) },
    comments: pr.comments.nodes.map((c) => ({ id: c.id, ...who(c.author), body: cleanBody(c.body), at: c.createdAt, url: c.url })),
    reviews: pr.reviews.nodes
      .filter((r) => r.body || r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
      .map((r) => ({ id: r.id, ...who(r.author), state: r.state, body: cleanBody(r.body), at: r.submittedAt, url: r.url })),
    threads: pr.reviewThreads.nodes.map((t) => ({
      id: t.id,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      path: t.path,
      line: t.line,
      comments: t.comments.nodes.map((c) => ({ id: c.id, ...who(c.author), body: cleanBody(c.body), at: c.createdAt, url: c.url })),
    })),
  };
}

module.exports = { fetchPRs, mergePR, disableAutoMerge, fetchPRConversation };
