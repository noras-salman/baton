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

// Compares a fresh fetch with what we've already told the user about.
// state: { seeded, readyKeys: [], commentIds: [] }
function diff(state, data) {
  const notes = [];
  const readyKeys = new Set();
  const commentIds = new Set(state.commentIds || []);
  const prevReady = new Set(state.readyKeys || []);
  const first = !state.seeded;

  // Readiness: only your own PRs. One notification per stack, not per PR.
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
    notes.push(
      size > 1
        ? { kind: 'ready', url: root, title: `Stack ready to merge (${size} PRs)`, body: prs[0].stackName }
        : { kind: 'ready', url: root, title: `Ready to merge: ${prs[0].repo.split('/')[1]}#${prs[0].number}`, body: prs[0].title },
    );
  }

  // New comments from other people on your PRs.
  for (const p of data.mine) {
    const fresh = (p.incoming || []).filter((c) => !commentIds.has(c.id));
    fresh.forEach((c) => commentIds.add(c.id));
    if (first || !fresh.length) continue;
    const last = fresh[fresh.length - 1];
    const who = [...new Set(fresh.map((c) => `@${c.author}`))].join(', ');
    notes.push({
      kind: 'comment',
      url: p.url,
      title: fresh.length === 1 ? `@${last.author} ${VERB[last.kind] || 'commented on'} #${p.number}` : `${fresh.length} new comments on #${p.number}`,
      body: fresh.length === 1 ? last.body || p.title : `${who}: ${last.body || p.title}`,
    });
  }

  // Keep the seen-comment set bounded.
  const ids = [...commentIds].slice(-5000);
  return { notes, state: { seeded: true, readyKeys: [...readyKeys], commentIds: ids } };
}

module.exports = { annotate, diff, buildStacks, ownReady, needsResponse };
