// ==UserScript==
// @name         Buddy Manager
// @namespace    https://github.com/Blake-cpu1/buddystocks
// @version      7.4.0
// @description  Buddy labels with schedules, item-received detection from your Torn logs, overdue warnings, a buddy badge with countdowns on profile pages, and a company trains tracker.
// @match        https://www.torn.com/*
// @grant        none
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/Blake-cpu1/buddystocks/main/buddy.user.js
// @updateURL    https://raw.githubusercontent.com/Blake-cpu1/buddystocks/main/buddy.user.js
// ==/UserScript==

/*
 * API usage (Torn API ToS)
 *  - Data storage:     only locally (this browser's IndexedDB / localStorage)
 *  - Data sharing:     nobody
 *  - Purpose of use:   personal - show items your buddies sent you
 *  - Key storage:      handled by Torn PDA, or stored locally in this browser; only ever sent to api.torn.com
 *  - Key access level: custom key with user -> log (item sending category) is enough; Full also works
 */

// NOTE: never put curly quotes (smart apostrophes or quote marks) in this file: Torn PDA swaps them for plain quotes
// before injecting, which breaks strings. Use \u2019 escapes instead.
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
  const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
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
  const ITEMLOG_KEY = 'bm-itemlog-v2', ITEMNAMES_KEY = 'bm-itemnames-v1', APIKEY_KEY = 'bm-apikey';
  const SCRIPT_VERSION = '7.4.0';
  const LOG_MAX = 200;              // all item-received entries are kept, buddies are matched when shown
  const FIRST_LOOKBACK = 7 * 86400; // first check looks back 7 days

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

  // Quick first values from localStorage; the IndexedDB copy (loaded in storeReady) is the real one.
  const stored = jget(STORAGE_KEY, null);
  const hadLocalConfig = !!(stored && stored.users);
  let users = (stored || DEFAULT).users || {}, schedules = (stored || DEFAULT).schedules || {}, usersMeta = (stored || DEFAULT).usersMeta || {};
  let prefs = Object.assign({ overdueHour: 18, onlyToday: !!jget(LS_USER_ONLY_TODAY, false) }, (stored && stored.prefs) || {});

  let done = jget(DONE_KEY, {}) || {};
  const dKey = (u, id) => u + '||' + id;
  const isDone = (u, id) => done[dKey(u, id)] === todayStrLocal();
  function setDone(u, id, val) { const k = dKey(u, id); if (val) done[k] = todayStrLocal(); else delete done[k]; saveDone(); renderProfile(); }

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
    '.bm-tabs{display:flex;gap:5px;justify-content:center;flex-wrap:wrap;margin:4px 0 2px}',
    '.bm-tab{position:relative;padding:5px 8px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#eaf2ff;font-weight:800;cursor:pointer;font-size:var(--base);line-height:1}',
    '.bm-tab.active{background:linear-gradient(135deg,#4F9FFF,#64E5FF);color:#fff;border-color:#4F9FFF}',
    '.bm-tab .bm-count{position:absolute;top:-6px;right:-6px;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:#ffb300;color:#1a1a1a;font-size:9px;line-height:15px;text-align:center}',
    '.bm-section{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:6px;margin-top:4px}',
    '.bm-user-header{display:flex;align-items:center;gap:6px;padding:2px 0;margin:2px 0;font-size:calc(var(--base) - 1px);font-weight:800;color:#b9d2ff;border-bottom:1px dashed rgba(255,255,255,.08)}',
    '.bm-user-header a{color:inherit;text-decoration:none}',
    '.bm-uid{font-weight:600;opacity:.6;font-size:9px}',
    '.bm-bell.seen{background:rgba(255,255,255,.05);border-color:rgba(255,179,0,.3);color:#d9c38a;font-weight:700;animation:none}',
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
    '.bm-badge.overdue{background:rgba(255,70,70,.22);border-color:rgba(255,90,90,.6);color:#ffb3b3;font-weight:800}',
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
    '#bm-prof-badge{display:inline-flex;align-items:center;gap:5px;margin-left:10px;padding:3px 10px;border-radius:999px;font:700 12px/1.3 Segoe UI,system-ui,sans-serif;letter-spacing:0;text-transform:none;color:#B3DDFF;background:rgba(79,159,255,.16);border:1px solid rgba(100,229,255,.45);cursor:pointer;vertical-align:middle;white-space:nowrap;user-select:none}',
    '#bm-prof-badge.today{background:rgba(79,159,255,.3);border-color:#64E5FF;color:#fff}',
    '#bm-prof-badge.overdue{background:rgba(255,70,70,.25);border-color:rgba(255,90,90,.7);color:#ffc2c2}',
    '#bm-prof-badge.done{background:rgba(63,195,128,.2);border-color:rgba(63,195,128,.55);color:#b4f8c8}',
    '#bm-prof-badge.add{background:rgba(255,255,255,.06);border:1px dashed rgba(255,255,255,.35);color:#d6dde6}',
    '#bm-prof-badge .bm-cd{font-variant-numeric:tabular-nums}',
    '#bm-prof-panel{margin:6px 0 8px;padding:8px 10px;border-radius:10px;background:linear-gradient(145deg,rgba(15,18,25,.97),rgba(22,27,38,.95));border:1px solid rgba(65,100,255,.25);color:#e1e5e9;font:12px/1.4 Segoe UI,system-ui,sans-serif;display:flex;flex-direction:column;gap:6px}',
    '#bm-prof-panel .bm-pp-head{font-weight:800;color:#b9d2ff}',
    '#bm-prof-panel .bm-pp-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}',
    '#bm-prof-panel .bm-pp-row.copy{cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '#bm-prof-panel .bm-pp-row.copy:active{background:rgba(79,159,255,.18);border-color:rgba(100,229,255,.45)}',
    '#bm-prof-panel .bm-pp-label{font-weight:800;color:#fff}',
    '#bm-prof-panel .bm-pp-sub{font-size:11px;opacity:.75}',
    '#bm-prof-panel .bm-badge{font-size:11px}',
    '#bm-prof-panel button{font:700 11px Segoe UI,system-ui,sans-serif}',
    '.bm-tr-card{display:flex;flex-direction:column;gap:6px;padding:8px}',
    '.bm-tr-card.complete{opacity:.65}',
    '.bm-tr-hero{display:flex;justify-content:space-between;align-items:center}',
    '.bm-tr-big{font-size:26px;font-weight:800;line-height:1;background:linear-gradient(135deg,#4F9FFF,#64E5FF);-webkit-background-clip:text;-webkit-text-fill-color:transparent}',
    '.bm-tr-cap{font-size:8.5px;text-transform:uppercase;letter-spacing:.5px;opacity:.65;margin-top:2px}',
    '.bm-tr-order{display:flex;flex-direction:column;gap:4px}',
    '.bm-tr-orow{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07)}',
    '.bm-tr-slot{min-width:34px;text-align:center;padding:2px 6px;border-radius:6px;background:rgba(79,159,255,.2);color:#B3DDFF;font-weight:800;font-size:9.5px;font-variant-numeric:tabular-nums}',
    '.bm-tr-who{flex:1;min-width:0;color:#9fe870;font-weight:800;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bm-tr-n{font-weight:700;opacity:.9;white-space:nowrap}',
    '.bm-tr-title{font-weight:800;color:#b9d2ff;margin:6px 2px 0;font-size:calc(var(--base) + 1px)}',
    '.bm-tr-bhead{display:flex;align-items:center;gap:6px}',
    '.bm-tr-bhead .bm-tr-who{flex:0 1 auto}',
    '.bm-tr-x{all:unset;cursor:pointer;width:20px;height:20px;border-radius:6px;text-align:center;line-height:20px;font-size:11px;color:#ff9a9a;background:rgba(255,80,80,.1)}',
    '.bm-tr-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}',
    '.bm-tr-box{text-align:center;padding:6px 2px;border-radius:8px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08);cursor:default}',
    '.bm-tr-box[title]{cursor:pointer}',
    '.bm-tr-box.auto{border-color:rgba(255,179,0,.3)}',
    '.bm-tr-box.left{border-color:rgba(100,229,255,.45);background:rgba(79,159,255,.12)}',
    '.bm-tr-box.left .bm-tr-num{color:#B3DDFF}',
    '.bm-tr-box.zero{border-color:rgba(63,195,128,.5);background:rgba(63,195,128,.12)}',
    '.bm-tr-box.zero .bm-tr-num{color:#b4f8c8}',
    '.bm-tr-num{font-size:16px;font-weight:800;color:#fff;line-height:1.1;font-variant-numeric:tabular-nums}',
    '.bm-tr-bar{height:4px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}',
    '.bm-tr-bar span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#4F9FFF,#64E5FF)}',
    '.bm-tr-foot{font-size:9.5px;opacity:.7}',
    '.bm-tr-add{cursor:pointer;font-weight:800;color:#8fc0ff;list-style:none}',
    '.bm-tr-form{display:flex;flex-direction:column;gap:5px;margin-top:6px}',
    '.bm-tr-row{display:flex;gap:5px}',
    '.bm-tr-row .bm-input{min-width:0}',
    '#bm-emp-card{--base:11px;display:flex;align-items:center;gap:10px;margin:8px 0;padding:10px 12px;border-radius:12px;background:linear-gradient(145deg,rgba(15,18,25,.97),rgba(22,27,38,.95));border:1px solid rgba(65,100,255,.25);color:#e1e5e9;font:12px/1.4 Segoe UI,system-ui,sans-serif}',
    '#bm-emp-card .bm-emp-left{text-align:center;min-width:58px}',
    '#bm-emp-card .bm-emp-mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
    '#bm-emp-card .bm-emp-o{display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden}',
    '#bm-emp-card .bm-emp-o b{color:#9fe870;overflow:hidden;text-overflow:ellipsis}',
    '#bm-emp-card .bm-emp-o span:last-child{margin-left:auto;opacity:.85}',
    '#bm-emp-card .bm-emp-none{opacity:.7}',
    '#bm-emp-card .refresh-btn{white-space:nowrap}',
    'li.bm-emp-next{box-shadow:inset 3px 0 0 #64E5FF}',
    '.bm-emp-chip{position:absolute;top:50%;right:100px;transform:translateY(-50%);z-index:2;display:flex;flex-direction:column;align-items:center;padding:2px 6px;border-radius:7px;font:800 9px/1.2 Segoe UI,system-ui,sans-serif;color:#d6dde6;background:rgba(15,18,25,.9);border:1px solid rgba(255,255,255,.2);pointer-events:none;white-space:nowrap}',
    '.bm-emp-chip.next{color:#B3DDFF;border-color:rgba(100,229,255,.6);background:rgba(20,40,70,.92)}',
    '.bm-emp-chip.done{color:#b4f8c8;border-color:rgba(63,195,128,.6);background:rgba(15,45,30,.92)}',
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
    const own = ownKeyMem || jget(APIKEY_KEY, '');
    if (isValidKey(own)) return { key: own, source: 'own key' };
    if (isValidKey(PDA_KEY)) return { key: PDA_KEY, source: 'Torn PDA key' };
    return { key: null, source: 'none' };
  }

  /* ---------------- item log store ----------------
     Torn's chat fills localStorage on torn.com (QuotaExceededError), so the item log
     lives in memory and is saved to IndexedDB, which has its own, much larger space. */
  const IDB = (() => {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        try {
          const r = indexedDB.open('bm-buddy-manager', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        } catch (e) { rej(e); }
      });
      return dbp;
    }
    const get = k => open().then(db => new Promise((res, rej) => {
      const q = db.transaction('kv', 'readonly').objectStore('kv').get(k);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    }));
    const set = (k, v) => open().then(db => new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    }));
    return { get, set };
  })();
  let logMem = {};
  let storageNote = null; // shown in Check details if saving fails
  function persist(k, v) {
    return IDB.set(k, v).then(() => { storageNote = null; return true; }).catch(err => {
      storageNote = 'Could not save to IndexedDB (' + (err && err.name || 'error') + '), changes reset on reload';
      return false;
    });
  }
  const configObj = () => JSON.parse(JSON.stringify({ users, schedules, usersMeta, prefs }));
  // Saved to IndexedDB (has room); the localStorage copy is best-effort only, as Torn chat fills it.
  function saveConfig() { const v = configObj(); jset(STORAGE_KEY, v); return persist(STORAGE_KEY, v); }
  function saveDone() { jset(DONE_KEY, done); return persist(DONE_KEY, done); }
  function readLog() {
    const s = JSON.parse(JSON.stringify(logMem || {}));
    return {
      entries: Array.isArray(s.entries) ? s.entries : [],
      lastTs: s.lastTs || 0,
      lastPoll: s.lastPoll || 0,
      error: s.error || null,
      pausedUntil: s.pausedUntil || 0,
      typeIds: Array.isArray(s.typeIds) ? s.typeIds : [],
      typesAt: s.typesAt || 0,
      diag: s.diag || null,
      step: s.step || null
    };
  }
  function writeLog(s) { logMem = JSON.parse(JSON.stringify(s)); persist(ITEMLOG_KEY, logMem); }
  let itemNames = {};
  let ownKeyMem = '';
  // Load saved data, then free up the localStorage copies older versions left behind.
  const storeReady = Promise.all([IDB.get(ITEMLOG_KEY), IDB.get(ITEMNAMES_KEY), IDB.get(APIKEY_KEY), IDB.get(STORAGE_KEY), IDB.get(DONE_KEY)])
    .then(([log, names, k, cfg, dn]) => {
      if (!ownKeyMem && typeof k === 'string') ownKeyMem = k;
      logMem = Object.assign({}, log || {}, logMem);
      itemNames = Object.assign({}, names || {}, itemNames);
      if (cfg && cfg.users) {
        users = cfg.users; schedules = cfg.schedules || {}; usersMeta = cfg.usersMeta || {};
        prefs = Object.assign({ overdueHour: 18, onlyToday: false }, cfg.prefs || {});
      } else if (hadLocalConfig) {
        saveConfig(); // first run of this version: copy your buddy list over from localStorage
      }
      if (dn && typeof dn === 'object') done = Object.assign({}, dn, done);
      const today = todayStrLocal(); // ticks only matter for today
      Object.keys(done).forEach(key => { if (done[key] !== today) delete done[key]; });
      saveDone();
    })
    .catch(err => { storageNote = 'IndexedDB unavailable (' + (err && err.name || 'error') + '), list resets on reload'; })
    .then(() => {
      ['bm-itemlog-v1', 'bm-itemlog-v2', 'bm-itemnames-v1', 'bm-logs-cache-v2'].forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
      refreshIndicators();
      if (isMenuOpen()) rebuildContent();
      renderProfile();
    });

  function buddyByUserId(id) {
    const want = String(id);
    for (const name of Object.keys(users)) {
      const uid = String((usersMeta[name] || {}).userId || '').trim();
      if (uid && uid === want) return name;
    }
    return null;
  }
  // Which buddy (if any) an entry belongs to, using the IDs currently saved in Config.
  const entryBuddy = e => (e && e.senderId ? buddyByUserId(e.senderId) : null);
  function buddyEntries(entries, name) {
    return entries.filter(e => { const b = entryBuddy(e); return b && (!name || b === name); });
  }
  function unseenCount(name) {
    return buddyEntries(readLog().entries, name).filter(e => !e.seen).length;
  }
  function markSeen(name) {
    const s = readLog(); let changed = false;
    buddyEntries(s.entries, name).forEach(e => { if (!e.seen) { e.seen = true; changed = true; } });
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
      type: r.log != null ? String(r.log) : (r.details && r.details.id != null ? String(r.details.id) : null),
      data: r.data || {},
      params: r.params || {}
    })).filter(r => r.ts > 0);
  }

  /* ---------------- API calls ---------------- */
  const API = 'https://api.torn.com';
  const COMMENT = 'BuddyMgr';
  // Error codes that mean "stop using this key until the user fixes it"
  const FATAL_CODES = [1, 2, 10, 13, 16, 18];

  const REQUEST_TIMEOUT = 20000;
  function withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Request timed out after ' + Math.round(ms / 1000) + 's')), ms);
      Promise.resolve(p).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
  }
  // Torn PDA provides its own HTTP handler; use it when present, otherwise plain fetch.
  async function httpGetJson(url) {
    if (typeof window.PDA_httpGet === 'function') {
      const r = await withTimeout(window.PDA_httpGet(url, {}), REQUEST_TIMEOUT);
      const text = r && (r.responseText != null ? r.responseText : (r.body != null ? r.body : r));
      return typeof text === 'string' ? JSON.parse(text) : text;
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT) : null;
    try {
      const res = await withTimeout(fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }), REQUEST_TIMEOUT + 1000);
      return await res.json();
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('Request timed out after ' + Math.round(REQUEST_TIMEOUT / 1000) + 's');
      throw e;
    } finally { if (t) clearTimeout(t); }
  }
  async function apiGet(path, key) {
    const sep = path.indexOf('?') === -1 ? '?' : '&';
    const j = await httpGetJson(API + path + sep + 'key=' + encodeURIComponent(key) + '&comment=' + COMMENT);
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
    persist(ITEMNAMES_KEY, itemNames);
  }

  let polling = false, pollingSince = 0;
  function setStep(state, step) { state.step = { name: step, at: Date.now() }; writeLog(state); }
  async function pollLogs(force) {
    await storeReady;
    // A stuck request must never block checks forever.
    if (polling && Date.now() - pollingSince < 3 * REQUEST_TIMEOUT) return;
    const { key } = getKey();
    if (!key) return;
    try { // another tab may have checked since this one loaded
      const saved = await IDB.get(ITEMLOG_KEY);
      if (saved && (saved.lastPoll || 0) > (logMem.lastPoll || 0)) logMem = Object.assign({}, logMem, saved);
    } catch (e) { /* ignore */ }
    const state = readLog();
    const now = Date.now();
    if (force && now - state.lastPoll < 10000) return; // manual Check: at most once per 10s
    if (!force) {
      if (document.hidden) return;
      if (state.error && state.error.fatal) return;
      if (state.pausedUntil > now) return;
      if (now - state.lastPoll < 60000) return; // shared across tabs: at most one poll a minute
    }
    polling = true; pollingSince = now;
    state.lastPoll = now;
    setStep(state, 'started (' + (typeof window.PDA_httpGet === 'function' ? 'PDA handler' : 'fetch') + ')');
    try {
      setStep(state, 'looking up log types');
      const types = await resolveTypeIds(state, key);
      setStep(state, 'reading your log (types ' + types.join(',') + ')');
      const from = state.lastTs ? state.lastTs + 1 : Math.floor(now / 1000) - FIRST_LOOKBACK;
      const j = await apiGet('/user/?selections=log&log=' + types.join(',') + '&from=' + from, key);
      const rows = normaliseLogResponse(j);
      const known = new Set(state.entries.map(e => e.id));
      const newItemIds = [];
      const diag = { at: Date.now(), types: types.slice(), rows: rows.length, itemRows: 0, senders: [], from };
      for (const r of rows) {
        if (r.type && types.indexOf(r.type) === -1) continue; // safety: only item-received types
        diag.itemRows++;
        const sid = extractSender(r.data);
        if (sid && diag.senders.indexOf(sid) === -1 && diag.senders.length < 8) diag.senders.push(sid);
        if (r.ts > state.lastTs) state.lastTs = r.ts;
        if (known.has(r.id)) continue;
        const sender = extractSender(r.data);
        if (!sender) continue; // anonymous sends can't be matched to a buddy
        // Keep it even if the sender isn't a buddy yet: adding their ID later will show it.
        const items = extractItems(r.data);
        if (buddyByUserId(sender)) items.forEach(i => newItemIds.push(i.id));
        state.entries.push({ id: r.id, ts: r.ts, senderId: sender, items, message: r.data.message || '', seen: false });
        known.add(r.id);
      }
      state.entries.sort((a, b) => b.ts - a.ts);
      state.entries = state.entries.slice(0, LOG_MAX);
      state.error = null;
      state.diag = diag;
      writeLog(state);
      if (newItemIds.length) { setStep(state, 'naming items'); await resolveItemNames(Array.from(new Set(newItemIds)), key); }
      setStep(state, 'finished');
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
  function toast(msg, icon) {
    let t = $('#bm-toast');
    if (!t) { t = el('div', { id: 'bm-toast', 'aria-live': 'polite' }); document.body.appendChild(t); }
    t.textContent = (icon || '✅') + ' ' + msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
  }
  // Clipboard: modern API first, then the older copy command (works in more in-app browsers).
  function copyText(text) {
    const legacy = () => {
      try {
        const ta = el('textarea', { readonly: 'readonly', style: { position: 'fixed', top: '-1000px', opacity: '0' } });
        ta.value = text; document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch (e) { return false; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => legacy());
    }
    return Promise.resolve(legacy());
  }
  const userProfileURL = name => {
    const id = String((usersMeta[name] || {}).userId || '').trim();
    return id ? 'https://www.torn.com/profiles.php?XID=' + encodeURIComponent(id) : 'https://www.torn.com/search.php?p=people&q=' + encodeURIComponent(name);
  };
  // Badge next to a buddy's name/ID: amber "new" until viewed, then a quieter "last detected" time (shown for 7 days).
  function bellFor(name) {
    const mine = buddyEntries(readLog().entries, name);
    if (!mine.length) return null;
    const latest = mine.reduce((a, b) => (b.ts > a.ts ? b : a));
    if (Date.now() - latest.ts * 1000 > 7 * 86400000) return null;
    const n = mine.filter(e => !e.seen).length;
    const ago = timeAgo(latest.ts * 1000).replace(' ago', '');
    return el('span', {
      class: 'bm-bell' + (n ? '' : ' seen'),
      title: 'Log detected: last item from ' + name + ' ' + timeAgo(latest.ts * 1000) + '. Tap to view.',
      onclick: ev => { ev.preventDefault(); ev.stopPropagation(); LOG_FILTER = name; setView('log'); }
    }, '🔔 ', n ? (n > 1 ? n + ' new' : 'new') : ago);
  }
  function refreshIndicators() {
    renderProfile();
    renderCompany();
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

  function receivedToday(u) {
    const mid = new Date(); mid.setHours(0, 0, 0, 0);
    return buddyEntries(readLog().entries, u).some(e => e.ts * 1000 >= mid.getTime());
  }
  // Everything the UI needs to know about one label today.
  function labelInfo(u, labelId) {
    const e = schedules[u] && schedules[u][labelId];
    const interval = Math.max(1, parseInt(e && e.interval, 10) || 1);
    const countdown = bellStatus(u, labelId).countdown;
    const dueToday = countdown === 0;
    const done = dueToday && isDone(u, labelId);
    const received = dueToday && receivedToday(u);
    const overdue = dueToday && !done && !received && new Date().getHours() >= prefs.overdueHour;
    // days until the next one still to do (a done label counts from its next occurrence)
    const nextDays = countdown == null ? null : (done ? interval : countdown);
    return { countdown, interval, dueToday, done, received, overdue, nextDays };
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
    const onlyToday = !!prefs.onlyToday;
    const pill = el('div', { class: 'bm-pill' + (onlyToday ? ' active' : ''), onclick: () => { prefs.onlyToday = !onlyToday; saveConfig(); rebuildContent(); } }, 'Show only due today');
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
        const st = labelInfo(u, o.id);
        if (onlyToday && !st.dueToday) return;
        shown++;
        const paint = info => {
          if (!info.dueToday) return info.countdown > 0 ? ['bm-badge', 'in ' + info.countdown + 'd'] : ['bm-badge', ''];
          if (info.done) return ['bm-badge done', 'done'];
          if (info.overdue) return ['bm-badge overdue', 'overdue'];
          return ['bm-badge today', 'today'];
        };
        const [cls, txt] = paint(st);
        const badge = el('span', { class: cls, title: st.overdue ? 'Due today, not ticked and nothing received from ' + u + ' yet' : null }, txt);
        let check = null;
        if (st.dueToday) {
          check = el('input', { type: 'checkbox', class: 'bm-check', title: 'Mark done' });
          check.checked = st.done;
          check.addEventListener('click', ev => ev.stopPropagation());
          check.addEventListener('change', ev => {
            setDone(u, o.id, ev.target.checked);
            const [c2, t2] = paint(labelInfo(u, o.id));
            badge.className = c2; badge.textContent = t2;
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
        await pollLogs(true); rebuildContent();
      } }, '↻ Check')));

    if (state.error) {
      container.appendChild(el('div', { class: 'bm-error' },
        '❌ ' + (state.error.code != null ? 'Error ' + state.error.code + ': ' : '') + state.error.msg,
        state.error.fatal ? ' - checking is paused until you fix the key and press Check.' : null));
    }

    // Diagnostics: what the last check actually got back from the API
    const d = state.diag;
    const ids = Object.keys(users).map(n => String((usersMeta[n] || {}).userId || '').trim()).filter(Boolean);
    container.appendChild(el('details', { class: 'bm-section' },
      el('summary', { style: { cursor: 'pointer', fontSize: '9.5px', opacity: '.85' } }, '🛠 Check details (v' + SCRIPT_VERSION + ')'),
      el('div', { class: 'bm-sub', style: { lineHeight: '1.5', marginTop: '4px', wordBreak: 'break-word' } },
        state.step ? 'Last step: ' + state.step.name + ' (' + timeAgo(state.step.at) + ')' : 'Last step: none yet', el('br'),
        d ? [
          'Last completed: ' + timeAgo(d.at), el('br'),
          'Log types: ' + (d.types.join(', ') || 'none'), el('br'),
          'Rows returned: ' + d.rows + ' · item-received rows: ' + d.itemRows, el('br'),
          'Senders seen: ' + (d.senders.join(', ') || 'none'), el('br'),
          'Looked from: ' + new Date(d.from * 1000).toLocaleString('en-GB'), el('br'),
          'Stored entries: ' + state.entries.length, el('br'),
          'Buddy IDs saved: ' + (ids.join(', ') || 'none'),
          storageNote ? [el('br'), '⚠️ ' + storageNote] : null
        ] : 'No completed check yet. Buddy IDs saved: ' + (ids.join(', ') || 'none')),
      el('button', { class: 'refresh-btn', style: { marginTop: '6px' }, onclick: async ev => {
        ev.target.textContent = 'Rescanning…';
        const s = readLog(); s.entries = []; s.lastTs = 0; s.lastPoll = 0; s.error = null; s.pausedUntil = 0; s.typeIds = []; s.typesAt = 0; writeLog(s);
        await pollLogs(true); rebuildContent();
      } }, '↺ Rescan last 7 days')));

    const noIds = Object.keys(users).filter(n => !String((usersMeta[n] || {}).userId || '').trim());
    if (noIds.length) container.appendChild(el('div', { class: 'bm-status' }, 'No user ID set for: ' + noIds.join(', ') + ' (add it in ⚙️)'));

    if (LOG_FILTER) {
      container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'center' } },
        el('div', { class: 'bm-pill active', onclick: () => { LOG_FILTER = null; rebuildContent(); } }, 'Only ' + LOG_FILTER + '  ✕')));
    }

    const entries = buddyEntries(state.entries, LOG_FILTER);
    // Fetch names for items we haven't named yet (e.g. a buddy whose ID was added after the item arrived).
    const unnamed = Array.from(new Set([].concat.apply([], entries.map(e => (e.items || []).map(i => i.id))).filter(id => !itemNames[id])));
    if (unnamed.length && k.key && !buildLog._naming) {
      buildLog._naming = true;
      resolveItemNames(unnamed, k.key).then(() => { buildLog._naming = false; if (VIEW === 'log' && isMenuOpen()) rebuildContent(); });
    }
    const list = el('div', { class: 'bm-list' });
    if (!entries.length) list.appendChild(el('div', { class: 'bm-status', style: { padding: '8px 0' } }, 'No items received from your buddies yet.'));
    entries.forEach(e => {
      list.appendChild(el('div', { class: 'bm-log-row' + (e.seen ? '' : ' new') },
        el('div', { class: 'bm-log-top' },
          el('a', { class: 'bm-log-who', href: 'https://www.torn.com/profiles.php?XID=' + encodeURIComponent(e.senderId), target: '_blank', rel: 'noopener' }, (e.seen ? '' : '🔔 ') + entryBuddy(e)),
          el('span', { class: 'bm-sub' }, timeAgo(e.ts * 1000))),
        el('div', { class: 'bm-log-what' }, 'sent you ' + describeItems(e.items)),
        e.message ? el('div', { class: 'bm-log-msg' }, '"' + e.message + '"') : null));
    });
    container.appendChild(list);

    // key + ToS
    const keyInput = el('input', { class: 'bm-input', type: 'password', placeholder: '16-character API key', value: ownKeyMem || jget(APIKEY_KEY, '') || '' });
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
          ownKeyMem = v; jset(APIKEY_KEY, v); persist(APIKEY_KEY, v);
          const s = readLog(); s.error = null; s.pausedUntil = 0; s.lastPoll = 0; writeLog(s);
          toast(v ? 'Key saved' : 'Key cleared'); rebuildContent(); pollLogs(true);
        } }, 'Save key'),
        el('button', { class: 'remove-btn', onclick: () => { if (confirm('Clear the detected items list?')) { const s = readLog(); s.entries = []; writeLog(s); refreshIndicators(); rebuildContent(); } } }, 'Clear list')),
      el('table', { class: 'bm-tos' },
        el('tr', null, el('td', null, 'Data storage'), el('td', null, 'Only locally (this browser)')),
        el('tr', null, el('td', null, 'Data sharing'), el('td', null, 'Nobody')),
        el('tr', null, el('td', null, 'Purpose of use'), el('td', null, 'Personal: show items your buddies sent you, and company trains you owe buyers')),
        el('tr', null, el('td', null, 'Key storage & sharing'), el('td', null, 'Stored locally / Not shared. Only sent to api.torn.com')),
        el('tr', null, el('td', null, 'Key access level'), el('td', null, 'Custom: user → log; company → news, detailed (Full also works)'))));
    container.appendChild(settings);

    // Viewing the log clears the bells for what's on screen.
    setTimeout(() => markSeen(LOG_FILTER), 1500);
  }

  /* ---------------- COMPANY TRAINS ----------------
     Train events come from your company's news ("<Position> <a …XID=ID>Name</a> has been trained by the director").
     Trains left today come from company → detailed. Both are read about every 2 minutes, only once you have buyers. */
  const TRAINS_KEY = 'bm-trains-v1';
  const TRAINS_POLL_MS = 120000, DETAILED_POLL_MS = 300000, TRAIN_EVENTS_MAX = 500;
  let trainsMem = {};
  const trainsReady = IDB.get(TRAINS_KEY)
    .then(t => { trainsMem = Object.assign({}, t || {}, trainsMem); })
    .catch(() => { /* IndexedDB unavailable: works until reload */ });
  function readTrains() {
    const s = JSON.parse(JSON.stringify(trainsMem || {}));
    return {
      buyers: Array.isArray(s.buyers) ? s.buyers : [],
      events: Array.isArray(s.events) ? s.events : [],
      names: s.names || {},
      lastPoll: s.lastPoll || 0, lastDetailed: s.lastDetailed || 0,
      trainsLeft: s.trainsLeft == null ? null : s.trainsLeft, trainsLeftAt: s.trainsLeftAt || 0,
      error: s.error || null, detailedError: s.detailedError || null
    };
  }
  function writeTrains(s) { trainsMem = JSON.parse(JSON.stringify(s)); persist(TRAINS_KEY, trainsMem); }
  const getCompanyKey = () => getKey(); // same key as the rest of the script

  function parseTrainNews(json) {
    const news = json && json.news; if (!news) return [];
    const rows = Array.isArray(news) ? news.map(n => [String(n.id), n]) : Object.keys(news).map(id => [id, news[id]]);
    const out = [];
    rows.forEach(([id, n]) => {
      const text = String((n && (n.news || n.text)) || '');
      if (!/has been trained by the director/i.test(text)) return;
      const m = /XID=(\d+)[^>]*>([^<]*)<[/]a>/i.exec(text); // [/] (no escaped slash)
      if (!m) return;
      out.push({ id, ts: Number(n.timestamp) || 0, uid: m[1], name: m[2].trim() });
    });
    return out.filter(e => e.ts > 0);
  }
  function trainsLeftFrom(json) {
    const d = json && (json.company_detailed || json.detailed || json);
    const v = d && (d.trains_available != null ? d.trains_available : d.trains);
    return v == null || isNaN(Number(v)) ? null : Number(v);
  }

  // Purchased is entered; Trained is every train detected for that ID (plus any manual correction); Left = Purchased - Trained.
  function buyerStats(b, events) {
    const mine = events.filter(e => e.uid === String(b.id));
    const purchased = parseInt(b.purchased != null ? b.purchased : b.paid, 10) || 0;
    const trained = Math.max(0, mine.length + (parseInt(b.adjust, 10) || 0));
    const left = Math.max(0, purchased - trained);
    const last = mine.length ? mine.reduce((a, e) => (e.ts > a.ts ? e : a)) : null;
    return { purchased, trained, left, last, complete: purchased > 0 && trained >= purchased };
  }
  // Today's order: buyers with trains left, in list order, filling today's available trains.
  function trainOrder(s) {
    const out = []; let slot = 1;
    for (const b of s.buyers) {
      const st = buyerStats(b, s.events);
      if (!st.left) continue;
      let n = st.left;
      if (s.trainsLeft != null) n = Math.min(n, s.trainsLeft - (slot - 1));
      if (n <= 0) break;
      out.push({ b, from: slot, to: slot + n - 1, n });
      slot += n;
    }
    return out;
  }

  let trainsPolling = false;
  async function pollTrains(force) {
    await trainsReady; await storeReady;
    if (trainsPolling) return;
    const s = readTrains();
    if (!s.buyers.length && !force) return; // nothing to track yet
    const { key } = getCompanyKey(); if (!key) return;
    const now = Date.now();
    if (!force) {
      if (document.hidden) return;
      if (s.error && s.error.fatal) return;
      if (now - s.lastPoll < TRAINS_POLL_MS) return;
    } else if (now - s.lastPoll < 10000) return;
    trainsPolling = true; s.lastPoll = now; writeTrains(s);
    try {
      const j = await apiGet('/company/?selections=news', key);
      const known = new Set(s.events.map(e => e.id));
      parseTrainNews(j).forEach(e => { s.names[e.uid] = e.name; if (!known.has(e.id)) { s.events.push(e); known.add(e.id); } });
      s.events.sort((a, b) => b.ts - a.ts); s.events = s.events.slice(0, TRAIN_EVENTS_MAX);
      s.error = null;
      if (force || now - s.lastDetailed >= DETAILED_POLL_MS) {
        s.lastDetailed = now;
        try {
          const d = await apiGet('/company/?selections=detailed', key);
          const left = trainsLeftFrom(d);
          s.trainsLeft = left; s.trainsLeftAt = now;
          s.detailedError = left == null ? 'No trains figure in the company data' : null;
        } catch (e) {
          s.detailedError = (e.code != null ? 'Error ' + e.code + ': ' : '') + (e.message || 'failed') + (e.code === 16 || e.code === 7 ? ' (the key needs company access as director)' : '');
        }
      }
      writeTrains(s);
    } catch (e) {
      s.error = { code: e.code == null ? null : e.code, msg: e.message || 'Network error', fatal: FATAL_CODES.indexOf(e.code) !== -1 || e.code === 7, at: Date.now() };
      writeTrains(s);
    } finally {
      trainsPolling = false;
      renderCompany();
      if (VIEW === 'trains' && isMenuOpen()) rebuildContent();
    }
  }

  function buildTrains(container) {
    if (!buildTrains._loaded) { buildTrains._loaded = true; trainsReady.then(() => { if (VIEW === 'trains' && isMenuOpen()) rebuildContent(); pollTrains(false); }); }
    const s = readTrains();
    const ck = getCompanyKey();
    const save = mut => { const t = readTrains(); mut(t); writeTrains(t); rebuildContent(); };
    const order = trainOrder(s);
    const nameOf = b => b.name || s.names[b.id] || ('User ' + b.id);
    const profile = id => 'https://www.torn.com/profiles.php?XID=' + encodeURIComponent(id);

    // --- Today: trains left + order
    const hero = el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-hero' },
        el('div', null,
          el('div', { class: 'bm-tr-big' }, s.trainsLeft == null ? '?' : String(s.trainsLeft)),
          el('div', { class: 'bm-tr-cap' }, 'trains left today')),
        el('button', { class: 'refresh-btn', disabled: ck.key ? null : 'disabled', onclick: async ev => {
          ev.currentTarget.textContent = '…';
          const t = readTrains(); t.error = null; t.lastPoll = 0; writeTrains(t);
          await pollTrains(true); rebuildContent();
        } }, '↻ Check')),
      el('div', { class: 'bm-tr-order' },
        order.length
          ? order.map(o => el('div', { class: 'bm-tr-orow' },
              el('span', { class: 'bm-tr-slot' }, o.from === o.to ? '#' + o.from : '#' + o.from + '–' + o.to),
              el('a', { class: 'bm-tr-who', href: profile(o.b.id), target: '_blank', rel: 'noopener' }, nameOf(o.b)),
              el('span', { class: 'bm-tr-n' }, o.n + (o.n === 1 ? ' train' : ' trains'))))
          : el('div', { class: 'bm-status', style: { textAlign: 'left' } }, s.buyers.length ? 'Nobody has trains left to give.' : 'Add a buyer below to start.')),
      el('div', { class: 'bm-status', style: { textAlign: 'left', marginTop: '2px' } }, ck.key
        ? 'Checked ' + (s.lastPoll ? timeAgo(s.lastPoll) : 'never') + ' · ' + ck.source
        : 'No API key yet - add one in the Log tab'));
    container.appendChild(hero);

    if (s.error) container.appendChild(el('div', { class: 'bm-error' }, '❌ ' + (s.error.code != null ? 'Error ' + s.error.code + ': ' : '') + s.error.msg,
      s.error.code === 7 || s.error.code === 16 ? ' - company news needs a key with company access.' : null));
    if (s.detailedError) container.appendChild(el('div', { class: 'bm-status', style: { textAlign: 'left' } }, '⚠️ Trains left unavailable: ' + s.detailedError));

    // --- Buyers
    container.appendChild(el('div', { class: 'bm-tr-title' }, 'Buyers'));
    if (!s.buyers.length) container.appendChild(el('div', { class: 'bm-status', style: { textAlign: 'left' } }, 'No buyers yet.'));
    s.buyers.forEach((b, idx) => {
      const st = buyerStats(b, s.events);
      const pct = st.purchased ? Math.min(100, Math.round(st.trained / st.purchased * 100)) : 0;
      const box = (cap, num, cls, onclick, title) => el('div', { class: 'bm-tr-box' + (cls ? ' ' + cls : ''), onclick, title },
        el('div', { class: 'bm-tr-num' }, String(num)), el('div', { class: 'bm-tr-cap' }, cap));
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' + (st.complete ? ' complete' : '') },
        el('div', { class: 'bm-tr-bhead' },
          el('a', { class: 'bm-tr-who', href: profile(b.id), target: '_blank', rel: 'noopener' }, nameOf(b)),
          el('span', { class: 'bm-uid' }, '[' + b.id + ']'),
          st.complete ? el('span', { class: 'bm-badge done', style: { marginLeft: 'auto' } }, 'complete') : null,
          el('button', { class: 'bm-tr-x', title: 'Remove buyer', style: st.complete ? null : { marginLeft: 'auto' },
            onclick: () => { if (confirm('Remove ' + nameOf(b) + '?')) save(t => { t.buyers.splice(idx, 1); }); } }, '✕')),
        el('div', { class: 'bm-tr-stats' },
          box('Purchased', st.purchased, '', () => {
            const v = prompt('Trains purchased by ' + nameOf(b) + ':', String(st.purchased));
            const n = parseInt(v, 10); if (v == null || isNaN(n) || n < 0) return;
            save(t => { t.buyers[idx].purchased = n; });
          }, 'Tap to change'),
          box('Trained', st.trained, 'auto', () => {
            const v = prompt('Detected ' + (st.trained - (parseInt(b.adjust, 10) || 0)) + ' trains for ' + nameOf(b) + ' from your company log.\nCorrect the total trained to:', String(st.trained));
            const n = parseInt(v, 10); if (v == null || isNaN(n) || n < 0) return;
            save(t => { const x = t.buyers[idx]; x.adjust = (parseInt(x.adjust, 10) || 0) + (n - st.trained); });
          }, 'Detected from your company log - tap to correct'),
          box('Left', st.left, st.complete ? 'zero' : 'left')),
        el('div', { class: 'bm-tr-bar' }, el('span', { style: { width: pct + '%' } })),
        el('div', { class: 'bm-tr-foot' }, st.last ? 'Last trained ' + timeAgo(st.last.ts * 1000) : 'No trains detected yet')));
    });

    // --- Add buyer: ID (+ name) and trains purchased
    const idIn = el('input', { class: 'bm-input', type: 'number', placeholder: 'User ID' });
    const nameIn = el('input', { class: 'bm-input', type: 'text', placeholder: 'Name (optional)' });
    const purIn = el('input', { class: 'bm-input', type: 'number', min: '1', placeholder: 'Trains purchased' });
    const hint = el('div', { class: 'bm-tr-foot' });
    idIn.addEventListener('input', () => {
      const id = idIn.value.trim(); const n = s.names[id];
      if (n && !nameIn.value) nameIn.value = n;
      const found = s.events.filter(e => e.uid === id).length;
      hint.textContent = /^\d+$/.test(id) ? (found ? found + ' train' + (found === 1 ? '' : 's') + ' already detected for this ID' : 'No trains detected for this ID yet') : '';
    });
    container.appendChild(el('details', { class: 'bm-section bm-tr-card' },
      el('summary', { class: 'bm-tr-add' }, '＋ Add buyer'),
      el('div', { class: 'bm-tr-form' },
        el('div', { class: 'bm-tr-row' }, idIn, nameIn),
        purIn, hint,
        el('button', { class: 'refresh-btn', onclick: () => {
          const id = idIn.value.trim(), pur = parseInt(purIn.value, 10);
          if (!/^\d+$/.test(id)) { alert('Enter the buyer\u2019s Torn user ID.'); return; }
          if (!(pur > 0)) { alert('Enter how many trains they purchased.'); return; }
          if (s.buyers.some(b => String(b.id) === id)) { alert('That buyer is already in the list.'); return; }
          save(t => t.buyers.push({ id, name: nameIn.value.trim() || s.names[id] || '', purchased: pur, adjust: 0, addedAt: Date.now() }));
          toast('Buyer added'); pollTrains(true);
        } }, 'Add buyer'))));
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
          saveConfig().then(ok => {
            if (ok) toast('Saved!');
            else alert('Could not save (browser storage unavailable), so this change only lasts until you reload. Use Backup → Export to keep a copy.');
          });
          rebuildContent(); renderProfile();
        } }, 'Save'),
        el('button', { class: 'refresh-btn', onclick: () => rebuildContent() }, 'Cancel')));
    }
    render();
    container.appendChild(buildSettings());
    container.appendChild(buildBackup());
  }

  /* ---------------- settings: overdue time ---------------- */
  function buildSettings() {
    const hourInput = el('input', { class: 'bm-input', type: 'number', min: '0', max: '23', value: prefs.overdueHour, style: { width: '64px' },
      onchange: e => {
        const h = Math.min(23, Math.max(0, parseInt(e.target.value, 10)));
        if (isNaN(h)) { e.target.value = prefs.overdueHour; return; }
        prefs.overdueHour = h; e.target.value = h; saveConfig(); renderProfile(); toast('Overdue time set to ' + pad(h) + ':00');
      } });
    return el('details', { class: 'bm-section' },
      el('summary', { style: { cursor: 'pointer', fontWeight: '800', color: '#b9d2ff' } }, '⏰ Overdue warning'),
      el('div', { class: 'bm-sub', style: { margin: '4px 0' } }, 'A label due today turns red from this hour if it isn\'t ticked and that buddy hasn\'t sent you an item today.'),
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, 'Overdue from', hourInput, ':00'));
  }

  /* ---------------- backup & restore ---------------- */
  function buildBackup() {
    const box = el('textarea', { class: 'bm-input', rows: '4', placeholder: 'Paste a backup here to restore it', style: { fontFamily: 'monospace', fontSize: '9px', marginTop: '4px', resize: 'vertical' } });
    const exportNow = () => {
      const data = Object.assign({ app: 'buddy-manager', version: SCRIPT_VERSION, exportedAt: new Date().toISOString() }, configObj());
      const text = JSON.stringify(data);
      box.value = text; box.focus(); box.select();
      const copied = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false);
      copied.then(ok => toast(ok ? 'Backup copied to clipboard' : 'Backup shown below - copy it'));
      try { // also offer a file, where the browser allows downloads
        const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })), download: 'buddy-manager-backup-' + todayStrLocal() + '.json' });
        document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } catch (e) { /* downloads not supported here */ }
    };
    const importNow = () => {
      let data;
      try { data = JSON.parse(box.value.trim()); } catch (e) { alert('That isn\'t a valid backup (could not read it).'); return; }
      if (!data || typeof data.users !== 'object' || Array.isArray(data.users)) { alert('That isn\'t a Buddy Manager backup.'); return; }
      const n = Object.keys(data.users).length;
      if (!confirm('Replace your current ' + Object.keys(users).length + ' buddies with the ' + n + ' in this backup?')) return;
      users = data.users; schedules = data.schedules || {}; usersMeta = data.usersMeta || {};
      prefs = Object.assign({ overdueHour: 18, onlyToday: false }, data.prefs || {});
      saveConfig().then(ok => toast(ok ? 'Restored ' + n + ' buddies' : 'Restored, but could not save'));
      rebuildContent(); renderProfile();
    };
    return el('details', { class: 'bm-section' },
      el('summary', { style: { cursor: 'pointer', fontWeight: '800', color: '#b9d2ff' } }, '💾 Backup & restore'),
      el('div', { class: 'bm-sub', style: { margin: '4px 0' } }, 'Export copies your buddies, labels, schedules and settings (saved version - press Save first). Keep it somewhere safe, or paste it into another device.'),
      el('div', { style: { display: 'flex', gap: '6px' } },
        el('button', { class: 'refresh-btn', onclick: exportNow }, '⬆ Export'),
        el('button', { class: 'refresh-btn', onclick: importNow }, '⬇ Import')),
      box);
  }

  /* ---------------- menu ---------------- */
  const TITLES = { user: '💰 Buddy Manager', log: '📜 Item Log', config: '⚙️ Configuration', trains: '🏢 Company Trains' };
  const isMenuOpen = () => { const m = $('#bm-menu'); return !!(m && m.style.display === 'flex'); };

  function rebuildContent() {
    const content = $('#bm-content'); if (!content) return;
    const h = $('#bm-menu h2'); if (h) h.textContent = TITLES[VIEW];
    document.querySelectorAll('#bm-menu .bm-tab').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === VIEW));
    content.innerHTML = '';
    if (VIEW === 'config') buildConfig(content);
    else if (VIEW === 'log') buildLog(content);
    else if (VIEW === 'trains') buildTrains(content);
    else buildBuddy(content);
    refreshIndicators();
  }
  function setView(v) { VIEW = v; if (v !== 'log') LOG_FILTER = null; if (!isMenuOpen()) buildMenu(); else rebuildContent(); }

  function buildMenu() {
    const old = $('#bm-menu'); if (old) old.remove();
    const tab = (v, label, title) => el('button', { class: 'bm-tab', 'data-view': v, title, onclick: () => setView(v) }, label);
    const menu = el('div', { id: 'bm-menu', style: { display: 'flex' } },
      el('h2', null, TITLES[VIEW]),
      el('div', { class: 'bm-tabs' }, tab('user', '💬 USER', 'Buddies'), tab('log', '📜 LOG', 'Items received'), tab('config', '⚙️', 'Config'), tab('trains', '🏢 Trains', 'Company trains')),
      el('div', { id: 'bm-content' }));
    document.body.appendChild(menu);
    rebuildContent();
  }
  function toggleMenu() {
    const m = $('#bm-menu');
    if (m && m.style.display === 'flex') m.style.display = 'none';
    else buildMenu();
  }

  /* ---------------- profile page badge ----------------
     On profiles.php?XID=… : a buddy badge with the next label's countdown (tap for details),
     or "+ Add as buddy" for someone not in your list. Uses saved data only - no API calls. */
  let profPanelOpen = false, profSig = '';
  function profileXid() {
    if (location.pathname !== '/profiles.php') return null;
    const m = /[?&]XID=(\d+)/i.exec(location.search) || /XID=(\d+)/i.exec(location.hash);
    return m ? m[1] : null;
  }
  function profileTitleEl() {
    return $('#skip-to-content') || $('.content-title h4') ||
      Array.from(document.querySelectorAll('h4')).find(h => /'s Profile/i.test(h.textContent)) || null;
  }
  function profileName(h) {
    // Read only the title's own text, not our badge inside it.
    const t = Array.from(h.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    const m = /^(.+?)['\u2019]s Profile$/i.exec(t);
    return m ? m[1].trim() : '';
  }
  function fmtCountdown(ms) {
    if (ms <= 0) return 'now';
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm ' + (s % 60) + 's';
  }
  // Local midnight starting the day `days` from today.
  function dayStart(days) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days); return d.getTime(); }
  const cdSpan = target => el('span', { class: 'bm-cd', 'data-bm-cd': String(target) }, fmtCountdown(target - Date.now()));

  function buddyLabels(u) {
    return (users[u] || []).filter(o => o && o.label && o.label.trim()).map(o => Object.assign({ id: o.id, label: o.label.trim(), text: String(o.text || '').trim() }, labelInfo(u, o.id)));
  }
  function profileBadgeContent(u) {
    const labels = buddyLabels(u).filter(l => l.nextDays != null);
    if (!labels.length) return { cls: '', parts: ['🤝 Buddy'] };
    const pending = labels.filter(l => l.dueToday && !l.done);
    if (pending.length) {
      const over = pending.filter(l => l.overdue);
      const first = (over[0] || pending[0]).label + (pending.length > 1 ? ' +' + (pending.length - 1) : '');
      return over.length ? { cls: 'overdue', parts: ['🤝 ' + first + ' · overdue'] } : { cls: 'today', parts: ['🤝 ' + first + ' · due today'] };
    }
    const next = labels.reduce((a, b) => (b.nextDays < a.nextDays ? b : a));
    const allTodayDone = labels.some(l => l.dueToday) && labels.filter(l => l.dueToday).every(l => l.done);
    return { cls: allTodayDone ? 'done' : '', parts: ['🤝 ' + (allTodayDone ? '✓ · ' : '') + next.label + ' in ', cdSpan(dayStart(next.nextDays))] };
  }
  function buildProfilePanel(u, xid) {
    const rows = buddyLabels(u).map(l => {
      let chip;
      if (l.nextDays == null) chip = el('span', { class: 'bm-badge' }, 'no schedule');
      else if (l.dueToday && l.done) chip = el('span', { class: 'bm-badge done' }, '✓ done · next in ', cdSpan(dayStart(l.nextDays)));
      else if (l.overdue) chip = el('span', { class: 'bm-badge overdue' }, 'overdue');
      else if (l.dueToday) chip = el('span', { class: 'bm-badge today' }, l.received ? 'due today · 📦 received' : 'due today');
      else chip = el('span', { class: 'bm-badge' }, 'in ', cdSpan(dayStart(l.nextDays)));
      const short = l.text.length > 22 ? l.text.slice(0, 21) + '…' : l.text;
      return el('div', {
          class: 'bm-pp-row' + (l.text ? ' copy' : ''),
          title: l.text ? 'Tap to copy: ' + l.text : 'No amount set for this label (add one in ⚙️)',
          onclick: () => {
            if (!l.text) { toast('No amount set for ' + l.label, '⚠️'); return; }
            copyText(l.text).then(ok => {
              if (!ok) { toast('Could not copy - long-press to copy manually', '⚠️'); return; }
              // Copying counts as doing it, like tapping a label in the menu (only matters when it's due today).
              const ticked = l.dueToday && !l.done;
              if (ticked) setDone(u, l.id, true);
              toast('Copied ' + l.text + (ticked ? ' · ticked' : ''), '📋');
              renderProfile(true);
            });
          }
        },
        el('div', null, el('div', { class: 'bm-pp-label' }, l.label),
          el('div', { class: 'bm-pp-sub' }, 'every ' + l.interval + (l.interval === 1 ? ' day' : ' days') + (short ? ' · 📋 ' + short : ''))),
        chip);
    });
    const mine = buddyEntries(readLog().entries, u);
    const latest = mine.length ? mine.reduce((a, b) => (b.ts > a.ts ? b : a)) : null;
    return el('div', { id: 'bm-prof-panel' },
      el('div', { class: 'bm-pp-head' }, '🤝 ' + u + ' [' + xid + ']'),
      rows.length ? rows : el('div', { class: 'bm-pp-sub' }, 'No labels yet - add some in ⚙️.'),
      el('div', { class: 'bm-pp-sub' }, latest
        ? '🔔 Last item: ' + describeItems(latest.items) + ' · ' + timeAgo(latest.ts * 1000)
        : '🔔 No items detected from ' + u + ' in your logs yet.'),
      el('div', { style: { display: 'flex', gap: '6px' } },
        el('button', { class: 'refresh-btn', onclick: () => { LOG_FILTER = u; setView('log'); } }, '📜 Log'),
        el('button', { class: 'refresh-btn', onclick: () => setView('config') }, '⚙️ Edit')));
  }
  function addAsBuddy(xid, h) {
    if (buddyByUserId(xid)) return;
    const name = (prompt('Add as buddy with this name:', profileName(h) || ('User ' + xid)) || '').trim();
    if (!name) return;
    if (users[name]) { alert('You already have a buddy called "' + name + '". Pick another name.'); return; }
    users[name] = []; schedules[name] = {}; usersMeta[name] = { userId: xid };
    saveConfig().then(ok => toast(ok ? 'Added ' + name + ' - add their labels' : 'Added, but could not save'));
    renderProfile(true);
    VIEW = 'config'; buildMenu();
  }
  function renderProfile(force) {
    const xid = profileXid(); if (!xid) return;
    const h = profileTitleEl(); if (!h) return;
    const u = buddyByUserId(xid);
    let badge = document.getElementById('bm-prof-badge');
    if (badge && badge.parentNode !== h) { badge.remove(); badge = null; }
    // Rebuild only when something visible changed (countdown text is updated by the ticker).
    const mine = u ? buddyEntries(readLog().entries, u) : [];
    const sig = JSON.stringify([xid, u, profPanelOpen, u ? buddyLabels(u) : null, mine.length, mine[0] && mine[0].id, todayStrLocal(), new Date().getHours(), Object.keys(itemNames).length]);
    if (badge && !force && sig === profSig && (!profPanelOpen || document.getElementById('bm-prof-panel'))) return;
    profSig = sig;
    if (!badge) { badge = el('span', { id: 'bm-prof-badge', role: 'button', tabindex: '0' }); h.appendChild(badge); }
    badge.innerHTML = '';
    const oldPanel = document.getElementById('bm-prof-panel'); if (oldPanel) oldPanel.remove();
    if (!u) {
      badge.className = 'add'; badge.title = 'Add this player to Buddy Manager';
      badge.appendChild(document.createTextNode('+ Add as buddy'));
      badge.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); addAsBuddy(xid, h); };
      return;
    }
    const c = profileBadgeContent(u);
    badge.className = c.cls; badge.title = 'Buddy Manager - tap for details';
    c.parts.forEach(p => badge.appendChild(typeof p === 'string' ? document.createTextNode(p) : p));
    badge.appendChild(el('span', { style: { opacity: '.7', fontSize: '10px' } }, profPanelOpen ? '▲' : '▼'));
    badge.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); profPanelOpen = !profPanelOpen; renderProfile(true); };
    if (profPanelOpen) {
      const box = h.closest('.content-title') || h.parentElement;
      box.insertAdjacentElement('afterend', buildProfilePanel(u, xid));
    }
  }
  if (profileXid()) {
    // Torn builds the profile in pieces and may redraw the title, so keep watching (ignoring our own changes).
    let profQueued = false;
    const isOurs = n => n && n.nodeType === 1 && (n.id === 'bm-prof-badge' || n.id === 'bm-prof-panel' || (n.closest && n.closest('#bm-prof-badge,#bm-prof-panel')));
    try {
      new MutationObserver(muts => {
        if (muts.every(m => isOurs(m.target) || Array.from(m.addedNodes).concat(Array.from(m.removedNodes)).every(isOurs) && m.addedNodes.length + m.removedNodes.length > 0)) return;
        if (profQueued) return; profQueued = true;
        requestAnimationFrame(() => { profQueued = false; renderProfile(); });
      }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
    storeReady.then(() => renderProfile(true));
    setInterval(() => {
      document.querySelectorAll('[data-bm-cd]').forEach(n => { n.textContent = fmtCountdown(Number(n.getAttribute('data-bm-cd')) - Date.now()); });
    }, 1000);
    setInterval(() => renderProfile(), 30000); // roll over to "due today"/"overdue" as time passes
  }

  /* ---------------- company employees page ----------------
     On companies.php: a trains card above the employee list, and a tag on each buyer's row
     (slot in today's order + trains left). Uses the Trains tab's saved data - no extra API calls. */
  let compSig = '';
  const onCompanyPage = () => location.pathname === '/companies.php';
  function companyRows() {
    const rows = Array.from(document.querySelectorAll('.employee-list > li, ul.employee-list li[data-user]'));
    return rows.filter((li, i) => rows.indexOf(li) === i && rowUserId(li));
  }
  function rowUserId(li) {
    const d = li.getAttribute('data-user');
    if (d && /^\d+$/.test(d)) return d;
    const a = li.querySelector('a[href*="XID="]');
    const m = a && /XID=(\d+)/.exec(a.getAttribute('href') || '');
    return m ? m[1] : null;
  }
  function renderCompany(force) {
    if (!onCompanyPage()) return;
    const rows = companyRows();
    const oldCard = document.getElementById('bm-emp-card');
    if (!rows.length) { if (oldCard) oldCard.remove(); return; }
    const s = readTrains();
    const order = trainOrder(s);
    const sig = JSON.stringify([rows.length, s.buyers, s.events.length, s.trainsLeft, order.map(o => [o.b.id, o.from, o.to])]);
    if (!force && sig === compSig && oldCard && oldCard.isConnected && rows.every(li => li.__bmDone)) return;
    compSig = sig;
    const nameOf = b => b.name || s.names[b.id] || ('User ' + b.id);
    const slotTxt = o => '#' + (o.from === o.to ? o.from : o.from + '\u2013' + o.to);

    // Summary card above the list
    if (oldCard) oldCard.remove();
    const card = el('div', { id: 'bm-emp-card' },
      el('div', { class: 'bm-emp-left' },
        el('div', { class: 'bm-tr-big' }, s.trainsLeft == null ? '?' : String(s.trainsLeft)),
        el('div', { class: 'bm-tr-cap' }, 'trains left')),
      el('div', { class: 'bm-emp-mid' },
        !s.buyers.length ? el('div', { class: 'bm-emp-none' }, 'No train buyers yet - add them in the Trains tab.')
          : order.length ? order.slice(0, 4).map(o => el('div', { class: 'bm-emp-o' },
              el('span', { class: 'bm-tr-slot' }, slotTxt(o)), el('b', null, nameOf(o.b)), el('span', null, o.n + (o.n === 1 ? ' train' : ' trains'))))
          : el('div', { class: 'bm-emp-none' }, 'Nobody has trains left to give.')),
      el('button', { class: 'refresh-btn', onclick: ev => { ev.preventDefault(); setView('trains'); } }, '\ud83c\udfe2 Tracker'));
    const list = rows[0].parentElement;
    list.parentElement.insertBefore(card, list);

    // Tags on buyers' rows
    rows.forEach(li => {
      li.__bmDone = true;
      Array.from(li.children).forEach(c => { if (c.classList && c.classList.contains('bm-emp-chip')) c.remove(); });
      li.classList.remove('bm-emp-next');
      const id = rowUserId(li);
      const b = s.buyers.find(x => String(x.id) === id);
      if (!b) return;
      const st = buyerStats(b, s.events);
      const o = order.find(x => String(x.b.id) === id);
      if (o) li.classList.add('bm-emp-next');
      if (getComputedStyle(li).position === 'static') li.style.position = 'relative';
      li.appendChild(el('span', { class: 'bm-emp-chip' + (st.complete ? ' done' : o ? ' next' : ''),
          title: st.trained + ' of ' + st.purchased + ' trains given' },
        st.complete ? '\u2713 done' : [o ? el('span', null, slotTxt(o)) : null, el('span', null, st.left + ' left')]));
    });
  }
  if (onCompanyPage()) {
    // The employee list loads after the page and is redrawn when switching tabs; ignore our own changes.
    let compQueued = false;
    const ours = n => n && n.nodeType === 1 && (n.id === 'bm-emp-card' || (n.classList && n.classList.contains('bm-emp-chip')) || (n.closest && n.closest('#bm-emp-card,.bm-emp-chip')));
    try {
      new MutationObserver(muts => {
        if (muts.every(m => ours(m.target) || (m.addedNodes.length + m.removedNodes.length > 0 &&
            Array.from(m.addedNodes).concat(Array.from(m.removedNodes)).every(ours)))) return;
        if (compQueued) return; compQueued = true;
        requestAnimationFrame(() => { compQueued = false; renderCompany(); });
      }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
    window.addEventListener('hashchange', () => setTimeout(() => renderCompany(true), 300));
    trainsReady.then(() => { renderCompany(true); pollTrains(false); });
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

  /* ---------------- polling ---------------- */
  storeReady.then(() => setTimeout(() => pollLogs(false), 1500));
  trainsReady.then(() => setTimeout(() => pollTrains(false), 4000));
  setInterval(() => { pollLogs(false); pollTrains(false); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollLogs(false); pollTrains(false); } });
})();
