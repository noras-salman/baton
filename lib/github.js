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

const PR_FIELDS = `
  ... on PullRequest {
    number title url isDraft createdAt updatedAt
    headRefName baseRefName mergeable reviewDecision
    additions deletions
    author { login }
    repository { nameWithOwner }
    reviewThreads(first: 50) { nodes { isResolved } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }`;

const searchQuery = (q, n) => `
query {
  viewer { login }
  search(query: "${q}", type: ISSUE, first: ${n}) { nodes { ${PR_FIELDS} } }
}`;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(ghPath(), args, { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }, (err, out, stderr) => {
      if (err) {
        const msg = err.code === 'ENOENT' ? 'GitHub CLI (gh) not found. Install it with `brew install gh`.' : (stderr || err.message).trim();
        return reject(new Error(msg));
      }
      resolve(out);
    });
  });
}

function normalize(n) {
  if (!n || !n.url) return null;
  const threads = n.reviewThreads?.nodes || [];
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
    unresolvedThreads: threads.filter((t) => !t.isResolved).length,
    additions: n.additions,
    deletions: n.deletions,
  };
}

async function search(q, n) {
  const out = await run(['api', 'graphql', '-f', `query=${searchQuery(q, n)}`]);
  const { data, errors } = JSON.parse(out);
  if (!data && errors) throw new Error(errors.map((e) => e.message).join('; '));
  return { viewer: data.viewer.login, prs: data.search.nodes.map(normalize).filter(Boolean) };
}

async function fetchPRs() {
  const [mine, review] = await Promise.all([
    search('is:open is:pr author:@me archived:false sort:updated-desc', 50),
    search('is:open is:pr review-requested:@me archived:false sort:updated-desc', 30),
  ]);
  return { viewer: mine.viewer, mine: mine.prs, review: review.prs, fetchedAt: new Date().toISOString() };
}

module.exports = { fetchPRs };
