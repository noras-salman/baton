/* global api */
// Small GitHub-flavoured markdown renderer that builds DOM nodes directly (never innerHTML),
// so comment content can't inject markup or script. Covers what PR comments and Claude's
// replies use: headings, emphasis, code, links, lists, quotes, tables, rules.
(function () {
  const el = (tag, cls, ...kids) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const k of kids.flat()) if (k != null && k !== '') n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  };

  function link(text, href) {
    const a = el('a', 'md-link', text);
    a.href = '#';
    a.title = href;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (/^https?:\/\//.test(href)) api.openUrl(href.replace(/^http:/, 'https:'));
    });
    return a;
  }

  // Inline: `code`, **bold**, *italic*, ~~strike~~, [text](url), ![alt](url), bare URLs.
  const INLINE = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)|(?<![\w_])_(?!\s)([^_\n]+?)_(?!\w)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

  function inline(text) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const [, , code, alt, img, ltext, lurl, b1, b2, strike, i1, i2, bare] = m;
      if (code !== undefined) out.push(el('code', 'md-code', code.replace(/^ (.*) $/, '$1')));
      else if (img !== undefined) out.push(link(`[image${alt ? `: ${alt}` : ''}]`, img));
      else if (lurl !== undefined) out.push(link(inline(ltext), lurl));
      else if (b1 !== undefined || b2 !== undefined) out.push(el('strong', null, inline(b1 ?? b2)));
      else if (strike !== undefined) out.push(el('del', null, inline(strike)));
      else if (i1 !== undefined || i2 !== undefined) out.push(el('em', null, inline(i1 ?? i2)));
      else if (bare !== undefined) out.push(link(bare, bare));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  // Lines joined with <br>, like GitHub comments.
  function lines(arr) {
    const out = [];
    arr.forEach((l, i) => {
      if (i) out.push(el('br'));
      out.push(...inline(l));
    });
    return out;
  }

  const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function blocks(src) {
    const L = String(src || '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    while (i < L.length) {
      const line = L[i];
      // fenced code
      const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < L.length && !L[i].trim().startsWith(fence[1])) body.push(L[i++]);
        i++;
        out.push(el('pre', 'md-pre', el('code', null, body.join('\n'))));
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const hd = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (hd) {
        out.push(el(`h${Math.min(6, hd[1].length + 2)}`, 'md-h', inline(hd[2])));
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push(el('hr', 'md-hr'));
        i++;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const q = [];
        while (i < L.length && /^\s*>/.test(L[i])) q.push(L[i++].replace(/^\s*>\s?/, ''));
        out.push(el('blockquote', 'md-quote', blocks(q.join('\n'))));
        continue;
      }
      if (line.includes('|') && i + 1 < L.length && TABLE_SEP.test(L[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < L.length && L[i].includes('|') && L[i].trim()) rows.push(cells(L[i++]));
        out.push(
          el(
            'div',
            'md-table-wrap',
            el('table', 'md-table', el('thead', null, el('tr', null, head.map((c) => el('th', null, inline(c))))), el('tbody', null, rows.map((r) => el('tr', null, r.map((c) => el('td', null, inline(c))))))),
          ),
        );
        continue;
      }
      if (LIST.test(line)) {
        const ordered = /\d/.test(LIST.exec(line)[2]);
        const list = el(ordered ? 'ol' : 'ul', 'md-list');
        while (i < L.length && (LIST.test(L[i]) || (/^\s{2,}\S/.test(L[i]) && list.lastChild))) {
          const m = LIST.exec(L[i]);
          if (m) {
            const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
            const li = el('li', m[1].length >= 2 ? 'md-li nested' : 'md-li', task ? [task[1].trim() ? '☑ ' : '☐ ', ...inline(task[2])] : inline(m[3]));
            list.append(li);
          } else list.lastChild.append(el('br'), ...inline(L[i].trim()));
          i++;
        }
        out.push(list);
        continue;
      }
      // paragraph: until blank line or another block starts
      const para = [];
      while (i < L.length && L[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(L[i]) && !LIST.test(L[i]) && !(L[i].includes('|') && TABLE_SEP.test(L[i + 1] || ''))) para.push(L[i++]);
      if (!para.length) para.push(L[i++]); // safety: always advance
      out.push(el('p', 'md-p', lines(para)));
    }
    return out;
  }

  window.md = (text) => el('div', 'md', blocks(text));
})();
