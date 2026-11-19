// PR readiness, stacks, and change detection for notifications.
// Pure functions: used by the background poller in the main process.

// Ready = could be merged right now with nothing left to do.
function ownReady(p) {
  return (
    !p.draft &&
    p.mergeable === 'MERGEABLE' &&
    (p.reviewDecision === 'APPROVED' || p.reviewDecision == null) &&
    (p.checks === 'SUCCESS' || p.checks == null) &&
    p.unresolvedThreads === 0
  );
}

function needsResponse(p) {
  return p.awaitingReply > 0 || p.reviewDecision === 'CHANGES_REQUESTED';
}

// A PR whose base branch is another open PR's head branch (same repo) sits on top of it.
// Returns groups ordered root -> leaf.
function buildStacks(prs) {
  const key = (repo, branch) => `${repo}|${branch}`;
  const byBranch = new Map(prs.map((p) => [key(p.repo, p.branch), p]));
  const children = new Map();
  const roots = [];
  for (const p of prs) {
    const parent = byBranch.get(key(p.repo, p.base));
    if (parent && parent !== p) {
      if (!children.has(parent.url)) children.set(parent.url, []);
      children.get(parent.url).push(p);
    } else roots.push(p);
  }
  const seen = new Set();
  const groups = roots.map((root) => {
    const ordered = [];
    const walk = (p) => {
      if (seen.has(p.url)) return;
      seen.add(p.url);
      ordered.push(p);
      (children.get(p.url) || []).sort((a, b) => a.number - b.number).forEach(walk);
    };
    walk(root);
    return ordered;
  });
  for (const p of prs) if (!seen.has(p.url)) groups.push([p]);
  return groups;
}

function stackName(stack) {
  return stack[0].title.replace(/\s*\[\d+\s*\/\s*\d+\]\s*:?\s*/, ' ').replace(/\s+/g, ' ').trim();
}

// Adds readiness fields. A PR inside a stack is only merge-ready when the whole stack is.
function annotate(data) {
  const all = [...data.mine, ...data.review];
  const unique = all.filter((p, i) => all.findIndex((x) => x.url === p.url) === i);
  const info = new Map();
  for (const stack of buildStacks(unique)) {
    const allReady = stack.every(ownReady);
    stack.forEach((p, i) =>
      info.set(p.url, {
        stackRoot: stack[0].url,
        stackSize: stack.length,
        stackIndex: i,
        stackName: stack.length > 1 ? stackName(stack) : '',
        ready: ownReady(p),
        mergeReady: allReady, // stack-aware
        needsResponse: needsResponse(p),
      }),
    );
  }
  const add = (p) => ({ ...p, ...info.get(p.url) });
  return { ...data, mine: data.mine.map(add), review: data.review.map(add) };
}

const VERB = { 'review comment': 'commented on', comment: 'commented on', reviewed: 'reviewed', approved: 'approved', 'requested changes': 'requested changes on' };

function commentText(p, comments) {
  const last = comments[comments.length - 1];
  const who = [...new Set(comments.map((c) => `@${c.author}`))].join(', ');
  return {
    link: last.url || p.url, // deep link to the newest comment
    title: comments.length === 1 ? `@${last.author} ${VERB[last.kind] || 'commented on'} #${p.number}` : `${comments.length} new comments on #${p.number}`,
    body: comments.length === 1 ? last.body || p.prTitle || p.title : `${who}: ${last.body || p.prTitle || p.title}`,
  };
}

const short = (p) => `${p.repo.split('/')[1]}#${p.number}`;

// Compares a fresh fetch with what we've already seen and returns every new event.
// Preferences are applied separately (applyPrefs) so toggling a type on later never replays history.
// state: { seeded, readyKeys, commentIds, reviewKeys, failedKeys }
function diff(state, data) {
  const notes = [];
  const first = !state.seeded;
  const prevReady = new Set(state.readyKeys || []);
  const commentIds = new Set(state.commentIds || []);
  // Event types added later seed silently on their first run.
  const reviewsSeeded = !first && Array.isArray(state.reviewKeys);
  const failsSeeded = !first && Array.isArray(state.failedKeys);
  const prevReviews = new Set(state.reviewKeys || []);
  const prevFailed = new Set(state.failedKeys || []);

  // Readiness: only your own PRs. One notification per stack, not per PR.
  const readyKeys = new Set();
  const stacks = new Map();
  for (const p of data.mine) {
    if (!stacks.has(p.stackRoot)) stacks.set(p.stackRoot, []);
    stacks.get(p.stackRoot).push(p);
  }
  for (const [root, prs] of stacks) {
    const size = prs[0].stackSize;
    if (!prs.every((p) => p.mergeReady) || prs.length !== size) continue;
    const key = `${root}|${prs.map((p) => p.number).join(',')}`;
    readyKeys.add(key);
    if (first || prevReady.has(key)) continue;
    const base = { kind: 'ready', url: root, link: root, repo: prs[0].repo, number: prs[0].number, prTitle: prs[0].title, prUrls: prs.map((p) => p.url) };
    notes.push(
      size > 1
        ? { ...base, title: `Stack ready to merge (${size} PRs)`, body: prs[0].stackName, stack: prs.map((p) => ({ url: p.url, number: p.number, title: p.title })) }
        : { ...base, title: `Ready to merge: ${short(prs[0])}`, body: prs[0].title },
    );
  }

  // New comments and reviews from other people on your PRs.
  for (const p of data.mine) {
    const fresh = (p.incoming || []).filter((c) => !commentIds.has(c.id));
    fresh.forEach((c) => commentIds.add(c.id));
    if (first || !fresh.length) continue;
    const comments = fresh.slice(-20).map((c) => ({ author: c.author, bot: Boolean(c.bot), kind: c.kind, body: c.body, url: c.url, at: c.at }));
    const ref = { url: p.url, repo: p.repo, number: p.number, prTitle: p.title, prUrls: [p.url] };
    notes.push({ kind: 'comment', ...ref, comments, ...commentText(ref, comments) });
  }

  // Newly requested reviews.
  const reviewKeys = new Set(data.review.map((p) => p.url));
  if (reviewsSeeded) {
    for (const p of data.review) {
      if (prevReviews.has(p.url)) continue;
      notes.push({ kind: 'review', url: p.url, link: p.url, repo: p.repo, number: p.number, prTitle: p.title, prUrls: [p.url], author: p.author, title: `Review requested by @${p.author}: ${short(p)}`, body: p.title });
    }
  }

  // Your PRs whose checks just started failing.
  const failing = data.mine.filter((p) => p.checks === 'FAILURE' || p.checks === 'ERROR');
  const failedKeys = new Set(failing.map((p) => p.url));
  if (failsSeeded) {
    for (const p of failing) {
      if (prevFailed.has(p.url)) continue;
      notes.push({ kind: 'ci', url: p.url, link: `${p.url}/checks`, repo: p.repo, number: p.number, prTitle: p.title, prUrls: [p.url], title: `Checks failing on ${short(p)}`, body: p.title });
    }
  }

  return {
    notes,
    state: {
      seeded: true,
      readyKeys: [...readyKeys],
      commentIds: [...commentIds].slice(-5000), // bounded
      reviewKeys: [...reviewKeys],
      failedKeys: [...failedKeys],
    },
  };
}

// ---- notification preferences --------------------------------------------------
const DEFAULT_PREFS = {
  readyPR: true, // a standalone PR becomes ready to merge
  readyStack: true, // a whole stack becomes ready to merge
  comments: true, // humans commenting on your PRs
  botComments: true, // bots and AI reviewers commenting
  approvals: true,
  changesRequested: true,
  reviewRequested: true,
  ciFailed: true,
  sessionDone: true, // a Claude session finishes a turn
  sessionMinSeconds: 30, // ...that ran at least this long
  banners: true, // macOS banners (history is always kept for enabled types)
  dockBadge: true,
  mutedRepos: [],
  mutedPRs: [],
};

function prefsFrom(settings) {
  const n = { ...DEFAULT_PREFS, ...(settings.notify || {}) };
  // Settings from before the Settings tab.
  if (settings.notifyReady === false && !settings.notify) n.readyPR = n.readyStack = false;
  if (settings.notifyComments === false && !settings.notify) n.comments = n.botComments = n.approvals = n.changesRequested = false;
  return n;
}

function commentAllowed(c, prefs) {
  if (c.bot && !prefs.botComments) return false;
  if (c.kind === 'approved') return prefs.approvals;
  if (c.kind === 'requested changes') return prefs.changesRequested;
  return c.bot ? prefs.botComments : prefs.comments;
}

// Drops events you're not interested in; trims comment notes to the comments you care about.
function applyPrefs(notes, prefs) {
  const mutedRepos = new Set(prefs.mutedRepos);
  const mutedPRs = new Set(prefs.mutedPRs);
  const out = [];
  for (const n of notes) {
    if (n.repo && mutedRepos.has(n.repo)) continue;
    if ((n.prUrls || []).some((u) => mutedPRs.has(u))) continue;
    if (n.kind === 'ready' && !(n.stack ? prefs.readyStack : prefs.readyPR)) continue;
    if (n.kind === 'review' && !prefs.reviewRequested) continue;
    if (n.kind === 'ci' && !prefs.ciFailed) continue;
    if (n.kind === 'session' && !prefs.sessionDone) continue;
    if (n.kind === 'comment') {
      const kept = n.comments.filter((c) => commentAllowed(c, prefs));
      if (!kept.length) continue;
      out.push({ ...n, comments: kept.slice(-10), ...commentText(n, kept) });
      continue;
    }
    out.push(n);
  }
  return out;
}

module.exports = { annotate, diff, applyPrefs, prefsFrom, DEFAULT_PREFS, buildStacks, ownReady, needsResponse };
