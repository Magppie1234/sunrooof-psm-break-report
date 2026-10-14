// Multi-date picker in the same layout as the browser's date picker.
// Click a date to add/remove it, drag or Shift-click to select a range, then Apply.
// Usage: const dp = DatePicker(buttonEl, { max: 'YYYY-MM-DD', limit: 31, onApply(dates) {} }); dp.set([...]).
(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MON = MONTHS.map((m) => m.slice(0, 3));
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m: m - 1, d }; };
  const addDays = (s, n) => { const t = new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5); return t.toISOString().slice(0, 10); };
  const between = (a, b) => { if (a > b) [a, b] = [b, a]; const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };

  // "24 Sep 2026" · "22–24 Sep 2026" · "22–24 Sep, 1 Oct 2026"
  function label(dates) {
    if (!dates.length) return 'Pick dates';
    const runs = [];
    dates.forEach((d) => { const r = runs[runs.length - 1]; if (r && addDays(r[1], 1) === d) r[1] = d; else runs.push([d, d]); });
    const one = (s, withYear) => { const p = parse(s); return `${p.d} ${MON[p.m]}${withYear ? ' ' + p.y : ''}`; };
    const years = new Set(dates.map((d) => d.slice(0, 4)));
    const multiYear = years.size > 1;
    const txt = runs.map(([a, b], i) => {
      const last = i === runs.length - 1;
      if (a === b) return one(a, multiYear || last);
      const pa = parse(a), pb = parse(b);
      const left = pa.m === pb.m && pa.y === pb.y ? String(pa.d) : one(a, multiYear);
      return `${left}–${one(b, multiYear || last)}`;
    });
    return txt.length > 3 ? `${txt[0]}, ${txt[1]} +${txt.length - 2} more` : txt.join(', ');
  }

  const css = document.createElement('style');
  css.textContent = `
.dp-wrap{position:relative;display:inline-block}
.dp-btn{display:inline-flex;align-items:center;gap:8px;font:inherit;padding:6px 10px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:6px;cursor:pointer;min-width:190px;justify-content:space-between}
.dp-btn svg{flex:none;opacity:.75}
.dp-btn .n{font-size:11px;font-weight:700;background:var(--navy);color:#fff;border-radius:999px;padding:1px 7px}
.dp{position:absolute;top:calc(100% + 6px);left:0;z-index:40;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 30px rgba(15,20,35,.22);padding:12px 12px 8px;width:292px;user-select:none;-webkit-user-select:none;touch-action:none}
.dp[hidden]{display:none}
.dp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.dp-my{font:inherit;font-weight:700;font-size:15px;background:none;border:0;color:inherit;cursor:pointer;padding:4px 2px;display:flex;align-items:center;gap:6px}
.dp-my:after{content:'';border:5px solid transparent;border-top-color:currentColor;margin-top:5px}
.dp-nav{display:flex;gap:2px}
.dp-nav button{background:none;border:0;color:inherit;cursor:pointer;width:34px;height:30px;border-radius:6px;font-size:18px;line-height:1}
.dp-nav button:hover:not(:disabled){background:var(--bg)}
.dp-nav button:disabled{opacity:.3;cursor:default}
.dp-hint{font-size:11px;color:var(--muted);margin:0 2px 6px}
.dp-hint.warn{color:var(--badtxt);font-weight:700}
.dp-grid{display:grid;grid-template-columns:repeat(7,1fr);row-gap:3px}
.dp-grid .wd{text-align:center;font-size:12px;font-weight:600;padding:4px 0;color:var(--ink)}
.dp-day{font:inherit;font-size:13px;height:34px;border:1px solid transparent;background:none;color:inherit;cursor:pointer;border-radius:4px;margin:0 1px;padding:0}
.dp-day:hover:not(:disabled){background:var(--bg);border-color:var(--line)}
.dp-day.out{color:var(--muted);opacity:.6}
.dp-day.today{border-color:var(--ink);font-weight:700}
.dp-day:disabled{opacity:.25;cursor:default}
.dp-day.sel{background:#5f6368;color:#fff;font-weight:700;opacity:1}
.dp-day.sel:hover{background:#4a4e53}
.dp-day.sel.jl{border-top-left-radius:0;border-bottom-left-radius:0;margin-left:0}
.dp-day.sel.jr{border-top-right-radius:0;border-bottom-right-radius:0;margin-right:0}
.dp-months{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:4px 0 6px}
.dp-months button{font:inherit;font-size:13px;padding:10px 0;border:1px solid var(--line);background:none;color:inherit;border-radius:6px;cursor:pointer}
.dp-months button.cur{background:#5f6368;color:#fff;border-color:#5f6368}
.dp-months button:disabled{opacity:.3;cursor:default}
.dp-foot{display:flex;align-items:center;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid var(--line);gap:6px}
.dp-link{font:inherit;font-size:13px;background:none;border:0;color:#1a73e8;cursor:pointer;padding:4px 2px}
.dp-count{font-size:12px;color:var(--muted);flex:1;text-align:center}
.dp-apply{font:inherit;font-size:13px;font-weight:700;border:0;border-radius:6px;background:#1a73e8;color:#fff;padding:6px 12px;cursor:pointer}
.dp-apply:disabled{opacity:.4;cursor:default}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .dp-link{color:#8ab4f8}}`;
  document.head.appendChild(css);

  window.DatePicker = function (btn, opts) {
    const limit = opts.limit || 31;
    let applied = [];           // what the report is showing
    let sel = new Set();        // working selection while the calendar is open
    let view;                   // { y, m } month on screen
    let mode = 'days';          // 'days' | 'months'
    let anchor = null;          // last clicked date (for Shift-click)
    let drag = null;            // { start, base:Set, add:boolean, moved }
    let warn = '';

    const wrap = document.createElement('span'); wrap.className = 'dp-wrap';
    btn.replaceWith(wrap); wrap.appendChild(btn);
    btn.classList.add('dp-btn'); btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
    const pop = document.createElement('div'); pop.className = 'dp'; pop.hidden = true;
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Choose dates');
    wrap.appendChild(pop);

    const maxDate = () => typeof opts.max === 'function' ? opts.max() : opts.max;
    const sorted = () => [...sel].sort();

    function renderBtn() {
      const cal = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
      btn.innerHTML = `<span>${label(applied)}</span>${applied.length > 1 ? `<span class="n">${applied.length} days</span>` : ''}${cal}`;
      btn.title = applied.length > 1 ? applied.join(', ') : '';
    }

    function render() {
      const max = maxDate();
      const pm = parse(max);
      const atMax = view.y > pm.y || (view.y === pm.y && view.m >= pm.m);
      let h = `<div class="dp-head"><button type="button" class="dp-my" data-act="months">${mode === 'days' ? `${MONTHS[view.m]}, ${view.y}` : view.y}</button>
        <span class="dp-nav"><button type="button" data-act="prev" aria-label="${mode === 'days' ? 'Previous month' : 'Previous year'}">↑</button><button type="button" data-act="next" aria-label="${mode === 'days' ? 'Next month' : 'Next year'}" ${mode === 'days' ? (atMax ? 'disabled' : '') : (view.y >= pm.y ? 'disabled' : '')}>↓</button></span></div>`;
      if (mode === 'months') {
        h += '<div class="dp-months">' + MON.map((m, i) => `<button type="button" data-month="${i}" class="${i === view.m ? 'cur' : ''}" ${view.y > pm.y || (view.y === pm.y && i > pm.m) ? 'disabled' : ''}>${m}</button>`).join('') + '</div>';
      } else {
        h += `<div class="dp-hint ${warn ? 'warn' : ''}">${warn || 'Click dates to add or remove · drag or Shift-click for a range'}</div><div class="dp-grid">` +
          ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((w) => `<div class="wd">${w}</div>`).join('');
        const first = new Date(Date.UTC(view.y, view.m, 1));
        let d = addDays(iso(view.y, view.m, 1), -first.getUTCDay());
        const today = opts.today ? opts.today() : max;
        for (let i = 0; i < 42; i++, d = addDays(d, 1)) {
          const p = parse(d), s = sel.has(d);
          const col = i % 7;
          const cls = ['dp-day'];
          if (p.m !== view.m) cls.push('out');
          if (d === today) cls.push('today');
          if (s) {
            cls.push('sel');
            if (col > 0 && sel.has(addDays(d, -1))) cls.push('jl');
            if (col < 6 && sel.has(addDays(d, 1))) cls.push('jr');
          }
          h += `<button type="button" class="${cls.join(' ')}" data-d="${d}" ${d > max ? 'disabled' : ''} aria-pressed="${s}" aria-label="${p.d} ${MONTHS[p.m]} ${p.y}">${p.d}</button>`;
        }
        h += '</div>';
      }
      const n = sel.size;
      h += `<div class="dp-foot"><button type="button" class="dp-link" data-act="clear">Clear</button>
        <span class="dp-count">${n ? n + (n === 1 ? ' day' : ' days') + ' selected' : 'No dates selected'}</span>
        <button type="button" class="dp-link" data-act="today">Today</button>
        <button type="button" class="dp-apply" data-act="apply" ${n ? '' : 'disabled'}>Apply</button></div>`;
      pop.innerHTML = h;
    }

    function setRange(days, add) {
      warn = '';
      for (const d of days) {
        if (d > maxDate()) continue;
        if (add) {
          if (!sel.has(d) && sel.size >= limit) { warn = `You can pick up to ${limit} days at a time`; break; }
          sel.add(d);
        } else sel.delete(d);
      }
    }

    function open() {
      sel = new Set(applied); mode = 'days'; warn = ''; anchor = applied.length ? applied[applied.length - 1] : null;
      const last = applied.length ? applied[applied.length - 1] : maxDate();
      const p = parse(last); view = { y: p.y, m: p.m };
      render(); pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
    }
    function close() { pop.hidden = true; drag = null; btn.setAttribute('aria-expanded', 'false'); }
    function apply() {
      if (!sel.size) return;
      const next = sorted();
      const changed = next.join() !== applied.join();
      applied = next; renderBtn(); close();
      if (changed && opts.onApply) opts.onApply(applied.slice());
    }

    btn.addEventListener('click', () => (pop.hidden ? open() : apply()));

    pop.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      const act = t.dataset.act;
      if (act === 'prev' || act === 'next') {
        const k = act === 'prev' ? -1 : 1;
        if (mode === 'months') view.y += k;
        else { view.m += k; if (view.m < 0) { view.m = 11; view.y--; } if (view.m > 11) { view.m = 0; view.y++; } }
        render();
      } else if (act === 'months') { mode = mode === 'days' ? 'months' : 'days'; render(); }
      else if (t.dataset.month) { view.m = +t.dataset.month; mode = 'days'; render(); }
      else if (act === 'clear') { sel.clear(); warn = ''; anchor = null; render(); }
      else if (act === 'today') { const td = opts.today ? opts.today() : maxDate(); sel = new Set([td]); apply(); }
      else if (act === 'apply') apply();
    });

    // Click toggles a day; dragging paints a range; Shift-click fills from the last clicked day.
    const dayAt = (x, y) => { const el = document.elementFromPoint(x, y); const b = el && el.closest && el.closest('.dp-day'); return b && !b.disabled && pop.contains(b) ? b.dataset.d : null; };
    pop.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.dp-day'); if (!b || b.disabled || e.button > 0) return;
      e.preventDefault();
      const d = b.dataset.d;
      if (e.shiftKey && anchor) { setRange(between(anchor, d), true); anchor = d; render(); return; }
      drag = { start: d, base: new Set(sel), add: !sel.has(d), last: d };
      setRange([d], drag.add); anchor = d; render();
    });
    pop.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const d = dayAt(e.clientX, e.clientY);
      if (!d || d === drag.last) return;
      drag.last = d;
      sel = new Set(drag.base); setRange(between(drag.start, d), drag.add); anchor = d; render();
    });
    const endDrag = () => { if (drag) { drag = null; } };
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);

    document.addEventListener('keydown', (e) => {
      if (pop.hidden) return;
      if (e.key === 'Escape') { close(); btn.focus(); }
      else if (e.key === 'Enter' && sel.size) { e.preventDefault(); apply(); }
    });
    // Clicking outside keeps what was picked (same as pressing Apply).
    // composedPath() is fixed when the event starts, so a day button that re-rendered away still counts as inside.
    document.addEventListener('pointerdown', (e) => { if (pop.hidden) return; const path = e.composedPath ? e.composedPath() : [e.target]; if (path.includes(wrap) || wrap.contains(e.target)) return; if (sel.size) apply(); else close(); });

    return {
      set(dates) { applied = [...new Set(dates)].filter(Boolean).sort().slice(-limit); renderBtn(); },
      get() { return applied.slice(); },
      label: () => label(applied),
    };
  };
  window.DatePicker.label = label;
})();
