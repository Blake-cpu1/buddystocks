// ==UserScript==
// @name         Buddy Manager
// @namespace    https://github.com/Blake-cpu1/buddystocks
// @version      7.11.3
// @description  Buddy labels with schedules, item-received detection from your Torn logs, overdue warnings, a buddy badge with countdowns on profile pages, a company trains tracker, and an offences HOF progression tab.
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
    const add = x => {
      if (x == null || x === false) return;
      if (Array.isArray(x)) { x.forEach(add); return; } // any depth of nesting
      n.appendChild(typeof x === 'object' && x.nodeType ? x : document.createTextNode(String(x)));
    };
    for (let i = 2; i < arguments.length; i++) add(arguments[i]);
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
  const SCRIPT_VERSION = '7.11.3';
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

  let VIEW = 'home';          // 'home' | 'user' | 'log' | 'config' | 'trains' | 'crimes' - the menu always opens on 'home'
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
    '.bm-subtabs{display:flex;gap:4px;padding:3px;border-radius:10px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08)}',
    '.bm-subtab{position:relative;flex:1;padding:5px 4px;border:none;border-radius:7px;background:transparent;color:#cfe1ff;font-weight:800;font-size:var(--base);cursor:pointer}',
    '.bm-subtab.active{background:rgba(79,159,255,.25);color:#fff}',
    '.bm-usage{grid-template-columns:1fr auto auto auto!important}',
    '.bm-tab .bm-count,.bm-subtab .bm-count{position:absolute;top:-6px;right:-6px;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:#ffb300;color:#1a1a1a;font-size:9px;line-height:15px;text-align:center}',
    '.bm-subtab .bm-count{top:-5px;right:-3px}',
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
    '#bm-prof-tbadge{display:inline-flex;align-items:center;gap:5px;margin-left:10px;padding:3px 10px;border-radius:999px;font:700 12px/1.3 Segoe UI,system-ui,sans-serif;letter-spacing:0;text-transform:none;color:#B3DDFF;background:rgba(79,159,255,.16);border:1px solid rgba(100,229,255,.45);cursor:pointer;vertical-align:middle;white-space:nowrap;user-select:none}',
    '#bm-prof-badge.today{background:rgba(79,159,255,.3);border-color:#64E5FF;color:#fff}',
    '#bm-prof-tbadge.today{background:rgba(79,159,255,.3);border-color:#64E5FF;color:#fff}',
    '#bm-prof-badge.overdue{background:rgba(255,70,70,.25);border-color:rgba(255,90,90,.7);color:#ffc2c2}',
    '#bm-prof-tbadge.overdue{background:rgba(255,70,70,.25);border-color:rgba(255,90,90,.7);color:#ffc2c2}',
    '#bm-prof-badge.done{background:rgba(63,195,128,.2);border-color:rgba(63,195,128,.55);color:#b4f8c8}',
    '#bm-prof-tbadge.done{background:rgba(63,195,128,.2);border-color:rgba(63,195,128,.55);color:#b4f8c8}',
    '#bm-prof-badge.add{background:rgba(255,255,255,.06);border:1px dashed rgba(255,255,255,.35);color:#d6dde6}',
    '#bm-prof-tbadge.add{background:rgba(255,255,255,.06);border:1px dashed rgba(255,255,255,.35);color:#d6dde6}',
    '#bm-prof-badge .bm-cd{font-variant-numeric:tabular-nums}',
    '#bm-prof-tbadge .bm-cd{font-variant-numeric:tabular-nums}',
    '#bm-prof-panel{margin:6px 0 8px;padding:8px 10px;border-radius:10px;background:linear-gradient(145deg,rgba(15,18,25,.97),rgba(22,27,38,.95));border:1px solid rgba(65,100,255,.25);color:#e1e5e9;font:12px/1.4 Segoe UI,system-ui,sans-serif;display:flex;flex-direction:column;gap:6px}',
    '#bm-prof-tpanel{--base:11px;margin:6px 0 8px;padding:8px 10px;border-radius:10px;background:linear-gradient(145deg,rgba(15,18,25,.97),rgba(22,27,38,.95));border:1px solid rgba(65,100,255,.25);color:#e1e5e9;font:12px/1.4 Segoe UI,system-ui,sans-serif;display:flex;flex-direction:column;gap:6px}',
    '#bm-prof-panel .bm-pp-head{font-weight:800;color:#b9d2ff}',
    '#bm-prof-tpanel .bm-pp-head{font-weight:800;color:#b9d2ff}',
    '#bm-prof-panel .bm-pp-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}',
    '#bm-prof-tpanel .bm-pp-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}',
    '#bm-prof-panel .bm-pp-row.copy{cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '#bm-prof-tpanel .bm-pp-row.copy{cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '#bm-prof-panel .bm-pp-row.copy:active{background:rgba(79,159,255,.18);border-color:rgba(100,229,255,.45)}',
    '#bm-prof-tpanel .bm-pp-row.copy:active{background:rgba(79,159,255,.18);border-color:rgba(100,229,255,.45)}',
    '#bm-prof-panel .bm-pp-label{font-weight:800;color:#fff}',
    '#bm-prof-tpanel .bm-pp-label{font-weight:800;color:#fff}',
    '#bm-prof-panel .bm-pp-sub{font-size:11px;opacity:.75}',
    '#bm-prof-tpanel .bm-pp-sub{font-size:11px;opacity:.75}',
    '#bm-prof-panel .bm-badge{font-size:11px}',
    '#bm-prof-tpanel .bm-badge{font-size:11px}',
    '#bm-prof-panel button{font:700 11px Segoe UI,system-ui,sans-serif}',
    '#bm-prof-tpanel button{font:700 11px Segoe UI,system-ui,sans-serif}',
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
    '.bm-tr-frow{display:flex;align-items:center;gap:6px}',
    '.bm-tr-focus{display:flex;gap:4px;flex:1}',
    '.bm-tr-fbtn{all:unset;flex:1;text-align:center;padding:4px 0;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);font:800 10px Segoe UI,system-ui,sans-serif;cursor:pointer;color:#cfe1ff}',
    '.bm-tr-fbtn.on.f-MAN,.bm-tr-ftag.f-MAN{background:rgba(255,150,60,.25);border-color:rgba(255,170,90,.7);color:#ffd2a6}',
    '.bm-tr-fbtn.on.f-INT,.bm-tr-ftag.f-INT{background:rgba(79,159,255,.28);border-color:rgba(100,229,255,.7);color:#cfe8ff}',
    '.bm-tr-fbtn.on.f-END,.bm-tr-ftag.f-END{background:rgba(63,195,128,.25);border-color:rgba(63,195,128,.7);color:#c6f6d5}',
    '.bm-pos-list{display:flex;flex-direction:column;gap:4px;margin-top:4px}',
    '.bm-pos-row{padding:5px 8px;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column;gap:2px}',
    '.bm-pos-row.move{border-color:rgba(255,179,0,.45);background:rgba(255,179,0,.06)}',
    '.bm-pos-top{display:flex;justify-content:space-between;align-items:center}',
    '.bm-pos-name{font-weight:800;color:#b9d2ff}',
    '.bm-pos-score{font-weight:800;color:#fff;font-variant-numeric:tabular-nums;padding:1px 6px;border-radius:6px;background:rgba(79,159,255,.2)}',
    '.bm-pos-who{display:flex;align-items:center;gap:6px}',
    '.bm-pos-who a{flex:1;min-width:0;color:#9fe870;font-weight:800;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.bm-pos-tot{opacity:.75;font-variant-numeric:tabular-nums}',
    '.bm-tr-ws span.on{font-weight:800;opacity:1}',
    '.bm-tr-ws span.f-MAN.on{color:#ffd2a6}', '.bm-tr-ws span.f-INT.on{color:#cfe8ff}', '.bm-tr-ws span.f-END.on{color:#c6f6d5}',
    '.bm-tr-ftag{font:800 8.5px Segoe UI,system-ui,sans-serif;padding:1px 5px;border-radius:5px;border:1px solid transparent}',
    '.bm-tr-lbl{font-size:9px;opacity:.7;text-transform:uppercase;letter-spacing:.3px}',
    '.bm-tr-star{all:unset;cursor:pointer;font-size:14px;line-height:1;color:#8a93a3}',
    '.bm-tr-star.on{color:#ffd866}',
    '.bm-tr-hfoot{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:2px}',
    '.bm-tr-link{font-size:9.5px;font-weight:800;color:#8fc0ff;text-decoration:none;white-space:nowrap}',
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
    '#bm-pos-card{--base:11px;margin:8px 0;padding:10px 12px;border-radius:12px;background:linear-gradient(145deg,rgba(15,18,25,.97),rgba(22,27,38,.95));border:1px solid rgba(65,100,255,.25);color:#e1e5e9;font:12px/1.4 Segoe UI,system-ui,sans-serif}',
    '#bm-pos-card .bm-pos-head{display:flex;align-items:center;gap:8px;cursor:pointer}',
    '#bm-pos-card .bm-pos-title{font-weight:800;color:#b9d2ff;font-size:13px;flex:1;min-width:0}',
    '#bm-pos-card .bm-pos-pill{font-weight:800;font-size:10px;padding:2px 8px;border-radius:999px;white-space:nowrap}',
    '#bm-pos-card .bm-pos-pill.warn{background:rgba(255,179,0,.18);border:1px solid rgba(255,179,0,.55);color:#ffd866}',
    '#bm-pos-card .bm-pos-pill.good{background:rgba(63,195,128,.18);border:1px solid rgba(63,195,128,.55);color:#b4f8c8}',
    '#bm-pos-card .bm-pos-caret{opacity:.6;font-size:10px}',
    '#bm-pos-card .bm-pos-table{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto;margin-top:8px;font-variant-numeric:tabular-nums}',
    '#bm-pos-card .h{font-size:9px;text-transform:uppercase;letter-spacing:.5px;opacity:.6;padding:0 6px 4px;border-bottom:1px solid rgba(255,255,255,.1)}',
    '#bm-pos-card .c{padding:6px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;align-items:center;gap:6px;white-space:nowrap}',
    '#bm-pos-card .c.move{background:rgba(255,179,0,.07)}',
    '#bm-pos-card .n{justify-content:flex-end;text-align:right}',
    '#bm-pos-card .pos{font-weight:800;color:#b9d2ff}',
    '#bm-pos-card .who{min-width:0}',
    '#bm-pos-card .who a{color:#9fe870;font-weight:800;text-decoration:none;overflow:hidden;text-overflow:ellipsis}',
    '#bm-pos-card .c b{color:#fff}',
    '#bm-pos-card .st.ok{color:#9fe870;font-weight:800;justify-content:center}',
    '#bm-pos-card .st.move{color:#ffd866;font-size:10px;max-width:120px}',
    '#bm-pos-card .st.move span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#bm-pos-card .bm-pos-note{font-size:10px;opacity:.65;margin-top:6px}',
    'li.bm-emp-next{box-shadow:inset 3px 0 0 #64E5FF}',
    '.bm-emp-chip{position:absolute;top:50%;right:100px;transform:translateY(-50%);z-index:2;display:flex;flex-direction:column;align-items:center;padding:2px 6px;border-radius:7px;font:800 9px/1.2 Segoe UI,system-ui,sans-serif;color:#d6dde6;background:rgba(15,18,25,.9);border:1px solid rgba(255,255,255,.2);cursor:pointer;white-space:nowrap}',
    '.bm-emp-chip.prio{border-color:rgba(255,216,102,.7)}',
    '.bm-emp-chip.mv{border-color:rgba(255,179,0,.65)}',
    '.bm-emp-chip .bm-pos-mv{color:#ffd866}',
    '.bm-emp-chip .bm-pos-ok{color:#9fe870;opacity:.8;font-weight:700}',
    '#bm-emp-card .bm-emp-right{display:flex;flex-direction:column;align-items:flex-end;gap:4px}',
    '#bm-emp-card .bm-emp-posnote{font-size:10px;font-weight:800;color:#9fe870}',
    '#bm-emp-card .bm-emp-posnote.warn{color:#ffd866}',
    '.bm-emp-chip.next{color:#B3DDFF;border-color:rgba(100,229,255,.6);background:rgba(20,40,70,.92)}',
    '.bm-emp-chip.done{color:#b4f8c8;border-color:rgba(63,195,128,.6);background:rgba(15,45,30,.92)}',
    '.bm-cr-eta{font-size:24px;font-weight:800;line-height:1.1;background:linear-gradient(135deg,#4F9FFF,#64E5FF);-webkit-background-clip:text;-webkit-text-fill-color:transparent}',
    '.bm-cr-eta.good{background:linear-gradient(135deg,#3fc380,#9fe870);-webkit-background-clip:text}',
    '.bm-cr-eta.bad{background:linear-gradient(135deg,#ff7a7a,#ffb3b3);-webkit-background-clip:text}',
    '.bm-cr-eta.prov{opacity:.85}',
    '.bm-home-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 2px;font-variant-numeric:tabular-nums}',
    '.bm-home-row + .bm-home-row{border-top:1px solid rgba(255,255,255,.06)}',
    '.bm-home-row.link{cursor:pointer}',
    'a.bm-home-row,a.bm-home-bar{color:inherit;text-decoration:none;-webkit-tap-highlight-color:transparent}',
    'a.bm-home-row:active,a.bm-home-bar:active{background:rgba(79,159,255,.12);border-radius:6px}',
    '.bm-home-row .bm-home-l{flex:1;min-width:0}',
    '.bm-home-go{opacity:.45;font-weight:800;margin-left:2px}',
    '.bm-home-bar.link .bm-home-row{padding-right:2px}',
    '.bm-home-row.link b{color:#fff}',
    '.bm-home-row.warn b{color:#ffd866}',
    '.bm-home-row.ready .bm-home-cd{color:#9fe870;font-weight:800}',
    '.bm-home-ok{color:#9fe870;font-weight:800}',
    '.bm-home-used{opacity:.6}',
    '.bm-home-todo{color:#ffd866;font-weight:800}',
    '.bm-home-cd{font-weight:800;color:#B3DDFF}',
    '.bm-home-bar{display:flex;flex-direction:column;gap:2px;padding:2px 0}',
    '.bm-home-bar .bm-home-row{padding:0 2px}',
    '.bm-home-bar b{color:#fff}',
    '.b-energy .bm-tr-bar span{background:linear-gradient(90deg,#3fc380,#9fe870)}',
    '.b-nerve .bm-tr-bar span{background:linear-gradient(90deg,#ff6b6b,#ffa0a0)}',
    '.b-happy .bm-tr-bar span{background:linear-gradient(90deg,#ffb300,#ffd866)}',
    '.b-life .bm-tr-bar span{background:linear-gradient(90deg,#4F9FFF,#64E5FF)}',
    '.bm-cr-etarow{display:flex;align-items:center;gap:6px}',
    '.bm-cr-ico{font-size:20px;line-height:1}',
    '.bm-cr-trend{display:flex;flex-direction:column;gap:2px;font-weight:800;font-size:calc(var(--base) - .5px)}',
    '.bm-cr-days{display:grid;grid-template-columns:auto 1fr auto;gap:3px 6px;align-items:center;font-variant-numeric:tabular-nums;font-size:calc(var(--base) - .5px)}',
    '.bm-cr-days .lbl{opacity:.75;white-space:nowrap}',
    '.bm-cr-days .bar{height:8px;border-radius:999px;background:rgba(255,255,255,.06);overflow:hidden}',
    '.bm-cr-days .bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#4F9FFF,#64E5FF)}',
    '.bm-cr-days .bar i.today{background:linear-gradient(90deg,#9fe870,#3fc380)}',
    '.bm-cr-days .num{text-align:right;font-weight:800}',
    '.bm-cr-grid{display:grid;grid-template-columns:1fr auto;gap:3px 8px;font-variant-numeric:tabular-nums}',
    '.bm-cr-grid span:nth-child(odd){opacity:.75}',
    '.bm-cr-grid span:nth-child(even){font-weight:800;color:#fff;text-align:right}',
    '.bm-cr-up{color:#9fe870!important}',
    '.bm-cr-down{color:#ff9a9a!important}',
    '.bm-cr-need{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}',
    '.bm-cr-cats{display:grid;grid-template-columns:1fr auto auto;gap:3px 8px;font-variant-numeric:tabular-nums;font-size:calc(var(--base) - .5px)}',
    '.bm-cr-cats .h{opacity:.6;font-size:8.5px;text-transform:uppercase;letter-spacing:.4px}',
    '.bm-cr-cats .n{text-align:right}',
    '.bm-cr-spark{width:100%;height:46px;display:block}',
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
  // API usage meter: one timestamp per call, by feature, kept for 24h (shared by all open pages).
  const USAGE_KEY = 'bm-usage-v1';
  function usageFeature(path) {
    if (/cooldowns|refills|bars/.test(path)) return 'Home';
    if (/^\/company\/|selections=companies/.test(path)) return 'Trains';
    if (/hof|criminalrecord/.test(path)) return 'Crimes';
    return 'Item log';
  }
  function recordApiCall(path) {
    const f = usageFeature(path), now = Date.now();
    IDB.get(USAGE_KEY).catch(() => null).then(u => {
      u = u || {};
      const cut = now - 86400000;
      Object.keys(u).forEach(k => { u[k] = (u[k] || []).filter(t => t > cut); if (!u[k].length) delete u[k]; });
      (u[f] = u[f] || []).push(now);
      return IDB.set(USAGE_KEY, u);
    }).catch(() => {});
  }
  async function apiGet(path, key) {
    recordApiCall(path);
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
    document.querySelectorAll('#bm-menu .bm-tab[data-view="user"], #bm-menu .bm-subtab[data-view="log"]').forEach(tab => {
      let c = tab.querySelector('.bm-count');
      if (total) { if (!c) { c = el('span', { class: 'bm-count' }); tab.appendChild(c); } c.textContent = String(total); }
      else if (c) c.remove();
    });
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
      : 'No API key yet - add one in \u2699\ufe0f Settings';
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
    if (noIds.length) container.appendChild(el('div', { class: 'bm-status' }, 'No user ID set for: ' + noIds.join(', ') + ' (add it in ✏️ Edit)'));

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

    container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '4px' } },
      el('button', { class: 'remove-btn', onclick: () => { if (confirm('Clear the detected items list?')) { const s = readLog(); s.entries = []; writeLog(s); refreshIndicators(); rebuildContent(); } } }, 'Clear list')));

    // Viewing the log clears the bells for what's on screen.
    setTimeout(() => markSeen(LOG_FILTER), 1500);
  }

  /* ---------------- COMPANY TRAINS ----------------
     Train events come from your company's news ("<Position> <a …XID=ID>Name</a> has been trained by the director").
     Trains left today come from company → detailed. Both are read only when you tap Check (2 calls). */
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
      error: s.error || null, detailedError: s.detailedError || null,
      company: s.company || null, // { name, id } - from Check, the Trains tab, or a colleague's profile
      employees: s.employees || {}, // id -> { name, position, MAN, INT, END, eff }, fetched with Check
      companyType: s.companyType || null,
      posReq: s.posReq || null, posReqAt: s.posReqAt || 0 // position -> { MAN, INT, END } required, for companyType
    };
  }
  function writeTrains(s) { trainsMem = JSON.parse(JSON.stringify(s)); persist(TRAINS_KEY, trainsMem); }
  const getCompanyKey = () => getKey(); // same key as the rest of the script

  // company -> profile: { company: { ID, name, employees: { id: { name, position, ... } } } }
  function parseCompanyProfile(json) {
    const c = json && (json.company || json.profile);
    if (!c || (!c.name && !c.ID && !c.id)) return null;
    const emps = {};
    const list = c.employees || {};
    (Array.isArray(list) ? list.map(e => [String(e.id), e]) : Object.keys(list).map(id => [id, list[id]])).forEach(([id, e]) => {
      if (/^\d+$/.test(id)) emps[id] = { name: (e && e.name) || '', position: (e && e.position) || '' };
    });
    return { name: String(c.name || '').trim(), id: String(c.ID != null ? c.ID : (c.id || '')), type: c.company_type != null ? String(c.company_type) : null, employees: emps };
  }
  // torn -> companies (for one type): { companies: { <type>: { positions: { <name>: { man_required, int_required, end_required } } } } }
  function parsePositionReqs(json, type) {
    const all = json && json.companies;
    const c = all && (all[type] || all[Object.keys(all)[0]]);
    if (!c || !c.positions) return null;
    const out = {};
    Object.keys(c.positions).forEach(name => {
      const p = c.positions[name] || {};
      out[name] = { MAN: Number(p.man_required) || 0, INT: Number(p.int_required) || 0, END: Number(p.end_required) || 0 };
    });
    return out;
  }
  // Your formula, per required stat: floor(min(45, s*45/r) + max(0, 5*log2(s/r))); summed over the
  // position's primary and secondary requirements (the two highest).
  function statPart(s, r) {
    if (!(r > 0)) return 0;
    s = Math.max(0, Number(s) || 0);
    const log = s > 0 ? 5 * Math.log2(s / r) : -Infinity;
    return Math.floor(Math.min(45, s * 45 / r) + Math.max(0, log));
  }
  function positionScore(emp, req) {
    if (!emp || !req) return null;
    const needs = ['MAN', 'INT', 'END'].filter(k => req[k] > 0).sort((a, b) => req[b] - req[a]).slice(0, 2);
    if (!needs.length) return 0;
    return needs.reduce((sum, k) => sum + statPart(emp[k], req[k]), 0);
  }
  // Your layout: by strength rank (1 = strongest, -1 = weakest), everyone else Mill Operator.
  const POSITION_LAYOUT = [['Manager', [1]], ['Sales Executive', [2, 5]], ['Secretary', [3]], ['Safety Inspector', [4]],
    ['Electrician', [-1]], ['Foreman', [-2]], ['Engineer', [-3]]];
  const POSITION_REST = 'Mill Operator';
  const workTotal = e => (Number(e.MAN) || 0) + (Number(e.INT) || 0) + (Number(e.END) || 0);
  function recommendPositions(t) {
    const emps = Object.keys(t.employees || {}).map(id => Object.assign({ id }, t.employees[id]))
      .filter(e => !/^director$/i.test(e.position || '') && (e.MAN != null || e.INT != null || e.END != null));
    if (!emps.length) return [];
    emps.sort((a, b) => workTotal(b) - workTotal(a));
    const n = emps.length, taken = new Set(), out = [];
    POSITION_LAYOUT.forEach(([pos, ranks]) => ranks.forEach(rk => {
      const i = rk > 0 ? rk - 1 : n + rk;
      if (i < 0 || i >= n || taken.has(i)) return;
      taken.add(i); out.push({ pos, rank: i + 1, e: emps[i] });
    }));
    emps.forEach((e, i) => { if (!taken.has(i)) out.push({ pos: POSITION_REST, rank: i + 1, e }); });
    const reqFor = pos => { const r = t.posReq || {}; const k = Object.keys(r).find(x => x.toLowerCase() === pos.toLowerCase()); return k ? r[k] : null; };
    out.forEach(o => {
      o.score = positionScore(o.e, reqFor(o.pos));
      o.cur = o.e.position || '';
      o.curScore = positionScore(o.e, reqFor(o.cur));
      o.ok = o.cur.toLowerCase() === o.pos.toLowerCase();
    });
    return out;
  }
  // company -> employees: { company_employees: { id: { name, position, manual_labor, intelligence, endurance, ... } } }
  function parseCompanyEmployees(json) {
    const list = json && (json.company_employees || json.employees);
    if (!list || typeof list !== 'object') return null;
    const emps = {};
    (Array.isArray(list) ? list.map(e => [String(e.id), e]) : Object.keys(list).map(id => [id, list[id]])).forEach(([id, e]) => {
      if (!/^\d+$/.test(id) || !e) return;
      const num = v => (v == null || isNaN(Number(v)) ? null : Number(v));
      emps[id] = { name: e.name || '', position: e.position || '', MAN: num(e.manual_labor), INT: num(e.intelligence), END: num(e.endurance),
        eff: e.effectiveness && e.effectiveness.total != null ? Number(e.effectiveness.total) : null };
    });
    return emps;
  }
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
    const ranked = s.buyers.filter(b => b.priority).concat(s.buyers.filter(b => !b.priority)); // priority first
    for (const b of ranked) {
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

  const COMPANY_URL = 'https://www.torn.com/companies.php#/option=employees';
  const FOCUS_STATS = [['MAN', 'Manual labour'], ['INT', 'Intelligence'], ['END', 'Endurance']];
  const buyerById = (t, id) => t.buyers.find(x => String(x.id) === String(id));
  // Three toggle buttons; tapping the selected one clears it.
  function focusPicker(current, onPick) {
    return el('div', { class: 'bm-tr-focus' }, FOCUS_STATS.map(([f, full]) =>
      el('button', { class: 'bm-tr-fbtn f-' + f + (current === f ? ' on' : ''), title: full, onclick: ev => { ev.preventDefault(); ev.stopPropagation(); onPick(current === f ? '' : f); } }, f)));
  }
  const focusTag = f => (f ? el('span', { class: 'bm-tr-ftag f-' + f }, f) : null);
  // "MAN 1,234 · INT 5,678 · END 910" from the employee list (after a Check), focus stat highlighted.
  function workStats(t, id, focus) {
    const e = t.employees && t.employees[String(id)];
    if (!e || (e.MAN == null && e.INT == null && e.END == null)) return null;
    return el('div', { class: 'bm-tr-foot bm-tr-ws' }, FOCUS_STATS.map(([f], i) => [i ? ' \u00b7 ' : '',
      el('span', { class: focus === f ? 'f-' + f + ' on' : '' }, f + ' ' + (e[f] == null ? '-' : Number(e[f]).toLocaleString('en-GB')))]),
      e.position ? ' (' + e.position + ')' : '');
  }
  // Each open Torn page holds its own copy in memory; reload the saved one before changing anything,
  // so an older page can never write its stale copy over newer changes.
  function syncTrains() {
    return IDB.get(TRAINS_KEY).then(t => { if (t) trainsMem = t; }).catch(() => {});
  }
  // Read-modify-write on the freshest saved copy.
  function updateTrains(mut) {
    return trainsReady.then(syncTrains).then(() => { const t = readTrains(); const r = mut(t); writeTrains(t); return r; });
  }
  async function togglePriority(id) {
    const b = await updateTrains(t => {
      const x = t.buyers.find(y => String(y.id) === String(id)); if (x) x.priority = !x.priority;
      return x ? Object.assign({ names: t.names }, x) : null;
    });
    if (!b) return;
    toast((b.priority ? 'Priority on: ' : 'Priority off: ') + (b.name || b.names[b.id] || b.id), b.priority ? '\u2b50' : '\u2606');
    renderCompany(true);
    if (VIEW === 'trains' && isMenuOpen()) rebuildContent();
  }

  let trainsPolling = false;
  // Only called from the Check button (manual): fetches company news and trains left - 2 calls.
  async function pollTrains(force) {
    if (!force) return;
    await trainsReady; await storeReady;
    if (trainsPolling) return;
    await syncTrains();
    const s = readTrains();
    if (!s.buyers.length && !force) return; // nothing to track yet
    const { key } = getCompanyKey(); if (!key) return;
    const now = Date.now();
    if (!force) {
      if (document.hidden) return;
      if (s.error && s.error.fatal) return;
      if (now - s.lastPoll < TRAINS_POLL_MS) return;
    } else if (now - s.lastPoll < 10000) return;
    trainsPolling = true;
    await updateTrains(t => { t.lastPoll = now; });
    try {
      const nj = await apiGet('/company/?selections=news,employees,profile', key); // one call: train log, employees, company name
      const news = parseTrainNews(nj);
      const prof = parseCompanyProfile(nj);
      const emps = parseCompanyEmployees(nj);
      let detail = null, posReq = null;
      const ctype = (prof && prof.type) || s.companyType;
      if (ctype && (!s.posReq || s.companyType !== ctype || now - s.posReqAt > 30 * 86400000)) {
        try { posReq = parsePositionReqs(await apiGet('/torn/' + ctype + '?selections=companies', key), ctype); } catch (e) { posReq = null; }
      }
      if (force || now - s.lastDetailed >= DETAILED_POLL_MS) {
        try {
          const left = trainsLeftFrom(await apiGet('/company/?selections=detailed', key));
          detail = { left, err: left == null ? 'No trains figure in the company data' : null };
        } catch (e) {
          detail = { left: s.trainsLeft, err: (e.code != null ? 'Error ' + e.code + ': ' : '') + (e.message || 'failed') + (e.code === 16 || e.code === 7 ? ' (the key needs company access as director)' : '') };
        }
      }
      // Merge only what this check learned into the latest saved copy (buyers are never touched here).
      await updateTrains(t => {
        const known = new Set(t.events.map(e => e.id));
        news.forEach(e => { t.names[e.uid] = e.name; if (!known.has(e.id)) { t.events.push(e); known.add(e.id); } });
        if (prof && (prof.name || prof.id)) t.company = { name: prof.name, id: prof.id };
        if (prof && prof.type) t.companyType = prof.type;
        if (posReq) { t.posReq = posReq; t.posReqAt = now; }
        const staff = emps || (prof && Object.keys(prof.employees).length ? prof.employees : null);
        if (staff) {
          t.employees = staff;
          Object.keys(staff).forEach(id => { if (staff[id].name) t.names[id] = staff[id].name; });
        }
        t.events.sort((a, b) => b.ts - a.ts); t.events = t.events.slice(0, TRAIN_EVENTS_MAX);
        t.error = null;
        if (detail) { t.lastDetailed = now; t.trainsLeft = detail.left; t.trainsLeftAt = now; t.detailedError = detail.err; }
      });
    } catch (e) {
      await updateTrains(t => { t.error = { code: e.code == null ? null : e.code, msg: e.message || 'Network error', fatal: FATAL_CODES.indexOf(e.code) !== -1 || e.code === 7, at: Date.now() }; });
    } finally {
      trainsPolling = false;
      renderCompany();
      if (VIEW === 'trains' && isMenuOpen()) rebuildContent();
    }
  }

  function buildTrains(container) {
    if (!buildTrains._loaded) { buildTrains._loaded = true; trainsReady.then(() => { if (VIEW === 'trains' && isMenuOpen()) rebuildContent(); }); }
    const s = readTrains();
    const ck = getCompanyKey();
    const save = mut => updateTrains(mut).then(() => rebuildContent());
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
          await updateTrains(t => { t.error = null; t.lastPoll = 0; });
          await pollTrains(true); rebuildContent();
        } }, '↻ Check')),
      el('div', { class: 'bm-tr-order' },
        order.length
          ? order.map(o => el('div', { class: 'bm-tr-orow' },
              el('span', { class: 'bm-tr-slot' }, o.from === o.to ? '#' + o.from : '#' + o.from + '–' + o.to),
              el('a', { class: 'bm-tr-who', href: profile(o.b.id), target: '_blank', rel: 'noopener' }, (o.b.priority ? '\u2b50 ' : '') + nameOf(o.b)),
              focusTag(o.b.focus),
              el('span', { class: 'bm-tr-n' }, o.n + (o.n === 1 ? ' train' : ' trains'))))
          : el('div', { class: 'bm-status', style: { textAlign: 'left' } }, s.buyers.length ? 'Nobody has trains left to give.' : 'Add a buyer below to start.')),
      el('div', { class: 'bm-tr-hfoot' },
        el('div', { class: 'bm-status', style: { textAlign: 'left' } }, ck.key
          ? 'Checked ' + (s.lastPoll ? timeAgo(s.lastPoll) : 'never') + ' \u00b7 ' + ck.source
          : 'No API key yet - add one in \u2699\ufe0f Settings'),
        el('a', { class: 'bm-tr-link', href: COMPANY_URL }, '\ud83c\udfe2 Company page \u2197')));
    container.appendChild(hero);

    if (s.error) container.appendChild(el('div', { class: 'bm-error' }, '❌ ' + (s.error.code != null ? 'Error ' + s.error.code + ': ' : '') + s.error.msg,
      s.error.code === 7 || s.error.code === 16 ? ' - company news needs a key with company access.' : null));
    if (s.detailedError) container.appendChild(el('div', { class: 'bm-status', style: { textAlign: 'left' } }, '⚠️ Trains left unavailable: ' + s.detailedError));

    // --- Buyers
    container.appendChild(el('div', { class: 'bm-tr-title' }, 'Buyers'));
    if (!s.buyers.length) container.appendChild(el('div', { class: 'bm-status', style: { textAlign: 'left' } }, 'No buyers yet.'));
    s.buyers.forEach(b => {
      const st = buyerStats(b, s.events);
      const pct = st.purchased ? Math.min(100, Math.round(st.trained / st.purchased * 100)) : 0;
      const box = (cap, num, cls, onclick, title) => el('div', { class: 'bm-tr-box' + (cls ? ' ' + cls : ''), onclick, title },
        el('div', { class: 'bm-tr-num' }, String(num)), el('div', { class: 'bm-tr-cap' }, cap));
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' + (st.complete ? ' complete' : '') },
        el('div', { class: 'bm-tr-bhead' },
          el('button', { class: 'bm-tr-star' + (b.priority ? ' on' : ''), title: b.priority ? 'Priority - trained first (tap to turn off)' : 'Tap to train this buyer first',
            onclick: () => togglePriority(b.id) }, b.priority ? '\u2b50' : '\u2606'),
          el('a', { class: 'bm-tr-who', href: profile(b.id), target: '_blank', rel: 'noopener' }, nameOf(b)),
          el('span', { class: 'bm-uid' }, '[' + b.id + ']'),
          st.complete ? el('span', { class: 'bm-badge done', style: { marginLeft: 'auto' } }, 'complete') : null,
          el('button', { class: 'bm-tr-x', title: 'Remove buyer', style: st.complete ? null : { marginLeft: 'auto' },
            onclick: () => { if (confirm('Remove ' + nameOf(b) + '?')) save(t => { t.buyers = t.buyers.filter(x => String(x.id) !== String(b.id)); }); } }, '✕')),
        el('div', { class: 'bm-tr-frow' }, el('span', { class: 'bm-tr-lbl' }, 'Focus'),
          focusPicker(b.focus || '', f => save(t => { const x = buyerById(t, b.id); if (x) x.focus = f; }))),
        workStats(s, b.id, b.focus),
        el('div', { class: 'bm-tr-stats' },
          box('Purchased', st.purchased, '', () => {
            const v = prompt('Trains purchased by ' + nameOf(b) + ':', String(st.purchased));
            const n = parseInt(v, 10); if (v == null || isNaN(n) || n < 0) return;
            save(t => { const x = buyerById(t, b.id); if (x) x.purchased = n; });
          }, 'Tap to change'),
          box('Trained', st.trained, 'auto', () => {
            const v = prompt('Detected ' + (st.trained - (parseInt(b.adjust, 10) || 0)) + ' trains for ' + nameOf(b) + ' from your company log.\nCorrect the total trained to:', String(st.trained));
            const n = parseInt(v, 10); if (v == null || isNaN(n) || n < 0) return;
            save(t => { const x = buyerById(t, b.id); if (x) x.adjust = (parseInt(x.adjust, 10) || 0) + (n - st.trained); });
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
    let newFocus = '';
    const focusSlot = el('div', { class: 'bm-tr-frow' });
    const drawFocus = () => { focusSlot.innerHTML = ''; focusSlot.appendChild(el('span', { class: 'bm-tr-lbl' }, 'Focus')); focusSlot.appendChild(focusPicker(newFocus, f => { newFocus = f; drawFocus(); })); };
    drawFocus();
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
        purIn, focusSlot, hint,
        el('button', { class: 'refresh-btn', onclick: () => {
          const id = idIn.value.trim(), pur = parseInt(purIn.value, 10);
          if (!/^\d+$/.test(id)) { alert('Enter the buyer\u2019s Torn user ID.'); return; }
          if (!(pur > 0)) { alert('Enter how many trains they purchased.'); return; }
          if (s.buyers.some(b => String(b.id) === id)) { alert('That buyer is already in the list.'); return; }
          save(t => t.buyers.push({ id, name: nameIn.value.trim() || s.names[id] || '', purchased: pur, adjust: 0, focus: newFocus, addedAt: Date.now() }));
          toast('Buyer added - tap Check to count their trains');
        } }, 'Add buyer'))));

    // --- Positions now live on the Employees page
    const recN = recommendPositions(s);
    if (recN.length) {
      const moves = recN.filter(o => !o.ok).length;
      container.appendChild(el('a', { class: 'bm-section bm-tr-card bm-tr-add', href: COMPANY_URL, style: { textDecoration: 'none' } },
        '👷 Positions \u00b7 ' + (moves ? moves + ' change' + (moves === 1 ? '' : 's') + ' needed' : 'all in place \u2713') + ' \u2192 tags on Employees page'));
    }

    // --- Your company (used to spot colleagues on their profile pages - no API)
    const coName = el('input', { class: 'bm-input', type: 'text', placeholder: 'Company name', value: (s.company && s.company.name) || '' });
    const coId = el('input', { class: 'bm-input', type: 'number', placeholder: 'ID (optional)', value: (s.company && s.company.id) || '', style: { width: '40%' } });
    container.appendChild(el('details', { class: 'bm-section bm-tr-card' },
      el('summary', { class: 'bm-tr-add' }, '🏢 Your company' + (s.company && s.company.name ? ': ' + s.company.name : '')),
      el('div', { class: 'bm-tr-form' },
        el('div', { class: 'bm-tr-foot' }, 'Used to show trains on colleagues\' profiles. Filled in automatically when you tap Check' + (Object.keys(s.employees || {}).length ? ' (' + Object.keys(s.employees).length + ' employees known)' : '') + '.'),
        el('div', { class: 'bm-tr-row' }, coName, coId),
        el('button', { class: 'refresh-btn', onclick: () => {
          const name = coName.value.trim(), id = coId.value.trim();
          save(t => { t.company = name || id ? { name, id } : null; });
          toast(name || id ? 'Company saved' : 'Company cleared');
        } }, 'Save'))));
  }

  /* ---------------- CRIMES / HOF OFFENCES ----------------
     Only on Refresh (2 calls): user -> hof,criminalrecord and v2 torn/hof at the target position.
     Each refresh is saved as a snapshot; paces and the ETA come from how the numbers moved between snapshots. */
  const CRIMES_KEY = 'bm-crimes-v1', CRIME_SNAPS_MAX = 1500;
  const CRIME_CATS = [['vandalism', 'Vandalism'], ['theft', 'Theft'], ['counterfeiting', 'Counterfeiting'], ['fraud', 'Fraud'],
    ['illicitservices', 'Illicit services'], ['cybercrime', 'Cybercrime'], ['extortion', 'Extortion'], ['illegalproduction', 'Illegal production']];
  let crimesMem = {};
  const crimesReady = IDB.get(CRIMES_KEY).then(c => { crimesMem = Object.assign({}, c || {}, crimesMem); }).catch(() => {});
  function readCrimes() {
    const s = JSON.parse(JSON.stringify(crimesMem || {}));
    return { snaps: Array.isArray(s.snaps) ? s.snaps : [], preds: Array.isArray(s.preds) ? s.preds : [], target: parseInt(s.target, 10) || 250, error: s.error || null, lastRefresh: s.lastRefresh || 0 };
  }
  function writeCrimes(s) { crimesMem = JSON.parse(JSON.stringify(s)); persist(CRIMES_KEY, crimesMem); }
  const fmtN = n => (n == null || isNaN(n) ? '-' : Math.round(n).toLocaleString('en-GB'));

  // Pick a snapshot to measure from: the oldest within the last 7 days that is at least 6h older than the latest,
  // otherwise the oldest one at least 1h older. Returns null until there is enough history.
  function crimeBaseline(snaps, latest, pick) {
    const ok = x => pick(x) != null;
    const older = snaps.filter(x => ok(x) && latest.t - x.t >= 3600000);
    if (!older.length) return null;
    const week = older.filter(x => latest.t - x.t <= 7 * 86400000 && latest.t - x.t >= 6 * 3600000);
    return (week.length ? week : older).reduce((a, b) => (b.t < a.t ? b : a));
  }
  function crimeRates(s) {
    const snaps = s.snaps.slice().sort((a, b) => a.t - b.t);
    const latest = snaps[snaps.length - 1];
    if (!latest) return null;
    const out = { latest, snaps };
    const mine = crimeBaseline(snaps, latest, x => x.total);
    if (mine) out.myPace = (latest.total - mine.total) / ((latest.t - mine.t) / 86400000), out.paceFrom = mine.t;
    // only compare target values measured at the same position
    const tgt = crimeBaseline(snaps.filter(x => x.tgtPos === latest.tgtPos), latest, x => x.tgtValue);
    if (tgt && latest.tgtValue != null) out.tgtPace = (latest.tgtValue - tgt.tgtValue) / ((latest.t - tgt.t) / 86400000);
    out.gap = latest.tgtValue != null ? latest.tgtValue - latest.total : null;
    out.reached = latest.rank != null && latest.rank <= latest.tgtPos;
    if (out.gap != null && out.myPace != null && out.tgtPace != null) {
      out.closing = out.myPace - out.tgtPace;
      out.etaDays = out.gap <= 0 ? 0 : (out.closing > 0 ? out.gap / out.closing : null);
    }
    if (out.gap != null) {
      const tp = out.tgtPace != null ? out.tgtPace : 0;
      out.need = [30, 60, 90].map(d => ({ d, perDay: Math.max(0, (out.gap + tp * d) / d) }));
    }
    // rank / category movement: since local midnight, and over ~7 days
    const mid = new Date(); mid.setHours(0, 0, 0, 0);
    const beforeToday = snaps.filter(x => x.t < mid.getTime());
    out.dayRef = beforeToday.length ? beforeToday[beforeToday.length - 1] : null;
    const weekOld = snaps.filter(x => latest.t - x.t <= 7 * 86400000 && x !== latest);
    out.weekRef = weekOld.length ? weekOld[0] : null;
    // Provisional: your pace is known but rank 250's isn't yet - assume they stand still.
    if (out.etaDays == null && out.myPace > 0 && out.tgtPace == null && out.gap > 0) out.provDays = out.gap / out.myPace;
    return out;
  }
  // The prediction to show: { days, at (timestamp), provisional } or null.
  function crimePrediction(r) {
    if (!r || r.reached || (r.gap != null && r.gap <= 0)) return null;
    const days = r.etaDays != null ? r.etaDays : r.provDays;
    if (days == null) return null;
    return { days, at: r.latest.t + days * 86400000, provisional: r.etaDays == null };
  }
  // Offences per calendar day (local time) from snapshots: last snapshot of each day minus the day before.
  function dailyOffences(snaps, days) {
    const key = t => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
    const lastOf = {};
    snaps.slice().sort((a, b) => a.t - b.t).forEach(x => { if (x.total != null) lastOf[key(x.t)] = x; });
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
      const prev = new Date(d); prev.setDate(prev.getDate() - 1);
      const a = lastOf[key(prev.getTime())], b = lastOf[key(d.getTime())];
      out.push({ date: d, n: a && b ? b.total - a.total : null, today: i === 0 });
    }
    return out;
  }

  let crimesBusy = false;
  function syncCrimes() { return IDB.get(CRIMES_KEY).then(c => { if (c) crimesMem = c; }).catch(() => {}); }
  async function refreshCrimes() {
    await crimesReady; await storeReady; await syncCrimes();
    if (crimesBusy) return;
    const s = readCrimes();
    if (Date.now() - s.lastRefresh < 30000) { toast('Refreshed under 30s ago', '⏳'); return; }
    const { key } = getKey(); if (!key) { toast('No API key yet', '⚠️'); return; }
    crimesBusy = true; s.lastRefresh = Date.now(); writeCrimes(s);
    try {
      const me = await apiGet('/user/?selections=hof,criminalrecord', key);
      const cr = me.criminalrecord || {}, hof = (me.halloffame || me.hof || {}).offences || {};
      const board = await apiGet('/v2/torn/hof?cat=offences&limit=1&offset=' + Math.max(0, s.target - 1), key);
      const row = (board.hof || [])[0] || {};
      const snap = { t: Date.now(), total: Number(cr.total), rank: hof.rank != null ? Number(hof.rank) : null, hofValue: hof.value != null ? Number(hof.value) : null,
        cats: {}, tgtPos: Number(row.position) || s.target, tgtValue: row.value != null ? Number(row.value) : null, tgtName: row.username || '', tgtId: row.id || null };
      CRIME_CATS.forEach(([k]) => { if (cr[k] != null) snap.cats[k] = Number(cr[k]); });
      if (isNaN(snap.total)) throw new Error('No criminal record total in the response');
      // refreshes within 10 minutes replace each other, so tapping Refresh a lot doesn't skew the history
      const last = s.snaps[s.snaps.length - 1];
      if (last && snap.t - last.t < 600000) s.snaps[s.snaps.length - 1] = snap; else s.snaps.push(snap);
      s.snaps = s.snaps.slice(-CRIME_SNAPS_MAX);
      const pred = crimePrediction(crimeRates(s));
      if (pred) {
        const lp = s.preds[s.preds.length - 1];
        const entry = { t: snap.t, at: pred.at, prov: pred.provisional };
        if (lp && snap.t - lp.t < 600000) s.preds[s.preds.length - 1] = entry; else s.preds.push(entry);
        s.preds = s.preds.slice(-CRIME_SNAPS_MAX);
      }
      s.error = null; writeCrimes(s);
      toast('Offences updated', '📈');
    } catch (e) {
      s.error = { code: e.code == null ? null : e.code, msg: e.message || 'Network error' };
      writeCrimes(s);
    } finally {
      crimesBusy = false;
      if (VIEW === 'crimes' && isMenuOpen()) rebuildContent();
    }
  }

  // How the predicted date has moved: vs ~a day ago, plus a small chart of the predicted date.
  function predictionTrend(s, pred) {
    const preds = s.preds.filter(p => !p.prov).length >= 2 ? s.preds.filter(p => !p.prov) : s.preds;
    if (!pred || preds.length < 2) return null;
    const now = preds[preds.length - 1];
    const older = preds.filter(p => now.t - p.t >= 20 * 3600000);
    const ref = older.length ? older[older.length - 1] : preds[0];
    const diffDays = Math.round((now.at - ref.at) / 86400000);
    const when = now.t - ref.t >= 20 * 3600000 ? 'yesterday\u2019s estimate' : 'your first estimate';
    const txt = diffDays === 0 ? 'Same date as ' + when : Math.abs(diffDays) + ' day' + (Math.abs(diffDays) === 1 ? '' : 's') + (diffDays < 0 ? ' sooner' : ' later') + ' than ' + when;
    const spark = sparkline(preds.slice(-120).map(p => ({ t: p.t, v: p.at })));
    return el('div', { class: 'bm-cr-trend' },
      el('div', { class: diffDays < 0 ? 'bm-cr-up' : diffDays > 0 ? 'bm-cr-down' : '' }, (diffDays < 0 ? '\u25bc ' : diffDays > 0 ? '\u25b2 ' : '= ') + txt),
      spark ? el('div', { class: 'bm-tr-foot' }, 'Predicted date over time (lower = sooner)') : null, spark);
  }
  function sparkline(points) {
    if (points.length < 2) return null;
    const W = 240, H = 46, xs = points.map(p => p.t), ys = points.map(p => p.v);
    const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    const X = t => (x1 === x0 ? 0 : (t - x0) / (x1 - x0) * (W - 4) + 2), Y = v => (y1 === y0 ? H / 2 : H - 3 - (v - y0) / (y1 - y0) * (H - 6));
    const d = points.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('class', 'bm-cr-spark'); svg.setAttribute('preserveAspectRatio', 'none');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#64E5FF'); path.setAttribute('stroke-width', '2');
    path.setAttribute('vector-effect', 'non-scaling-stroke'); path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function buildCrimes(container) {
    if (!buildCrimes._loaded) { buildCrimes._loaded = true; crimesReady.then(() => { if (VIEW === 'crimes' && isMenuOpen()) rebuildContent(); }); }
    const s = readCrimes();
    const r = crimeRates(s);
    const L = r && r.latest;
    const k = getKey();

    // Header: refresh
    container.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
      el('div', { class: 'bm-status', style: { textAlign: 'left' } }, L ? 'Refreshed ' + timeAgo(L.t) + ' · ' + s.snaps.length + ' snapshot' + (s.snaps.length === 1 ? '' : 's') : 'Not refreshed yet'),
      el('button', { class: 'refresh-btn', disabled: k.key ? null : 'disabled', onclick: async ev => { ev.currentTarget.textContent = '…'; await refreshCrimes(); rebuildContent(); } }, '↻ Refresh')));
    if (s.error) container.appendChild(el('div', { class: 'bm-error' }, '❌ ' + (s.error.code != null ? 'Error ' + s.error.code + ': ' : '') + s.error.msg,
      s.error.code === 16 ? ' - HOF needs a key with Limited access or more.' : null));
    if (!L) {
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-head' }, 'Top ' + s.target + ' offences'),
        el('div', { class: 'bm-sub' }, 'Tap Refresh to take your first snapshot. Refresh again every so often (e.g. once a day) - the ETA needs at least two snapshots an hour or more apart, and gets better with a few days of history.')));
      container.appendChild(crimeSettings(s));
      return;
    }

    // Headline: ETA
    let eta, etaCls = '', etaSub, etaSub2 = null, etaIcon = null;
    const pred = crimePrediction(r);
    const fmtDate = t => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const paceTxt = (r.myPace != null ? 'You ' + fmtN(r.myPace) + '/day' : '') + (r.tgtPace != null ? ' vs rank ' + L.tgtPos + ' ' + fmtN(r.tgtPace) + '/day' : '');
    if (r.reached || (r.gap != null && r.gap <= 0)) { eta = 'You\u2019re in!'; etaIcon = '🎉'; etaCls = 'good'; etaSub = 'Rank #' + fmtN(L.rank) + ' - inside the top ' + L.tgtPos; }
    else if (pred) {
      eta = fmtDate(pred.at); etaIcon = '📅';
      etaSub = 'in ~' + (pred.days < 1 ? '<1' : fmtN(pred.days)) + ' day' + (Math.round(pred.days) === 1 ? '' : 's') + (paceTxt ? ' \u00b7 ' + paceTxt : '');
      if (pred.provisional) { etaCls = 'prov'; etaSub2 = 'Provisional: assumes rank ' + L.tgtPos + ' stands still - refresh again later to measure their pace too.'; }
    } else if (r.closing != null && r.closing <= 0) { eta = 'Not closing'; etaCls = 'bad'; etaSub = 'Rank ' + L.tgtPos + ' is gaining as fast as you or faster' + (paceTxt ? ' (' + paceTxt + ')' : ''); }
    else { eta = 'Need more history'; etaSub = 'Refresh again in an hour or more to measure your pace'; }
    const pct = L.tgtValue ? Math.min(100, Math.round(L.total / L.tgtValue * 100)) : 0;
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-cap' }, 'Top ' + L.tgtPos + ' offences'),
      el('div', { class: 'bm-cr-etarow' }, etaIcon ? el('span', { class: 'bm-cr-ico' }, etaIcon) : null, el('span', { class: 'bm-cr-eta ' + etaCls }, eta)),
      el('div', { class: 'bm-sub' }, etaSub),
      etaSub2 ? el('div', { class: 'bm-tr-foot' }, etaSub2) : null,
      predictionTrend(s, pred),
      el('div', { class: 'bm-tr-bar' }, el('span', { style: { width: pct + '%' } })),
      el('div', { class: 'bm-tr-foot' }, fmtN(L.total) + ' / ' + fmtN(L.tgtValue) + ' (' + pct + '%)')));

    // Numbers
    const rankDelta = ref => (ref && ref.rank != null && L.rank != null ? ref.rank - L.rank : null); // positive = moved up
    const dRank = rankDelta(r.dayRef), wRank = rankDelta(r.weekRef);
    const mv = d => d == null ? '' : d === 0 ? ' (=)' : d > 0 ? ' (▲' + fmtN(d) + ')' : ' (▼' + fmtN(-d) + ')';
    const grid = el('div', { class: 'bm-cr-grid' },
      el('span', null, 'Your rank'), el('span', { class: dRank > 0 ? 'bm-cr-up' : dRank < 0 ? 'bm-cr-down' : '' }, '#' + fmtN(L.rank) + mv(dRank)),
      wRank != null ? [el('span', null, 'Rank change (7d)'), el('span', { class: wRank > 0 ? 'bm-cr-up' : wRank < 0 ? 'bm-cr-down' : '' }, wRank > 0 ? '▲' + fmtN(wRank) : wRank < 0 ? '▼' + fmtN(-wRank) : '=')] : null,
      el('span', null, 'Your offences'), el('span', null, fmtN(L.total)),
      el('span', null, 'Rank ' + L.tgtPos + (L.tgtName ? ' (' + L.tgtName + ')' : '')), el('span', null, fmtN(L.tgtValue)),
      el('span', null, 'Gap'), el('span', null, fmtN(r.gap)),
      el('span', null, 'Your pace'), el('span', null, r.myPace != null ? fmtN(r.myPace) + '/day' : '-'),
      el('span', null, 'Rank ' + L.tgtPos + ' pace'), el('span', null, r.tgtPace != null ? fmtN(r.tgtPace) + '/day' : '-'),
      r.closing != null ? [el('span', null, 'Catching up'), el('span', { class: r.closing > 0 ? 'bm-cr-up' : 'bm-cr-down' }, (r.closing > 0 ? '+' : '') + fmtN(r.closing) + '/day')] : null);
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' }, grid,
      r.paceFrom ? el('div', { class: 'bm-tr-foot' }, 'Pace measured since ' + timeAgo(r.paceFrom)) : null));

    // Needed per day
    if (r.need && !r.reached && r.gap > 0) {
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-cap' }, 'Offences per day needed to make it in'),
        el('div', { class: 'bm-cr-need' }, r.need.map(n => el('div', { class: 'bm-tr-box' + (r.myPace != null && r.myPace >= n.perDay ? ' zero' : '') },
          el('div', { class: 'bm-tr-num' }, fmtN(n.perDay)), el('div', { class: 'bm-tr-cap' }, n.d + ' days')))),
        r.tgtPace == null ? el('div', { class: 'bm-tr-foot' }, 'Assumes rank ' + L.tgtPos + ' stands still until its pace is known') : null));
    }

    // Offences per day (last 7 days)
    const daily = dailyOffences(r.snaps, 7);
    if (daily.some(d => d.n != null) || r.dayRef) {
      const todaySoFar = r.dayRef ? L.total - r.dayRef.total : null;
      if (todaySoFar != null) daily[daily.length - 1].n = todaySoFar;
      const max = Math.max.apply(null, daily.map(d => d.n || 0).concat([1]));
      const known = daily.filter(d => d.n != null && !d.today);
      const avg = known.length ? known.reduce((a, d) => a + d.n, 0) / known.length : null;
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-cap' }, 'Offences per day' + (avg != null ? ' \u00b7 avg ' + fmtN(avg) : '')),
        el('div', { class: 'bm-cr-days' }, daily.map(d => [
          el('span', { class: 'lbl' }, d.today ? 'Today' : d.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })),
          el('span', { class: 'bar' }, el('i', { style: { width: (d.n ? Math.max(3, Math.round(d.n / max * 100)) : 0) + '%' }, class: d.today ? 'today' : '' })),
          el('span', { class: 'num' }, d.n == null ? '-' : fmtN(d.n))])),
        el('div', { class: 'bm-tr-foot' }, 'A day fills in when you refreshed on it and on the day before.')));
    }

    // Gap chart
    const pts = r.snaps.filter(x => x.tgtValue != null && x.tgtPos === L.tgtPos).map(x => ({ t: x.t, v: x.tgtValue - x.total }));
    const spark = sparkline(pts.slice(-200));
    if (spark) container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-cap' }, 'Gap to rank ' + L.tgtPos + ' over time'), spark,
      el('div', { class: 'bm-tr-foot', style: { display: 'flex', justifyContent: 'space-between' } },
        el('span', null, new Date(pts[Math.max(0, pts.length - 200)].t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })),
        el('span', null, 'now: ' + fmtN(pts[pts.length - 1].v)))));

    // Categories
    const diff = (ref, key) => (ref && ref.cats && ref.cats[key] != null && L.cats[key] != null ? L.cats[key] - ref.cats[key] : null);
    const plus = n => n == null ? '-' : n > 0 ? '+' + fmtN(n) : '0';
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-cr-cats' },
        el('span', { class: 'h' }, 'Criminal record'), el('span', { class: 'h n' }, 'Today'), el('span', { class: 'h n' }, '7 days'),
        CRIME_CATS.filter(([key]) => L.cats[key] != null).map(([key, label]) => [
          el('span', null, label + ' ', el('span', { style: { opacity: '.55' } }, fmtN(L.cats[key]))),
          el('span', { class: 'n' + (diff(r.dayRef, key) > 0 ? ' bm-cr-up' : '') }, plus(diff(r.dayRef, key))),
          el('span', { class: 'n' + (diff(r.weekRef, key) > 0 ? ' bm-cr-up' : '') }, plus(diff(r.weekRef, key)))]),
        el('span', { style: { fontWeight: '800' } }, 'Total'),
        el('span', { class: 'n', style: { fontWeight: '800' } }, plus(r.dayRef ? L.total - r.dayRef.total : null)),
        el('span', { class: 'n', style: { fontWeight: '800' } }, plus(r.weekRef ? L.total - r.weekRef.total : null))),
      !r.dayRef ? el('div', { class: 'bm-tr-foot' }, '"Today" fills in once you have a snapshot from before midnight') : null));

    container.appendChild(crimeSettings(s));
  }
  function crimeSettings(s) {
    const tIn = el('input', { class: 'bm-input', type: 'number', min: '1', value: s.target, style: { width: '80px' } });
    return el('details', { class: 'bm-section' },
      el('summary', { style: { cursor: 'pointer', fontWeight: '800', color: '#b9d2ff' } }, '🎯 Target & history'),
      el('div', { class: 'bm-tr-row', style: { alignItems: 'center', marginTop: '6px' } }, 'Target rank', tIn,
        el('button', { class: 'refresh-btn', onclick: () => {
          const v = parseInt(tIn.value, 10); if (!(v >= 1)) return;
          const t = readCrimes(); t.target = v; t.lastRefresh = 0; writeCrimes(t);
          toast('Target set to top ' + v + ' - tap Refresh'); rebuildContent();
        } }, 'Set')),
      el('div', { class: 'bm-tr-foot', style: { marginTop: '4px' } }, 'Uses 2 API calls per Refresh, nothing in between. Snapshots are kept in this browser.'),
      el('button', { class: 'remove-btn', style: { marginTop: '6px' }, onclick: () => {
        if (!confirm('Delete all ' + s.snaps.length + ' offence snapshots?')) return;
        const t = readCrimes(); t.snaps = []; writeCrimes(t); rebuildContent();
      } }, 'Clear history'));
  }

  /* ---------------- HOME ----------------
     Cooldowns, refills and bars from one call (user -> cooldowns,refills,bars), on every page load (max once per 30s) and on Refresh.
     Plus a "today" summary from the other tabs' saved data (no API). */
  const HOME_KEY = 'bm-home-v1';
  const TORN = 'https://www.torn.com/';
  const HOME_LINKS = {
    drug: TORN + 'item.php#drugs-items',
    booster: TORN + 'item.php#boosters-items',
    medical: TORN + 'factions.php?step=your#/tab=armoury&start=0&sub=medical',
    refills: TORN + 'points.php',
    energy: TORN + 'gym.php',
    nerve: TORN + 'loader.php?sid=crimes',
    life: TORN + 'factions.php?step=your#/tab=armoury&start=0&sub=medical',
    hof: TORN + 'halloffame.php#/type=offences'
  };
  // A row that opens a Torn page (same tab), with a small arrow.
  const homeLink = (href, cls, ...kids) => el('a', { class: cls + ' link', href }, kids, el('span', { class: 'bm-home-go' }, '\u203a'));
  let homeMem = {};
  const homeReady = IDB.get(HOME_KEY).then(h => { homeMem = Object.assign({}, h || {}, homeMem); }).catch(() => {});
  function syncHome() { return IDB.get(HOME_KEY).then(h => { if (h) homeMem = h; }).catch(() => {}); }
  const readHome = () => JSON.parse(JSON.stringify(homeMem || {}));
  function writeHome(h) { homeMem = JSON.parse(JSON.stringify(h)); persist(HOME_KEY, homeMem); }
  // Torn's day (and daily refills) resets at 00:00 TCT = UTC.
  const lastTornMidnight = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
  let homeBusy = false;
  // auto = page-load refresh: silent, and skipped if any page refreshed in the last 30s (Torn caches 30s anyway).
  async function refreshHome(auto) {
    await homeReady; await storeReady; await syncHome();
    if (homeBusy) return;
    const h = readHome();
    if (Date.now() - (h.at || 0) < (auto ? 30000 : 15000)) { if (!auto) toast('Refreshed a moment ago', '\u23f3'); return; }
    const { key } = getKey(); if (!key) { if (!auto) toast('No API key yet', '\u26a0\ufe0f'); return; }
    homeBusy = true;
    try {
      const j = await apiGet('/user/?selections=cooldowns,refills,bars', key);
      const at = Date.now();
      const cd = j.cooldowns || {}, rf = j.refills || {};
      const bar = b => b ? { cur: Number(b.current) || 0, max: Number(b.maximum) || 0, full: Number(b.fulltime) || 0 } : null;
      writeHome({ at, error: null,
        cd: { drug: Number(cd.drug) || 0, booster: Number(cd.booster) || 0, medical: Number(cd.medical) || 0 },
        rf: { energy: !!rf.energy_refill_used, nerve: !!rf.nerve_refill_used, token: !!rf.token_refill_used, special: Number(rf.special_refills_available) || 0 },
        bars: { energy: bar(j.energy), nerve: bar(j.nerve), happy: bar(j.happy), life: bar(j.life) } });
    } catch (e) {
      const x = readHome(); x.error = { code: e.code == null ? null : e.code, msg: e.message || 'Network error' }; writeHome(x);
    } finally {
      homeBusy = false;
      if (VIEW === 'home' && isMenuOpen()) rebuildContent();
    }
  }

  function buildHome(container) {
    if (!buildHome._loaded) { buildHome._loaded = true; homeReady.then(() => { if (VIEW === 'home' && isMenuOpen()) rebuildContent(); }); }
    const h = readHome();
    const k = getKey();
    const go = v => () => setView(v);

    container.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
      el('div', { class: 'bm-status', style: { textAlign: 'left' } }, h.at ? 'Updated ' + timeAgo(h.at) : 'Tap Refresh for cooldowns & refills'),
      el('button', { class: 'refresh-btn', disabled: k.key ? null : 'disabled', onclick: async ev => { ev.currentTarget.textContent = '\u2026'; await refreshHome(); rebuildContent(); } }, '\u21bb Refresh')));
    if (h.error) container.appendChild(el('div', { class: 'bm-error' }, '\u274c ' + (h.error.code != null ? 'Error ' + h.error.code + ': ' : '') + h.error.msg));

    if (h.at) {
      // Cooldowns: live countdown to ready
      const cdRow = (label, icon, secs, href) => {
        const end = h.at + secs * 1000, ready = end <= Date.now();
        const row = homeLink(href, 'bm-home-row' + (ready ? ' ready' : ''),
          el('span', { class: 'bm-home-l' }, icon + ' ' + label),
          ready ? el('span', { class: 'bm-home-ok' }, 'Ready \u2713')
                : el('span', { class: 'bm-home-cd' }, el('span', { class: 'bm-cd', 'data-bm-cd': String(end), 'data-bm-zero': 'Ready \u2713' }, fmtCountdown(end - Date.now()))));
        row.setAttribute('data-bm-ready', '1');
        return row;
      };
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-cap' }, 'Cooldowns'),
        cdRow('Drug', '💊', h.cd.drug, HOME_LINKS.drug), cdRow('Booster', '\u26a1', h.cd.booster, HOME_LINKS.booster), cdRow('Medical', '🩹', h.cd.medical, HOME_LINKS.medical)));

      // Refills: reset at Torn midnight, so older data is shown as "reset"
      const stale = h.at < lastTornMidnight();
      const rfRow = (label, icon, used) => homeLink(HOME_LINKS.refills, 'bm-home-row' + (stale || !used ? ' todo' : ''),
        el('span', { class: 'bm-home-l' }, icon + ' ' + label),
        stale ? el('span', { class: 'bm-home-todo' }, 'Reset - refresh') : used ? el('span', { class: 'bm-home-used' }, 'Used \u2713') : el('span', { class: 'bm-home-todo' }, 'Available'));
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-cap' }, 'Refills today' + (h.rf.special ? ' \u00b7 ' + h.rf.special + ' special available' : '')),
        rfRow('Energy refill', '\u26a1', h.rf.energy), rfRow('Nerve refill', '🧠', h.rf.nerve), rfRow('Token refill', '🪙', h.rf.token)));

      // Bars: value as of refresh, live time-to-full
      const barRow = (label, key) => {
        const b = h.bars[key]; if (!b) return null;
        const pct = b.max ? Math.min(100, Math.round(b.cur / b.max * 100)) : 0;
        const end = h.at + b.full * 1000;
        const href = HOME_LINKS[key];
        return el(href ? 'a' : 'div', { class: 'bm-home-bar b-' + key + (href ? ' link' : ''), href: href || null },
          el('div', { class: 'bm-home-row' }, el('span', null, label + ' ', el('b', null, fmtN(b.cur) + ' / ' + fmtN(b.max))),
            b.full > 0 && end > Date.now() ? el('span', { class: 'bm-home-cd' }, 'full in ', el('span', { class: 'bm-cd', 'data-bm-cd': String(end), 'data-bm-zero': 'now' }, fmtCountdown(end - Date.now())))
              : el('span', { class: 'bm-home-ok' }, 'Full')),
          el('div', { class: 'bm-tr-bar' }, el('span', { style: { width: pct + '%' } })));
      };
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-cap' }, 'Bars (as of refresh)'),
        barRow('Energy', 'energy'), barRow('Nerve', 'nerve'), barRow('Happy', 'happy'), barRow('Life', 'life')));
    }

    // Today, from saved data (no API)
    const rows = [];
    let due = 0, over = 0, doneN = 0;
    Object.keys(users).forEach(u => (users[u] || []).forEach(o => {
      if (!o || !o.label) return;
      const li = labelInfo(u, o.id);
      if (li.dueToday) { due++; if (li.done) doneN++; else if (li.overdue) over++; }
    }));
    rows.push(el('div', { class: 'bm-home-row link' + (over ? ' warn' : ''), onclick: go('user') },
      el('span', null, '💬 Stocks due today'), el('b', null, due ? doneN + '/' + due + ' done' + (over ? ' \u00b7 ' + over + ' overdue' : '') : 'none')));
    const unseen = unseenCount();
    rows.push(el('div', { class: 'bm-home-row link' + (unseen ? ' warn' : ''), onclick: go('log') },
      el('span', null, '🔔 New items from buddies'), el('b', null, unseen ? String(unseen) : 'none')));
    const t = readTrains();
    if (t.buyers.length) {
      const ord = trainOrder(t);
      rows.push(el('div', { class: 'bm-home-row link', onclick: go('trains') },
        el('span', null, '🏢 Trains left'), el('b', null, (t.trainsLeft == null ? '?' : t.trainsLeft) + (ord.length ? ' \u00b7 next ' + (ord[0].b.name || t.names[ord[0].b.id] || ord[0].b.id) : ''))));
    }
    const cr = crimeRates(readCrimes());
    const pr = crimePrediction(cr);
    if (cr) rows.push(homeLink(HOME_LINKS.hof, 'bm-home-row',
      el('span', { class: 'bm-home-l' }, '📈 Top ' + cr.latest.tgtPos + ' (HOF)'), el('b', null, cr.reached ? 'reached 🎉' : pr ? new Date(pr.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'need more history')));
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' }, el('div', { class: 'bm-tr-cap' }, 'Today'), rows));
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
            const n = prompt('Rename buddy:', uName); if (!n || !n.trim()) return;
            const nn = n.trim(); if (nn === uName) return;
            if (tmp.users[nn]) { alert('A buddy with that name already exists.'); return; }
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
            el('input', { class: 'bm-input', type: 'text', placeholder: 'Stock (e.g. PRN)', value: code.label || '', oninput: e => { code.label = e.target.value; } }),
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
        list.appendChild(el('button', { class: 'refresh-btn', style: { marginTop: '6px' }, onclick: () => { codes.push({ id: uuid(), label: '', text: '' }); render(); } }, '+ Add New Stock'));
        section.appendChild(list);
        section.appendChild(el('button', { class: 'remove-btn', style: { marginTop: '6px' }, onclick: () => {
          if (confirm(`Delete buddy "${uName}"?`)) { delete tmp.users[uName]; delete tmp.schedules[uName]; delete tmp.usersMeta[uName]; render(); }
        } }, '🗑 Delete Buddy'));
        editor.appendChild(section);
      }

      editor.appendChild(el('div', { style: { display: 'flex', justifyContent: 'center', marginTop: '10px', gap: '8px', flexWrap: 'wrap' } },
        el('button', { class: 'refresh-btn', onclick: () => {
          const n = (prompt('Enter buddy name:') || '').trim();
          if (n && !tmp.users[n]) { tmp.users[n] = []; tmp.schedules[n] = {}; tmp.usersMeta[n] = { userId: '' }; render(); }
        } }, '+ Add New Buddy'),
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
      el('div', { class: 'bm-sub', style: { margin: '4px 0' } }, 'A stock due today turns red from this hour if it isn\'t ticked and that buddy hasn\'t sent you an item today.'),
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
      el('div', { class: 'bm-sub', style: { margin: '4px 0' } }, 'Export copies your buddies, stocks, schedules and settings (saved version - press Save first). Keep it somewhere safe, or paste it into another device.'),
      el('div', { style: { display: 'flex', gap: '6px' } },
        el('button', { class: 'refresh-btn', onclick: exportNow }, '⬆ Export'),
        el('button', { class: 'refresh-btn', onclick: importNow }, '⬇ Import')),
      box);
  }

  /* ---------------- SETTINGS ---------------- */
  function buildSettingsTab(container) {
    const k = getKey();
    const pdaOk = isValidKey(PDA_KEY);
    // API key
    const keyInput = el('input', { class: 'bm-input', type: 'password', placeholder: '16-character API key', value: ownKeyMem || jget(APIKEY_KEY, '') || '' });
    const saveKey = v => {
      if (v && !isValidKey(v)) { alert('That doesn\u2019t look like a 16-character Torn API key.'); return; }
      ownKeyMem = v; jset(APIKEY_KEY, v); persist(APIKEY_KEY, v);
      const s = readLog(); s.error = null; s.pausedUntil = 0; s.lastPoll = 0; writeLog(s);
      updateTrains(t => { t.error = null; });
      toast(v ? 'Key saved' : (pdaOk ? 'Using your Torn PDA key' : 'Key cleared')); rebuildContent(); pollLogs(true);
    };
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '🔑 API key', el('small', null, k.key ? 'using ' + k.source : 'none set')),
      el('div', { class: 'bm-sub' }, pdaOk
        ? 'Your Torn PDA key is used automatically. Only add a key here if you want this script to use a different one.'
        : 'No Torn PDA key found. Paste a key here, or set one for this script in Torn PDA (Set API Key).'),
      keyInput,
      el('div', { style: { display: 'flex', gap: '6px' } },
        el('button', { class: 'refresh-btn', onclick: () => saveKey(keyInput.value.trim()) }, 'Save key'),
        (ownKeyMem || jget(APIKEY_KEY, '')) ? el('button', { class: 'remove-btn', onclick: () => saveKey('') }, pdaOk ? 'Use PDA key' : 'Clear key') : null)));

    // API usage
    const usageBox = el('div', { class: 'bm-section bm-tr-card' }, el('div', { class: 'bm-tr-head' }, '📊 API usage'), el('div', { class: 'bm-status', style: { textAlign: 'left' } }, 'Loading\u2026'));
    container.appendChild(usageBox);
    IDB.get(USAGE_KEY).catch(() => null).then(u => {
      u = u || {};
      const now = Date.now();
      const count = (arr, ms) => (arr || []).filter(t => now - t <= ms).length;
      const feats = ['Home', 'Item log', 'Trains', 'Crimes'];
      const tot = ms => feats.reduce((a, f) => a + count(u[f], ms), 0);
      usageBox.innerHTML = '';
      usageBox.appendChild(el('div', { class: 'bm-tr-head' }, '📊 API usage', el('small', null, 'Torn limit: 100 / min')));
      usageBox.appendChild(el('div', { class: 'bm-cr-cats bm-usage' },
        el('span', { class: 'h' }, 'Feature'), el('span', { class: 'h n' }, 'Min'), el('span', { class: 'h n' }, 'Hour'), el('span', { class: 'h n' }, '24h'),
        feats.map(f => [el('span', null, f), el('span', { class: 'n' }, String(count(u[f], 60000))), el('span', { class: 'n' }, String(count(u[f], 3600000))), el('span', { class: 'n' }, String(count(u[f], 86400000)))]),
        el('span', { style: { fontWeight: '800' } }, 'Total'),
        el('span', { class: 'n', style: { fontWeight: '800' } }, String(tot(60000))),
        el('span', { class: 'n', style: { fontWeight: '800' } }, String(tot(3600000))),
        el('span', { class: 'n', style: { fontWeight: '800' } }, String(tot(86400000)))));
      usageBox.appendChild(el('div', { class: 'bm-tr-foot' }, 'Automatic: Home on page load (max every 30s), Item log about once a minute. Trains and Crimes only when you tap Check / Refresh. Counted on this device only.'));
    });

    // Terms
    container.appendChild(el('details', { class: 'bm-section' },
      el('summary', { style: { cursor: 'pointer', fontWeight: '800', color: '#b9d2ff' } }, '📜 API terms (Torn ToS)'),
      el('table', { class: 'bm-tos' },
        el('tr', null, el('td', null, 'Data storage'), el('td', null, 'Only locally (this browser)')),
        el('tr', null, el('td', null, 'Data sharing'), el('td', null, 'Nobody')),
        el('tr', null, el('td', null, 'Purpose of use'), el('td', null, 'Personal: buddy stock items received, company trains, crimes progress, cooldowns and bars')),
        el('tr', null, el('td', null, 'Key storage & sharing'), el('td', null, 'Stored locally / Not shared. Only sent to api.torn.com')),
        el('tr', null, el('td', null, 'Key access level'), el('td', null, 'Limited (for HOF). Custom: user \u2192 log, hof, criminalrecord, cooldowns, refills, bars; company \u2192 news, employees, profile, detailed; torn \u2192 companies, logtypes, items')))));

    container.appendChild(buildBackup());
    container.appendChild(el('div', { class: 'bm-status' }, 'Buddy Manager v' + SCRIPT_VERSION));
  }

  /* ---------------- menu ---------------- */
  const TITLES = { home: '🏠 Home', user: '💬 Buddies', log: '💬 Buddies', config: '💬 Buddies', trains: '🏢 Company Trains', crimes: '📈 Offences HOF', settings: '⚙️ Settings' };
  const BUDDY_VIEWS = ['user', 'log', 'config'];
  const tabGroup = v => (BUDDY_VIEWS.indexOf(v) !== -1 ? 'user' : v);
  const isMenuOpen = () => { const m = $('#bm-menu'); return !!(m && m.style.display === 'flex'); };

  function rebuildContent() {
    const content = $('#bm-content'); if (!content) return;
    const h = $('#bm-menu h2'); if (h) h.textContent = TITLES[VIEW];
    document.querySelectorAll('#bm-menu .bm-tab').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === tabGroup(VIEW)));
    content.innerHTML = '';
    if (BUDDY_VIEWS.indexOf(VIEW) !== -1) {
      const sub = (v, label) => el('button', { class: 'bm-subtab' + (VIEW === v ? ' active' : ''), 'data-view': v, onclick: () => setView(v) }, label);
      content.appendChild(el('div', { class: 'bm-subtabs' }, sub('user', 'Buddy'), sub('log', '📜 Log'), sub('config', '✏️ Edit')));
    }
    if (VIEW === 'config') buildConfig(content);
    else if (VIEW === 'settings') buildSettingsTab(content);
    else if (VIEW === 'log') buildLog(content);
    else if (VIEW === 'trains') buildTrains(content);
    else if (VIEW === 'crimes') buildCrimes(content);
    else if (VIEW === 'home') buildHome(content);
    else buildBuddy(content);
    refreshIndicators();
  }
  function setView(v) { VIEW = v; if (v !== 'log') LOG_FILTER = null; if (!isMenuOpen()) buildMenu(); else rebuildContent(); }

  // Pull the latest saved data (another open page may have changed it) and redraw.
  function syncAll() {
    return Promise.all([IDB.get(STORAGE_KEY), IDB.get(DONE_KEY), IDB.get(ITEMLOG_KEY), syncTrains(), syncCrimes(), syncHome()])
      .then(([cfg, dn, log]) => {
        if (cfg && cfg.users) { users = cfg.users; schedules = cfg.schedules || {}; usersMeta = cfg.usersMeta || {}; prefs = Object.assign({ overdueHour: 18, onlyToday: false }, cfg.prefs || {}); }
        if (dn && typeof dn === 'object') done = dn;
        if (log && (log.lastPoll || 0) >= (logMem.lastPoll || 0)) logMem = log;
      }).catch(() => {});
  }
  function buildMenu() {
    const old = $('#bm-menu'); if (old) old.remove();
    // Redraw once the freshest saved data is loaded (skipped while editing Config, so typing isn't lost).
    storeReady.then(syncAll).then(() => { if (isMenuOpen() && VIEW !== 'config') rebuildContent(); renderProfile(true); renderCompany(true); });
    const tab = (v, label, title) => el('button', { class: 'bm-tab', 'data-view': v, title, onclick: () => setView(v) }, label);
    const menu = el('div', { id: 'bm-menu', style: { display: 'flex' } },
      el('h2', null, TITLES[VIEW]),
      el('div', { class: 'bm-tabs' }, tab('home', '🏠', 'Home'), tab('user', '💬 Buddies', 'Buddies: buddy list, item log, edit'), tab('trains', '🏢 Trains', 'Company trains'), tab('crimes', '📈 Crimes', 'Crimes and HOF'), tab('settings', '⚙️', 'Settings: API key, usage, backup')),
      el('div', { id: 'bm-content' }));
    document.body.appendChild(menu);
    rebuildContent();
  }
  function toggleMenu() {
    const m = $('#bm-menu');
    if (m && m.style.display === 'flex') m.style.display = 'none';
    else { VIEW = 'home'; LOG_FILTER = null; buildMenu(); } // the BM button always opens on Home
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
          title: l.text ? 'Tap to copy: ' + l.text : 'No amount set for this stock (add one in ✏️ Edit)',
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
      rows.length ? rows : el('div', { class: 'bm-pp-sub' }, 'No stocks yet - add some in ✏️ Edit.'),
      el('div', { class: 'bm-pp-sub' }, latest
        ? '🔔 Last item: ' + describeItems(latest.items) + ' · ' + timeAgo(latest.ts * 1000)
        : '🔔 No items detected from ' + u + ' in your logs yet.'),
      el('div', { style: { display: 'flex', gap: '6px' } },
        el('button', { class: 'refresh-btn', onclick: () => { LOG_FILTER = u; setView('log'); } }, '📜 Log'),
        el('button', { class: 'refresh-btn', onclick: () => setView('config') }, '✏️ Edit')));
  }
  function addAsBuddy(xid, h) {
    if (buddyByUserId(xid)) return;
    const name = (prompt('Add as buddy with this name:', profileName(h) || ('User ' + xid)) || '').trim();
    if (!name) return;
    if (users[name]) { alert('You already have a buddy called "' + name + '". Pick another name.'); return; }
    users[name] = []; schedules[name] = {}; usersMeta[name] = { userId: xid };
    saveConfig().then(ok => toast(ok ? 'Added ' + name + ' - add their stocks' : 'Added, but could not save'));
    renderProfile(true);
    VIEW = 'config'; buildMenu();
  }
  function renderProfile(force) {
    const xid = profileXid(); if (!xid) return;
    const h = profileTitleEl(); if (!h) return;
    renderBuddyProfile(h, xid, force);
    renderTrainsProfile(h, xid, force);
  }
  function renderBuddyProfile(h, xid, force) {
    const u = buddyByUserId(xid);
    let badge = document.getElementById('bm-prof-badge');
    if (badge && badge.parentNode !== h) { badge.remove(); badge = null; }
    // Rebuild only when something visible changed (countdown text is updated by the ticker).
    const mine = u ? buddyEntries(readLog().entries, u) : [];
    const sig = JSON.stringify([xid, u, profPanelOpen, u ? buddyLabels(u) : null, mine.length, mine[0] && mine[0].id, todayStrLocal(), new Date().getHours(), Object.keys(itemNames).length]);
    if (badge && !force && sig === profSig && (!profPanelOpen || document.getElementById('bm-prof-panel'))) return;
    profSig = sig;
    if (!badge) { badge = el('span', { id: 'bm-prof-badge', role: 'button', tabindex: '0' }); h.insertBefore(badge, document.getElementById('bm-prof-tbadge')); }
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
  /* ---- company trains on a colleague's profile (no API: matches the job link on their profile) ---- */
  let tPanelOpen = false, tSig = '';
  // Company links on the profile (their job), ignoring our own UI and Torn's menus.
  function profileCompanies() {
    const out = [];
    document.querySelectorAll('a[href*="corpinfo"], a[href*="joblist.php"], a[href*="companies.php?ID"], a[href*="companies.php?step=profile"]').forEach(a => {
      if (a.closest('#bm-menu,#bm-prof-panel,#bm-prof-tpanel,nav,header,[class*="sidebar"]')) return;
      const m = /[?&#]ID=(\d+)/i.exec(a.getAttribute('href') || '');
      const name = (a.textContent || '').trim();
      if (m || name) out.push({ id: m ? m[1] : '', name });
    });
    return out;
  }
  const norm = x => String(x || '').trim().toLowerCase();
  // Fallback: your company name appears in the profile's text (ignoring our own menu).
  function profileMentionsCompany(company) {
    const name = company && norm(company.name);
    if (!name || name.length < 3) return false;
    let txt = norm(document.body ? document.body.innerText : '');
    const menu = document.getElementById('bm-menu');
    if (menu && menu.innerText) txt = txt.split(norm(menu.innerText)).join(' ');
    return txt.indexOf(name) !== -1;
  }
  function isMyCompany(company, links) {
    if (!company || (!company.name && !company.id)) return false;
    return links.some(l => (company.id && l.id && String(company.id) === l.id) || (company.name && l.name && norm(company.name) === norm(l.name)));
  }
  function buildTrainsProfilePanel(t, xid, h) {
    const b = buyerById(t, xid);
    const nm = (b && b.name) || profileName(h) || t.names[xid] || ('User ' + xid);
    const order = trainOrder(t);
    const head = el('div', { class: 'bm-pp-head' }, '🏢 Company trains · ' + nm + ' [' + xid + ']');
    const foot = el('div', { class: 'bm-pp-sub' }, 'Trains left today: ' + (t.trainsLeft == null ? '? (tap Check in the Trains tab)' : t.trainsLeft) +
      (order.length ? ' · next: ' + ((order[0].b.name || t.names[order[0].b.id]) || order[0].b.id) : ''));
    const openTab = el('button', { class: 'refresh-btn', onclick: () => setView('trains') }, '🏢 Trains tab');
    if (!b) {
      // Not a buyer yet: add trains + focus here
      const purIn = el('input', { class: 'bm-input', type: 'number', min: '1', placeholder: 'Trains purchased', style: { flex: '1' } });
      let f = '';
      const fSlot = el('div', null);
      const drawF = () => { fSlot.innerHTML = ''; fSlot.appendChild(focusPicker(f, v => { f = v; drawF(); })); };
      drawF();
      const found = t.events.filter(e => e.uid === xid).length;
      return el('div', { id: 'bm-prof-tpanel' }, head,
        el('div', { class: 'bm-pp-sub' }, 'Not buying trains yet.' + (found ? ' ' + found + ' train' + (found === 1 ? '' : 's') + ' already in your company log.' : '')),
        el('div', { class: 'bm-tr-row' }, purIn),
        el('div', { class: 'bm-tr-frow' }, el('span', { class: 'bm-tr-lbl' }, 'Focus'), fSlot),
        workStats(t, xid, ''),
        el('div', { style: { display: 'flex', gap: '6px' } },
          el('button', { class: 'refresh-btn', onclick: () => {
            const pur = parseInt(purIn.value, 10);
            if (!(pur > 0)) { alert('Enter how many trains they purchased.'); return; }
            updateTrains(x => { if (!buyerById(x, xid)) x.buyers.push({ id: xid, name: profileName(h) || x.names[xid] || '', purchased: pur, adjust: 0, focus: f, addedAt: Date.now() }); })
              .then(() => { toast('Added ' + nm + ' - tap Check to count trains'); renderProfile(true); renderCompany(true); });
          } }, '+ Add trains'), openTab),
        foot);
    }
    const st = buyerStats(b, t.events);
    const pct = st.purchased ? Math.min(100, Math.round(st.trained / st.purchased * 100)) : 0;
    const o = order.find(x => String(x.b.id) === xid);
    const box = (cap, num, cls, onclick, title) => el('div', { class: 'bm-tr-box' + (cls ? ' ' + cls : ''), onclick, title },
      el('div', { class: 'bm-tr-num' }, String(num)), el('div', { class: 'bm-tr-cap' }, cap));
    const change = mut => updateTrains(x => { const y = buyerById(x, xid); if (y) mut(y); }).then(() => { renderProfile(true); renderCompany(true); });
    return el('div', { id: 'bm-prof-tpanel' }, head,
      el('div', { class: 'bm-tr-stats' },
        box('Purchased', st.purchased, '', () => {
          const v = prompt('Trains purchased by ' + nm + ':', String(st.purchased));
          const n = parseInt(v, 10); if (v == null || isNaN(n) || n < 0) return;
          change(y => { y.purchased = n; });
        }, 'Tap to change'),
        box('Trained', st.trained, 'auto', () => {
          const v = prompt('Correct the total trained for ' + nm + ' to:', String(st.trained));
          const n = parseInt(v, 10); if (v == null || isNaN(n) || n < 0) return;
          change(y => { y.adjust = (parseInt(y.adjust, 10) || 0) + (n - st.trained); });
        }, 'Detected from your company log - tap to correct'),
        box('Left', st.left, st.complete ? 'zero' : 'left')),
      el('div', { class: 'bm-tr-bar' }, el('span', { style: { width: pct + '%' } })),
      el('div', { class: 'bm-tr-frow' }, el('span', { class: 'bm-tr-lbl' }, 'Focus'), focusPicker(b.focus || '', v => change(y => { y.focus = v; }))),
      workStats(t, xid, b.focus),
      el('div', { class: 'bm-pp-sub' }, (o ? 'In today\u2019s order: #' + (o.from === o.to ? o.from : o.from + '–' + o.to) + ' · ' : '') +
        (st.last ? 'Last trained ' + timeAgo(st.last.ts * 1000) : 'No trains detected yet')),
      el('div', { style: { display: 'flex', gap: '6px' } },
        el('button', { class: 'refresh-btn', onclick: () => togglePriority(xid).then(() => renderProfile(true)) }, b.priority ? '⭐ Priority' : '☆ Priority'),
        openTab),
      foot);
  }
  function renderTrainsProfile(h, xid, force) {
    const t = readTrains();
    const b = buyerById(t, xid);
    const links = profileCompanies();
    const inCo = !!b || !!(t.employees && t.employees[xid]) || isMyCompany(t.company, links) || profileMentionsCompany(t.company);
    const hasCo = !!(t.company && (t.company.name || t.company.id));
    const suggest = !inCo && !hasCo && links.find(l => l.name);
    let badge = document.getElementById('bm-prof-tbadge');
    if (badge && badge.parentNode !== h) { badge.remove(); badge = null; }
    const st = b ? buyerStats(b, t.events) : null;
    const sig = JSON.stringify([xid, inCo, suggest && suggest.name, b, st, tPanelOpen, t.trainsLeft, t.company, trainOrder(t).map(o => [o.b.id, o.from])]);
    if (badge && !force && sig === tSig && (!tPanelOpen || document.getElementById('bm-prof-tpanel'))) return;
    tSig = sig;
    const oldP = document.getElementById('bm-prof-tpanel'); if (oldP) oldP.remove();
    if (!inCo && !suggest) { if (badge) badge.remove(); return; }
    if (!badge) { badge = el('span', { id: 'bm-prof-tbadge', role: 'button', tabindex: '0' }); h.appendChild(badge); }
    badge.innerHTML = '';
    if (suggest) {
      badge.className = 'add'; badge.title = 'Is ' + suggest.name + ' your company? Tap to set it';
      badge.appendChild(document.createTextNode('🏢 My company?'));
      badge.onclick = ev => {
        ev.preventDefault(); ev.stopPropagation();
        if (!confirm('Set "' + suggest.name + '" as your company? Its employees will then show company trains on their profiles.')) return;
        updateTrains(x => { x.company = { name: suggest.name, id: suggest.id }; }).then(() => { toast('Company set: ' + suggest.name); renderProfile(true); });
      };
      return;
    }
    if (b) {
      const inOrder = trainOrder(t).some(o => String(o.b.id) === xid);
      badge.className = st.complete ? 'done' : inOrder ? 'today' : '';
      badge.appendChild(document.createTextNode('🏢 ' + (b.priority ? '⭐ ' : '') + (st.complete ? '✓ trains done' : st.left + ' left')));
      if (b.focus) badge.appendChild(focusTag(b.focus));
    } else {
      badge.className = 'add';
      badge.appendChild(document.createTextNode('🏢 + Add trains'));
    }
    badge.title = 'Company trains - tap for details';
    badge.appendChild(el('span', { style: { opacity: '.7', fontSize: '10px' } }, tPanelOpen ? '▲' : '▼'));
    badge.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); tPanelOpen = !tPanelOpen; renderTrainsProfile(h, xid, true); };
    if (tPanelOpen) {
      const box = h.closest('.content-title') || h.parentElement;
      const after = document.getElementById('bm-prof-panel') || box;
      after.insertAdjacentElement('afterend', buildTrainsProfilePanel(t, xid, h));
    }
  }

  if (profileXid()) {
    // Torn builds the profile in pieces and may redraw the title, so keep watching (ignoring our own changes).
    let profQueued = false;
    const isOurs = n => n && n.nodeType === 1 && (/^bm-prof-/.test(n.id || '') || (n.closest && n.closest('#bm-prof-badge,#bm-prof-panel,#bm-prof-tbadge,#bm-prof-tpanel')));
    try {
      new MutationObserver(muts => {
        if (muts.every(m => isOurs(m.target) || Array.from(m.addedNodes).concat(Array.from(m.removedNodes)).every(isOurs) && m.addedNodes.length + m.removedNodes.length > 0)) return;
        if (profQueued) return; profQueued = true;
        requestAnimationFrame(() => { profQueued = false; renderProfile(); });
      }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
    Promise.all([storeReady, trainsReady]).then(() => renderProfile(true));
    setInterval(() => renderProfile(), 30000); // roll over to "due today"/"overdue" as time passes
  }

  /* ---------------- company employees page ----------------
     On companies.php: a trains card above the employee list, and a tag on each buyer's row
     (slot in today's order + trains left). Uses the Trains tab's saved data - no extra API calls. */
  let compSig = '', posOpen = true;
  // Recommended positions, laid out as a table on the Employees page.
  function buildPositionsCard(s) {
    const rec = recommendPositions(s);
    const moves = rec.filter(o => !o.ok).length;
    const head = el('div', { class: 'bm-pos-head', onclick: () => { posOpen = !posOpen; renderCompany(true); } },
      el('span', { class: 'bm-pos-title' }, '👷 Recommended positions'),
      rec.length ? el('span', { class: 'bm-pos-pill' + (moves ? ' warn' : ' good') }, moves ? moves + ' change' + (moves === 1 ? '' : 's') : 'all in place \u2713') : null,
      el('button', { class: 'refresh-btn', onclick: async ev => {
        ev.preventDefault(); ev.stopPropagation(); ev.currentTarget.textContent = '\u2026';
        await updateTrains(t => { t.lastPoll = 0; }); await pollTrains(true); renderCompany(true);
      } }, '\u21bb Check'),
      el('span', { class: 'bm-pos-caret' }, posOpen ? '\u25b2' : '\u25bc'));
    const card = el('div', { id: 'bm-pos-card' }, head);
    if (!posOpen) return card;
    if (!rec.length) {
      card.appendChild(el('div', { class: 'bm-pos-note' }, 'Tap Check to load your employees\u2019 working stats.'));
      return card;
    }
    const table = el('div', { class: 'bm-pos-table' },
      el('div', { class: 'h' }, 'Position'), el('div', { class: 'h' }, 'Employee'), el('div', { class: 'h n' }, 'Stats'), el('div', { class: 'h n' }, 'Score'), el('div', { class: 'h' }, ''),
      rec.map(o => {
        const cls = o.ok ? 'ok' : 'move';
        return [
          el('div', { class: 'c pos ' + cls }, o.pos),
          el('div', { class: 'c who ' + cls }, el('span', { class: 'bm-tr-slot' }, '#' + o.rank),
            el('a', { href: 'https://www.torn.com/profiles.php?XID=' + o.e.id, target: '_blank', rel: 'noopener' }, o.e.name || o.e.id)),
          el('div', { class: 'c n ' + cls, title: 'MAN ' + fmtN(o.e.MAN) + ' \u00b7 INT ' + fmtN(o.e.INT) + ' \u00b7 END ' + fmtN(o.e.END) }, fmtN(workTotal(o.e))),
          el('div', { class: 'c n ' + cls }, el('b', null, o.score == null ? '-' : String(o.score))),
          el('div', { class: 'c st ' + cls, title: o.ok ? 'Already in place' : 'Now: ' + (o.cur || 'unassigned') + (o.curScore != null ? ' (score ' + o.curScore + ')' : '') },
            o.ok ? '\u2713' : el('span', null, '\u2190 ' + (o.cur || 'none') + (o.curScore != null ? ' (' + o.curScore + ')' : '')))];
      }));
    card.appendChild(table);
    card.appendChild(el('div', { class: 'bm-pos-note' }, 'Ranked by total working stats (MAN+INT+END), director excluded. Score = your position formula'
      + (s.posReq ? '' : ' (tap Check once to load position requirements)') + '. Amber rows need moving; the last column shows where they are now.'));
    return card;
  }
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
    const oldPos = document.getElementById('bm-pos-card');
    if (!rows.length) { if (oldCard) oldCard.remove(); if (oldPos) oldPos.remove(); return; }
    const s = readTrains();
    const order = trainOrder(s);
    const sig = JSON.stringify([rows.length, s.buyers, s.events.length, s.trainsLeft, order.map(o => [o.b.id, o.from, o.to]), s.employees, s.posReqAt, posOpen]);
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
              el('span', { class: 'bm-tr-slot' }, slotTxt(o)), el('b', null, (o.b.priority ? '\u2b50 ' : '') + nameOf(o.b)), el('span', null, o.n + (o.n === 1 ? ' train' : ' trains'))))
          : el('div', { class: 'bm-emp-none' }, 'Nobody has trains left to give.')),
      el('div', { class: 'bm-emp-right' },
        el('button', { class: 'refresh-btn', onclick: ev => { ev.preventDefault(); setView('trains'); } }, '\ud83c\udfe2 Tracker'),
        (() => { const rec = recommendPositions(s); if (!rec.length) return null; const m = rec.filter(o => !o.ok).length;
          return el('span', { class: 'bm-emp-posnote' + (m ? ' warn' : '') }, m ? '\ud83d\udc77 ' + m + ' move' + (m === 1 ? '' : 's') : '\ud83d\udc77 \u2713'); })()));
    const list = rows[0].parentElement;
    list.parentElement.insertBefore(card, list);
    if (oldPos) oldPos.remove();

    // Tags on employee rows: suggested position (all employees) + train info (buyers)
    const recBy = {};
    recommendPositions(s).forEach(o => { recBy[String(o.e.id)] = o; });
    rows.forEach(li => {
      li.__bmDone = true;
      Array.from(li.children).forEach(c => { if (c.classList && c.classList.contains('bm-emp-chip')) c.remove(); });
      li.classList.remove('bm-emp-next');
      const id = rowUserId(li);
      const b = s.buyers.find(x => String(x.id) === id);
      const rp = recBy[id];
      if (!b && !rp) return;
      if (getComputedStyle(li).position === 'static') li.style.position = 'relative';
      const parts = [], cls = ['bm-emp-chip'], tips = [];
      if (rp) {
        parts.push(rp.ok
          ? el('span', { class: 'bm-pos-ok' }, '✓ ' + rp.pos)
          : el('span', { class: 'bm-pos-mv' }, '→ ' + rp.pos + (rp.score != null ? ' ' + rp.score : '')));
        tips.push('#' + rp.rank + ' by working stats (' + fmtN(workTotal(rp.e)) + '). Suggested: ' + rp.pos + (rp.score != null ? ' (score ' + rp.score + ')' : '') +
          (rp.ok ? ' - already there.' : '. Now: ' + (rp.cur || 'unassigned') + (rp.curScore != null ? ' (score ' + rp.curScore + ')' : '') + '.'));
        if (!rp.ok) cls.push('mv');
      }
      if (b) {
        const st = buyerStats(b, s.events);
        const o = order.find(x => String(x.b.id) === id);
        if (o) li.classList.add('bm-emp-next');
        cls.push(st.complete ? 'done' : o ? 'next' : '');
        if (b.priority) cls.push('prio');
        if (st.complete) parts.push(el('span', null, '✓ trains done'));
        else {
          parts.push(el('span', null, (b.priority ? '⭐' : '☆') + (o ? ' ' + slotTxt(o) : '')));
          parts.push(el('span', null, st.left + ' left' + (b.focus ? ' · ' + b.focus : '')));
        }
        tips.push(st.trained + ' of ' + st.purchased + ' trains given - tap to ' + (b.priority ? 'remove priority' : 'train first'));
      }
      li.appendChild(el('span', {
          class: cls.filter(Boolean).join(' '), role: b ? 'button' : null, title: tips.join('\n'),
          onclick: b ? (ev => { ev.preventDefault(); ev.stopPropagation(); togglePriority(id); }) : null
        }, parts));
    });
  }
  if (onCompanyPage()) {
    // The employee list loads after the page and is redrawn when switching tabs; ignore our own changes.
    let compQueued = false;
    const ours = n => n && n.nodeType === 1 && (n.id === 'bm-emp-card' || n.id === 'bm-pos-card' || (n.classList && n.classList.contains('bm-emp-chip')) || (n.closest && n.closest('#bm-emp-card,#bm-pos-card,.bm-emp-chip')));
    try {
      new MutationObserver(muts => {
        if (muts.every(m => ours(m.target) || (m.addedNodes.length + m.removedNodes.length > 0 &&
            Array.from(m.addedNodes).concat(Array.from(m.removedNodes)).every(ours)))) return;
        if (compQueued) return; compQueued = true;
        requestAnimationFrame(() => { compQueued = false; renderCompany(); });
      }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
    window.addEventListener('hashchange', () => setTimeout(() => renderCompany(true), 300));
    trainsReady.then(() => renderCompany(true));
  }

  // Live countdowns anywhere (menu + profile badges).
  setInterval(() => {
    document.querySelectorAll('[data-bm-cd]').forEach(n => {
      const ms = Number(n.getAttribute('data-bm-cd')) - Date.now();
      const zero = n.getAttribute('data-bm-zero');
      if (ms <= 0 && zero != null) { if (n.textContent !== zero) { n.textContent = zero; const row = n.closest('[data-bm-ready]'); if (row) row.classList.add('ready'); } }
      else n.textContent = fmtCountdown(ms);
    });
  }, 1000);

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
  homeReady.then(() => setTimeout(() => refreshHome(true), 800)); // Home: cooldowns, refills, bars on every page load (1 call)
  setInterval(() => pollLogs(false), 15000); // trains and crimes only call the API when you tap Check / Refresh
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    storeReady.then(syncAll).then(() => { if (isMenuOpen() && VIEW !== 'config') rebuildContent(); renderProfile(true); renderCompany(true); pollLogs(false); });
  });
})();
