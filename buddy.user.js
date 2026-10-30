// ==UserScript==
// @name         Buddy Manager
// @namespace    https://github.com/Blake-cpu1/buddystocks
// @version      7.0.0
// @description  Buddy labels with schedules, plus item-received detection from your Torn logs (bell next to the buddy).
// @match        https://www.torn.com/*
// @grant        none
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/Blake-cpu1/buddystocks/main/buddy.user.js
// @updateURL    https://raw.githubusercontent.com/Blake-cpu1/buddystocks/main/buddy.user.js
// ==/UserScript==

/*
 * API usage (Torn API ToS)
 *  - Data storage:     only locally (this browser's localStorage)
 *  - Data sharing:     nobody
 *  - Purpose of use:   personal - show items your buddies sent you
 *  - Key storage:      handled by Torn PDA, or stored locally in this browser; only ever sent to api.torn.com
 *  - Key access level: custom key with user -> log (item sending category) is enough; Full also works
 */

(function () {
  'use strict';

  // Torn PDA can inject a script more than once; only run one copy.
  if (window.__bmBuddyManagerLoaded) return;
  window.__bmBuddyManagerLoaded = true;

  /* ---------------- helpers ---------------- */
  function el(tag, props) {
    const n = document.createElement(tag); props = props || {};
    for (const k in props) if (Object.prototype.hasOwnProperty.call(props, k)) {
      const v = props[k];
      if (v == null) continue;
      if (k === 'style' && typeof v === 'object') { for (const sk in v) n.style[sk] = v[sk]; }
      else if (k === 'class') n.className = v;
      else if (k === 'value') n.value = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i]; if (c == null || c === false) continue;
      const list = Array.isArray(c) ? c : [c];
      for (const x of list) { if (x == null || x === false) continue; n.appendChild(typeof x === 'object' && x.nodeType ? x : document.createTextNode(String(x))); }
    }
    return n;
  }
  const $ = (q, r) => (r || document).querySelector(q);
  const jget = (k, f) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : (f === undefined ? null : f); } catch (e) { return f === undefined ? null : f; } };
  const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } };
  const uuid = () => 'l_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const pad = n => String(n).padStart(2, '0');
  function todayStrLocal() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parseLocalDate(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function timeAgo(ms) {
    const m = Math.floor((Date.now() - ms) / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (h < 24) return h + 'h ago';
    if (d < 7) return d + 'd ago';
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  /* ---------------- state ---------------- */
  const STORAGE_KEY = 'bm-config', DONE_KEY = 'bm-done', LS_USER_ONLY_TODAY = 'bm-user-only-today';
  const ITEMLOG_KEY = 'bm-itemlog-v1', ITEMNAMES_KEY = 'bm-itemnames-v1', APIKEY_KEY = 'bm-apikey';
  const LOG_MAX = 100;

  const DEFAULT = (() => {
    const a = uuid(), b = uuid();
    return {
      users: { 'Example User': [
        { id: a, label: 'Daily Check', text: 'Good morning! How are things going today?' },
        { id: b, label: 'Weekly Report', text: 'Time for the weekly report. Please update your status.' }
      ] },
      schedules: { 'Example User': { [a]: { start: '2024-01-01', interval: 1 }, [b]: { start: '2024-01-01', interval: 7 } } },
      usersMeta: { 'Example User': { userId: '' } }
    };
  })();

  const stored = jget(STORAGE_KEY, DEFAULT) || DEFAULT;
  let users = stored.users || {}, schedules = stored.schedules || {}, usersMeta = stored.usersMeta || {};

  let done = jget(DONE_KEY, {}) || {};
  const dKey = (u, id) => u + '||' + id;
  const isDone = (u, id) => done[dKey(u, id)] === todayStrLocal();
  function setDone(u, id, val) { const k = dKey(u, id); if (val) done[k] = todayStrLocal(); else delete done[k]; jset(DONE_KEY, done); }

  let VIEW = 'user';          // 'user' | 'log' | 'config'
  let LOG_FILTER = null;      // buddy name or null
  let lastField = null;
  document.addEventListener('click', e => { const t = e.target; if (t && !t.closest('#bm-menu') && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /text|number|date/.test(t.type)))) lastField = t; });

  /* ---------------- styles ---------------- */
  const css = [
    '#bm-menu{--w:258px;--base:10.5px;--radius:14px;--pad:8px;background:linear-gradient(145deg,rgba(15,18,25,.97),rgba(22,27,38,.95));backdrop-filter:blur(10px);border:1px solid rgba(65,100,255,.18);position:fixed;bottom:72px;left:18px;z-index:9999;padding:var(--pad);border-radius:var(--radius);display:none;flex-direction:column;gap:6px;overflow-y:auto;font-family:Segoe UI,system-ui,sans-serif;font-size:var(--base);box-shadow:0 14px 36px rgba(0,0,0,.32),0 4px 18px rgba(65,100,255,.1);min-width:var(--w);max-width:var(--w);max-height:70vh;animation:bm-in .25s ease-out;color:#e1e5e9;box-sizing:border-box}',
    '#bm-menu *{box-sizing:border-box}',
    '@keyframes bm-in{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}',
    '#bm-menu h2{margin:0 0 4px;font-size:calc(var(--base) + 4px);font-weight:800;background:linear-gradient(135deg,#4F9FFF,#64E5FF);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;letter-spacing:.35px}',
    '.bm-tabs{display:flex;gap:6px;justify-content:center;margin:4px 0 2px}',
    '.bm-tab{position:relative;padding:5px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#eaf2ff;font-weight:800;cursor:pointer;font-size:var(--base);line-height:1}',
    '.bm-tab.active{background:linear-gradient(135deg,#4F9FFF,#64E5FF);color:#fff;border-color:#4F9FFF}',
    '.bm-tab .bm-count{position:absolute;top:-6px;right:-6px;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:#ffb300;color:#1a1a1a;font-size:9px;line-height:15px;text-align:center}',
    '.bm-section{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:6px;margin-top:4px}',
    '.bm-user-header{display:flex;align-items:center;gap:6px;padding:2px 0;margin:2px 0;font-size:calc(var(--base) - 1px);font-weight:800;color:#b9d2ff;border-bottom:1px dashed rgba(255,255,255,.08)}',
    '.bm-user-header a{color:inherit;text-decoration:none}',
    '.bm-uid{font-weight:600;opacity:.6;font-size:9px}',
    '.bm-bell{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:999px;background:rgba(255,179,0,.18);border:1px solid rgba(255,179,0,.55);color:#ffd866;font-size:10px;font-weight:800;cursor:pointer;animation:bm-ring 1s ease-in-out 3;transform-origin:50% 0}',
    '@keyframes bm-ring{0%,100%{transform:rotate(0)}20%{transform:rotate(14deg)}40%{transform:rotate(-12deg)}60%{transform:rotate(8deg)}80%{transform:rotate(-4deg)}}',
    '.bm-pill{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#eaf2ff;font-weight:800;cursor:pointer;user-select:none}',
    '.bm-pill.active{border-color:#4F9FFF;background:rgba(79,159,255,.18);color:#B3DDFF}',
    '.bm-list{display:flex;flex-direction:column;gap:4px;margin-top:2px}',
    '.bm-user{display:grid;grid-template-columns:1fr;gap:2px;padding:6px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}',
    '.bm-user-btn{all:unset;display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:8px;cursor:pointer;color:#e1e5e9}',
    '.bm-title{font-weight:800;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bm-sub{font-size:9.5px;color:#cfe1ff;opacity:.85}',
    '.bm-badge{font-size:10px;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);white-space:nowrap}',
    '.bm-badge.today{background:rgba(79,159,255,.25);border-color:rgba(100,229,255,.5);color:#B3DDFF}',
    '.bm-badge.done{background:rgba(63,195,128,.22);border-color:rgba(63,195,128,.55);color:#b4f8c8}',
    '.bm-badge.api{background:rgba(255,179,0,.14);border-color:rgba(255,179,0,.45);color:#ffd866}',
    '.bm-check{appearance:none;-webkit-appearance:none;width:14px;height:14px;border-radius:4px;border:1px solid rgba(255,255,255,.35);background:rgba(0,0,0,.25);cursor:pointer;position:relative;margin:0}',
    '.bm-check:checked::after{content:"✓";position:absolute;color:#fff;font-size:10px;line-height:14px;width:100%;text-align:center;left:0;top:0}',
    '.refresh-btn{background:rgba(65,100,255,.28);border:1px solid rgba(65,100,255,.4);color:#8fc0ff;border-radius:8px;padding:4px 8px;font-size:var(--base);cursor:pointer}',
    '.remove-btn{background:rgba(255,80,80,.15);border:1px solid rgba(255,80,80,.4);color:#ff9a9a;border-radius:8px;padding:4px 8px;font-size:var(--base);cursor:pointer}',
    '.edit-user-btn{all:unset;cursor:pointer;font-size:11px}',
    '.bm-input{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.12);padding:6px;border-radius:6px;width:100%;color:#fff;font-size:var(--base)}',
    '.bm-log-row{display:flex;flex-direction:column;gap:3px;padding:6px 8px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}',
    '.bm-log-row.new{border-color:rgba(255,179,0,.55);background:rgba(255,179,0,.07)}',
    '.bm-log-top{display:flex;justify-content:space-between;gap:6px;align-items:center}',
    '.bm-log-who{font-weight:800;color:#b9d2ff;text-decoration:none}',
    '.bm-log-what{color:#fff}',
    '.bm-log-msg{font-style:italic;opacity:.8;font-size:9.5px}',
    '.bm-status{font-size:9.5px;opacity:.85;text-align:center}',
    '.bm-error{background:rgba(255,80,80,.12);border:1px solid rgba(255,80,80,.4);color:#ffb3b3;border-radius:8px;padding:6px;font-size:9.5px}',
    '.bm-tos{width:100%;border-collapse:collapse;font-size:9px;margin-top:4px}',
    '.bm-tos td{border:1px solid rgba(255,255,255,.1);padding:3px 4px;vertical-align:top}',
    '.bm-tos td:first-child{font-weight:700;color:#b9d2ff;width:38%}',
    '#bm-btn{position:fixed;bottom:20px;left:20px;z-index:2147483647;width:40px;height:40px;border:none;border-radius:6px;background:#1a1a1a;color:#e6e6e6;font-size:14px;font-weight:800;cursor:pointer;box-shadow:0 0 0 1px rgba(255,255,255,.06)}',
    '#bm-btn .bm-dot{position:absolute;top:-4px;right:-4px;width:12px;height:12px;border-radius:50%;background:#ffb300;border:2px solid #1a1a1a}',
    '#bm-toast{position:fixed;bottom:128px;right:18px;z-index:2147483647;background:linear-gradient(135deg,#4CAF50,#45a049);color:#fff;padding:6px 10px;border-radius:10px;opacity:0;transition:.3s;font-size:11px;font-weight:700;pointer-events:none}',
    '#bm-toast.show{opacity:1;transform:translateY(-6px)}'
  ].join('');
  document.head.appendChild(el('style', { id: 'bm-style' }, css));

  /* ---------------- API key ----------------
     Torn PDA replaces the placeholder below with your key at runtime.
     Outside PDA (or if you prefer a separate key) you can paste one in the LOG tab. */
  const PDA_KEY = '###PDA-APIKEY###';
  const isValidKey = k => typeof k === 'string' && /^[A-Za-z0-9]{16}$/.test(k);
  function getKey() {
    const own = jget(APIKEY_KEY, '');
    if (isValidKey(own)) return { key: own, source: 'own key' };
    if (isValidKey(PDA_KEY)) return { key: PDA_KEY, source: 'Torn PDA key' };
    return { key: null, source: 'none' };
  }

  /* ---------------- item log store ---------------- */
  function readLog() {
    const s = jget(ITEMLOG_KEY, null) || {};
    return {
      entries: Array.isArray(s.entries) ? s.entries : [],
      lastTs: s.lastTs || 0,
      lastPoll: s.lastPoll || 0,
      error: s.error || null,
      pausedUntil: s.pausedUntil || 0,
      typeIds: Array.isArray(s.typeIds) ? s.typeIds : [],
      typesAt: s.typesAt || 0
    };
  }
  const writeLog = s => jset(ITEMLOG_KEY, s);
  let itemNames = jget(ITEMNAMES_KEY, {}) || {};

  function buddyByUserId(id) {
    const want = String(id);
    for (const name of Object.keys(users)) {
      const uid = String((usersMeta[name] || {}).userId || '').trim();
      if (uid && uid === want) return name;
    }
    return null;
  }
  function unseenCount(name) {
    return readLog().entries.filter(e => !e.seen && (!name || e.buddy === name)).length;
  }
  function markSeen(name) {
    const s = readLog(); let changed = false;
    s.entries.forEach(e => { if (!e.seen && (!name || e.buddy === name)) { e.seen = true; changed = true; } });
    if (changed) writeLog(s);
    refreshIndicators();
  }

  /* ---------------- log parsing (handles v1 and v2 response shapes) ---------------- */
  function asId(v) {
    if (v == null) return null;
    if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) return String(v);
    if (typeof v === 'object') return asId(v.id != null ? v.id : v.user_id);
    return null;
  }
  function extractSender(data) {
    if (!data || typeof data !== 'object') return null;
    for (const k of ['sender', 'sender_id', 'from', 'from_id', 'user', 'user_id']) {
      const id = asId(data[k]); if (id) return id;
    }
    return null;
  }
  function extractItems(data) {
    if (!data || typeof data !== 'object') return [];
    const out = [];
    const push = (id, qty) => { const i = asId(id); if (i) out.push({ id: i, qty: Math.max(1, parseInt(qty, 10) || 1) }); };
    const it = data.items;
    if (Array.isArray(it)) it.forEach(x => { if (x && typeof x === 'object') push(x.id != null ? x.id : (x.item != null ? x.item : x.item_id), x.qty != null ? x.qty : x.quantity); else push(x, 1); });
    else if (it && typeof it === 'object') Object.keys(it).forEach(k => { const v = it[k]; push(k, typeof v === 'object' && v ? (v.qty != null ? v.qty : v.quantity) : v); });
    if (!out.length && (data.item != null || data.item_id != null)) push(data.item != null ? data.item : data.item_id, data.quantity != null ? data.quantity : data.qty);
    return out;
  }
  function normaliseLogResponse(json) {
    let rows = json && json.log;
    if (!rows) return [];
    if (!Array.isArray(rows)) rows = Object.keys(rows).map(id => Object.assign({ id }, rows[id]));
    return rows.map(r => ({
      id: String(r.id != null ? r.id : (r.log_id || '') + '_' + r.timestamp),
      ts: Number(r.timestamp) || 0,
      data: r.data || {},
      params: r.params || {}
    })).filter(r => r.ts > 0);
  }

  /* ---------------- API calls ---------------- */
  const API = 'https://api.torn.com';
  const COMMENT = 'BuddyMgr';
  // Error codes that mean "stop using this key until the user fixes it"
  const FATAL_CODES = [1, 2, 10, 13, 16, 18];

  async function apiGet(path, key) {
    const sep = path.indexOf('?') === -1 ? '?' : '&';
    const res = await fetch(API + path + sep + 'key=' + encodeURIComponent(key) + '&comment=' + COMMENT, { cache: 'no-store' });
    const j = await res.json();
    if (j && j.error) { const e = new Error(j.error.error || 'API error'); e.code = j.error.code; throw e; }
    return j;
  }

  // Find the "item received" log type IDs once a week instead of hard-coding them.
  async function resolveTypeIds(state, key) {
    if (state.typeIds.length && Date.now() - state.typesAt < 7 * 86400000) return state.typeIds;
    const j = await apiGet('/torn/?selections=logtypes', key);
    let list = j.logtypes || {};
    list = Array.isArray(list) ? list.map(x => ({ id: String(x.id), title: String(x.title || '') }))
                               : Object.keys(list).map(id => ({ id, title: String(list[id] && list[id].title ? list[id].title : list[id]) }));
    const ids = list.filter(x => /^items?\s+receiv/i.test(x.title.trim())).map(x => x.id);
    state.typeIds = ids.length ? ids : ['4103'];
    state.typesAt = Date.now();
    return state.typeIds;
  }

  async function resolveItemNames(ids, key) {
    const missing = ids.filter(id => !itemNames[id]).slice(0, 10);
    for (const id of missing) {
      try {
        const j = await apiGet('/torn/' + id + '?selections=items', key);
        const it = j.items && (j.items[id] || j.items[Object.keys(j.items)[0]]);
        if (it && it.name) itemNames[id] = it.name;
      } catch (e) { break; }
    }
    jset(ITEMNAMES_KEY, itemNames);
  }

  let polling = false;
  async function pollLogs(force) {
    if (polling) return;
    const { key } = getKey();
    const state = readLog();
    if (!key) return;
    const now = Date.now();
    if (!force) {
      if (document.hidden) return;
      if (state.error && state.error.fatal) return;
      if (state.pausedUntil > now) return;
      if (now - state.lastPoll < 60000) return; // shared across tabs: at most one poll a minute
    }
    polling = true;
    state.lastPoll = now; writeLog(state);
    try {
      const types = await resolveTypeIds(state, key);
      const from = state.lastTs ? state.lastTs + 1 : Math.floor(now / 1000) - 86400;
      const j = await apiGet('/v2/user/log?log=' + types.join(',') + '&from=' + from + '&limit=100', key);
      const rows = normaliseLogResponse(j);
      const known = new Set(state.entries.map(e => e.id));
      const newItemIds = [];
      for (const r of rows) {
        if (r.ts > state.lastTs) state.lastTs = r.ts;
        if (known.has(r.id)) continue;
        const sender = extractSender(r.data);
        const buddy = sender ? buddyByUserId(sender) : null;
        if (!buddy) continue; // only track people in your buddy list
        const items = extractItems(r.data);
        items.forEach(i => newItemIds.push(i.id));
        state.entries.push({ id: r.id, ts: r.ts, senderId: sender, buddy, items, message: r.data.message || '', seen: false });
        known.add(r.id);
      }
      state.entries.sort((a, b) => b.ts - a.ts);
      state.entries = state.entries.slice(0, LOG_MAX);
      state.error = null;
      writeLog(state);
      if (newItemIds.length) await resolveItemNames(Array.from(new Set(newItemIds)), key);
    } catch (e) {
      const code = e.code;
      const fatal = FATAL_CODES.indexOf(code) !== -1;
      state.error = { code: code == null ? null : code, msg: e.message || 'Network error', fatal, at: Date.now() };
      if (code === 5) state.pausedUntil = Date.now() + 2 * 60000;          // too many requests
      if (code === 14) state.pausedUntil = Date.now() + 6 * 3600000;       // daily cloud read limit
      if (code === 8) state.pausedUntil = Date.now() + 30 * 60000;         // IP block
      writeLog(state);
    } finally {
      polling = false;
      refreshIndicators();
      if (VIEW === 'log' && isMenuOpen()) rebuildContent();
    }
  }

  /* ---------------- UI shared ---------------- */
  function toast(msg) {
    let t = $('#bm-toast');
    if (!t) { t = el('div', { id: 'bm-toast', 'aria-live': 'polite' }); document.body.appendChild(t); }
    t.textContent = '✅ ' + msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1200);
  }
  const userProfileURL = name => {
    const id = String((usersMeta[name] || {}).userId || '').trim();
    return id ? 'https://www.torn.com/profiles.php?XID=' + encodeURIComponent(id) : 'https://www.torn.com/search.php?p=people&q=' + encodeURIComponent(name);
  };
  function bellFor(name) {
    const n = unseenCount(name);
    if (!n) return null;
    return el('span', { class: 'bm-bell', title: 'Items received (from your Torn logs) - tap to view', onclick: ev => { ev.preventDefault(); ev.stopPropagation(); LOG_FILTER = name; setView('log'); } }, '🔔', n > 1 ? String(n) : null);
  }
  function refreshIndicators() {
    const total = unseenCount();
    const btn = $('#bm-btn');
    if (btn) {
      let dot = btn.querySelector('.bm-dot');
      if (total && !dot) btn.appendChild(el('span', { class: 'bm-dot' }));
      if (!total && dot) dot.remove();
    }
    const tab = $('#bm-menu .bm-tab[data-view="log"]');
    if (tab) {
      let c = tab.querySelector('.bm-count');
      if (total) { if (!c) { c = el('span', { class: 'bm-count' }); tab.appendChild(c); } c.textContent = String(total); }
      else if (c) c.remove();
    }
  }

  /* ---------------- schedules ---------------- */
  function bellStatus(u, labelId) {
    const e = schedules[u] && schedules[u][labelId];
    if (!e) return { countdown: null };
    const start = parseLocalDate(e.start);
    if (!start) return { countdown: null };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const interval = Math.max(1, parseInt(e.interval, 10) || 1);
    const days = Math.round((today - start) / 86400000);
    if (days < 0) return { countdown: -days };
    const rem = days % interval;
    return { countdown: rem === 0 ? 0 : interval - rem };
  }

  function pasteMsg(text, u, labelId) {
    const ae = document.activeElement;
    const field = ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && /text|number|date/.test(ae.type))) && !ae.closest('#bm-menu')
      ? ae : (lastField || $('textarea, input[type="text"], input[type="number"]'));
    if (!field) { toast('Tap a text box first'); return; }
    field.focus();
    field.value = '';
    for (let i = 0; i < text.length; i++) {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: text[i], bubbles: true }));
      field.value += text[i];
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    field.dispatchEvent(new Event('change', { bubbles: true }));
    setDone(u, labelId, true);
    toggleMenu();
    toast('Pasted');
  }

  /* ---------------- USER view ---------------- */
  function buildBuddy(container) {
    let onlyToday = !!jget(LS_USER_ONLY_TODAY, false);
    const pill = el('div', { class: 'bm-pill' + (onlyToday ? ' active' : ''), onclick: () => { jset(LS_USER_ONLY_TODAY, !onlyToday); rebuildContent(); } }, 'Show only due today');
    container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'center', margin: '2px 0 6px' } }, pill));

    for (const u of Object.keys(users)) {
      const labels = (users[u] || []).filter(o => o && o.label && o.label.trim() && o.text && o.text.trim());
      const uid = String((usersMeta[u] || {}).userId || '').trim();
      const bell = bellFor(u);
      const sec = el('div', { class: 'bm-section' });
      sec.appendChild(el('div', { class: 'bm-user-header' },
        el('a', { href: userProfileURL(u), target: '_blank', rel: 'noopener' }, u),
        uid ? el('span', { class: 'bm-uid' }, '[' + uid + ']') : null,
        bell));
      const list = el('div', { class: 'bm-list' });
      let shown = 0;
      labels.forEach(o => {
        const st = bellStatus(u, o.id);
        if (onlyToday && st.countdown !== 0) return;
        shown++;
        let badgeTxt = '', badgeClass = 'bm-badge';
        if (st.countdown === 0) { badgeTxt = 'today'; badgeClass += ' today'; }
        else if (st.countdown > 0) { badgeTxt = 'in ' + st.countdown + 'd'; }
        const badge = el('span', { class: badgeClass }, badgeTxt);
        let check = null;
        if (st.countdown === 0) {
          check = el('input', { type: 'checkbox', class: 'bm-check', title: 'Mark done' });
          check.checked = isDone(u, o.id);
          if (check.checked) { badge.textContent = 'done'; badge.className = 'bm-badge done'; }
          check.addEventListener('click', ev => ev.stopPropagation());
          check.addEventListener('change', ev => {
            const c = ev.target.checked; setDone(u, o.id, c);
            badge.textContent = c ? 'done' : 'today'; badge.className = 'bm-badge ' + (c ? 'done' : 'today');
          });
        }
        const btn = el('button', { class: 'bm-user-btn', onclick: () => pasteMsg(o.text, u, o.id) },
          el('span', { class: 'bm-title' }, o.label), badge, check);
        list.appendChild(el('div', { class: 'bm-user' }, btn, el('div', { class: 'bm-sub' }, 'Click to paste message')));
      });
      if (onlyToday && !shown && !bell) continue;
      sec.appendChild(list);
      container.appendChild(sec);
    }
  }

  /* ---------------- LOG view ---------------- */
  function describeItems(items) {
    if (!items || !items.length) return 'an item';
    return items.map(i => (i.qty > 1 ? i.qty + 'x ' : '') + (itemNames[i.id] || ('Item #' + i.id))).join(', ');
  }

  function buildLog(container) {
    const state = readLog();
    const k = getKey();

    // status + refresh
    const status = k.key
      ? 'Last checked ' + (state.lastPoll ? timeAgo(state.lastPoll) : 'never') + ' · ' + k.source
      : 'No API key yet - add one below';
    container.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
      el('div', { class: 'bm-status' }, status),
      el('button', { class: 'refresh-btn', disabled: k.key ? null : 'disabled', onclick: async ev => {
        ev.target.textContent = '…';
        const s = readLog(); s.error = null; s.pausedUntil = 0; writeLog(s);
        await pollLogs(true);
      } }, '↻ Check')));

    if (state.error) {
      container.appendChild(el('div', { class: 'bm-error' },
        '❌ ' + (state.error.code != null ? 'Error ' + state.error.code + ': ' : '') + state.error.msg,
        state.error.fatal ? ' - checking is paused until you fix the key and press Check.' : null));
    }

    const noIds = Object.keys(users).filter(n => !String((usersMeta[n] || {}).userId || '').trim());
    if (noIds.length) container.appendChild(el('div', { class: 'bm-status' }, 'No user ID set for: ' + noIds.join(', ') + ' (add it in ⚙️)'));

    if (LOG_FILTER) {
      container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'center' } },
        el('div', { class: 'bm-pill active', onclick: () => { LOG_FILTER = null; rebuildContent(); } }, 'Only ' + LOG_FILTER + '  ✕')));
    }

    const entries = state.entries.filter(e => !LOG_FILTER || e.buddy === LOG_FILTER);
    const list = el('div', { class: 'bm-list' });
    if (!entries.length) list.appendChild(el('div', { class: 'bm-status', style: { padding: '8px 0' } }, 'No items received from your buddies yet.'));
    entries.forEach(e => {
      list.appendChild(el('div', { class: 'bm-log-row' + (e.seen ? '' : ' new') },
        el('div', { class: 'bm-log-top' },
          el('a', { class: 'bm-log-who', href: 'https://www.torn.com/profiles.php?XID=' + encodeURIComponent(e.senderId), target: '_blank', rel: 'noopener' }, (e.seen ? '' : '🔔 ') + e.buddy),
          el('span', { class: 'bm-sub' }, timeAgo(e.ts * 1000))),
        el('div', { class: 'bm-log-what' }, 'sent you ' + describeItems(e.items)),
        e.message ? el('div', { class: 'bm-log-msg' }, '"' + e.message + '"') : null,
        el('div', null, el('span', { class: 'bm-badge api' }, '🔍 Detected from Torn logs'))));
    });
    container.appendChild(list);

    // key + ToS
    const keyInput = el('input', { class: 'bm-input', type: 'password', placeholder: '16-character API key', value: jget(APIKEY_KEY, '') || '' });
    const settings = el('details', { class: 'bm-section' },
      el('summary', { style: { cursor: 'pointer', fontWeight: '800', color: '#b9d2ff' } }, '🔑 API key & terms'),
      el('div', { class: 'bm-sub', style: { margin: '4px 0' } }, isValidKey(PDA_KEY)
        ? 'Using your Torn PDA key. You can paste a separate key here instead (a custom key with only user → log is safest).'
        : 'Paste a key (a custom key with only user → log is safest). In Torn PDA you can also give this script a key from its details screen.'),
      keyInput,
      el('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } },
        el('button', { class: 'refresh-btn', onclick: () => {
          const v = keyInput.value.trim();
          if (v && !isValidKey(v)) { alert('That doesn\'t look like a 16-character Torn API key.'); return; }
          jset(APIKEY_KEY, v);
          const s = readLog(); s.error = null; s.pausedUntil = 0; writeLog(s);
          toast(v ? 'Key saved' : 'Key cleared'); rebuildContent(); pollLogs(true);
        } }, 'Save key'),
        el('button', { class: 'remove-btn', onclick: () => { if (confirm('Clear the detected items list?')) { const s = readLog(); s.entries = []; writeLog(s); refreshIndicators(); rebuildContent(); } } }, 'Clear list')),
      el('table', { class: 'bm-tos' },
        el('tr', null, el('td', null, 'Data storage'), el('td', null, 'Only locally (this browser)')),
        el('tr', null, el('td', null, 'Data sharing'), el('td', null, 'Nobody')),
        el('tr', null, el('td', null, 'Purpose of use'), el('td', null, 'Personal: show items your buddies sent you')),
        el('tr', null, el('td', null, 'Key storage & sharing'), el('td', null, 'Stored locally / Not shared. Only sent to api.torn.com')),
        el('tr', null, el('td', null, 'Key access level'), el('td', null, 'Custom: user → log (Full also works)'))));
    container.appendChild(settings);

    // Viewing the log clears the bells for what's on screen.
    setTimeout(() => markSeen(LOG_FILTER), 1500);
  }

  /* ---------------- CONFIG view ---------------- */
  function buildConfig(container) {
    const tmp = {
      users: JSON.parse(JSON.stringify(users)),
      schedules: JSON.parse(JSON.stringify(schedules)),
      usersMeta: JSON.parse(JSON.stringify(usersMeta || {}))
    };
    const editor = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    container.appendChild(editor);

    function render() {
      editor.innerHTML = '';
      for (const uName of Object.keys(tmp.users)) {
        const codes = tmp.users[uName] || (tmp.users[uName] = []);
        const meta = (tmp.usersMeta[uName] = tmp.usersMeta[uName] || { userId: '' });
        const section = el('div', { class: 'bm-section' });

        section.appendChild(el('div', { class: 'bm-user-header' }, uName,
          el('button', { class: 'edit-user-btn', title: 'Rename', onclick: () => {
            const n = prompt('Rename user:', uName); if (!n || !n.trim()) return;
            const nn = n.trim(); if (nn === uName) return;
            if (tmp.users[nn]) { alert('A user with that name already exists.'); return; }
            tmp.users[nn] = tmp.users[uName]; delete tmp.users[uName];
            if (tmp.schedules[uName]) { tmp.schedules[nn] = tmp.schedules[uName]; delete tmp.schedules[uName]; }
            tmp.usersMeta[nn] = tmp.usersMeta[uName]; delete tmp.usersMeta[uName];
            render();
          } }, '✏️')));

        // User ID + bell
        section.appendChild(el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '6px' } },
          el('input', { class: 'bm-input', type: 'number', placeholder: 'User ID (Torn XID) - needed for log detection', value: meta.userId || '',
            oninput: e => { meta.userId = String(e.target.value).trim(); } }),
          bellFor(uName)));

        const list = el('div', { class: 'bm-list' });
        codes.forEach((code, idx) => {
          if (!code.id) code.id = uuid();
          const sched = () => {
            tmp.schedules[uName] = tmp.schedules[uName] || {};
            return (tmp.schedules[uName][code.id] = tmp.schedules[uName][code.id] || { start: '', interval: 1 });
          };
          const cur = (tmp.schedules[uName] || {})[code.id] || {};
          list.appendChild(el('div', { class: 'bm-user' },
            el('input', { class: 'bm-input', type: 'text', placeholder: 'Label', value: code.label || '', oninput: e => { code.label = e.target.value; } }),
            el('input', { class: 'bm-input', type: 'text', placeholder: 'Message or Amount', value: code.text || '', oninput: e => { code.text = e.target.value; } }),
            el('div', { style: { display: 'flex', gap: '6px' } },
              el('input', { class: 'bm-input', type: 'date', value: cur.start || '', style: { width: '48%' }, oninput: e => { sched().start = e.target.value; } }),
              el('input', { class: 'bm-input', type: 'number', min: '1', title: 'Repeat every N days', value: cur.interval || 1, style: { width: '32%' }, oninput: e => { sched().interval = parseInt(e.target.value, 10) || 1; } }),
              el('button', { class: 'remove-btn', onclick: () => {
                codes.splice(idx, 1);
                if (tmp.schedules[uName]) delete tmp.schedules[uName][code.id];
                render();
              } }, '×'))));
        });
        list.appendChild(el('button', { class: 'refresh-btn', style: { marginTop: '6px' }, onclick: () => { codes.push({ id: uuid(), label: '', text: '' }); render(); } }, '+ Add New Label'));
        section.appendChild(list);
        section.appendChild(el('button', { class: 'remove-btn', style: { marginTop: '6px' }, onclick: () => {
          if (confirm(`Delete user "${uName}"?`)) { delete tmp.users[uName]; delete tmp.schedules[uName]; delete tmp.usersMeta[uName]; render(); }
        } }, '🗑 Delete User'));
        editor.appendChild(section);
      }

      editor.appendChild(el('div', { style: { display: 'flex', justifyContent: 'center', marginTop: '10px', gap: '8px', flexWrap: 'wrap' } },
        el('button', { class: 'refresh-btn', onclick: () => {
          const n = (prompt('Enter user name:') || '').trim();
          if (n && !tmp.users[n]) { tmp.users[n] = []; tmp.schedules[n] = {}; tmp.usersMeta[n] = { userId: '' }; render(); }
        } }, '+ Add New User'),
        el('button', { class: 'refresh-btn', onclick: () => {
          users = tmp.users; schedules = tmp.schedules; usersMeta = tmp.usersMeta;
          jset(STORAGE_KEY, { users, schedules, usersMeta });
          // Re-link already-detected entries to renamed buddies
          const s = readLog(); s.entries.forEach(e => { const b = buddyByUserId(e.senderId); if (b) e.buddy = b; }); writeLog(s);
          toast('Saved!'); rebuildContent();
        } }, 'Save'),
        el('button', { class: 'refresh-btn', onclick: () => rebuildContent() }, 'Cancel')));
    }
    render();
  }

  /* ---------------- menu ---------------- */
  const TITLES = { user: '💰 Buddy Manager', log: '📜 Item Log', config: '⚙️ Configuration' };
  const isMenuOpen = () => { const m = $('#bm-menu'); return !!(m && m.style.display === 'flex'); };

  function rebuildContent() {
    const content = $('#bm-content'); if (!content) return;
    const h = $('#bm-menu h2'); if (h) h.textContent = TITLES[VIEW];
    document.querySelectorAll('#bm-menu .bm-tab').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === VIEW));
    content.innerHTML = '';
    if (VIEW === 'config') buildConfig(content);
    else if (VIEW === 'log') buildLog(content);
    else buildBuddy(content);
    refreshIndicators();
  }
  function setView(v) { VIEW = v; if (v !== 'log') LOG_FILTER = null; if (!isMenuOpen()) buildMenu(); else rebuildContent(); }

  function buildMenu() {
    const old = $('#bm-menu'); if (old) old.remove();
    const tab = (v, label, title) => el('button', { class: 'bm-tab', 'data-view': v, title, onclick: () => setView(v) }, label);
    const menu = el('div', { id: 'bm-menu', style: { display: 'flex' } },
      el('h2', null, TITLES[VIEW]),
      el('div', { class: 'bm-tabs' }, tab('user', '💬 USER', 'Buddies'), tab('log', '📜 LOG', 'Items received'), tab('config', '⚙️', 'Config')),
      el('div', { id: 'bm-content' }));
    document.body.appendChild(menu);
    rebuildContent();
  }
  function toggleMenu() {
    const m = $('#bm-menu');
    if (m && m.style.display === 'flex') m.style.display = 'none';
    else buildMenu();
  }

  /* ---------------- launcher ---------------- */
  function ensureButton() {
    if (!document.body) return;
    if (!$('#bm-btn')) {
      document.body.appendChild(el('button', { id: 'bm-btn', title: 'Buddy Manager', onclick: toggleMenu }, 'BM'));
      refreshIndicators();
    }
  }
  let ensureQueued = false;
  try {
    new MutationObserver(() => {
      if (ensureQueued) return; ensureQueued = true;
      requestAnimationFrame(() => { ensureQueued = false; ensureButton(); });
    }).observe(document.body || document.documentElement, { childList: true });
  } catch (e) { /* ignore */ }
  ensureButton();
  setTimeout(ensureButton, 1500);

  // Other tabs may have polled; keep the bell in sync.
  window.addEventListener('storage', e => { if (e.key === ITEMLOG_KEY) refreshIndicators(); });

  /* ---------------- polling ---------------- */
  setTimeout(() => pollLogs(false), 3000);
  setInterval(() => pollLogs(false), 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollLogs(false); });
})();
