/* global api */
const state = {
  tasks: [],
  sessions: [],
  prs: null, // { viewer, mine, review, fetchedAt }
  prError: '',
  prLoading: false,
  view: 'open',
  selected: null, // task id | session id | PR url, depending on view
  search: '',
  groupStacks: localStorage.getItem('groupStacks') !== '0',
  prFilter: localStorage.getItem('prFilter') || 'all', // all | ready | respond
  notifications: [],
  settings: null, // from main: { notify: prefs, repos, openAtLogin, ... }
  notifFilter: localStorage.getItem('notifFilter') || 'all', // all | unread
  stackOpen: JSON.parse(localStorage.getItem('stackOpen') || '{}'), // root PR url -> expanded?
};

// ---- tiny DOM helper (always textContent, never innerHTML) ---------------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (s) => document.querySelector(s);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2000);
}

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
const home = (p) => (p || '').replace(/^\/Users\/[^/]+/, '~');
const folder = (p) => (p || '').split('/').filter(Boolean).pop() || p;
const realBranch = (b) => (b && b !== 'HEAD' ? b : '');
const sessionById = (id) => state.sessions.find((s) => s.id === id);
const allPRs = () => (state.prs ? [...state.prs.mine, ...state.prs.review] : []);
const prByUrl = (url) => allPRs().find((p) => p.url === url);
const prLabel = (p) => `${p.repo.split('/')[1] || p.repo}#${p.number}`;

// Sessions that touched a PR: an explicit PR link in the transcript, or the same branch.
function sessionsForPR(pr) {
  return state.sessions.filter((s) => s.prUrls?.includes(pr.url) || (pr.branch && realBranch(s.gitBranch) === pr.branch));
}
function prsForSession(s) {
  return allPRs().filter((p) => s.prUrls?.includes(p.url) || (p.branch && realBranch(s.gitBranch) === p.branch));
}

// Stacks: a PR whose base branch is another open PR's head branch (same repo) sits on top of it.
// Returns groups ordered root -> leaf, most recently updated group first.
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
  for (const p of prs) if (!seen.has(p.url)) groups.push([p]); // cycles (shouldn't happen)
  const latest = (g) => g.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), '');
  return groups.sort((a, b) => latest(b).localeCompare(latest(a)));
}

function stackName(stack) {
  const strip = (t) => t.replace(/\s*\[\d+\s*\/\s*\d+\]\s*:?\s*/, ' ').replace(/\s+/g, ' ').trim();
  return strip(stack[0].title);
}

function stackHealth(stack) {
  const n = stack.length;
  const approved = stack.filter((p) => p.reviewDecision === 'APPROVED').length;
  const failing = stack.filter((p) => p.checks === 'FAILURE' || p.checks === 'ERROR').length;
  const changes = stack.filter((p) => p.reviewDecision === 'CHANGES_REQUESTED').length;
  const threads = stack.reduce((a, p) => a + (p.unresolvedThreads || 0), 0);
  const conflicts = stack.filter((p) => p.mergeable === 'CONFLICTING').length;
  const awaiting = stack.reduce((a, p) => a + (isMine(p) ? p.awaitingReply || 0 : 0), 0);
  if (stack.every((p) => p.mergeReady)) return [h('span', { class: 'pill ready' }, '✓ whole stack ready to merge')];
  return [
    awaiting ? h('span', { class: 'pill bad' }, `💬 ${awaiting} to address`) : null,
    h('span', { class: `pill ${approved === n ? 'ok' : ''}` }, `${approved}/${n} approved`),
    failing ? h('span', { class: 'pill bad' }, `✗ ${failing} failing`) : h('span', { class: 'pill ok' }, '✓ CI'),
    changes ? h('span', { class: 'pill bad' }, `${changes} changes requested`) : null,
    threads && !awaiting ? h('span', { class: 'pill wait' }, `💬 ${threads}`) : null,
    conflicts ? h('span', { class: 'pill bad' }, `${conflicts} conflicting`) : null,
  ];
}

function sessionsForPRs(prs) {
  const out = [];
  for (const p of prs) for (const s of sessionsForPR(p)) if (!out.includes(s)) out.push(s);
  return out;
}

// "To address" (comments waiting on you) only makes sense on PRs you authored.
const isMine = (p) => Boolean(state.prs && p.author === state.prs.viewer);
// Counter badge for filter tabs; always shown, muted at zero.
const countBadge = (n, tone) => h('span', { class: `tab-badge ${n ? tone : 'zero'}` }, n);

const isPRView = (v = state.view) => v === 'prs' || v === 'reviews';
// The view a PR lives in: your own PRs vs. review requests.
const viewForPR = (url) => (state.prs && state.prs.review.some((p) => p.url === url) && !state.prs.mine.some((p) => p.url === url) ? 'reviews' : 'prs');
// Filters (Ready / To address) only apply to your own PRs.
const activePRFilter = () => (state.view === 'prs' ? state.prFilter : 'all');

// Your explicit expand/collapse choice always wins; otherwise small stacks, stacks holding the
// selected PR, and stacks under a filter start open.
function stackIsOpen(root, size, containsSelected) {
  const choice = state.stackOpen[root];
  if (choice !== undefined) return choice;
  return containsSelected || activePRFilter() !== 'all' || size <= 5;
}

function stackRoots() {
  const roots = new Map();
  const list = state.prs ? (state.view === 'reviews' ? state.prs.review : state.prs.mine) : [];
  for (const p of list) if (p.stackSize > 1 && p.stackRoot) roots.set(p.stackRoot, p.stackSize);
  return roots;
}

function setAllStacks(open) {
  for (const root of stackRoots().keys()) state.stackOpen[root] = open;
  localStorage.setItem('stackOpen', JSON.stringify(state.stackOpen));
  renderListHead();
  renderList();
}

// ---- pills ----------------------------------------------------------------
function livePill(live) {
  if (!live) return null;
  return h('span', { class: `pill live ${live.status === 'busy' ? 'busy' : ''}` }, live.status === 'busy' ? 'running' : 'open');
}

function prStatusPills(p, { compact } = {}) {
  if (!p) return [h('span', { class: 'pill' }, state.prs ? 'merged or closed' : 'loading…')];
  const out = [];
  if (p.draft) out.push(h('span', { class: 'pill' }, 'draft'));
  if (p.checks === 'SUCCESS') out.push(h('span', { class: 'pill ok' }, compact ? '✓ CI' : '✓ checks passing'));
  else if (p.checks === 'FAILURE' || p.checks === 'ERROR') out.push(h('span', { class: 'pill bad' }, compact ? '✗ CI' : '✗ checks failing'));
  else if (p.checks === 'PENDING' || p.checks === 'EXPECTED') out.push(h('span', { class: 'pill wait' }, compact ? '● CI' : '● checks running'));
  if (p.reviewDecision === 'APPROVED') out.push(h('span', { class: 'pill ok' }, 'approved'));
  else if (p.reviewDecision === 'CHANGES_REQUESTED') out.push(h('span', { class: 'pill bad' }, 'changes requested'));
  else if (p.reviewDecision === 'REVIEW_REQUIRED' && !compact) out.push(h('span', { class: 'pill' }, 'review required'));
  if (p.mergeReady) out.unshift(h('span', { class: 'pill ready' }, '✓ ready to merge'));
  else if (p.ready && p.stackSize > 1) out.unshift(h('span', { class: 'pill', title: 'This PR is ready, but other PRs in its stack are not' }, 'ready · waiting on stack'));
  if (p.awaitingReply && isMine(p)) out.push(h('span', { class: 'pill bad', title: 'Unresolved threads where someone else spoke last' }, `💬 ${p.awaitingReply} to address`));
  else if (p.unresolvedThreads) out.push(h('span', { class: 'pill wait' }, `💬 ${p.unresolvedThreads}`));
  if (p.mergeable === 'CONFLICTING') out.push(h('span', { class: 'pill bad' }, 'conflicts'));
  return out;
}

// ---- data -----------------------------------------------------------------
async function loadTasks() {
  state.tasks = await api.listTasks();
}
async function loadNotifications() {
  state.notifications = await api.listNotifications();
}
async function loadSessions() {
  state.sessions = await api.listSessions();
  linkPendingStarts();
}
async function refreshPRs({ quiet } = {}) {
  if (state.prLoading) return;
  state.prLoading = true;
  renderListHead();
  const r = await api.refreshPRs();
  state.prLoading = false;
  applyPRUpdate(r);
  if (r.error && !quiet) toast(`GitHub: ${r.error}`);
}

function applyPRUpdate({ data, error }) {
  if (data) state.prs = data;
  state.prError = error || '';
  render({ keepDetail: isEditing() });
}

async function saveTask(task, { quiet } = {}) {
  const saved = await api.saveTask(task);
  const i = state.tasks.findIndex((t) => t.id === saved.id);
  if (i === -1) state.tasks.unshift(saved);
  else state.tasks[i] = saved;
  if (!quiet) render();
  return saved;
}

const taskPR = (p) => ({ url: p.url, number: p.number, title: p.title, repo: p.repo });

async function linkSessions(task, ids) {
  const existing = new Set(task.sessions.map((s) => s.id));
  const add = (await Promise.all(ids.filter((id) => !existing.has(id)).map((id) => api.sessionLink(id)))).filter(Boolean);
  return { ...task, sessions: [...task.sessions, ...add] };
}
function linkPRs(task, urls) {
  const existing = new Set(task.prs.map((p) => p.url));
  const add = urls.filter((u) => !existing.has(u)).map(prByUrl).filter(Boolean).map(taskPR);
  return { ...task, prs: [...task.prs, ...add] };
}

// ---- rendering ------------------------------------------------------------
const VIEW_TITLES = { settings: 'Settings', reviews: 'Review requests', notifications: 'Notifications', open: 'Open', todo: 'To do', doing: 'In progress', done: 'Done', sessions: 'Claude sessions', prs: 'Pull requests' };
const STATUS_ORDER = { doing: 0, todo: 1, done: 2 };
const PRIO_ORDER = { high: 0, normal: 1, low: 2 };

function matches(text) {
  const q = state.search.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
}

function visibleTasks() {
  return state.tasks
    .filter((t) => (state.view === 'open' ? t.status !== 'done' : t.status === state.view))
    .filter((t) =>
      matches([t.title, t.notes, t.summary, ...t.sessions.map((s) => `${s.title} ${s.cwd}`), ...t.prs.map((p) => `${p.title} ${p.repo}#${p.number}`)].join(' ')),
    )
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority] ||
        b.createdAt.localeCompare(a.createdAt),
    );
}

function render({ keepDetail } = {}) {
  const c = { open: 0, todo: 0, doing: 0, done: 0 };
  for (const t of state.tasks) {
    c[t.status]++;
    if (t.status !== 'done') c.open++;
  }
  c.live = state.sessions.filter((s) => s.live).length || '';
  c.prs = state.prs ? state.prs.mine.length : '';
  c.reviews = state.prs ? state.prs.review.length : '';
  c.unread = state.notifications.filter((n) => !n.read).length || '';
  document.querySelectorAll('[data-count]').forEach((el) => (el.textContent = c[el.dataset.count] || ''));
  document.querySelectorAll('aside [data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  renderListHead();
  renderList();
  if (!keepDetail) renderDetail();
}

function renderListHead() {
  $('#listTitle').textContent = VIEW_TITLES[state.view];
  const btn = $('#refreshBtn');
  const sub = $('#listSub');
  btn.hidden = !isPRView();
  const eb = $('#expandBtn');
  const roots = stackRoots();
  const anyCollapsed = [...roots].some(([root, size]) => !stackIsOpen(root, size, false));
  eb.hidden = !isPRView() || !state.groupStacks || !roots.size;
  eb.textContent = anyCollapsed ? '▾ Expand all' : '▸ Collapse all';
  eb.onclick = () => setAllStacks(anyCollapsed);
  const sb = $('#stackBtn');
  sb.hidden = !isPRView();
  sb.classList.toggle('on', state.groupStacks);
  sb.textContent = state.groupStacks ? '☑ Stacks' : '☐ Stacks';
  const mb = $('#markAllBtn');
  const nf = $('#notifFilters');
  const isNotif = state.view === 'notifications';
  const unread = state.notifications.filter((n) => !n.read).length;
  mb.hidden = !isNotif;
  const cb = $('#clearAllBtn');
  cb.hidden = !isNotif;
  cb.disabled = !state.notifications.length;
  mb.disabled = !unread;
  nf.hidden = !isNotif;
  if (isNotif) {
    nf.replaceChildren(
      ...[
        ['all', 'All'],
        ['unread', ['Unread', countBadge(unread, 'accent')]],
      ].map(([v, label]) =>
        h(
          'button',
          {
            class: state.notifFilter === v ? 'on' : '',
            onclick: () => {
              state.notifFilter = v;
              localStorage.setItem('notifFilter', v);
              renderListHead();
              renderList();
            },
          },
          label,
        ),
      ),
    );
  }
  const pf = $('#prFilters');
  pf.hidden = state.view !== 'prs';
  if (state.view === 'prs') {
    const mine = state.prs ? state.prs.mine : [];
    const readyUnits = new Set(mine.filter((p) => p.mergeReady).map((p) => p.stackRoot || p.url)).size;
    const respond = mine.filter((p) => p.needsResponse).length;
    const opts = [
      ['all', 'All'],
      ['ready', ['Ready to merge', countBadge(readyUnits, 'green')]],
      ['respond', ['To address', countBadge(respond, 'red')]],
    ];
    pf.replaceChildren(
      ...opts.map(([v, label]) =>
        h(
          'button',
          {
            class: state.prFilter === v ? 'on' : '',
            onclick: () => {
              state.prFilter = v;
              localStorage.setItem('prFilter', v);
              renderListHead();
              renderList();
            },
          },
          label,
        ),
      ),
    );
  }
  btn.disabled = state.prLoading;
  btn.textContent = state.prLoading ? 'Refreshing…' : 'Refresh';
  sub.className = 'list-sub';
  sub.textContent = '';
  if (isPRView()) {
    if (state.prError) {
      sub.className = 'list-sub error';
      sub.textContent = state.prError;
    } else if (state.prs) sub.textContent = `@${state.prs.viewer} · updated ${ago(state.prs.fetchedAt)}`;
  }
}

function listItem({ selected, cls = '', onclick, ondblclick, lead, title, meta, trail }) {
  return h(
    'div',
    { class: `item ${cls} ${selected ? 'selected' : ''}`, onclick, ondblclick },
    lead,
    h('div', { class: 'item-main' }, h('div', { class: 'item-title' }, title), h('div', { class: 'item-meta' }, meta)),
    trail,
  );
}

// Small "open in browser" button; stops the click from also selecting the row.
function openButton(url, label = '↗') {
  return h(
    'button',
    {
      class: 'open-btn',
      title: 'Open on GitHub (⌘-click or double-click the row also works)',
      onclick: (e) => {
        e.stopPropagation();
        api.openUrl(url);
      },
    },
    label,
  );
}

function renderList() {
  const list = $('#list');
  list.replaceChildren();

  if (state.view === 'settings') return settingsList(list);

  if (state.view === 'notifications') {
    const items = state.notifications
      .filter((n) => state.notifFilter === 'all' || !n.read)
      .filter((n) => matches([n.title, n.body, n.prTitle, n.repo, n.number].join(' ')));
    if (!items.length) {
      list.append(
        h(
          'div',
          { class: 'empty' },
          state.search
            ? 'No matches.'
            : state.notifFilter === 'unread'
              ? 'All caught up.'
              : 'No notifications yet. Baton checks GitHub every 3 minutes and records when a PR or stack becomes ready to merge, or when someone comments on your PRs.',
        ),
      );
    }
    let lastDay = '';
    for (const n of items) {
      const day = dayLabel(n.createdAt);
      if (day !== lastDay) {
        list.append(h('div', { class: 'section-head' }, h('span', {}, day)));
        lastDay = day;
      }
      list.append(
        listItem({
          cls: `notif ${n.read ? 'read' : 'unread'}`,
          selected: state.selected === n.id,
          onclick: () => openNotification(n),
          lead: h('span', { class: `notif-icon ${n.kind}` }, NOTIF_ICON[n.kind] || '•'),
          title: n.title,
          meta: [
            n.repo ? h('span', { class: 'mono' }, `${n.repo.split('/')[1]}#${n.number}`) : null,
            n.kind === 'session' ? h('span', { class: 'mono' }, folder(n.cwd)) : null,
            h('span', { class: 'notif-body' }, n.body || ''),
            h('span', {}, timeLabel(n.createdAt)),
          ],
          trail: n.read ? null : h('span', { class: 'unread-dot', title: 'Unread' }),
        }),
      );
    }
    return;
  }

  if (state.view === 'sessions') {
    const items = state.sessions.filter((s) => matches([s.title, s.cwd, s.gitBranch, s.firstPrompt].join(' ')));
    if (!items.length) list.append(h('div', { class: 'empty' }, 'No Claude Code sessions found in ~/.claude/projects.'));
    for (const s of items) {
      const linked = state.tasks.filter((t) => t.status !== 'done' && t.sessions.some((x) => x.id === s.id)).length;
      const prs = prsForSession(s).length;
      list.append(
        listItem({
          selected: state.selected === s.id,
          onclick: () => select(s.id),
          title: s.title,
          meta: [
            livePill(s.live),
            h('span', {}, folder(s.cwd)),
            realBranch(s.gitBranch) ? h('span', { class: 'mono' }, s.gitBranch) : null,
            h('span', {}, ago(s.modifiedAt)),
            prs ? h('span', { class: 'pill' }, `${prs} PR${prs > 1 ? 's' : ''}`) : null,
            linked ? h('span', { class: 'pill claude' }, `${linked} task${linked > 1 ? 's' : ''}`) : null,
          ],
        }),
      );
    }
    return;
  }

  if (isPRView()) {
    if (!state.prs) {
      list.append(h('div', { class: 'empty' }, state.prLoading ? 'Loading pull requests from GitHub…' : state.prError || 'No PR data yet.'));
      return;
    }
    const prItem = (p, { pos } = {}) => {
      const sess = sessionsForPR(p);
      const tasks = state.tasks.filter((t) => t.status !== 'done' && t.prs.some((x) => x.url === p.url)).length;
      return listItem({
        cls: pos ? 'stacked' : '',
        selected: state.selected === p.url,
        onclick: (e) => (e.metaKey ? api.openUrl(p.url) : select(p.url)),
        ondblclick: () => api.openUrl(p.url),
        trail: openButton(p.url),
        lead: pos ? h('span', { class: 'stack-pos' }, pos) : h('span', { class: `pr-dot ${p.draft ? 'draft' : ''}` }, '⇅'),
        title: p.title,
        meta: [
          h('span', { class: 'mono' }, prLabel(p)),
          state.view === 'reviews' || !isMine(p) ? h('span', { class: 'pill', title: 'Author' }, `@${p.author}`) : null,
          ...prStatusPills(p, { compact: true }),
          sess.length ? h('span', { class: 'pill claude' }, `◆ ${sess.length}`) : null,
          tasks ? h('span', { class: 'pill claude' }, `${tasks} task${tasks > 1 ? 's' : ''}`) : null,
          h('span', {}, ago(p.updatedAt)),
        ],
      });
    };
    const section = (label, prs) => {
      const searched = prs.filter((p) => matches([p.title, p.repo, p.number, p.branch, p.author].join(' ')));
      const f = activePRFilter();
      const keep = (p) => f === 'all' || (f === 'ready' ? p.mergeReady : p.needsResponse);
      // Readiness is stack-aware (mergeReady), so a ready stack shows whole; "needs response" shows
      // only the matching PRs, still under their stack header for context.
      const groups = (state.groupStacks ? buildStacks(searched) : searched.map((p) => [p]))
        .map((g) => (f === 'respond' ? g.filter(keep) : g.every(keep) ? g : []))
        .filter((g) => g.length);
      const count = groups.reduce((a, g) => a + g.length, 0);
      list.append(h('div', { class: 'section-head' }, h('span', {}, label), h('span', {}, count)));
      if (!count) list.append(h('div', { class: 'empty', style: 'padding:12px' }, f === 'ready' ? 'Nothing ready to merge.' : f === 'respond' ? 'No comments waiting on you.' : 'None'));
      for (const stack of groups) {
        if (stack.length === 1 && !(state.groupStacks && stack[0].stackSize > 1)) {
          list.append(prItem(stack[0]));
          continue;
        }
        const containsSelected = stack.some((p) => p.url === state.selected);
        // Header, health and "+ Task" always describe the whole stack, even when a filter hides members.
        const full = stack[0].stackRoot
          ? allPRs()
              .filter((p, i, arr) => p.stackRoot === stack[0].stackRoot && arr.findIndex((x) => x.url === p.url) === i)
              .sort((a, b) => a.stackIndex - b.stackIndex)
          : stack;
        const open = stackIsOpen(full[0].url, full.length, containsSelected);
        const toggle = () => {
          state.stackOpen[full[0].url] = !open;
          localStorage.setItem('stackOpen', JSON.stringify(state.stackOpen));
          renderListHead();
          renderList();
        };
        list.append(
          h(
            'div',
            { class: `stack ${open ? 'open' : ''}` },
            h(
              'div',
              {
                class: 'stack-head',
                title: open ? 'Collapse stack' : 'Expand stack',
                onclick: toggle,
              },
              h('span', { class: 'stack-caret' }, open ? '▾' : '▸'),
              h(
                'div',
                { class: 'item-main' },
                h('div', { class: 'stack-title', title: stackName(full) }, `Stack of ${full.length} · ${stackName(full)}`),
                h('div', { class: 'item-meta' }, h('span', { class: 'mono' }, `${full[0].base} ←`), stackHealth(full)),
              ),
              h(
                'button',
                {
                  class: 'btn small',
                  title: 'Create a task linked to every PR in this stack and the sessions that worked on them',
                  onclick: (e) =>
                    e.stopPropagation() ||
                    openNewTask({ title: stackName(full), prUrls: full.map((p) => p.url), sessionIds: sessionsForPRs(full).map((x) => x.id) }),
                },
                '+ Task',
              ),
            ),
            open
              ? [
                  stack.map((p) => prItem(p, { pos: `${(p.stackIndex ?? 0) + 1}/${p.stackSize || stack.length}` })),
                  stack.length > 5 ? h('button', { class: 'stack-toggle', onclick: toggle }, '▴ Collapse stack') : null,
                ]
              : h(
                  'div',
                  { class: 'stack-mini' },
                  // Collapsed: one chip per PR, coloured by status; click to jump to it.
                  stack.map((p) =>
                    h(
                      'button',
                      {
                        class: `mini ${p.mergeReady ? 'ok' : (isMine(p) && p.needsResponse) || p.checks === 'FAILURE' || p.mergeable === 'CONFLICTING' ? 'bad' : p.ready ? 'ok-ish' : ''} ${state.selected === p.url ? 'sel' : ''}`,
                        title: `#${p.number} ${p.title}`,
                        onclick: () => {
                          state.stackOpen[full[0].url] = true;
                          localStorage.setItem('stackOpen', JSON.stringify(state.stackOpen));
                          select(p.url);
                        },
                      },
                      `${(p.stackIndex ?? 0) + 1}`,
                    ),
                  ),
                  h('button', { class: 'stack-toggle inline', onclick: toggle }, `▾ Show ${stack.length} PRs`),
                ),
          ),
        );
      }
    };
    if (state.view === 'reviews') section('Waiting on your review', state.prs.review);
    else section('Your PRs', state.prs.mine);
    return;
  }

  const items = visibleTasks();
  if (!items.length) {
    list.append(
      h(
        'div',
        { class: 'empty' },
        state.search ? 'No matches.' : state.view === 'done' ? 'Nothing done yet.' : 'No tasks. Press ⌘N, or run /task inside a Claude Code session.',
      ),
    );
  }
  for (const t of items) {
    const live = t.sessions.map((s) => sessionById(s.id)?.live).find(Boolean);
    const prPills = t.prs.slice(0, 3).map((ref) => {
      const p = prByUrl(ref.url);
      const bad = p && (p.checks === 'FAILURE' || p.reviewDecision === 'CHANGES_REQUESTED' || p.mergeable === 'CONFLICTING');
      const ok = p && p.reviewDecision === 'APPROVED' && p.checks === 'SUCCESS';
      return h(
        'span',
        {
          class: `pill link ${bad ? 'bad' : ok ? 'ok' : ''}`,
          title: `${ref.title || ''}\nClick to open on GitHub`.trim(),
          onclick: (e) => {
            e.stopPropagation();
            api.openUrl(ref.url);
          },
        },
        `#${ref.number} ↗`,
      );
    });
    list.append(
      listItem({
        cls: t.status,
        selected: state.selected === t.id,
        onclick: () => select(t.id),
        lead: h('button', {
          class: `check ${t.status}`,
          title: 'Click to cycle status',
          onclick: (e) => {
            e.stopPropagation();
            saveTask({ ...t, status: { todo: 'doing', doing: 'done', done: 'todo' }[t.status] });
          },
        }),
        title: t.title || '(untitled)',
        meta: [
          t.priority === 'high' ? h('span', { class: 'pill high' }, 'high') : null,
          t.sessions.length
            ? h('span', { class: 'pill claude', title: t.sessions.map((s) => s.title).join('\n') }, `◆ ${t.sessions.length > 1 ? `${t.sessions.length} sessions` : folder(t.sessions[0].cwd)}`)
            : null,
          livePill(live),
          prPills,
          t.prs.length > 3 ? h('span', { class: 'pill' }, `+${t.prs.length - 3}`) : null,
          h('span', {}, ago(t.createdAt)),
        ],
      }),
    );
  }
}

function select(id) {
  state.selected = id;
  render();
}

function renderDetail() {
  const pane = $('#detail');
  pane.replaceChildren(h('div', { class: 'drag' }));
  if (state.view === 'sessions') {
    const s = sessionById(state.selected);
    return pane.append(s ? sessionDetail(s) : emptyDetail('Pick a session to view its context or turn it into a task.'));
  }
  if (state.view === 'settings') return pane.append(settingsDetail());
  if (state.view === 'notifications') {
    const n = state.notifications.find((x) => x.id === state.selected);
    return pane.append(n ? notificationDetail(n) : emptyDetail('Select a notification.'));
  }
  if (isPRView()) {
    const p = prByUrl(state.selected);
    return pane.append(p ? prDetail(p) : emptyDetail('Pick a pull request to see its Claude sessions and tasks.'));
  }
  const t = state.tasks.find((x) => x.id === state.selected);
  pane.append(t ? taskDetail(t) : emptyDetail('Select a task.'));
}

const emptyDetail = (msg) => h('div', { class: 'detail-empty' }, h('div', {}, msg));

// ---- shared detail pieces --------------------------------------------------
// Where Claude sessions open: the VS Code extension panel, Terminal, or iTerm.
const terminal = () => localStorage.getItem('terminal') || 'vscode';
const OPEN_IN = [
  ['vscode', 'VS Code'],
  ['terminal', 'Terminal'],
  ['iterm', 'iTerm'],
];
const openInLabel = (v = terminal()) => (OPEN_IN.find(([k]) => k === v) || OPEN_IN[0])[1];

async function resume(sessionId, cwd) {
  try {
    const r = await api.resume({ sessionId, cwd, terminal: terminal() });
    if (r.ok) toast('Opening session…');
  } catch (e) {
    toast(`Couldn't open terminal: ${e.message}`);
  }
}

async function copyResume(sessionId, cwd) {
  api.copy(await api.resumeCommand({ sessionId, cwd }));
  toast('Resume command copied');
}

function resumeActions(sessionId, cwd) {
  const cmdEl = h('code', {}, '…');
  api.resumeCommand({ sessionId, cwd }).then((c) => (cmdEl.textContent = c));
  return [
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => resume(sessionId, cwd) }, '▶ Resume session'),
      h('button', { class: 'btn', onclick: () => api.openVSCode(cwd) }, 'Open folder in VS Code'),
      h('button', { class: 'btn ghost', onclick: () => api.openFolder(cwd) }, 'Reveal in Finder'),
    ),
    h(
      'div',
      { class: 'cmd' },
      cmdEl,
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            api.copy(cmdEl.textContent);
            toast('Command copied');
          },
        },
        'Copy',
      ),
    ),
  ];
}

function conversation(recent) {
  if (!recent?.length) return h('div', { class: 'empty', style: 'padding:10px' }, 'No messages captured.');
  return h(
    'div',
    { class: 'convo' },
    recent.map((m) => h('div', { class: `msg ${m.role}` }, h('span', { class: 'who' }, m.role === 'user' ? 'You' : 'Claude'), m.text)),
  );
}

function card(title, actions, ...body) {
  return h('div', { class: 'card' }, h('h3', {}, title, actions ? h('span', { class: 'row' }, actions) : null), ...body);
}

function sessionRow(link, { onUnlink, showContext } = {}) {
  const s = sessionById(link.id);
  const cwd = (s && s.cwd) || link.cwd;
  const row = h(
    'div',
    { class: 'sess-row' },
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 't', title: (s && s.title) || link.title }, (s && s.title) || link.title || '(untitled session)'),
      h(
        'div',
        { class: 'm' },
        livePill(s?.live),
        h('span', { title: cwd }, folder(cwd)),
        realBranch((s && s.gitBranch) || link.gitBranch) ? h('span', { class: 'mono' }, (s && s.gitBranch) || link.gitBranch) : null,
        h('span', {}, s ? `active ${ago(s.modifiedAt)}` : 'transcript not found'),
      ),
    ),
    h('button', { class: 'btn small primary', title: `Open in ${openInLabel()}`, onclick: () => resume(link.id, cwd) }, terminal() === 'vscode' ? '▶ Open' : '▶ Resume'),
    h('button', { class: 'btn small', title: 'Copy resume command', onclick: () => copyResume(link.id, cwd) }, 'Copy cmd'),
    onUnlink ? h('button', { class: 'btn small ghost', onclick: onUnlink }, 'Unlink') : null,
  );
  if (!showContext || !link.context?.recent?.length) return row;
  return h(
    'div',
    {},
    row,
    h(
      'details',
      { class: 'ctx' },
      h('summary', {}, `Conversation when linked · ${ago(link.context.capturedAt)}`),
      conversation(link.context.recent),
    ),
  );
}

function prRow(ref, { onUnlink } = {}) {
  const p = prByUrl(ref.url);
  return h(
    'div',
    { class: 'sess-row' },
    h('span', { class: `pr-dot ${p?.draft ? 'draft' : ''}` }, '⇅'),
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 't', title: ref.title }, (p && p.title) || ref.title || `${ref.repo}#${ref.number}`),
      h('div', { class: 'm' }, h('span', { class: 'mono' }, `${ref.repo}#${ref.number}`), prStatusPills(p, { compact: true })),
    ),
    h('button', { class: 'btn small', onclick: () => api.openUrl(ref.url) }, 'GitHub ↗'),
    onUnlink ? h('button', { class: 'btn small ghost', onclick: onUnlink }, 'Unlink') : null,
  );
}

// ---- task detail ------------------------------------------------------------
function taskDetail(t) {
  let pending = null;
  const patch = (fields) => {
    Object.assign(t, fields);
    clearTimeout(pending);
    pending = setTimeout(() => saveTask(t, { quiet: true }).then(renderList), 300);
  };
  const seg = (field, opts) =>
    h(
      'div',
      { class: 'seg' },
      opts.map(([v, label]) => h('button', { class: t[field] === v ? 'on' : '', onclick: () => saveTask({ ...t, [field]: v }) }, label)),
    );

  // PRs touched by linked sessions that aren't linked yet — one click to add.
  const linkedUrls = new Set(t.prs.map((p) => p.url));
  const suggested = [];
  for (const link of t.sessions) {
    const s = sessionById(link.id);
    if (!s) continue;
    for (const p of prsForSession(s)) if (!linkedUrls.has(p.url) && !suggested.includes(p)) suggested.push(p);
  }

  return h(
    'div',
    {},
    h('input', { class: 'title-input', value: t.title, placeholder: 'Task title', oninput: (e) => patch({ title: e.target.value }) }),
    h(
      'div',
      { class: 'row', style: 'margin-top:10px' },
      seg('status', [
        ['todo', 'To do'],
        ['doing', 'In progress'],
        ['done', 'Done'],
      ]),
      seg('priority', [
        ['low', 'Low'],
        ['normal', 'Normal'],
        ['high', 'High'],
      ]),
      h('div', { style: 'flex:1' }),
      h('button', { class: 'btn primary', title: 'Start a new Claude Code session that takes a first pass at this task', onclick: () => openStartClaude(t) }, 'Start with Claude ✦'),
      h(
        'button',
        {
          class: 'btn ghost danger',
          onclick: async () => {
            if (!confirm(`Delete "${t.title}"?`)) return;
            await api.deleteTask(t.id);
            state.tasks = state.tasks.filter((x) => x.id !== t.id);
            state.selected = null;
            render();
          },
        },
        'Delete',
      ),
    ),
    taskFolderRow(t),
    h('label', { class: 'field-label' }, 'Notes'),
    h('textarea', { rows: 4, placeholder: 'Add notes…', value: t.notes, oninput: (e) => patch({ notes: e.target.value }) }),

    t.summary ? card('Agent handoff', null, h('div', { class: 'summary' }, t.summary)) : null,

    card(
      `Claude sessions${t.sessions.length ? ` (${t.sessions.length})` : ''}`,
      [
        t.sessions.length
          ? h(
              'button',
              {
                class: 'btn small',
                title: 'Re-capture the latest conversation from each transcript',
                onclick: async () => {
                  const fresh = await Promise.all(t.sessions.map(async (l) => (await api.sessionLink(l.id)) || l));
                  await saveTask({ ...t, sessions: fresh });
                  toast('Context refreshed');
                },
              },
              'Refresh context',
            )
          : null,
        h('button', { class: 'btn small', onclick: () => pickSessions(t) }, '+ Link sessions'),
      ],
      t.pendingStart
        ? h(
            'div',
            { class: 'sess-row pending' },
            h('div', { class: 'grow' }, h('div', { class: 't' }, 'New session starting in VS Code…'), h('div', { class: 'm' }, h('span', {}, folder(t.pendingStart.cwd)), h('span', {}, `asked ${ago(t.pendingStart.at)}`), h('span', {}, 'links automatically once the prompt is sent'))),
            h('button', { class: 'btn small ghost', onclick: () => saveTask({ ...t, pendingStart: null }) }, 'Cancel'),
          )
        : null,
      t.sessions.length
        ? t.sessions.map((l) => sessionRow(l, { showContext: true, onUnlink: () => saveTask({ ...t, sessions: t.sessions.filter((x) => x.id !== l.id) }) }))
        : t.pendingStart
          ? null
          : h('div', { class: 'muted' }, 'No sessions linked.'),
    ),

    card(
      `Pull requests${t.prs.length ? ` (${t.prs.length})` : ''}`,
      [h('button', { class: 'btn small', onclick: () => pickPRs(t) }, '+ Link PRs')],
      t.prs.length
        ? t.prs.map((ref) => prRow(ref, { onUnlink: () => saveTask({ ...t, prs: t.prs.filter((x) => x.url !== ref.url) }) }))
        : h('div', { class: 'muted' }, 'No PRs linked.'),
      suggested.length
        ? h(
            'div',
            { class: 'suggest' },
            h('span', { class: 'muted' }, 'From linked sessions:'),
            suggested.slice(0, 12).map((p) =>
              h('button', { class: 'btn small', title: p.title, onclick: () => saveTask(linkPRs(t, [p.url])) }, `+ ${prLabel(p)}`),
            ),
            suggested.length > 1 ? h('button', { class: 'btn small ghost', onclick: () => saveTask(linkPRs(t, suggested.map((p) => p.url))) }, 'Link all') : null,
          )
        : null,
    ),
    h('div', { class: 'foot-meta' }, `Created ${new Date(t.createdAt).toLocaleString()} · updated ${ago(t.updatedAt)}`),
  );
}

// ---- session detail ---------------------------------------------------------
function linkedTasksCard(tasks) {
  if (!tasks.length) return null;
  return card(
    'Linked tasks',
    null,
    tasks.map((t) =>
      listItem({
        cls: t.status,
        onclick: () => {
          state.view = t.status === 'done' ? 'done' : 'open';
          select(t.id);
        },
        lead: h('span', { class: `check ${t.status}` }),
        title: t.title,
        meta: [],
      }),
    ),
  );
}

function sessionDetail(s) {
  const prs = prsForSession(s);
  return h(
    'div',
    {},
    h('div', { class: 'title-input', style: 'border:none' }, s.title),
    h(
      'div',
      { class: 'row', style: 'margin-top:8px' },
      livePill(s.live),
      h('span', { class: 'pill' }, home(s.cwd)),
      realBranch(s.gitBranch) ? h('span', { class: 'pill mono' }, s.gitBranch) : null,
      h('span', { class: 'pill' }, `active ${ago(s.modifiedAt)}`),
    ),
    card(
      'Actions',
      null,
      h(
        'div',
        { class: 'row', style: 'margin-bottom:10px' },
        h('button', { class: 'btn primary', onclick: () => openNewTask({ sessionIds: [s.id], prUrls: [] }) }, '+ Create task from this session'),
      ),
      resumeActions(s.id, s.cwd),
    ),
    prs.length ? card(`Pull requests (${prs.length})`, null, prs.map((p) => prRow(taskPR(p)))) : null,
    linkedTasksCard(state.tasks.filter((t) => t.sessions.some((x) => x.id === s.id))),
    card('Recent conversation', null, conversation(s.recent)),
  );
}

// ---- notifications ------------------------------------------------------------
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
const timeLabel = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

async function openNotification(n) {
  state.selected = n.id;
  if (!n.read) {
    n.read = true;
    await api.setNotificationsRead({ ids: [n.id], read: true }); // main pushes notifications:changed
  }
  render();
}

function showPRInBaton(url) {
  state.view = viewForPR(url);
  state.prFilter = 'all';
  state.search = '';
  $('#search').value = '';
  select(url);
  setTimeout(() => document.querySelector('#list .item.selected')?.scrollIntoView({ block: 'center' }), 50);
}

const NOTIF_ICON = { ready: '✓', comment: '💬', review: '👀', ci: '✗', session: '◆', attention: '⏸' };
const NOTIF_LABEL = { ready: 'ready to merge', comment: 'comments', review: 'review request', ci: 'checks failing', session: 'Claude session', attention: 'waiting on you' };
const ATTENTION_LABEL = { permission: 'needs permission', question: 'has a question', plan: 'plan to approve', input: 'needs input' };

function sessionNotificationDetail(n) {
  const s = sessionById(n.sessionId);
  return h(
    'div',
    {},
    h('div', { class: 'title-input', style: 'border:none' }, n.title),
    h(
      'div',
      { class: 'row', style: 'margin-top:8px' },
      n.kind === 'attention' ? h('span', { class: 'pill wait' }, `⏸ ${ATTENTION_LABEL[n.reason] || 'waiting on you'}`) : h('span', { class: 'pill claude' }, 'Claude session'),
      h('span', { class: 'pill' }, `${dayLabel(n.createdAt)} · ${timeLabel(n.createdAt)}`),
      n.ranFor ? h('span', { class: 'pill' }, `ran ${n.ranFor >= 90 ? `${Math.round(n.ranFor / 60)} min` : `${Math.round(n.ranFor)} s`}`) : null,
      livePill(s?.live),
    ),
    h(
      'div',
      { class: 'row', style: 'margin-top:14px' },
      // A session that is still open lives in VS Code or a terminal; send you there instead of resuming a second copy.
      s?.live?.entrypoint === 'claude-vscode'
        ? h('button', { class: 'btn primary', onclick: () => api.openVSCode((s && s.cwd) || n.cwd) }, 'Go to VS Code')
        : h('button', { class: 'btn primary', onclick: () => resume(n.sessionId, (s && s.cwd) || n.cwd) }, s?.live ? '▶ Open session' : '▶ Resume session'),
      s
        ? h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                state.view = 'sessions';
                select(n.sessionId);
              },
            },
            'Show session in Baton',
          )
        : null,
      h('button', { class: 'btn', onclick: () => openNewTask({ sessionIds: [n.sessionId], title: (s && s.title) || '' }) }, '+ Create task'),
      h('div', { style: 'flex:1' }),
      notifActions(n),
    ),
    n.kind === 'attention'
      ? card({ permission: 'Waiting for your permission', question: 'Claude is asking', plan: 'Plan waiting for approval', input: 'Claude needs input' }[n.reason] || 'Waiting on you', null, h('div', { class: 'summary' }, n.body))
      : null,
    n.lastPrompt ? card('You asked', null, h('div', { class: 'summary' }, n.lastPrompt)) : null,
    n.kind === 'attention'
      ? s?.recent?.length
        ? card('Recent conversation', null, conversation(s.recent.slice(-2)))
        : null
      : card('Claude said', null, s?.recent?.length ? conversation(s.recent.slice(-2)) : h('div', { class: 'summary' }, n.body)),
  );
}

function notifActions(n) {
  return [
    h('button', { class: 'btn small ghost', onclick: () => api.setNotificationsRead({ ids: [n.id], read: !n.read }) }, n.read ? 'Mark unread' : 'Mark read'),
    h(
      'button',
      {
        class: 'btn small ghost danger',
        onclick: async () => {
          state.selected = null;
          await api.removeNotifications([n.id]);
        },
      },
      'Delete',
    ),
  ];
}

// "Don't tell me about this again" controls shown on PR notifications.
function muteControls(n) {
  if (!n.repo || !state.settings) return null;
  const prefs = state.settings.notify;
  const urls = n.prUrls || (n.url ? [n.url] : []);
  const prMuted = urls.length && urls.every((u) => prefs.mutedPRs.includes(u));
  const repoMuted = prefs.mutedRepos.includes(n.repo);
  return h(
    'div',
    { class: 'row mute-row' },
    h('span', { class: 'muted' }, 'Not interested?'),
    urls.length ? h('button', { class: 'btn small', onclick: () => setMutedPRs(urls, !prMuted) }, prMuted ? `🔔 Unmute ${urls.length > 1 ? 'stack' : 'PR'}` : `🔕 Mute this ${urls.length > 1 ? 'stack' : 'PR'}`) : null,
    h('button', { class: 'btn small', onclick: () => setMutedRepo(n.repo, !repoMuted) }, repoMuted ? `🔔 Unmute ${n.repo}` : `🔕 Mute ${n.repo}`),
  );
}

async function setMutedPRs(urls, mute) {
  const cur = new Set(state.settings.notify.mutedPRs);
  urls.forEach((u) => (mute ? cur.add(u) : cur.delete(u)));
  await saveNotifyPrefs({ mutedPRs: [...cur] });
  toast(mute ? 'Muted. You won’t get notifications for it.' : 'Unmuted');
}
async function setMutedRepo(repo, mute) {
  const cur = new Set(state.settings.notify.mutedRepos);
  mute ? cur.add(repo) : cur.delete(repo);
  await saveNotifyPrefs({ mutedRepos: [...cur] });
  toast(mute ? `Muted ${repo}` : `Unmuted ${repo}`);
}
async function saveNotifyPrefs(patch) {
  await api.setSettings({ notify: patch });
  await loadSettings();
  render({ keepDetail: isEditing() });
}
async function loadSettings() {
  state.settings = await api.getSettings();
}

function notificationDetail(n) {
  if (n.kind === 'session' || n.kind === 'attention') return sessionNotificationDetail(n);
  const prUrls = n.stack ? n.stack.map((x) => x.url) : n.url ? [n.url] : [];
  const live = prByUrl(n.url);
  const refs = n.stack
    ? n.stack.map((x) => ({ url: x.url, number: x.number, title: x.title, repo: n.repo }))
    : n.url
      ? [{ url: n.url, number: n.number, title: n.prTitle, repo: n.repo }]
      : [];
  const KIND = { 'review comment': 'commented', comment: 'commented', reviewed: 'reviewed', approved: 'approved', 'requested changes': 'requested changes' };

  return h(
    'div',
    {},
    h('div', { class: 'title-input', style: 'border:none' }, n.title),
    h(
      'div',
      { class: 'row', style: 'margin-top:8px' },
      h('span', { class: `pill ${n.kind === 'ready' ? 'ready' : n.kind === 'ci' ? 'bad' : 'claude'}` }, NOTIF_LABEL[n.kind] || n.kind),
      n.kind === 'review' && n.author ? h('span', { class: 'pill' }, `requested by @${n.author}`) : null,
      h('span', { class: 'pill' }, `${dayLabel(n.createdAt)} · ${timeLabel(n.createdAt)}`),
      n.read ? null : h('span', { class: 'pill wait' }, 'unread'),
      n.kind === 'ready' && live && !live.mergeReady ? h('span', { class: 'pill bad', title: 'Status changed since this notification' }, 'no longer ready') : null,
      n.url && !live && state.prs ? h('span', { class: 'pill' }, 'merged or closed') : null,
    ),
    h(
      'div',
      { class: 'row', style: 'margin-top:14px' },
      n.link ? h('button', { class: 'btn primary', onclick: () => api.openUrl(n.link) }, n.kind === 'comment' ? 'Open comment on GitHub ↗' : 'Open on GitHub ↗') : null,
      live ? h('button', { class: 'btn', onclick: () => showPRInBaton(n.url) }, 'Show PR in Baton') : null,
      prUrls.length
        ? h(
            'button',
            {
              class: 'btn',
              onclick: () =>
                openNewTask({
                  title: n.kind === 'comment' ? `Address comments on #${n.number}: ${n.prTitle || ''}`.trim() : `Merge: ${n.body || n.prTitle || ''}`,
                  prUrls: prUrls.filter((u) => prByUrl(u)),
                  sessionIds: sessionsForPRs(prUrls.map(prByUrl).filter(Boolean)).slice(0, 3).map((x) => x.id),
                }),
            },
            '+ Create task',
          )
        : null,
      h('div', { style: 'flex:1' }),
      h(
        'button',
        {
          class: 'btn small ghost',
          onclick: async () => {
            await api.setNotificationsRead({ ids: [n.id], read: !n.read });
          },
        },
        n.read ? 'Mark unread' : 'Mark read',
      ),
      h(
        'button',
        {
          class: 'btn small ghost danger',
          onclick: async () => {
            state.selected = null;
            await api.removeNotifications([n.id]);
          },
        },
        'Delete',
      ),
    ),
    muteControls(n),
    n.comments?.length
      ? card(
          `Comments (${n.comments.length})`,
          null,
          n.comments.map((c) =>
            h(
              'div',
              { class: 'comment' },
              h(
                'div',
                { class: 'comment-head' },
                h('b', {}, `@${c.author}`),
                h('span', { class: 'muted' }, ` ${KIND[c.kind] || 'commented'} · ${c.at ? ago(c.at) : ''}`),
                h('div', { style: 'flex:1' }),
                c.url ? openButton(c.url) : null,
              ),
              c.body ? h('div', { class: 'comment-body' }, c.body) : null,
            ),
          ),
        )
      : n.body
        ? card('Details', null, h('div', { class: 'summary' }, n.body))
        : null,
    refs.length ? card(refs.length > 1 ? `Stack (${refs.length} PRs) · current status` : 'Pull request · current status', null, refs.map((r) => prRow(r))) : null,
    (() => {
      const sess = sessionsForPRs(prUrls.map(prByUrl).filter(Boolean));
      return sess.length ? card(`Claude sessions (${sess.length})`, null, sess.map((x) => sessionRow({ id: x.id, cwd: x.cwd, title: x.title, gitBranch: x.gitBranch }))) : null;
    })(),
  );
}

// ---- PR detail --------------------------------------------------------------
function stackOf(p) {
  const pool = allPRs().filter((x, i, arr) => arr.findIndex((y) => y.url === x.url) === i);
  return buildStacks(pool).find((g) => g.some((x) => x.url === p.url)) || [p];
}

function prDetail(p) {
  const stack = stackOf(p);
  const own = sessionsForPR(p);
  const stackSess = sessionsForPRs(stack).filter((s) => !own.includes(s));
  const sess = [...own, ...stackSess];
  return h(
    'div',
    {},
    h('div', { class: 'title-input', style: 'border:none' }, p.title),
    h(
      'div',
      { class: 'row', style: 'margin-top:8px' },
      h('span', { class: 'pill mono' }, `${p.repo}#${p.number}`),
      h('span', { class: 'pill mono', title: `${p.branch} → ${p.base}` }, `${p.branch} → ${p.base}`),
      ...prStatusPills(p),
    ),
    h(
      'div',
      { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'btn primary', onclick: () => openNewTask({ prUrls: [p.url], sessionIds: sess.slice(0, 1).map((s) => s.id), title: p.title }) }, '+ Create task from this PR'),
      h('button', { class: 'btn', onclick: () => api.openUrl(p.url) }, 'Open on GitHub ↗'),
      state.settings
        ? (() => {
            const muted = state.settings.notify.mutedPRs.includes(p.url);
            return h('button', { class: 'btn ghost', title: 'Stop or resume notifications for this PR', onclick: () => setMutedPRs([p.url], !muted) }, muted ? '🔔 Unmute' : '🔕 Mute');
          })()
        : null,
      h(
        'button',
        {
          class: 'btn ghost',
          onclick: () => {
            api.copy(p.url);
            toast('URL copied');
          },
        },
        'Copy URL',
      ),
    ),
    card(
      `Claude sessions (${sess.length})`,
      null,
      sess.length
        ? [
            own.map((s) => sessionRow({ id: s.id, cwd: s.cwd, title: s.title, gitBranch: s.gitBranch })),
            stackSess.length ? h('div', { class: 'muted', style: 'margin:8px 0 2px;font-size:11.5px' }, 'Worked on other PRs in this stack:') : null,
            stackSess.map((s) => sessionRow({ id: s.id, cwd: s.cwd, title: s.title, gitBranch: s.gitBranch })),
          ]
        : h('div', { class: 'muted' }, 'No local Claude session touched this PR, its branch, or its stack.'),
    ),
    stack.length > 1
      ? card(
          `Stack · ${stack.findIndex((x) => x.url === p.url) + 1} of ${stack.length}`,
          [
            h(
              'button',
              {
                class: 'btn small',
                onclick: () => openNewTask({ title: stackName(stack), prUrls: stack.map((x) => x.url), sessionIds: sessionsForPRs(stack).map((x) => x.id) }),
              },
              '+ Task for whole stack',
            ),
          ],
          h('div', { class: 'row', style: 'margin-bottom:8px' }, stackHealth(stack)),
          stack.map((x, i) =>
            h(
              'div',
              { class: `stack-row ${x.url === p.url ? 'current' : ''}`, onclick: () => select(x.url) },
              h('span', { class: 'stack-pos' }, `${i + 1}`),
              h('span', { class: 'grow' }, x.title),
              h('span', { class: 'row' }, prStatusPills(x, { compact: true })),
              openButton(x.url),
            ),
          ),
        )
      : null,
    linkedTasksCard(state.tasks.filter((t) => t.prs.some((x) => x.url === p.url))),
    h(
      'div',
      { class: 'foot-meta' },
      `by @${p.author} · opened ${ago(p.createdAt)} · updated ${ago(p.updatedAt)} · +${p.additions} −${p.deletions}`,
    ),
  );
}

// ---- multi-select picker ------------------------------------------------------
// items: [{ key, title, meta: Node[], search: string }]; resolves to the selected keys, or null if cancelled.
function pickMany({ heading, placeholder, items, selected = [], confirmLabel = 'Link' }) {
  return new Promise((resolve) => {
    const dlg = $('#pickDlg');
    const chosen = new Set(selected);
    const filter = h('input', { type: 'search', placeholder });
    const listEl = h('div', { class: 'session-picker tall' });
    const countEl = h('span', { class: 'muted' });
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      listEl.replaceChildren(
        ...items
          .filter((it) => !q || it.search.toLowerCase().includes(q))
          .slice(0, 150)
          .map((it) =>
            h(
              'div',
              {
                class: `sp-item ${chosen.has(it.key) ? 'on' : ''}`,
                onclick: () => {
                  chosen.has(it.key) ? chosen.delete(it.key) : chosen.add(it.key);
                  draw();
                },
              },
              h('div', { class: 't' }, h('span', { class: 'tick' }, chosen.has(it.key) ? '☑' : '☐'), it.title),
              h('div', { class: 'm' }, it.meta),
            ),
          ),
      );
      countEl.textContent = `${chosen.size} selected`;
    };
    filter.addEventListener('input', draw);
    const done = (val) => {
      dlg.close();
      resolve(val);
    };
    dlg.replaceChildren(
      h(
        'div',
        { class: 'pick' },
        h('h2', {}, heading),
        filter,
        listEl,
        h(
          'div',
          { class: 'dlg-actions' },
          countEl,
          h('div', { style: 'flex:1' }),
          h('button', { class: 'btn', onclick: () => done(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => done([...chosen]) }, confirmLabel),
        ),
      ),
    );
    dlg.onclose = () => resolve(null);
    draw();
    dlg.showModal();
    filter.focus();
  });
}

const sessionItems = () =>
  state.sessions.map((s) => ({
    key: s.id,
    title: s.title,
    search: [s.title, s.cwd, s.gitBranch].join(' '),
    meta: [livePill(s.live), h('span', {}, folder(s.cwd)), realBranch(s.gitBranch) ? h('span', { class: 'mono' }, s.gitBranch) : null, h('span', {}, ago(s.modifiedAt))],
  }));

const prItems = () =>
  allPRs()
    .filter((p, i, arr) => arr.findIndex((x) => x.url === p.url) === i)
    .map((p) => ({
      key: p.url,
      title: p.title,
      search: [p.title, p.repo, p.number, p.branch].join(' '),
      meta: [h('span', { class: 'mono' }, prLabel(p)), ...prStatusPills(p, { compact: true }), p.author !== state.prs?.viewer ? h('span', {}, `@${p.author}`) : null],
    }));

async function pickSessions(task) {
  await loadSessions();
  const ids = await pickMany({
    heading: 'Link Claude sessions',
    placeholder: 'Filter by title, folder, or branch…',
    items: sessionItems(),
    selected: task.sessions.map((s) => s.id),
  });
  if (!ids) return;
  const kept = { ...task, sessions: task.sessions.filter((s) => ids.includes(s.id)) };
  saveTask(await linkSessions(kept, ids));
}

async function pickPRs(task) {
  if (!state.prs) await refreshPRs({ quiet: true });
  if (!state.prs) return toast(state.prError || 'Could not load PRs');
  const urls = await pickMany({
    heading: 'Link pull requests',
    placeholder: 'Filter by title, repo, number, or branch…',
    items: prItems(),
    selected: task.prs.map((p) => p.url),
  });
  if (!urls) return;
  // Keep linked PRs that are no longer open (not in the picker) unless the user could see and deselect them.
  const visible = new Set(allPRs().map((p) => p.url));
  const kept = { ...task, prs: task.prs.filter((p) => urls.includes(p.url) || !visible.has(p.url)) };
  saveTask(linkPRs(kept, urls));
}

// Sessions started in VS Code get their id from the extension, so we find them afterwards:
// same folder, first message is this task's prompt, started after we asked.
let linking = false;
async function linkPendingStarts() {
  if (linking) return;
  linking = true;
  try {
    for (const t of state.tasks.filter((x) => x.pendingStart)) {
      const p = t.pendingStart;
      if (Date.now() - new Date(p.at) > 24 * 3600 * 1000) {
        await saveTask({ ...t, pendingStart: null }, { quiet: true });
        continue;
      }
      const marker = `Task: ${p.title}`;
      const match = state.sessions.find(
        (s) => s.cwd === p.cwd && s.modifiedAt >= p.at && (s.firstPrompt || '').includes(marker) && !t.sessions.some((x) => x.id === s.id),
      );
      if (!match) continue;
      const link = await api.sessionLink(match.id);
      await saveTask({ ...t, pendingStart: null, sessions: [...t.sessions, link || { id: match.id, cwd: match.cwd, title: match.title, context: null }] }, { quiet: true });
      toast(`Linked the new Claude session to “${t.title}”`);
    }
  } finally {
    linking = false;
  }
  render({ keepDetail: isEditing() });
}

// ---- start a Claude session from a task ------------------------------------------------
// Where "Start with Claude" runs: the task's own folder, else a linked session's, else your
// default from Settings, else the last folder you started in, else your most recent session's.
function defaultFolderFor(t) {
  return t.folder || t.sessions.map((s) => s.cwd).find(Boolean) || state.settings?.defaultFolder || localStorage.getItem('lastStartFolder') || recentFolders()[0] || '';
}

function taskFolderRow(t) {
  const current = defaultFolderFor(t);
  const source = t.folder ? '' : current ? ' (default)' : '';
  const sel = h('select', { class: 'inline-select folder-select' });
  const opts = [...new Set([t.folder, current, state.settings?.defaultFolder, ...recentFolders()].filter(Boolean))];
  sel.replaceChildren(
    ...opts.map((f) => h('option', { value: f, selected: f === current ? true : null }, home(f) + (f === current ? source : ''))),
    h('option', { value: '__pick' }, 'Choose another folder…'),
    t.folder ? h('option', { value: '__clear' }, 'Use default') : null,
  );
  sel.addEventListener('change', async () => {
    let folder = sel.value;
    if (folder === '__pick') folder = await api.pickFolder(current);
    if (folder === '__clear') folder = '';
    if (folder === null || folder === undefined) return renderDetail();
    saveTask({ ...t, folder });
  });
  return h('div', { class: 'row', style: 'margin-top:10px' }, h('span', { class: 'muted' }, '📁 Project folder'), sel);
}

const START_MODES = [
  ['plan', 'Plan first', 'Read-only: Claude investigates and proposes a plan, no edits'],
  ['default', 'Work on it, ask before changes', 'Normal Claude Code permissions'],
  ['acceptEdits', 'Work on it, auto-accept edits', 'Claude edits files without asking (still asks for other commands)'],
];

function recentFolders() {
  const out = [];
  for (const s of state.sessions) if (s.cwd && !out.includes(s.cwd)) out.push(s.cwd);
  return out.slice(0, 15);
}

function buildPrompt(t, what, mode, withContext) {
  const lines = [`# Task: ${t.title}`, '', what.trim() || '(no further description)'];
  if (withContext) {
    const ctx = [];
    if (t.summary) ctx.push(`Handoff notes from an earlier session:\n${t.summary}`);
    if (t.notes && t.notes.trim() && t.notes.trim() !== what.trim()) ctx.push(`My notes:\n${t.notes.trim()}`);
    if (t.prs.length) ctx.push(`Related pull requests (use \`gh pr view <url>\` for details):\n${t.prs.map((p) => `- ${p.url}${p.title ? ` — ${p.title}` : ''}`).join('\n')}`);
    if (t.sessions.length)
      ctx.push(
        `Earlier Claude sessions on this:\n${t.sessions
          .map((s) => `- ${s.title || s.id}${s.context?.lastPrompt ? ` (last ask: ${s.context.lastPrompt.slice(0, 200)})` : ''}`)
          .join('\n')}`,
      );
    if (ctx.length) lines.push('', '## Context', '', ctx.join('\n\n'));
  }
  lines.push(
    '',
    '## How to approach this',
    '',
    mode === 'plan'
      ? 'Take a first pass: investigate the relevant code and propose a concrete plan. Do not change files yet.'
      : 'Take a first pass: investigate the relevant code, then make a reasonable first implementation. Keep changes focused and do not commit or push unless I ask.',
    'When you stop, summarize what you found or did, what is left, and any questions for me.',
  );
  return lines.join('\n');
}

function openStartClaude(t) {
  const dlg = $('#startDlg');
  const folders = recentFolders();
  let cwd = defaultFolderFor(t);
  let mode = localStorage.getItem('startMode') || 'plan';
  let openIn = terminal();
  const whereSel = h(
    'select',
    {
      onchange: (e) => {
        openIn = e.target.value;
        hint.textContent = whereHint();
      },
    },
    OPEN_IN.map(([v, label]) => h('option', { value: v, selected: openIn === v ? true : null }, label)),
  );
  const whereHint = () =>
    openIn === 'vscode'
      ? 'Opens the folder in VS Code and the Claude panel with this prompt. If it isn’t sent automatically, press Enter there. The mode is passed in the prompt; Baton links the session to this task once it starts.'
      : `Runs claude in a new ${openInLabel(openIn)} window with the chosen permission mode, linked to this task.`;
  const hint = h('div', { class: 'toggle-hint', style: 'margin-top:4px' }, whereHint());

  const folderSel = h('select', {});
  const drawFolders = () => {
    const opts = [...new Set([cwd, ...folders].filter(Boolean))];
    folderSel.replaceChildren(...opts.map((f) => h('option', { value: f, selected: f === cwd ? true : null }, home(f))), h('option', { value: '__pick' }, 'Choose another folder…'));
  };
  folderSel.addEventListener('change', async () => {
    if (folderSel.value === '__pick') {
      const picked = await api.pickFolder(cwd);
      if (picked) cwd = picked;
    } else cwd = folderSel.value;
    drawFolders();
  });
  drawFolders();

  const what = h('textarea', { rows: 6, placeholder: 'What needs to be done? Goals, constraints, where to look, what “done” means…', value: t.notes || '' });
  const withCtx = h('input', { type: 'checkbox', checked: true });
  const ctxBits = [t.summary && 'handoff notes', t.prs.length && `${t.prs.length} PR${t.prs.length > 1 ? 's' : ''}`, t.sessions.length && `${t.sessions.length} earlier session${t.sessions.length > 1 ? 's' : ''}`].filter(Boolean);
  const preview = h('pre', { class: 'prompt-preview' });
  const modeBox = h('div', { class: 'modes' });
  const drawModes = () =>
    modeBox.replaceChildren(
      ...START_MODES.map(([v, label, hint]) =>
        h(
          'label',
          { class: `mode ${mode === v ? 'on' : ''}` },
          h('input', {
            type: 'radio',
            name: 'startMode',
            checked: mode === v ? true : null,
            onchange: () => {
              mode = v;
              drawModes();
              drawPreview();
            },
          }),
          h('span', {}, h('span', { class: 'toggle-label' }, label), h('span', { class: 'toggle-hint' }, hint)),
        ),
      ),
    );
  const drawPreview = () => (preview.textContent = buildPrompt(t, what.value, mode, withCtx.checked));
  what.addEventListener('input', drawPreview);
  withCtx.addEventListener('change', drawPreview);
  drawModes();
  drawPreview();

  const start = async () => {
    try {
      const prompt = buildPrompt(t, what.value, mode, withCtx.checked);
      localStorage.setItem('startMode', mode);
      localStorage.setItem('lastStartFolder', cwd);
      const r = await api.startSession({ cwd, prompt, name: t.title, mode, terminal: openIn });
      dlg.close();
      const fresh0 = state.tasks.find((x) => x.id === t.id) || t;
      if (r.pending) {
        await saveTask({
          ...fresh0,
          status: fresh0.status === 'todo' ? 'doing' : fresh0.status,
          folder: cwd,
          notes: fresh0.notes || what.value,
          pendingStart: { at: r.startedAt, cwd: r.cwd, title: t.title },
        });
        toast('Opening in VS Code. Press Enter in the Claude panel if the prompt isn’t sent.');
        return;
      }
      // Link the new session right away; its transcript appears once Claude starts writing.
      const fresh = state.tasks.find((x) => x.id === t.id) || t;
      await saveTask({
        ...fresh,
        status: fresh.status === 'todo' ? 'doing' : fresh.status,
        folder: cwd,
        notes: fresh.notes || what.value,
        sessions: [...fresh.sessions, { id: r.sessionId, cwd: r.cwd, title: t.title, gitBranch: '', context: null }],
      });
      toast('Claude is starting in your terminal');
    } catch (e) {
      toast(`Couldn’t start Claude: ${e.message}`);
    }
  };

  dlg.replaceChildren(
    h(
      'div',
      { class: 'pick start' },
      h('h2', {}, 'Start with Claude'),
      h('div', { class: 'muted', style: 'margin-bottom:6px' }, `Starts a new Claude Code session linked to “${t.title}”.`),
      h('label', { class: 'field-label' }, 'Open in'),
      whereSel,
      hint,
      h('label', { class: 'field-label' }, 'Project folder'),
      folderSel,
      h('label', { class: 'field-label' }, 'What needs to be done'),
      what,
      h('label', { class: 'field-label' }, 'Mode'),
      modeBox,
      ctxBits.length ? h('label', { class: 'toggle', style: 'margin-top:12px' }, withCtx, `Include context from this task (${ctxBits.join(', ')})`) : null,
      h('details', { class: 'ctx' }, h('summary', {}, 'Preview prompt'), preview),
      h(
        'div',
        { class: 'dlg-actions' },
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: start }, 'Start Claude ✦'),
      ),
    ),
  );
  if (!state.sessions.length) loadSessions().then(drawFolders);
  dlg.showModal();
  what.focus();
}

// ---- new task dialog -----------------------------------------------------------
const draft = { sessionIds: [], prUrls: [] };

function renderDraftLinks() {
  const box = $('#draftLinks');
  const chips = [
    ...draft.sessionIds.map((id) => {
      const s = sessionById(id);
      return h(
        'span',
        { class: 'chip' },
        `◆ ${s ? s.title : id.slice(0, 8)}`,
        h('button', { type: 'button', onclick: () => ((draft.sessionIds = draft.sessionIds.filter((x) => x !== id)), renderDraftLinks()) }, '×'),
      );
    }),
    ...draft.prUrls.map((url) => {
      const p = prByUrl(url);
      return h(
        'span',
        { class: 'chip' },
        `⇅ ${p ? prLabel(p) : url}`,
        h('button', { type: 'button', onclick: () => ((draft.prUrls = draft.prUrls.filter((x) => x !== url)), renderDraftLinks()) }, '×'),
      );
    }),
  ];
  box.replaceChildren(...(chips.length ? chips : [h('span', { class: 'muted' }, 'Nothing linked yet.')]));
}

async function openNewTask({ sessionIds, prUrls = [], title = '' } = {}) {
  await loadSessions();
  const form = $('#newTaskForm');
  form.reset();
  draft.sessionIds = sessionIds || state.sessions.filter((s) => s.live).slice(0, 1).map((s) => s.id);
  draft.prUrls = [...prUrls];
  form.title.value = title || (sessionIds?.length === 1 ? sessionById(sessionIds[0])?.title || '' : '');
  renderDraftLinks();
  $('#newTaskDlg').showModal();
  form.title.focus();
  form.title.select();
}

$('#addSessionsBtn').addEventListener('click', async () => {
  const ids = await pickMany({ heading: 'Link Claude sessions', placeholder: 'Filter by title, folder, or branch…', items: sessionItems(), selected: draft.sessionIds, confirmLabel: 'Done' });
  if (ids) draft.sessionIds = ids;
  renderDraftLinks();
});
$('#addPRsBtn').addEventListener('click', async () => {
  if (!state.prs) await refreshPRs({ quiet: true });
  const urls = state.prs
    ? await pickMany({ heading: 'Link pull requests', placeholder: 'Filter by title, repo, number, or branch…', items: prItems(), selected: draft.prUrls, confirmLabel: 'Done' })
    : (toast(state.prError || 'Could not load PRs'), null);
  if (urls) draft.prUrls = urls;
  renderDraftLinks();
});

$('#newTaskForm').addEventListener('submit', async (e) => {
  const action = e.submitter?.value;
  if (action !== 'ok' && action !== 'start') return;
  const form = e.target;
  let task = { title: form.title.value.trim(), notes: form.notes.value, sessions: [], prs: [] };
  task = await linkSessions(task, draft.sessionIds);
  task = linkPRs(task, draft.prUrls);
  const saved = await saveTask(task);
  if (!['open', 'todo'].includes(state.view)) state.view = 'open';
  select(saved.id);
  if (action === 'start') openStartClaude(saved);
});
$('#cancelNew').addEventListener('click', () => $('#newTaskDlg').close());

// ---- skill install box -----------------------------------------------------------
async function renderSkillBox() {
  const st = await api.skillStatus();
  const box = $('#skillBox');
  if (!box) return;
  if (st.installed && st.current) {
    box.replaceChildren(h('div', {}, h('b', {}, '/task'), ' is installed. Inside any Claude Code session, run ', h('code', {}, '/task'), ' to park pending work here with the agent’s handoff notes.'));
    return;
  }
  box.replaceChildren(
    h('div', {}, st.installed ? 'The /task skill is out of date.' : 'Add a /task command to Claude Code so sessions can file tasks here.'),
    h(
      'button',
      {
        class: 'btn small',
        style: 'margin-top:8px',
        onclick: async () => {
          await api.installSkill();
          toast('/task skill installed');
          renderSkillBox();
        },
      },
      st.installed ? 'Update /task' : 'Install /task',
    ),
  );
}

// ---- wiring -------------------------------------------------------------------
document.querySelectorAll('aside [data-view]').forEach((a) =>
  a.addEventListener('click', async () => {
    state.view = a.dataset.view;
    state.selected = null;
    render();
    if (state.view === 'sessions') {
      await loadSessions();
      render();
    }
    if (isPRView() && (!state.prs || Date.now() - new Date(state.prs.fetchedAt) > 2 * 60 * 1000)) refreshPRs();
  }),
);
$('#refreshBtn').addEventListener('click', () => refreshPRs());
$('#stackBtn').addEventListener('click', () => {
  state.groupStacks = !state.groupStacks;
  localStorage.setItem('groupStacks', state.groupStacks ? '1' : '0');
  renderListHead();
  renderList();
});
$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderList();
});
$('#newTaskBtn').addEventListener('click', () => openNewTask());
document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key === 'n') {
    e.preventDefault();
    openNewTask();
  }
  if (e.metaKey && e.key === 'f') {
    e.preventDefault();
    $('#search').focus();
  }
  if (e.metaKey && e.key === 'o' && isPRView() && prByUrl(state.selected)) {
    e.preventDefault();
    api.openUrl(state.selected);
  }
  if (e.metaKey && e.key === 'r' && isPRView()) {
    e.preventDefault();
    refreshPRs();
  }
});

function isEditing() {
  const a = document.activeElement;
  return Boolean(a && ['INPUT', 'TEXTAREA'].includes(a.tagName) && $('#detail').contains(a));
}

api.on('tasks:changed', async () => {
  await loadTasks();
  render({ keepDetail: isEditing() });
});
api.on('sessions:changed', async () => {
  await loadSessions();
  render({ keepDetail: isEditing() });
});
window.addEventListener('focus', async () => {
  await Promise.all([loadTasks(), loadSessions()]);
  render({ keepDetail: isEditing() });
});
// The main process polls GitHub in the background and pushes results here.
api.on('prs:updated', (r) => applyPRUpdate(r));
api.on('notifications:changed', async () => {
  await loadNotifications();
  render({ keepDetail: isEditing() });
});
api.on('notifications:focus', async (id) => {
  await loadNotifications();
  state.view = 'notifications';
  state.notifFilter = 'all';
  state.search = '';
  $('#search').value = '';
  select(id);
  setTimeout(() => document.querySelector('#list .item.selected')?.scrollIntoView({ block: 'center' }), 50);
});
$('#markAllBtn').addEventListener('click', () => api.setNotificationsRead({ ids: 'all', read: true }));
$('#clearAllBtn').addEventListener('click', async () => {
  if (!confirm(`Delete all ${state.notifications.length} notifications? This can’t be undone.`)) return;
  state.selected = null;
  await api.clearAllNotifications();
  toast('Notifications cleared');
});
api.on('settings:changed', async () => {
  await loadSettings();
  if (state.view === 'settings') renderDetail();
});
api.on('prs:focus', (url) => {
  state.view = viewForPR(url);
  state.search = '';
  $('#search').value = '';
  state.prFilter = 'all';
  select(url);
  setTimeout(() => document.querySelector('#list .item.selected')?.scrollIntoView({ block: 'center' }), 50);
});

function hooksBox() {
  const box = h('div', { class: 'skill-box' }, 'Checking Claude Code hooks…');
  const draw = async () => {
    const st = await api.hooksStatus();
    const act = (label, fn, cls = 'btn small') =>
      h(
        'button',
        {
          class: cls,
          style: 'margin-top:8px;margin-right:6px',
          onclick: async () => {
            try {
              await fn();
              toast('Done. Restart running Claude sessions to pick it up.');
            } catch (e) {
              toast(e.message);
            }
            draw();
          },
        },
        label,
      );
    box.replaceChildren(
      h('div', {}, h('b', {}, '“Waiting on you” hooks'), st.installed ? (st.current ? ' are installed.' : ' are installed but point at an older Baton.') : ' are not installed.'),
      h(
        'div',
        { class: 'toggle-hint', style: 'margin-top:4px' },
        'Adds Notification and PreToolUse (AskUserQuestion, ExitPlanMode) hooks to ',
        h('code', {}, home(st.settingsFile)),
        ' so Claude Code tells Baton when a session needs you. Your other settings are kept and a backup is saved next to the file. Sessions started before installing need a restart.',
      ),
      st.installed
        ? [st.current ? null : act('Update hooks', () => api.installHooks(), 'btn small primary'), act('Remove hooks', () => api.uninstallHooks(), 'btn small ghost danger')]
        : act('Install hooks', () => api.installHooks(), 'btn small primary'),
    );
  };
  draw();
  return box;
}

// ---- Settings view ------------------------------------------------------------------
const SETTINGS_SECTIONS = [
  ['set-notify', 'Notifications', 'What Baton tells you about'],
  ['set-muted', 'Muted', 'Repos and PRs you don’t want to hear about'],
  ['set-general', 'General', 'Resume, startup'],
  ['set-claude', 'Claude Code', 'The /task skill'],
];

function settingsList(list) {
  for (const [id, title, sub] of SETTINGS_SECTIONS) {
    list.append(
      listItem({
        onclick: () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        title,
        meta: [h('span', {}, sub)],
      }),
    );
  }
}

function settingsDetail() {
  const st = state.settings;
  if (!st) return emptyDetail('Loading…');
  const n = st.notify;
  const check = (key, label, hint) =>
    h(
      'label',
      { class: 'toggle row-toggle' },
      h('input', { type: 'checkbox', checked: n[key] ? true : null, onchange: (e) => saveNotifyPrefs({ [key]: e.target.checked }) }),
      h('span', {}, h('span', { class: 'toggle-label' }, label), hint ? h('span', { class: 'toggle-hint' }, hint) : null),
    );
  const group = (title, ...rows) => h('div', { class: 'set-group' }, h('div', { class: 'field-label' }, title), ...rows);
  const secs = [
    [0, 'Any length'],
    [30, '30 seconds'],
    [60, '1 minute'],
    [120, '2 minutes'],
    [300, '5 minutes'],
  ];

  const muted = n.mutedPRs.map((url) => {
    const p = prByUrl(url);
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url) || [];
    return h(
      'div',
      { class: 'sess-row' },
      h('div', { class: 'grow' }, h('div', { class: 't' }, p ? p.title : url), h('div', { class: 'm' }, h('span', { class: 'mono' }, `${m[1] || ''}#${m[2] || ''}`))),
      h('button', { class: 'btn small', onclick: () => setMutedPRs([url], false) }, '🔔 Unmute'),
    );
  });

  const skillBox = h('div', { id: 'skillBox', class: 'skill-box' });
  setTimeout(renderSkillBox, 0);

  return h(
    'div',
    { class: 'settings' },
    h('div', { class: 'title-input', style: 'border:none' }, 'Settings'),

    h(
      'div',
      { class: 'card', id: 'set-notify' },
      h('h3', {}, 'Notifications'),
      h('div', { class: 'muted', style: 'margin:-4px 0 10px' }, 'Only the types you leave on are recorded in Notifications and shown as banners.'),
      group(
        'Pull requests',
        check('readyPR', 'A PR becomes ready to merge', 'Standalone PRs: approved, checks green, no conflicts or open threads'),
        check('readyStack', 'A whole stack becomes ready to merge', 'One notification when every PR in the stack is ready'),
        check('ciFailed', 'Checks start failing on my PRs'),
        check('reviewRequested', 'Someone requests my review', 'Includes who asked'),
      ),
      group(
        'Comments on my PRs',
        check('comments', 'Comments from people'),
        check('botComments', 'Comments from bots and AI reviewers', 'e.g. *-review-agent, [bot] accounts'),
        check('approvals', 'Approvals'),
        check('changesRequested', 'Changes requested'),
      ),
      group(
        'Claude Code',
        check('sessionAttention', 'A Claude session is waiting for my answer', 'Permission prompts, questions, and plans to approve. Needs the Claude Code hooks (Settings → Claude Code)'),
        check('sessionDone', 'A Claude session finishes', 'When a running session goes back to waiting for you'),
        h(
          'label',
          { class: 'toggle row-toggle', style: n.sessionDone ? '' : 'opacity:.5' },
          h('span', { class: 'toggle-label', style: 'margin-left:24px' }, 'Only if it ran at least'),
          h(
            'select',
            { class: 'inline-select', disabled: n.sessionDone ? null : true, onchange: (e) => saveNotifyPrefs({ sessionMinSeconds: Number(e.target.value) }) },
            secs.map(([v, label]) => h('option', { value: v, selected: n.sessionMinSeconds === v ? true : null }, label)),
          ),
        ),
      ),
      group(
        'Delivery',
        check('banners', 'Show macOS banners', 'Off = record quietly in Notifications only'),
        check('dockBadge', 'Unread count on the Dock icon'),
      ),
    ),

    h(
      'div',
      { class: 'card', id: 'set-muted' },
      h('h3', {}, 'Muted'),
      group(
        'Repositories',
        st.repos.length
          ? st.repos.map((repo) =>
              h(
                'label',
                { class: 'toggle row-toggle' },
                h('input', { type: 'checkbox', checked: n.mutedRepos.includes(repo) ? null : true, onchange: (e) => setMutedRepo(repo, !e.target.checked) }),
                h('span', { class: 'toggle-label mono' }, repo),
              ),
            )
          : h('div', { class: 'muted' }, 'No repositories yet.'),
      ),
      group('Pull requests and stacks', muted.length ? muted : h('div', { class: 'muted' }, 'None. Use “Mute” on a PR or notification to stop hearing about it.')),
    ),

    h(
      'div',
      { class: 'card', id: 'set-general' },
      h('h3', {}, 'General'),
      h(
        'label',
        { class: 'toggle row-toggle' },
        h('span', { class: 'toggle-label' }, 'Open Claude sessions in'),
        h(
          'select',
          {
            class: 'inline-select',
            onchange: (e) => {
              localStorage.setItem('terminal', e.target.value);
              toast('Saved');
            },
          },
          OPEN_IN.map(([v, label]) => h('option', { value: v, selected: terminal() === v ? true : null }, label)),
        ),
      ),
      h(
        'div',
        { class: 'toggle row-toggle' },
        h('span', {}, h('span', { class: 'toggle-label' }, 'Default folder for new Claude sessions'), h('span', { class: 'toggle-hint mono' }, st.defaultFolder ? home(st.defaultFolder) : 'Not set: uses the task’s linked session, then your last folder')),
        h('div', { style: 'flex:1' }),
        h(
          'button',
          {
            class: 'btn small',
            onclick: async () => {
              const f = await api.pickFolder(st.defaultFolder);
              if (!f) return;
              await api.setSettings({ defaultFolder: f });
              await loadSettings();
              renderDetail();
            },
          },
          'Choose…',
        ),
        st.defaultFolder
          ? h(
              'button',
              {
                class: 'btn small ghost',
                onclick: async () => {
                  await api.setSettings({ defaultFolder: '' });
                  await loadSettings();
                  renderDetail();
                },
              },
              'Clear',
            )
          : null,
      ),
      st.canLaunchAtLogin
        ? h(
            'label',
            { class: 'toggle row-toggle' },
            h('input', {
              type: 'checkbox',
              checked: st.openAtLogin ? true : null,
              onchange: async (e) => {
                await api.setSettings({ openAtLogin: e.target.checked });
                await loadSettings();
                renderDetail();
              },
            }),
            h('span', {}, h('span', { class: 'toggle-label' }, 'Run at login'), h('span', { class: 'toggle-hint' }, 'Keeps the GitHub and session watchers running in the background')),
          )
        : null,
    ),

    h('div', { class: 'card', id: 'set-claude' }, h('h3', {}, 'Claude Code'), hooksBox(), h('div', { style: 'height:12px' }), skillBox),
  );
}

(async () => {
  const [, , cached] = await Promise.all([loadTasks(), loadSessions(), api.cachedPRs(), loadNotifications()]);
  state.prs = cached;
  await loadSettings();
  render();
})();
