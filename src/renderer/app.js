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
  const awaiting = stack.reduce((a, p) => a + (p.awaitingReply || 0), 0);
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
  if (p.awaitingReply) out.push(h('span', { class: 'pill bad', title: 'Unresolved threads where someone else spoke last' }, `💬 ${p.awaitingReply} to address`));
  else if (p.unresolvedThreads) out.push(h('span', { class: 'pill wait' }, `💬 ${p.unresolvedThreads}`));
  if (p.mergeable === 'CONFLICTING') out.push(h('span', { class: 'pill bad' }, 'conflicts'));
  return out;
}

// ---- data -----------------------------------------------------------------
async function loadTasks() {
  state.tasks = await api.listTasks();
}
async function loadSessions() {
  state.sessions = await api.listSessions();
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
const VIEW_TITLES = { open: 'Open', todo: 'To do', doing: 'In progress', done: 'Done', sessions: 'Claude sessions', prs: 'Pull requests' };
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
  document.querySelectorAll('[data-count]').forEach((el) => (el.textContent = c[el.dataset.count] || ''));
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  renderListHead();
  renderList();
  if (!keepDetail) renderDetail();
}

function renderListHead() {
  $('#listTitle').textContent = VIEW_TITLES[state.view];
  const btn = $('#refreshBtn');
  const sub = $('#listSub');
  btn.hidden = state.view !== 'prs';
  const sb = $('#stackBtn');
  sb.hidden = state.view !== 'prs';
  sb.classList.toggle('on', state.groupStacks);
  sb.textContent = state.groupStacks ? '☑ Stacks' : '☐ Stacks';
  const pf = $('#prFilters');
  pf.hidden = state.view !== 'prs';
  if (state.view === 'prs') {
    const mine = state.prs ? state.prs.mine : [];
    const readyUnits = new Set(mine.filter((p) => p.mergeReady).map((p) => p.stackRoot || p.url)).size;
    const respond = mine.filter((p) => p.needsResponse).length;
    const opts = [
      ['all', 'All'],
      ['ready', `Ready to merge${readyUnits ? ` ${readyUnits}` : ''}`],
      ['respond', `To address${respond ? ` ${respond}` : ''}`],
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
  if (state.view === 'prs') {
    if (state.prError) {
      sub.className = 'list-sub error';
      sub.textContent = state.prError;
    } else if (state.prs) sub.textContent = `@${state.prs.viewer} · updated ${ago(state.prs.fetchedAt)}`;
  }
}

function listItem({ selected, cls = '', onclick, lead, title, meta }) {
  return h(
    'div',
    { class: `item ${cls} ${selected ? 'selected' : ''}`, onclick },
    lead,
    h('div', { class: 'item-main' }, h('div', { class: 'item-title' }, title), h('div', { class: 'item-meta' }, meta)),
  );
}

function renderList() {
  const list = $('#list');
  list.replaceChildren();

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

  if (state.view === 'prs') {
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
        onclick: () => select(p.url),
        lead: pos ? h('span', { class: 'stack-pos' }, pos) : h('span', { class: `pr-dot ${p.draft ? 'draft' : ''}` }, '⇅'),
        title: p.title,
        meta: [
          h('span', { class: 'mono' }, prLabel(p)),
          ...prStatusPills(p, { compact: true }),
          sess.length ? h('span', { class: 'pill claude' }, `◆ ${sess.length}`) : null,
          tasks ? h('span', { class: 'pill claude' }, `${tasks} task${tasks > 1 ? 's' : ''}`) : null,
          h('span', {}, ago(p.updatedAt)),
        ],
      });
    };
    const section = (label, prs) => {
      const searched = prs.filter((p) => matches([p.title, p.repo, p.number, p.branch, p.author].join(' ')));
      const f = state.prFilter;
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
        const open = containsSelected || state.prFilter !== 'all' || (state.stackOpen[full[0].url] ?? full.length <= 5);
        list.append(
          h(
            'div',
            { class: `stack ${open ? 'open' : ''}` },
            h(
              'div',
              {
                class: 'stack-head',
                onclick: () => {
                  state.stackOpen[full[0].url] = !open;
                  localStorage.setItem('stackOpen', JSON.stringify(state.stackOpen));
                  renderList();
                },
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
            open ? stack.map((p) => prItem(p, { pos: `${(p.stackIndex ?? 0) + 1}/${p.stackSize || stack.length}` })) : null,
          ),
        );
      }
    };
    section('Your PRs', state.prs.mine);
    // "To address" is about comments on your own PRs; review requests don't apply.
    if (state.prFilter !== 'respond') section('Review requested', state.prs.review);
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
      return h('span', { class: `pill ${bad ? 'bad' : ok ? 'ok' : ''}`, title: ref.title }, `#${ref.number}`);
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
  if (state.view === 'prs') {
    const p = prByUrl(state.selected);
    return pane.append(p ? prDetail(p) : emptyDetail('Pick a pull request to see its Claude sessions and tasks.'));
  }
  const t = state.tasks.find((x) => x.id === state.selected);
  pane.append(t ? taskDetail(t) : emptyDetail('Select a task.'));
}

const emptyDetail = (msg) => h('div', { class: 'detail-empty' }, h('div', {}, msg));

// ---- shared detail pieces --------------------------------------------------
const terminal = () => $('#terminalSel').value;

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
    h('button', { class: 'btn small primary', onclick: () => resume(link.id, cwd) }, '▶ Resume'),
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
      t.sessions.length
        ? t.sessions.map((l) => sessionRow(l, { showContext: true, onUnlink: () => saveTask({ ...t, sessions: t.sessions.filter((x) => x.id !== l.id) }) }))
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
  if (e.submitter?.value !== 'ok') return;
  const form = e.target;
  let task = { title: form.title.value.trim(), notes: form.notes.value, sessions: [], prs: [] };
  task = await linkSessions(task, draft.sessionIds);
  task = linkPRs(task, draft.prUrls);
  const saved = await saveTask(task);
  if (!['open', 'todo'].includes(state.view)) state.view = 'open';
  select(saved.id);
});
$('#cancelNew').addEventListener('click', () => $('#newTaskDlg').close());

// ---- skill install box -----------------------------------------------------------
async function renderSkillBox() {
  const st = await api.skillStatus();
  const box = $('#skillBox');
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
document.querySelectorAll('#nav a').forEach((a) =>
  a.addEventListener('click', async () => {
    state.view = a.dataset.view;
    state.selected = null;
    render();
    if (state.view === 'sessions') {
      await loadSessions();
      render();
    }
    if (state.view === 'prs' && (!state.prs || Date.now() - new Date(state.prs.fetchedAt) > 2 * 60 * 1000)) refreshPRs();
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
$('#terminalSel').value = localStorage.getItem('terminal') || 'terminal';
$('#terminalSel').addEventListener('change', (e) => localStorage.setItem('terminal', e.target.value));
document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key === 'n') {
    e.preventDefault();
    openNewTask();
  }
  if (e.metaKey && e.key === 'f') {
    e.preventDefault();
    $('#search').focus();
  }
  if (e.metaKey && e.key === 'r' && state.view === 'prs') {
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
api.on('prs:focus', (url) => {
  state.view = 'prs';
  state.search = '';
  $('#search').value = '';
  state.prFilter = 'all';
  select(url);
  setTimeout(() => document.querySelector('#list .item.selected')?.scrollIntoView({ block: 'center' }), 50);
});

async function renderSettings() {
  const st = await api.getSettings();
  const toggle = (key, label, title) =>
    h(
      'label',
      { class: 'toggle', title },
      h('input', {
        type: 'checkbox',
        checked: st[key] ? true : null,
        onchange: async (e) => {
          await api.setSettings({ [key]: e.target.checked });
          renderSettings();
        },
      }),
      label,
    );
  $('#settingsBox').replaceChildren(
    h('div', { class: 'field-label', style: 'margin-top:0' }, 'Notify me when'),
    toggle('notifyReady', 'A PR or stack is ready to merge'),
    toggle('notifyComments', 'Someone comments on my PRs'),
    ...(st.canLaunchAtLogin ? [toggle('openAtLogin', 'Run at login (background)', 'Keeps the PR watcher running after restarts')] : []),
  );
}

(async () => {
  const [, , cached] = await Promise.all([loadTasks(), loadSessions(), api.cachedPRs()]);
  state.prs = cached;
  render();
  renderSkillBox();
  renderSettings();
})();
