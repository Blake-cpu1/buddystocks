// ==UserScript==
// @name         Buddy Manager
// @namespace    https://github.com/Blake-cpu1/buddystocks
// @version      7.58.1
// @description  Buddy labels with schedules, item-received detection from your Torn logs, overdue warnings, a buddy badge with countdowns on profile pages, a company trains tracker, and an offences HOF progression tab.
// @match        https://www.torn.com/*
// @grant        none
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/Blake-cpu1/buddystocks/main/buddy.user.js
// @updateURL    https://raw.githubusercontent.com/Blake-cpu1/buddystocks/main/buddy.user.js
// ==/UserScript==

/*
 * API usage (Torn API ToS)
 *  - Data storage:     only locally (Torn PDA script storage / this browser's IndexedDB)
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
  const SCRIPT_VERSION = '7.58.1';
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
    '#bm-menu{overflow:hidden}',
    '#bm-menu.bm-kb h2,#bm-menu.bm-kb .bm-tabs{display:none}',
    '#bm-menu.bm-kb{gap:4px}',
    '#bm-content{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;margin:0 calc(var(--pad) * -1);padding:0 var(--pad)}',
    '.bm-sticky{position:sticky;top:0;z-index:3;background:rgb(17,21,30);margin:0 calc(var(--pad) * -1);padding:4px var(--pad) 5px;box-shadow:0 6px 8px -6px rgba(0,0,0,.6)}',
    '.bm-fold-head{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;-webkit-user-select:none}',
    '.bm-fold-head > :first-child{flex:0 1 auto}',
    '.bm-fold{margin-left:auto;flex:0 0 auto;background:none;border:0;color:inherit;opacity:.6;font-size:11px;line-height:1;padding:2px 2px 2px 6px;cursor:pointer}',
    '.bm-fold-sum{flex:1 1 auto;min-width:0;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:9.5px;font-weight:600;text-transform:none;letter-spacing:0;opacity:.95;color:#cfd6e0}',
    '.bm-folded{gap:0}',
    '.bm-foldall-row{display:flex;justify-content:flex-end;margin:2px 0 -2px}',
    '.bm-foldall{background:none;border:0;color:#8fc0ff;font-size:9.5px;font-weight:700;padding:2px 4px;cursor:pointer}',
    '.bm-tr-cap.bm-fold-head{opacity:1;color:rgba(225,229,233,.62)}',
    '.bm-folded > :not(:first-child){display:none!important}',
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
    '.bm-val-chip{margin-left:6px;padding:0 5px;border-radius:999px;background:rgba(76,175,80,.18);color:#9be59f;font-size:9px;font-weight:700}',
    '.bm-val-tots{display:flex;gap:6px;margin:2px 0 4px}',
    '.bm-val-tot{flex:1;text-align:center;background:rgba(255,255,255,.05);border-radius:6px;padding:4px 2px}',
    '.bm-val-tot b{display:block;font-size:12px;color:#9be59f}',
    '.bm-val-tot small{font-size:8.5px;opacity:.7}',
    '.bm-log-val{color:#9be59f;font-weight:700}',
    '.bm-val-tot b.neg,.bm-inc .neg{color:#ff8a8a}',
    '.bm-val-tot b.na{color:#cfd6e0}',
    '.bm-inc .pos{color:#9be59f}',
    '.bm-inc{gap:0;padding:6px 6px}',
    '.bm-inc-row{display:grid;grid-template-columns:1.3fr 1fr 1fr .8fr 1fr .4fr;gap:3px;padding:5px 1px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9px;cursor:pointer;align-items:center}',
    '.bm-inc-row > span:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}',
    '.bm-inc-row > span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bm-inc-tot{font-size:8.5px;font-weight:700;row-gap:2px}',
    '.bm-inc-tot > .bm-inc-wk{grid-column:1 / -1;text-align:left!important;font-weight:800;opacity:.85}',
    '.bm-inc-hd > span{overflow:visible}',
    '.bm-inc-row.open{background:rgba(79,159,255,.08)}',
    '.bm-inc-hd{font-size:8px;text-transform:uppercase;letter-spacing:.2px;opacity:.6;cursor:default}',
    '.bm-inc-tot{background:rgba(255,255,255,.07);font-weight:800;border-radius:5px;margin:1px 0 6px;cursor:default}',
    '.bm-inc-more{padding:5px 6px 7px;font-size:9.5px;line-height:1.6;opacity:.9;border-bottom:1px solid rgba(255,255,255,.06);background:rgba(79,159,255,.05)}',
    '.bm-inc-bars{display:flex;align-items:flex-end;gap:2px;height:42px;margin:2px 0}',
    '.bm-nw-spark{margin:2px 0 4px;background:#262626;border:1px solid #1d1d1d;border-radius:4px;padding:3px 4px}',
    '.bm-nw-pct{width:34px;text-align:right;color:#999;font-size:9px;flex:0 0 auto}',
    '.bm-home-row.bm-off{opacity:.45}',
    '.bm-list-row{gap:6px}',
    '.bm-list-name{color:#74c0fc;text-decoration:none;font-weight:700}',
    '.bm-list-name small{color:#999;font-weight:400}',
    '.bm-dot-on{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;background:#666;vertical-align:middle}',
    '.bm-dot-on.online{background:#85b200}', '.bm-dot-on.idle{background:#e8a92c}',
    '.bm-list-st{font-size:10px;font-weight:700;text-align:right;max-width:46%;color:#bbb}',
    '.bm-list-st.ok{color:#85b200}', '.bm-list-st.hosp{color:#f0604d}', '.bm-list-st.jail{color:#e8a92c}', '.bm-list-st.away{color:#74c0fc}',
    '.bm-list-hit{text-decoration:none;font-size:14px;flex:0 0 auto}',
    '.bm-war-vs{display:flex;align-items:center;gap:6px;text-decoration:none;color:#ddd;padding:4px 0}',
    '.bm-war-side{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start}',
    '.bm-war-side.them{align-items:flex-end;text-align:right}',
    '.bm-war-side span{font-size:10px;color:#bbb;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.bm-war-side b{font-size:18px;color:#fff}',
    '.bm-war-mid{color:#999;font-weight:700;font-size:10px}',
    '.bm-war-bar{height:6px;border-radius:3px;background:#232323;overflow:hidden;margin:2px 0}',
    '.bm-war-bar i{display:block;height:100%;background:linear-gradient(90deg,#6b8f00,#a6d61a)}',
    '.bm-war-bar.behind i{background:linear-gradient(90deg,#b33a2a,#f0604d)}',
    '.bm-gym-v{display:flex;flex-direction:column;align-items:flex-end;text-align:right}',
    '.bm-gym-v small{font-size:9px;font-weight:700;color:#bbb}',
    '#bm-nerve{position:fixed;top:calc(env(safe-area-inset-top,0px) + 6px);left:50%;transform:translateX(-50%);z-index:99998;min-width:190px;max-width:calc(100vw - 24px);height:22px;border-radius:11px;background:#2a2a2a;border:1px solid #1d1d1d;box-shadow:0 2px 6px rgba(0,0,0,.5);overflow:hidden;cursor:pointer;font:700 11px/22px Arial,Helvetica,sans-serif;color:#fff;text-align:center;white-space:nowrap}',
    '#bm-nerve .bm-nerve-fill{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#8f2d24,#d1473a);transition:width .4s}',
    '#bm-nerve.full .bm-nerve-fill{background:linear-gradient(90deg,#b3381f,#ff6a4d)}',
    '.bm-pillbar{position:fixed;top:calc(env(safe-area-inset-top,0px) + 6px);left:50%;transform:translateX(-50%);z-index:99998;height:22px;border-radius:11px;border:1px solid #1d1d1d;box-shadow:0 2px 6px rgba(0,0,0,.5);font:700 11px/22px Arial,Helvetica,sans-serif;color:#fff;white-space:nowrap;padding:0 2px;pointer-events:none}',
    '#bm-abroad{margin:8px 0;padding:6px 10px 8px;background:linear-gradient(180deg,#3b3b3b 0,#333 100%);border:1px solid #222;border-radius:5px;color:#ddd;font:12px/1.4 Arial,Helvetica,sans-serif;box-shadow:0 1px 2px rgba(0,0,0,.45)}',
    '#bm-abroad .bm-ab-h{display:flex;justify-content:space-between;align-items:center;font-weight:700;color:#fff;margin-bottom:3px}',
    '#bm-abroad .bm-ab-h small{color:#bbb;font-weight:700}',
    '#bm-abroad .bm-ab-r{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-top:1px solid #444}',
    '#bm-abroad .bm-ab-r span{color:#ccc}', '#bm-abroad .pos{color:#85b200;white-space:nowrap}', '#bm-abroad .neg{color:#f0604d;white-space:nowrap}',
    '.bm-hard{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:64px;padding:0 6px;border-left:1px solid #222;box-shadow:inset 1px 0 0 #444;font-family:Arial,Helvetica,sans-serif}',
    '.bm-hard-t{font-size:10px;font-weight:700;color:#ddd;text-transform:uppercase}',
    '.bm-hard-v{font-size:12px;font-weight:700;color:#e8a92c}',
    '.bm-jail-badge{position:absolute;top:1px;right:6px;font:700 12px/1 Arial,Helvetica,sans-serif;text-shadow:0 1px 1px rgba(0,0,0,.6);pointer-events:none;z-index:2;background:none;border:0;padding:0}',
    '.bm-jail-badge.green{color:#9fbf3c}', '.bm-jail-badge.amber{color:#e8a92c}', '.bm-jail-badge.red{color:#f0604d}',
    'a.bm-jail-on.green,a.bm-jail-on.green *{color:#91a752!important}', 'a.bm-jail-on.amber,a.bm-jail-on.amber *{color:#e0a43a!important}', 'a.bm-jail-on.red,a.bm-jail-on.red *{color:#e0645a!important}',
    'a.bm-jail-on.green svg,a.bm-jail-on.green svg *{fill:#91a752!important}', 'a.bm-jail-on.amber svg,a.bm-jail-on.amber svg *{fill:#e0a43a!important}', 'a.bm-jail-on.red svg,a.bm-jail-on.red svg *{fill:#e0645a!important}',
    'a.bm-jail-on .bm-jail-badge.green{color:#9fbf3c!important}', 'a.bm-jail-on .bm-jail-badge.amber{color:#e8a92c!important}', 'a.bm-jail-on .bm-jail-badge.red{color:#f0604d!important}',
    '.bm-pillbar.green{background:linear-gradient(90deg,#4f6b00,#6b8f00)}', '.bm-pillbar.amber{background:linear-gradient(90deg,#8a5c10,#b97a14)}', '.bm-pillbar.red{background:linear-gradient(90deg,#8f2d24,#b33a2a)}',
    '.bm-pillbar .bm-nerve-t{padding:0 10px;text-shadow:0 1px 2px rgba(0,0,0,.7)}',
    '#bm-nerve .bm-nerve-t{position:relative;padding:0 10px;text-shadow:0 1px 2px rgba(0,0,0,.7)}',
    '.bm-pf-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}',
    '.bm-pf-row{display:grid;grid-template-columns:1.4fr .45fr 1fr 1fr .85fr;gap:3px;padding:5px 1px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9px;cursor:pointer;align-items:center}',
    '.bm-pf-row > span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bm-pf-row > span:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}',
    '.bm-pf-row.open{background:rgba(79,159,255,.08)}',
    '.bm-pf-row.bm-inc-hd > span{overflow:visible}',
    '.bm-roi{display:inline-block;padding:0 4px;border-radius:4px;font-weight:700;justify-self:end}',
    '.bm-roi.good{background:rgba(76,175,80,.25);color:#9be59f}',
    '.bm-roi.ok{background:rgba(255,179,0,.2);color:#ffd27a}',
    '.bm-roi.bad{background:rgba(229,72,77,.25);color:#ff8a8a}',
    '.bm-roi.na{opacity:.5}',
    '.bm-roi small{display:block;font-size:7.5px;font-weight:600;opacity:.8;line-height:1.1}',
    '.bm-roi{text-align:center;line-height:1.25;padding:1px 4px}',
    '.bm-rk-row{display:grid;grid-template-columns:1.1fr 1fr 1fr .95fr .35fr;gap:3px;padding:5px 1px;border-bottom:1px solid rgba(255,255,255,.06);font-size:9px;cursor:pointer;align-items:center}',
    '.bm-rk-row > span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.bm-rk-row > span:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}',
    '.bm-rk-row.bm-inc-hd > span{overflow:visible}',
    '.bm-rk-row small{display:block;font-size:7.5px;opacity:.7;line-height:1.1}',
    '.bm-rk-row.own{background:rgba(76,175,80,.10)}',
    '.bm-rk-row.next{background:rgba(79,159,255,.16);box-shadow:inset 3px 0 0 #4F9FFF}',
    '.bm-rk-row.open{outline:1px solid rgba(79,159,255,.35)}',
    '.bm-rk-own{color:#9be59f;font-weight:800;text-align:center!important}',
    '.bm-pf-next{font-size:9.5px;padding:4px 6px;border-radius:6px;background:rgba(79,159,255,.12)}',
    '.bm-pf-add{display:flex;flex-direction:column;gap:5px;margin-top:6px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.12)}',
    '.bm-pf-add .bm-pill{flex:0 0 auto;white-space:nowrap;margin:0}',
    '.bm-pill.neg{background:rgba(229,72,77,.25);color:#ff8a8a}',
    '.bm-home-row b.neg,.bm-home-row b.pos{font-weight:800}',
    '.bm-home-row b.neg{color:#ff8a8a}', '.bm-home-row b.pos{color:#9be59f}',
    '.bm-inc-bar{flex:0 1 16px;height:100%;display:flex;align-items:flex-end;cursor:pointer}',
    '.bm-inc-bar i{display:block;width:100%;border-radius:2px 2px 0 0;background:linear-gradient(#9be59f,#4caf50)}',
    '.bm-inc-bar.neg i{background:linear-gradient(#ff8a8a,#c94a4a)}',
    '.bm-inc-bar.mon{border-left:1px dashed rgba(255,255,255,.18);padding-left:1px}',
    '.bm-wk-copy{margin-left:auto;background:rgba(255,255,255,.08);color:inherit;border:1px solid rgba(255,255,255,.15);border-radius:6px;font-size:9px;padding:1px 6px;cursor:pointer}',
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
    '#bm-dock-btn{position:relative;cursor:pointer;flex:0 0 auto;-webkit-tap-highlight-color:transparent}',
    '#bm-dock-btn .bm-tbadge{position:absolute;top:-15px;left:50%;transform:translateX(-50%);min-width:19px;height:19px;padding:0 5px;box-sizing:border-box;border-radius:10px;background:linear-gradient(#72a52e,#5e8d22);border:1px solid #bcd88c;color:#fff;font:700 11px/17px Arial,Helvetica,sans-serif;text-align:center;text-shadow:0 1px 1px rgba(0,0,0,.35);pointer-events:none;z-index:2;white-space:nowrap}',
    '#bm-dock-btn.bm-plain{display:flex;align-items:center;justify-content:center;width:38px;height:38px;padding:0;border:0;border-radius:4px;background:#333}',
    '#bm-dock-btn svg{width:24px;height:24px;display:block;filter:drop-shadow(0 1px 1px rgba(0,0,0,.55))}',
    '#bm-btn{display:flex;align-items:center;justify-content:center;padding:0;background:linear-gradient(180deg,#2c6785 0,#173847 100%);border:1px solid #0e2a36}',
    '#bm-btn svg{display:block;filter:drop-shadow(0 1px 1px rgba(0,0,0,.6))}',
    '#bm-dock-btn.bm-open svg{filter:brightness(1.35)}',
    'body.bm-docked #bm-btn{display:none!important}',
    '#bm-btn .bm-dot,#bm-dock-btn .bm-dot{position:absolute;top:-4px;right:-4px;width:12px;height:12px;border-radius:50%;background:#ffb300;border:2px solid #1a1a1a}',
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
    '.bm-co-note{margin-left:6px;font:800 11px Segoe UI,system-ui,sans-serif;white-space:nowrap}',
    '.bm-co-note.up{color:#3fc380}',
    '.bm-co-note.down{color:#ff6b6b}',
    '#bm-rank-card .bm-rk-sum{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;cursor:pointer;font-weight:800}',
    '#bm-rank-card .bm-rk-pos{color:#64b5ff}',
    '#bm-rank-card .bm-rk-arrow{color:#64b5ff;font-size:10px}',
    '#bm-rank-card .bm-rk-tiers{display:flex;flex-direction:column;gap:1px;font-size:11px}',
    '#bm-rank-card .bm-rk-tiers .up{color:#3fc380}',
    '#bm-rank-card .bm-rk-tiers .down{color:#ff6b6b}',
    '#bm-rank-card{--base:11px;margin:8px;padding:8px 12px;border-radius:12px;background:linear-gradient(145deg,rgba(15,18,25,.97),rgba(22,27,38,.95));border:1px solid rgba(65,100,255,.25);color:#e1e5e9;font:12px/1.4 Segoe UI,system-ui,sans-serif;display:flex;flex-direction:column;gap:6px}',
    '#bm-rank-card .bm-rk-head{display:flex;align-items:center;gap:8px}',
    '#bm-rank-card .bm-rk-title{font-weight:800;color:#b9d2ff;font-size:13px}',
    '#bm-rank-card .bm-rk-sub{flex:1;opacity:.6;font-size:10px}',
    '#bm-rank-card .bm-rk-big{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:6px;text-align:center}',
    '#bm-rank-card .bm-rk-big > div{padding:6px 2px;border-radius:8px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08)}',
    '#bm-rank-card .bm-rk-num{font-size:22px;font-weight:800;line-height:1.1;background:linear-gradient(135deg,#4F9FFF,#64E5FF);-webkit-background-clip:text;-webkit-text-fill-color:transparent}',
    '#bm-rank-card .bm-rk-num.sm{font-size:16px}',
    '#bm-rank-card .bm-rk-cap{font-size:9.5px;opacity:.7}',
    '#bm-rank-card .bm-rk-line{display:flex;flex-wrap:wrap;gap:5px}',
    '#bm-rank-card .bm-rk-pill{font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15)}',
    '#bm-rank-card .bm-rk-pill.good{color:#9fe870;border-color:rgba(63,195,128,.55);background:rgba(63,195,128,.12)}',
    '#bm-rank-card .bm-rk-pill.bad{color:#ff9a9a;border-color:rgba(255,90,90,.55);background:rgba(255,70,70,.1)}',
    '#bm-rank-card .bm-rk-note{font-size:11px;opacity:.85}',
    '#bm-rank-card .bm-rk-table{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;font-variant-numeric:tabular-nums}',
    '#bm-rank-card .h{font-size:9px;text-transform:uppercase;letter-spacing:.5px;opacity:.6;padding:0 5px 3px;border-bottom:1px solid rgba(255,255,255,.1)}',
    '#bm-rank-card .c{padding:4px 5px;border-bottom:1px solid rgba(255,255,255,.05);white-space:nowrap}',
    '#bm-rank-card .n{text-align:right}',
    '#bm-rank-card .nm{color:#cfe1ff;text-decoration:none;overflow:hidden;text-overflow:ellipsis}',
    '#bm-rank-card .me{background:rgba(79,159,255,.16);color:#fff;font-weight:800}',
    '#bm-rank-card .bm-rk-foot{font-size:9.5px;opacity:.6}',
    '#bm-rank-card .bm-rk-foot a{color:#8fc0ff}',
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
    '.bm-tr-head{display:flex;justify-content:space-between;align-items:baseline;gap:6px;font-weight:800;color:#fff}',
    '.bm-tr-head small{font-weight:600;color:#cfe1ff;opacity:.75;font-size:9.5px;white-space:nowrap}',
    '.bm-chk-row{align-items:center}',
    '.bm-st-row.ok b{color:#9fe870}',
    '.bm-st-row.hosp b,.bm-st-row.hosp .bm-home-cd{color:#ff8a8a}',
    '.bm-st-row.jail b,.bm-st-row.jail .bm-home-cd{color:#ffd866}',
    '.bm-st-row.fly .bm-home-cd,.bm-st-row.fly b{color:#B3DDFF}',
    '.bm-unread-n{opacity:.6;font-weight:700}',
    '.bm-unread-n.on{opacity:1;color:#fff;background:#e5484d;padding:1px 8px;border-radius:999px;font-size:10px}',
    '#bm-btn.bm-keydead,#bm-dock-btn.bm-keydead{box-shadow:0 0 0 2px #e5484d;border-radius:6px}',
    '#bm-btn .bm-late-badge,#bm-dock-btn .bm-late-badge{position:absolute;bottom:-6px;right:-8px;padding:0 4px;height:15px;border-radius:999px;background:#ffb300;color:#1a1a1a;font:800 9px/15px Segoe UI,system-ui,sans-serif;border:2px solid #1a1a1a}',
    '.bm-emp-idle{box-shadow:inset 4px 0 0 #e8a92c;background:rgba(232,169,44,.10)!important}',
    '.bm-emp-idle24{box-shadow:inset 6px 0 0 #f0604d;background:rgba(240,96,77,.20)!important}',
    '.bm-emp-idle24 a,.bm-emp-idle24 .bm-emp-chip{font-weight:800!important}',
    '.bm-idle-soon{color:#e8a92c}',
    '.bm-idle-24{color:#ff7a68;font-weight:800}',
    '.bm-emp-chip.idle24{border-color:#f0604d!important}',
    '.bm-alerts{border-radius:6px;background:linear-gradient(#3b3b3b,#333);border:1px solid #4a4a4a;border-left:3px solid #85b200;box-shadow:0 1px 3px rgba(0,0,0,.35);overflow:hidden}',
    '.bm-alerts-head{display:flex;justify-content:space-between;align-items:center;padding:5px 9px;font-weight:700;color:#ddd;font-size:calc(var(--base) - .5px);border-bottom:1px solid #2a2a2a}',
    '.bm-alerts-n{min-width:16px;height:16px;padding:0 5px;border-radius:8px;background:linear-gradient(#72a52e,#5e8d22);border:1px solid #bcd88c;color:#fff;font:700 10px/14px Arial,Helvetica,sans-serif;text-align:center;box-sizing:border-box}',
    '.bm-alert{display:flex;align-items:center;gap:7px;padding:6px 9px;color:#ddd;text-decoration:none;cursor:pointer;border-top:1px solid #3e3e3e;font-size:calc(var(--base) - .5px)}',
    '.bm-alert:first-of-type{border-top:0}',
    '.bm-alert-t{flex:1;min-width:0}',
    '.bm-alert-go{color:#999}',
    '.bm-alert.warn .bm-alert-t{color:#e8a92c}',
    '.bm-alert.ok .bm-alert-t{color:#85b200}',
    '.bm-late{border-radius:10px;padding:7px 9px;background:rgba(255,179,0,.1);border:1px solid rgba(255,179,0,.55);display:flex;flex-direction:column;gap:2px}',
    '.bm-late-head{display:flex;justify-content:space-between;font-weight:800;color:#ffd866}',
    '.bm-late-cd{font-weight:700;color:#ffe7a6}',
    '.bm-late-row{color:#ffe7a6;text-decoration:none;cursor:pointer;font-size:calc(var(--base) - .5px)}',
    '#bm-btn .bm-unread,#bm-dock-btn .bm-unread{position:absolute;top:-6px;left:-6px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#e5484d;color:#fff;font:800 9px/16px Segoe UI,system-ui,sans-serif;text-align:center;border:2px solid #1a1a1a}',
    '.bm-chk{width:18px;text-align:center;font-weight:900;font-size:13px}',
    '.bm-chk-row .bm-chk.ok,.bm-chk-row b.bm-chk-v.ok{color:#9fe870}',
    '.bm-chk-row .bm-chk.part,.bm-chk-row b.bm-chk-v.part{color:#ffd866}',
    '.bm-chk-row .bm-chk.no,.bm-chk-row b.bm-chk-v.no{color:#ff8a8a}',
    '.bm-chk-row .bm-chk.na,.bm-chk-row b.bm-chk-v.na{color:#8a93a3}',
    '.bm-chk-sub{font-size:9.5px;opacity:.65;font-weight:400}',
    '.bm-arr-row{display:flex;align-items:center;gap:6px;padding:5px 4px;border-top:1px solid rgba(255,255,255,.06)}',
    '.bm-arr-n{width:16px;text-align:center;opacity:.5;font-weight:800;font-variant-numeric:tabular-nums}',
    '.bm-arr-name{flex:1;font-weight:800;color:#fff}',
    '.bm-arr-btn{width:34px;height:28px;border-radius:8px;border:1px solid rgba(100,229,255,.35);background:rgba(79,159,255,.18);color:#cfe8ff;font-size:12px;cursor:pointer}',
    '.bm-arr-btn[disabled]{opacity:.25;cursor:default}',
    '.bm-cal-title{color:inherit;text-decoration:none}',
    '.bm-cal-row{padding:3px 6px;border-radius:8px;cursor:pointer;border-left:3px solid transparent}',
    '.bm-cal-row + .bm-cal-row{margin-top:2px}',
    '.bm-cal-row.live{border-left-color:#3fc380;background:rgba(63,195,128,.08)}',
    '.bm-cal-row.soon{border-left-color:#ffb300;background:rgba(255,179,0,.07)}',
    '.bm-cal-row.near{border-left-color:#4F9FFF}',
    '.bm-cal-tag{font:800 8px Segoe UI,system-ui,sans-serif;padding:1px 4px;border-radius:4px;background:rgba(79,159,255,.25);color:#cfe8ff;vertical-align:1px}',
    '.bm-cal-row.live .bm-cal-tag{background:rgba(63,195,128,.3);color:#c6f6d5}',
    '.bm-cal-row.soon .bm-cal-tag{background:rgba(255,179,0,.3);color:#ffe7a6}',
    '.bm-cal-row .bm-home-row{padding:2px 0}',
    '.bm-cal-row.live .bm-home-cd{color:#9fe870}',
    '.bm-cal-row.soon .bm-home-cd{color:#ffd866}',
    '.bm-cal-more{font-size:9.5px;opacity:.85;padding:2px 0 3px;display:flex;flex-direction:column;gap:2px}',
    '.bm-cal-desc{opacity:.8}',
    '.bm-cal-all{all:unset;cursor:pointer;font-size:9.5px;font-weight:800;color:#8fc0ff;align-self:flex-start;padding:2px 6px}',
    '.bm-home-go{opacity:.45;font-weight:800;margin-left:2px}',
    '.bm-home-bar.link .bm-home-row{padding-right:2px}',
    '.bm-home-row.link b{color:#fff}',
    '.bm-home-row.warn b{color:#ffd866}',
    '.bm-home-row.ready .bm-home-cd{color:#9fe870;font-weight:800}',
    '.bm-home-ok{color:#9fe870;font-weight:800}',
    '.bm-home-used{opacity:.6}',
    '.bm-home-todo{color:#ffd866;font-weight:800}',
    '.bm-hms{font-variant-numeric:tabular-nums}',
    '.bm-cd-max{opacity:.55;font-weight:600}',
    '.ready .bm-cd-max{display:none}',
    '.bm-home-cd{font-weight:800;color:#B3DDFF}',
    '.bm-home-bar{display:flex;flex-direction:column;gap:2px;padding:2px 0}',
    '.bm-home-bar .bm-home-row{padding:0 2px}',
    '.bm-home-bar b{color:#fff}',
    '.b-energy .bm-tr-bar span{background:linear-gradient(90deg,#3fc380,#9fe870)}',
    '.b-nerve .bm-tr-bar span{background:linear-gradient(90deg,#ff6b6b,#ffa0a0)}',
    '.b-happy .bm-tr-bar span{background:linear-gradient(90deg,#ffb300,#ffd866)}',
    '.bm-bar-full{opacity:.6;font-weight:600}',
    '.bm-home-bar .bm-home-row > span,.bm-home-bar .bm-home-row b{white-space:nowrap}',
    '.bm-bar-l{min-width:0;overflow:hidden;text-overflow:ellipsis}',
    '.bm-bar-sub{font-size:9px;opacity:.55;text-align:right;margin-top:-1px}',
    '.b-chain .bm-tr-bar span{background:linear-gradient(90deg,#a06bff,#d3a6ff)}',
    '.bm-chain-to{color:#ffd866!important}',
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
    /* ---- Company page widgets in Torn's own look: grey panels, Arial, flat tags, Torn-style buttons ---- */
    '#bm-rank-card,#bm-emp-card,#bm-pos-card{background:linear-gradient(180deg,#3b3b3b 0,#333 100%);border:1px solid #222;border-radius:5px;box-shadow:0 1px 2px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06);color:#ddd;font:13px/1.4 Arial,Helvetica,sans-serif;padding:8px 10px}',
    '#bm-rank-card{margin:8px 0}',
    '#bm-emp-card .bm-tr-big,#bm-rank-card .bm-rk-num{background:none;-webkit-text-fill-color:#fff;color:#fff;font-family:Arial,Helvetica,sans-serif;font-weight:700}',
    '#bm-emp-card .bm-tr-big{font-size:28px}',
    '#bm-emp-card .bm-tr-cap,#bm-rank-card .bm-rk-cap{color:#999;opacity:1;font-size:10px;text-transform:uppercase;letter-spacing:.3px}',
    '#bm-emp-card .bm-emp-left{border-right:1px solid #222;box-shadow:1px 0 0 #444;padding-right:10px}',
    '#bm-emp-card .bm-emp-o{font-size:12px}',
    '#bm-emp-card .bm-emp-o b,#bm-pos-card .who a{color:#74c0fc;font-weight:700}',
    '#bm-emp-card .bm-emp-o span:last-child{color:#bbb;opacity:1}',
    '#bm-emp-card .bm-tr-slot,#bm-pos-card .bm-tr-slot{background:#2a2a2a;border:1px solid #1d1d1d;box-shadow:inset 0 1px 2px rgba(0,0,0,.5);color:#ddd;border-radius:3px;font:700 11px Arial,Helvetica,sans-serif;padding:1px 6px}',
    '#bm-emp-card .refresh-btn{background:linear-gradient(180deg,#5a5a5a 0,#3c3c3c 100%);border:1px solid #1a1a1a;border-radius:5px;color:#eee;font:700 11px Arial,Helvetica,sans-serif;text-transform:uppercase;letter-spacing:.3px;padding:6px 10px;box-shadow:inset 0 1px 0 rgba(255,255,255,.15);text-shadow:0 1px 1px rgba(0,0,0,.5)}',
    '#bm-emp-card .refresh-btn:active{background:linear-gradient(180deg,#3c3c3c 0,#5a5a5a 100%)}',
    '#bm-emp-card .bm-emp-posnote{color:#85b200;font:700 12px Arial,Helvetica,sans-serif}',
    '#bm-emp-card .bm-emp-posnote.warn{color:#e8a92c}',
    '#bm-rank-card .bm-rk-pos{color:#fff}', '#bm-rank-card .bm-rk-arrow{color:#999}',
    '#bm-rank-card .bm-rk-tiers .up,.bm-co-note.up{color:#85b200}', '#bm-rank-card .bm-rk-tiers .down,.bm-co-note.down{color:#f0604d}',
    '.bm-co-note{font-family:Arial,Helvetica,sans-serif;font-weight:700}',
    '#bm-rank-card .bm-rk-big > div{background:#2a2a2a;border:1px solid #1d1d1d;border-radius:4px;box-shadow:inset 0 1px 2px rgba(0,0,0,.4)}',
    '#bm-rank-card .bm-rk-pill{border-radius:3px;background:#2a2a2a;border-color:#1d1d1d}',
    '#bm-rank-card .bm-rk-pill.good{color:#85b200;background:#2a2a2a;border-color:#1d1d1d}',
    '#bm-rank-card .bm-rk-pill.bad{color:#f0604d;background:#2a2a2a;border-color:#1d1d1d}',
    '#bm-rank-card .h,#bm-pos-card .h{color:#999;opacity:1;border-bottom:1px solid #222;box-shadow:0 1px 0 #444}',
    '#bm-rank-card .c,#bm-pos-card .c{border-bottom:1px solid #2a2a2a}',
    '#bm-rank-card .me{background:#454545;color:#fff}',
    '#bm-rank-card .nm{color:#74c0fc}', '#bm-rank-card .bm-rk-foot a{color:#74c0fc}',
    '#bm-pos-card .bm-pos-title{color:#fff;font:700 13px Arial,Helvetica,sans-serif}',
    '#bm-pos-card .pos{color:#ddd}', '#bm-pos-card .c.move{background:rgba(232,169,44,.08)}', '#bm-pos-card .st.ok{color:#85b200}', '#bm-pos-card .st.move{color:#e8a92c}',
    '#bm-pos-card .bm-pos-pill{border-radius:3px}', '#bm-pos-card .bm-pos-pill.warn{background:#2a2a2a;border-color:#1d1d1d;color:#e8a92c}', '#bm-pos-card .bm-pos-pill.good{background:#2a2a2a;border-color:#1d1d1d;color:#85b200}',
    '.bm-emp-chip{background:linear-gradient(180deg,#444 0,#333 100%);border:1px solid #1d1d1d;border-radius:4px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 1px 1px rgba(0,0,0,.4);color:#ddd;font:700 11px/1.25 Arial,Helvetica,sans-serif;padding:2px 7px}',
    '.bm-emp-chip.mv,.bm-emp-chip.prio{border-color:#1d1d1d}',
    '.bm-emp-chip .bm-pos-mv{color:#e8a92c}', '.bm-emp-chip .bm-pos-ok{color:#85b200;opacity:1}',
    '.bm-emp-chip.next{color:#ddd;background:linear-gradient(180deg,#444 0,#333 100%);border-color:#1d1d1d;box-shadow:inset 3px 0 0 #74c0fc,0 1px 1px rgba(0,0,0,.4)}',
    '.bm-emp-chip.done{color:#85b200;background:linear-gradient(180deg,#444 0,#333 100%);border-color:#1d1d1d}',
    'li.bm-emp-next{box-shadow:inset 3px 0 0 #74c0fc}',
    /* Torn light mode */
    'body:not(.dark-mode) #bm-rank-card,body:not(.dark-mode) #bm-emp-card,body:not(.dark-mode) #bm-pos-card{background:linear-gradient(180deg,#fff 0,#f2f2f2 100%);border-color:#ccc;color:#333;box-shadow:0 1px 2px rgba(0,0,0,.15)}',
    'body:not(.dark-mode) #bm-emp-card .bm-tr-big,body:not(.dark-mode) #bm-rank-card .bm-rk-num,body:not(.dark-mode) #bm-rank-card .bm-rk-pos{color:#333;-webkit-text-fill-color:#333}',
    'body:not(.dark-mode) #bm-emp-card .bm-tr-slot,body:not(.dark-mode) #bm-pos-card .bm-tr-slot,body:not(.dark-mode) #bm-rank-card .bm-rk-big > div,body:not(.dark-mode) #bm-rank-card .bm-rk-pill{background:#e9e9e9;border-color:#ccc;color:#333;box-shadow:none}',
    'body:not(.dark-mode) #bm-emp-card .bm-emp-o b,body:not(.dark-mode) #bm-pos-card .who a,body:not(.dark-mode) #bm-rank-card .nm{color:#069}',
    'body:not(.dark-mode) #bm-emp-card .bm-emp-o span:last-child{color:#666}',
    'body:not(.dark-mode) .bm-emp-chip{background:linear-gradient(180deg,#fff 0,#e9e9e9 100%);border-color:#bbb;color:#333}',
    'body:not(.dark-mode) #bm-pos-card .bm-pos-title,body:not(.dark-mode) #bm-pos-card .pos{color:#333}',
    'body:not(.dark-mode) #bm-rank-card .me{background:#dde8f0;color:#333}',
    'body:not(.dark-mode) #bm-emp-card .bm-emp-left{border-right-color:#ccc;box-shadow:none}',
    /* ---- Torn look: menu frame (like Torn's chat panels) ---- */
    '#bm-menu{background:#333;border:1px solid #404040;border-radius:8px;padding:0;gap:0;box-shadow:0 4px 18px rgba(0,0,0,.6);backdrop-filter:none;font-family:Arial,Helvetica,sans-serif;color:#ddd}',
    '#bm-menu h2{display:flex;align-items:center;gap:8px;margin:0;padding:9px 10px 9px 12px;background:linear-gradient(180deg,#2c6785 0,#1e4c64 55%,#174738 100%);background:linear-gradient(180deg,#2c6785 0,#1e4c64 55%,#173847 100%);-webkit-text-fill-color:#fff;color:#fff;font:700 15px Arial,Helvetica,sans-serif;text-align:left;letter-spacing:0;text-shadow:0 1px 2px rgba(0,0,0,.6);border-bottom:1px solid #30444d}',
    '#bm-menu h2 .bm-h2-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.bm-h2-x{all:unset;cursor:pointer;width:26px;height:20px;position:relative;flex:0 0 auto}',
    '.bm-h2-x::after{content:"";position:absolute;left:3px;right:3px;bottom:5px;height:3px;border-radius:1px;background:#ddd;box-shadow:0 1px 1px rgba(0,0,0,.5)}',
    '.bm-tabs{display:flex;flex-wrap:nowrap;gap:0;margin:0;justify-content:stretch;border-bottom:1px solid #000}',
    '.bm-tab{flex:1 1 0;min-width:0;height:40px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-right:1px solid #232323;border-radius:0;background:linear-gradient(180deg,#525252 0,#3a3a3a 100%);color:#b3b3b3;font:700 11px Arial,Helvetica,sans-serif}',
    '.bm-tab:last-child{border-right:0}',
    '.bm-tab .bm-tab-ic{font-size:18px;line-height:1;filter:grayscale(1) brightness(1.15) contrast(.9);opacity:.75}',
    '.bm-tab .bm-tab-tx{display:none}',
    '.bm-tab.active{background:#2a2a2a;border-color:#232323;box-shadow:inset 0 2px 4px rgba(0,0,0,.5)}',
    '.bm-tab.active .bm-tab-ic{filter:grayscale(1) brightness(2);opacity:1}',
    '.bm-tab .bm-count{top:3px;right:3px}',
    /* ---- 7.55: tidy sheet: full width, slim header, 4 labelled tabs, cog for settings ---- */
    '#bm-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483000}',
    '#bm-menu{position:fixed!important;top:calc(env(safe-area-inset-top,0px) + 8px);bottom:auto;left:8px;right:8px;margin:0 auto;width:auto;min-width:0!important;max-width:560px!important;max-height:calc(100% - 96px);z-index:2147483001}',
    '#bm-content{padding-bottom:20px!important}',
    '#bm-menu h2{padding:0 4px 0 12px!important;height:32px;background:#2a2a2a!important;border-bottom:1px solid #1d1d1d!important;font:700 11px Arial,Helvetica,sans-serif!important;color:#999!important;-webkit-text-fill-color:#999!important;text-transform:uppercase;letter-spacing:.06em!important;text-shadow:none!important}',
    '.bm-h2-cog,.bm-h2-x{all:unset;cursor:pointer;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font:400 16px/1 Arial,Helvetica,sans-serif;color:#bbb;-webkit-text-fill-color:#bbb;border-radius:4px}',
    '.bm-h2-cog{filter:grayscale(1) brightness(1.3);opacity:.8}',
    '.bm-h2-cog.active{opacity:1;filter:grayscale(1) brightness(2)}',
    '.bm-h2-x::after{display:none}',
    '.bm-h2-cog:focus-visible,.bm-h2-x:focus-visible,.bm-tab:focus-visible{outline:2px solid #74c0fc;outline-offset:-2px}',
    '.bm-tab{height:46px!important;flex-direction:column;gap:3px}',
    '.bm-tab .bm-tab-ic{font-size:16px!important}',
    '.bm-tab .bm-tab-tx{display:block!important;font:700 9px/1 Arial,Helvetica,sans-serif;text-transform:uppercase;letter-spacing:.04em;color:#aaa}',
    '.bm-tab.active{background:linear-gradient(180deg,#5c5c5c 0,#474747 100%)!important;box-shadow:inset 0 -3px 0 #85b200!important}',
    '.bm-tab.active .bm-tab-tx{color:#fff}',
    '#bm-content{margin:0;padding:6px 8px 8px}',
    '.bm-sticky{background:#333;box-shadow:0 1px 0 #262626,0 2px 0 #3d3d3d;margin:0 -8px;padding:5px 8px 6px}',
    '#bm-menu .bm-status{color:#aaa;opacity:1;font-family:Arial,Helvetica,sans-serif}',
    '#bm-menu .refresh-btn{background:linear-gradient(180deg,#555 0,#3a3a3a 100%);border:1px solid #1d1d1d;border-radius:4px;color:#ddd;font:700 11px Arial,Helvetica,sans-serif;padding:5px 9px;box-shadow:inset 0 1px 0 rgba(255,255,255,.12);text-shadow:0 1px 1px rgba(0,0,0,.5)}',
    '#bm-menu .refresh-btn:active{background:linear-gradient(180deg,#3a3a3a 0,#555 100%)}',
    '.bm-foldall{color:#74c0fc}',
    /* ---- Torn look: cards on every tab (grey title bars, flat rows) ---- */
    '#bm-content .bm-section{background:#2e2e2e;border:1px solid #232323;border-radius:5px;padding:0 8px 4px;margin-top:6px;overflow:hidden;font:12px/1.35 Arial,Helvetica,sans-serif;color:#ddd}',
    '#bm-content .bm-tr-card{gap:5px}',
    '#bm-content .bm-section > :first-child.bm-fold-head,#bm-content .bm-section > .bm-tr-cap:first-child,#bm-content .bm-section > .bm-tr-head:first-child,#bm-content .bm-section > .bm-user-header:first-child,#bm-content .bm-section > .bm-tr-bhead:first-child,#bm-content details.bm-section > summary{margin:0 -8px 2px;padding:6px 8px;background:linear-gradient(180deg,#4d4d4d 0,#3a3a3a 100%);border:0;border-bottom:1px solid #1d1d1d;color:#fff;font:700 12px Arial,Helvetica,sans-serif;text-transform:none;letter-spacing:0;opacity:1;text-shadow:0 1px 1px rgba(0,0,0,.5)}',
    '#bm-content details.bm-section:not([open]) > summary{margin-bottom:0;border-bottom:0}',
    '#bm-content .bm-section > :first-child .bm-cal-title,#bm-content .bm-section > :first-child a{color:#fff}',
    '#bm-content .bm-section > :first-child small{color:#bbb;opacity:1}',
    '#bm-content .bm-folded{padding-bottom:0}',
    '#bm-content .bm-folded > :first-child{margin-bottom:0!important;border-bottom:0!important}',
    '#bm-content .bm-fold{color:#ccc;opacity:.9}',
    '#bm-content .bm-fold-sum{color:#ddd}',
    '#bm-content .bm-home-row{padding:6px 2px}',
    '#bm-content .bm-home-row + .bm-home-row{border-top:1px solid #3c3c3c;box-shadow:0 -1px 0 #262626}',
    /* colours: Torn green / amber / red / link blue */
    '#bm-content .bm-home-ok,#bm-content .bm-chk-row .bm-chk.ok,#bm-content .bm-chk-row b.bm-chk-v.ok,#bm-content b.pos,#bm-content .pos,#bm-content .bm-st-row.ok b,#bm-content .bm-val-tot b,#bm-content .bm-log-val,#bm-content .bm-rk-own{color:#85b200}',
    '#bm-content .bm-home-todo,#bm-content .bm-chk-row .bm-chk.part,#bm-content .bm-chk-row b.bm-chk-v.part{color:#e8a92c}',
    '#bm-content .bm-chk-row .bm-chk.no,#bm-content .bm-chk-row b.bm-chk-v.no,#bm-content b.neg,#bm-content .neg,#bm-content .bm-val-tot b.neg{color:#f0604d}',
    '#bm-content .bm-val-tot b.na{color:#ddd}',
    '#bm-content .bm-home-cd,#bm-content .bm-cd{color:#74c0fc}',
    '#bm-content .bm-chk-sub,#bm-content .bm-sub{color:#999;opacity:1}',
    '#bm-content .bm-late{border-radius:5px;background:#3d3626;border:1px solid #5c4b22;margin-top:6px}',
    /* links and small text buttons */
    '#bm-content .bm-cal-all,#bm-content .bm-tr-link,#bm-content .bm-tr-add,#bm-content .bm-log-who,#bm-content .bm-user-header,#bm-content .bm-pos-name{color:#74c0fc}',
    '#bm-content .bm-user-header a{color:#fff}',
    /* sub-tabs: like Torn\u2019s grey tab strip */
    '#bm-content .bm-subtabs{gap:0;padding:0;border-radius:4px;background:#232323;border:1px solid #1d1d1d;overflow:hidden}',
    '#bm-content .bm-subtab{border-radius:0;padding:7px 4px;background:linear-gradient(180deg,#525252 0,#3a3a3a 100%);color:#bbb;font:700 11px Arial,Helvetica,sans-serif;border-right:1px solid #232323}',
    '#bm-content .bm-subtab:last-child{border-right:0}',
    '#bm-content .bm-subtab.active{background:#2a2a2a;color:#fff;box-shadow:inset 0 2px 4px rgba(0,0,0,.5)}',
    /* inputs: black like Torn\u2019s search box */
    '#bm-menu .bm-input,#bm-menu select.bm-input,#bm-menu textarea.bm-input{background:#000;border:1px solid #444;border-radius:5px;color:#ddd;font-family:Arial,Helvetica,sans-serif}',
    '#bm-menu .bm-input::placeholder{color:#888}',
    '#bm-menu .bm-input:focus{outline:none;border-color:#74c0fc}',
    /* pills and remove buttons: Torn grey buttons */
    '#bm-content .bm-pill{border-radius:4px;border:1px solid #1d1d1d;background:linear-gradient(180deg,#555 0,#3a3a3a 100%);color:#ddd;box-shadow:inset 0 1px 0 rgba(255,255,255,.1);font:700 11px Arial,Helvetica,sans-serif;padding:5px 9px}',
    '#bm-content .bm-pill.active{background:#2a2a2a;color:#fff;border-color:#74c0fc;box-shadow:inset 0 2px 4px rgba(0,0,0,.5)}',
    '#bm-content .bm-pill.neg{color:#f0604d}',
    '#bm-menu .remove-btn{background:linear-gradient(180deg,#5a3a36 0,#3f2724 100%);border:1px solid #1d1d1d;border-radius:4px;color:#f2b8b0;font:700 11px Arial,Helvetica,sans-serif;padding:5px 9px}',
    '#bm-content .bm-tr-x{border-radius:4px;background:#3f2724;color:#f2b8b0}',
    '#bm-content .bm-error{background:#3f2724;border-color:#5c2f29;color:#f2b8b0;border-radius:4px}',
    /* tiles, boxes, tables */
    '#bm-content .bm-val-tot,#bm-content .bm-tr-box,#bm-content .bm-rk-big > div{background:#262626;border:1px solid #1d1d1d;border-radius:4px;box-shadow:inset 0 1px 2px rgba(0,0,0,.45)}',
    '#bm-content .bm-tr-box.left{border-color:#2c6785;background:#1f2c33}',
    '#bm-content .bm-tr-box.left .bm-tr-num{color:#74c0fc}',
    '#bm-content .bm-tr-box.zero{border-color:#4d5c1a;background:#2a3020}',
    '#bm-content .bm-tr-box.zero .bm-tr-num{color:#85b200}',
    '#bm-content .bm-tr-big,#bm-content .bm-cr-eta{background:none;-webkit-text-fill-color:#fff;color:#fff;font-family:Arial,Helvetica,sans-serif}',
    '#bm-content .bm-cr-eta.good{-webkit-text-fill-color:#85b200}', '#bm-content .bm-cr-eta.bad{-webkit-text-fill-color:#f0604d}',
    '#bm-content .bm-tr-slot{background:#262626;border:1px solid #1d1d1d;border-radius:3px;color:#ddd;box-shadow:inset 0 1px 2px rgba(0,0,0,.45)}',
    '#bm-content .bm-tr-bar{background:#232323}', '#bm-content .bm-tr-bar span{background:linear-gradient(90deg,#2c6785,#74c0fc)}',
    '#bm-content .bm-inc-hd{color:#999;opacity:1}',
    '#bm-content .bm-inc-row,#bm-content .bm-pf-row,#bm-content .bm-rk-row{border-bottom:1px solid #3a3a3a}',
    '#bm-content .bm-inc-tot{background:#3a3a3a;border-radius:3px}',
    '#bm-content .bm-inc-more{background:#262626;border-bottom:1px solid #3a3a3a}',
    '#bm-content .bm-inc-row.open,#bm-content .bm-pf-row.open{background:#383838}',
    '#bm-content .bm-rk-row.own{background:rgba(133,178,0,.10)}',
    '#bm-content .bm-rk-row.next{background:rgba(116,192,252,.12);box-shadow:inset 3px 0 0 #74c0fc}',
    '#bm-content .bm-pf-next{background:#1f2c33;border:1px solid #2c6785;border-radius:4px;color:#ddd}',
    '#bm-content .bm-roi{border-radius:3px}',
    '#bm-content .bm-roi.good{background:rgba(133,178,0,.18);color:#a6d61a}',
    '#bm-content .bm-roi.ok{background:rgba(232,169,44,.18);color:#e8a92c}',
    '#bm-content .bm-roi.bad{background:rgba(240,96,77,.18);color:#f0604d}',
    '#bm-content .bm-val-chip{background:rgba(133,178,0,.18);color:#a6d61a;border-radius:3px}',
    '#bm-content .bm-inc-bar i{background:linear-gradient(#a6d61a,#6b8f00)}',
    '#bm-content .bm-inc-bar.neg i{background:linear-gradient(#f0604d,#b33a2a)}',
    /* buddy stocks, item log and positions */
    '#bm-content .bm-log-row{background:#2e2e2e;border:1px solid #232323;border-radius:4px}',
    '#bm-content .bm-log-row.new{border-color:#5c4b22;background:#3d3626}',
    '#bm-content .bm-pos-row{background:#262626;border-color:#1d1d1d;border-radius:4px}',
    '#bm-content .bm-pos-row.move{border-color:#5c4b22;background:#3d3626}',
    '#bm-content .bm-pos-score{background:#3a3a3a;border-radius:3px}',
    '#bm-content .bm-tr-star.on{color:#e8a92c}',
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
    const idbGet = k => open().then(db => new Promise((res, rej) => {
      const q = db.transaction('kv', 'readonly').objectStore('kv').get(k);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    }));
    const idbSet = (k, v) => open().then(db => new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    }));
    // Torn PDA's own per-script storage (survives clearing the browser cache). Used first when PDA provides it;
    // IndexedDB stays as a backup copy. Anything only in IndexedDB (older versions) moves over the first time it's read.
    const pda = (typeof PDA_storage !== 'undefined' && PDA_storage && typeof PDA_storage.get === 'function') ? PDA_storage : null;
    const state = { pda: !!pda, full: false, err: null };
    const get = k => {
      if (!pda) return idbGet(k);
      return pda.get(k, null).then(v => {
        if (v !== null && v !== undefined) return v;
        return idbGet(k).catch(() => undefined).then(old => {
          if (old !== undefined && old !== null) pda.set(k, old).catch(() => {}); // move it over
          return old;
        });
      }, err => { state.err = err && (err.code || err.message); return idbGet(k); });
    };
    const set = (k, v) => {
      const backup = idbSet(k, v);
      if (!pda) return backup;
      return pda.set(k, v).then(() => { state.full = false; backup.catch(() => {}); }, err => {
        state.full = !!(err && err.code === 'QuotaExceeded'); state.err = err && (err.code || err.message);
        return backup; // PDA storage full or unavailable: the IndexedDB copy still saves it
      });
    };
    const usage = () => (pda ? pda.usage().catch(() => null) : Promise.resolve(null));
    return { get, set, usage, state };
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
    if (/calendar/.test(path)) return 'Calendar';
    if (/selections=battlestats|log=5300/.test(path)) return 'Gym';
    if (/log=5360/.test(path)) return 'Busting';
    if (/log=6000,6003,4201,4211/.test(path)) return 'Portfolio';
    if (/^\/faction\/\?selections=basic,rankedwars|selections=basic,attacks|^\/v2\/user\/list/.test(path)) return 'Ranked war';
    if (/[?&]log=(6795|8155|9015|6710|7815|8156|6005|6001|2290|4900)\b/.test(path) || /selections=networth/.test(path)) return 'Portfolio';
    if (typeof homeBusy !== 'undefined' && homeBusy && /selections=(log&|logtypes)/.test(path)) return 'Home'; // wheel spin check
    if (/selections=stocks(&|$)|^\/torn\/\?selections=(items|bank)(&|$)|pointsmarket/.test(path)) return 'Portfolio';
    if (/^\/v2\/torn\/[\d,]+\/items/.test(path)) return 'Item values';
    if (/cooldowns|refills|bars|personalstats|organizedcrime|^\/faction\/\?selections=upgrades|^\/torn\/\?selections=education/.test(path)) return 'Home';
    if (/^\/company\/\d+\?selections=companies/.test(path)) return 'Company rank';
    if (/^\/company\/\?selections=profile,detailed,employees,stock|^\/company\/\?selections=profile,employees$/.test(path)) return 'Company income';
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
  /* ---- API guard (Torn API rules): one shared check before every call, on every open page.
     - A key Torn rejects (empty, incorrect, owner in federal jail, inactive, paused) is never used again until you
       change it or tap Retry in Settings: repeated calls with a bad key can get your IP temporarily banned.
     - "Too many requests" pauses every call for 60s; "IP block" for 10 min; "API disabled" for 5 min. */
  const GUARD_KEY = 'bm-apiguard-v1';
  const KEY_DEAD_CODES = [1, 2, 10, 13, 18];
  const PAUSE_CODES = { 5: 60000, 8: 600000, 9: 300000 };
  let apiGuard = {};
  IDB.get(GUARD_KEY).then(g => { apiGuard = Object.assign({}, g || {}, apiGuard); }).catch(() => {});
  const keyTag = k => (k ? k.length + ':' + k.slice(-4) : ''); // identifies the key without storing it again
  function guardSave(g) { apiGuard = g; persist(GUARD_KEY, g); refreshIndicators(); }
  function guardReason(key) {
    const g = apiGuard || {};
    if (g.dead && g.dead.tag === keyTag(key)) return g.dead;
    if (g.pauseUntil && g.pauseUntil > Date.now()) return { code: g.pauseCode, msg: 'Paused after Torn said "' + (g.pauseMsg || 'too many requests') + '" – resumes in ' + fmtCountdown(g.pauseUntil - Date.now()), pause: true };
    return null;
  }
  function clearApiGuard() { guardSave({}); }
  /* Pacing: Torn allows 100 calls a minute per player across ALL your keys and apps (PDA itself, other scripts...).
     This script keeps to at most API_BUDGET calls in any 60 seconds per open page, at least 300 ms apart; extra calls
     wait their turn instead of being sent in a burst. */
  const API_BUDGET = 30;
  let apiTimes = [], apiChain = Promise.resolve();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function apiSlot() {
    const run = apiChain.then(async () => {
      for (;;) {
        const now = Date.now();
        apiTimes = apiTimes.filter(t => now - t < 60000);
        if (apiTimes.length < API_BUDGET) {
          const last = apiTimes[apiTimes.length - 1], gap = last ? 300 - (now - last) : 0;
          if (gap > 0) await sleep(gap);
          apiTimes.push(Date.now());
          return;
        }
        await sleep(60000 - (now - apiTimes[0]) + 100);
      }
    });
    apiChain = run.catch(() => {});
    return run;
  }
  const apiCallsLastMinute = () => apiTimes.filter(t => Date.now() - t < 60000).length;
  async function apiGet(path, key) {
    await apiSlot();
    try { const g = await IDB.get(GUARD_KEY); if (g) apiGuard = g; } catch (e) { /* use what we have */ } // another page may have hit an error
    const blocked = guardReason(key);
    if (blocked) { const e = new Error(blocked.pause ? blocked.msg : 'API key not used: Torn rejected it (' + blocked.msg + '). Change it or tap Retry in Settings.'); e.code = blocked.code; e.guard = true; throw e; }
    recordApiCall(path);
    const sep = path.indexOf('?') === -1 ? '?' : '&';
    const j = await httpGetJson(API + path + sep + 'key=' + encodeURIComponent(key) + '&comment=' + COMMENT);
    if (j && j.error) {
      const code = j.error.code, msg = String(j.error.error || 'API error');
      if (KEY_DEAD_CODES.indexOf(code) !== -1) guardSave(Object.assign({}, apiGuard, { dead: { tag: keyTag(key), code, msg, at: Date.now() } }));
      else if (PAUSE_CODES[code]) guardSave(Object.assign({}, apiGuard, { pauseUntil: Date.now() + PAUSE_CODES[code], pauseCode: code, pauseMsg: msg }));
      const e = new Error(msg); e.code = code; throw e;
    }
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
  // Badge alerts from the last Home refresh: drug / booster cooldown over, energy / nerve full (each can be turned off in Settings).
  const READY_ALERTS = [['drug', '💊 Drug cooldown over'], ['booster', '\u26a1 Booster cooldown over'], ['energy', '\u26a1 Energy full'], ['nerve', '🧠 Nerve full'], ['cash', '💵 Lots of cash on hand'], ['bank', '🏦 Bank investment ready'], ['virus', '🦠 Virus finished']];
  const cashLimit = () => (prefs.cashWarn == null ? 5000000 : Math.max(0, Number(prefs.cashWarn) || 0));
  function readyAlerts() {
    const out = [];
    try {
      const h = homeMem || {}, now = Date.now(), off = prefs.alertOff || {};
      if (!h.at) return out;
      if (!off.drug && h.cd && h.at + (h.cd.drug || 0) * 1000 <= now) out.push('drug');
      if (!off.booster && h.cd && h.at + (h.cd.booster || 0) * 1000 <= now) out.push('booster');
      ['energy', 'nerve'].forEach(k => { const b = h.bars && h.bars[k]; if (!off[k] && b && b.max && (b.cur >= b.max || barNow(b, h.at, now).fullAt <= now)) out.push(k); });
      if (!off.cash && cashLimit() > 0 && h.cash != null && h.cash >= cashLimit()) out.push('cash');
      if (!off.bank && h.bank && h.bank.amt > 0 && h.at + (h.bank.left || 0) * 1000 <= now) out.push('bank');
      const vEnd = h.virus ? (h.virus.until || h.virus.last || 0) * 1000 : 0; // finished in the last day and nothing new started
      if (!off.virus && h.virus && !(h.virus.until * 1000 > now) && vEnd && vEnd <= now && now - vEnd < 86400000) out.push('virus');
    } catch (e) { /* no Home data yet */ }
    return out;
  }
  // What needs you in Money (payouts, bank, staff) and Activity (energy, nerve, war). Each item: { icon, text, view | href }.
  function tabReasons() {
    const out = { money: [], activity: [] };
    let ready = []; try { ready = readyAlerts(); } catch (e) { ready = []; }
    try {
      const own = (portMem && portMem.own) || [], st = (portMem && portMem.stocks) || {};
      const pay = own.filter(o => o.ready && !o.passive).map(o => (st[o.id] && st[o.id].acr) || '#' + o.id);
      if (pay.length) out.money.push({ icon: '📈', text: 'Stock payout' + (pay.length > 1 ? 's' : '') + ' ready: ' + pay.join(', '), href: TORN + 'page.php?sid=stocks' });
    } catch (e) { /* no portfolio yet */ }
    if (ready.indexOf('bank') !== -1) out.money.push({ icon: '🏦', text: 'Bank investment ready to collect', href: TORN + 'bank.php' });
    try {
      const idle = idleList(readTrains()).filter(x => x.h >= 24).length;
      if (idle) out.money.push({ icon: '💤', text: idle + ' employee' + (idle > 1 ? 's' : '') + ' inactive over 24h', href: TORN + 'companies.php#/option=employees' });
    } catch (e) { /* no company data */ }
    if (ready.indexOf('energy') !== -1) out.activity.push({ icon: '\u26a1', text: 'Energy full \u2013 time to train', view: 'gym' });
    if (ready.indexOf('nerve') !== -1) out.activity.push({ icon: '🧠', text: 'Nerve full \u2013 do some crimes', href: TORN + 'loader.php?sid=crimes' });
    try { if (warLive(warMem && warMem.war)) out.activity.push({ icon: '\u2694\ufe0f', text: 'Ranked war in progress', view: 'war' }); } catch (e) { /* no war data */ }
    return out;
  }
  function buildTabAlerts(group) {
    let items = []; try { items = tabReasons()[group] || []; } catch (e) { items = []; }
    if (!items.length) return null;
    return el('div', { class: 'bm-alerts', role: 'status', style: { margin: '6px 0' } },
      el('div', { class: 'bm-alerts-head' }, 'Needs your attention', el('span', { class: 'bm-alerts-n' }, String(items.length))),
      items.map(x => {
        const kids = [el('span', null, x.icon), el('span', { class: 'bm-alert-t' }, x.text), el('span', { class: 'bm-alert-go' }, '\u203a')];
        return x.href ? el('a', { class: 'bm-alert warn', href: x.href }, kids) : el('div', { class: 'bm-alert warn', role: 'button', onclick: () => setView(x.view) }, kids);
      }));
  }
  function refreshIndicators() {
    renderProfile();
    renderCompany();
    const total = unseenCount();
    document.querySelectorAll('#bm-btn, #bm-dock-btn').forEach(btn => {
      let dead = false; try { dead = !!(apiGuard && apiGuard.dead && apiGuard.dead.tag === keyTag(getKey().key)); } catch (e) { dead = false; }
      btn.classList.toggle('bm-keydead', dead); btn.title = dead ? 'Buddy Manager \u2013 API key rejected (see Settings)' : 'Buddy Manager';
      let lateN = 0; try { lateN = lateDayItems().length; } catch (e) { lateN = 0; }
      let hn0 = null; try { hn0 = homeMem && homeMem.notes; } catch (e) { hn0 = null; }
      const unread0 = hn0 ? (hn0.messages || 0) + (hn0.events || 0) : 0;
      if (btn.id === 'bm-dock-btn') {
        // In Torn's icon bar: one green count bubble like Torn's own (new buddy items + reset reminders + unread).
        btn.querySelectorAll('.bm-late-badge, .bm-unread, .bm-dot').forEach(x => x.remove());
        const ready = readyAlerts();
        const n = total + lateN + unread0 + ready.length;
        let tb = btn.querySelector('.bm-tbadge');
        if (n) { if (!tb) { tb = el('span', { class: 'bm-tbadge' }); btn.appendChild(tb); } tb.textContent = n > 99 ? '99+' : String(n); }
        else if (tb) tb.remove();
        const why = [total ? total + ' new from buddies' : null, lateN ? lateN + ' before the reset' : null, unread0 ? unread0 + ' unread' : null]
          .concat(ready.map(k => (READY_ALERTS.find(a => a[0] === k) || [k, k])[1].replace(/^\S+\s/, ''))).filter(Boolean);
        if (!dead && why.length) btn.title = 'Buddy Manager \u2013 ' + why.join(', ');
        return;
      }
      let lb = btn.querySelector('.bm-late-badge');
      if (lateN) { if (!lb) { lb = el('span', { class: 'bm-late-badge', title: 'Still to do before the daily reset' }); btn.appendChild(lb); } lb.textContent = '\u26a0' + lateN; }
      else if (lb) lb.remove();
      let hn = null; try { hn = homeMem && homeMem.notes; } catch (e) { hn = null; } // Home data may not be set up yet
      const unread = (hn ? (hn.messages || 0) + (hn.events || 0) : 0) + readyAlerts().length;
      let ub = btn.querySelector('.bm-unread');
      if (unread) { if (!ub) { ub = el('span', { class: 'bm-unread', title: 'Unread messages + events' }); btn.appendChild(ub); } ub.textContent = unread > 99 ? '99+' : String(unread); }
      else if (ub) ub.remove();
      let dot = btn.querySelector('.bm-dot');
      if (total && !dot) btn.appendChild(el('span', { class: 'bm-dot' }));
      if (!total && dot) dot.remove();
    });
    // Money / Activity tabs: a count of what needs you in each (the list itself shows at the top of the tab)
    try {
      const why = tabReasons();
      ['money', 'activity'].forEach(g => document.querySelectorAll('#bm-menu .bm-tab[data-view="' + g + '"]').forEach(tab => {
        let c = tab.querySelector('.bm-count'); const n = why[g].length;
        if (n) { if (!c) { c = el('span', { class: 'bm-count' }); tab.appendChild(c); } c.textContent = String(n); }
        else if (c) c.remove();
      }));
    } catch (e) { /* tab badges are optional */ }
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
    ensurePrices('user');
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
        (v => v.value ? el('span', { class: 'bm-val-chip', title: 'Market value received in the last 7 days' }, fmtCash(v.value) + ' wk') : null)(valueSince(readLog().entries, Date.now() - 7 * 86400000, u)),
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

  /* ---- Item values: Torn market value of what buddies send you.
         One v2 call for all the item IDs in your log, refreshed once per Torn day (plus new items, at most every 10 min). */
  const PRICE_KEY = 'bm-prices-v1';
  let priceMem = {}, priceBusy = false;
  const priceReady = IDB.get(PRICE_KEY).then(x => { priceMem = Object.assign({}, x || {}, priceMem); }).catch(() => {});
  const fmtCash = n => { if (n == null || isNaN(n)) return '-'; const a = Math.abs(n); return (n < 0 ? '\u2212$' : '$') + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'b' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'm' : a >= 1e3 ? (a / 1e3).toFixed(0) + 'k' : String(Math.round(a))); };
  const itemPrice = id => { const p = (priceMem.p || {})[id]; return p == null ? null : p; };
  // { value, unknown } for one log entry (unknown = items with no price yet)
  function entryValue(e) {
    let value = 0, unknown = 0;
    (e.items || []).forEach(i => { const p = itemPrice(i.id); if (p == null) unknown++; else value += p * (Number(i.qty) || 1); });
    return { value, unknown };
  }
  // Totals for buddy entries since `since` (ms), optionally one buddy.
  function valueSince(entries, since, name) {
    const out = { value: 0, count: 0, unknown: 0 };
    buddyEntries(entries, name).forEach(e => { if (e.ts * 1000 < since) return; const v = entryValue(e); out.value += v.value; out.unknown += v.unknown; out.count++; });
    return out;
  }
  async function refreshPrices(force) {
    await storeReady; await priceReady;
    if (priceBusy) return false;
    const { key } = getKey(); if (!key) return false;
    const ids = Array.from(new Set([].concat.apply([], buddyEntries(readLog().entries).map(e => (e.items || []).map(i => String(i.id)))))).filter(Boolean);
    if (!ids.length) return false;
    const p = priceMem.p || {}, now = Date.now();
    const stale = priceMem.day !== lastTornMidnight();
    const missing = ids.filter(id => p[id] == null);
    if (!force && !stale && !missing.length) return false;
    if (!force && !stale && now - (priceMem.tried || 0) < 600000) return false;
    if (force && now - (priceMem.tried || 0) < 15000) return false;
    priceBusy = true;
    try {
      const want = stale || force ? ids : missing, np = Object.assign({}, p);
      for (let i = 0; i < want.length; i += 100) {
        const j = await apiGet('/v2/torn/' + want.slice(i, i + 100).join(',') + '/items', key);
        (j.items || []).forEach(it => {
          if (!it || it.id == null) return;
          const v = it.value || {};
          np[String(it.id)] = Number(v.market_price) || Number(v.sell_price) || 0;
          if (it.name && !itemNames[it.id]) itemNames[it.id] = String(it.name);
        });
      }
      priceMem = { day: stale || force ? lastTornMidnight() : priceMem.day, at: now, tried: now, p: np };
      persist(PRICE_KEY, priceMem); persist(ITEMNAMES_KEY, itemNames);
      return true;
    } catch (e) {
      priceMem = Object.assign({}, priceMem, { tried: now }); persist(PRICE_KEY, priceMem);
      return false;
    } finally { priceBusy = false; }
  }
  // Called when a view that shows values is built; redraws that view if new prices arrived.
  function ensurePrices(view) {
    refreshPrices(false).then(ch => { if (ch && VIEW === view && isMenuOpen()) rebuildContent(); }).catch(() => {});
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
    ensurePrices('log');
    if (entries.length) {
      const now = Date.now(), mid = new Date(); mid.setHours(0, 0, 0, 0);
      const span = [['Today', mid.getTime()], ['7 days', now - 7 * 86400000], ['30 days', now - 30 * 86400000]];
      const tot = span.map(([l, t]) => [l, valueSince(state.entries, t, LOG_FILTER)]);
      const names = LOG_FILTER ? [] : Object.keys(users).filter(u => buddyEntries(state.entries, u).length);
      const unknown = tot[2][1].unknown;
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-cap' }, '💰 Value received' + (LOG_FILTER ? ' from ' + LOG_FILTER : '')),
        el('div', { class: 'bm-val-tots' }, tot.map(([l, v]) => el('div', { class: 'bm-val-tot' }, el('b', null, fmtCash(v.value)), el('small', null, l + ' · ' + v.count)))),
        names.length > 1 ? names.map(u => {
          const w = valueSince(state.entries, now - 7 * 86400000, u), m = valueSince(state.entries, now - 30 * 86400000, u);
          return el('div', { class: 'bm-home-row link', onclick: () => { LOG_FILTER = u; rebuildContent(); } },
            el('span', { class: 'bm-home-l' }, u), el('b', null, fmtCash(w.value) + ' wk · ' + fmtCash(m.value) + ' 30d'));
        }) : null,
        el('div', { class: 'bm-sub', style: { marginTop: '3px' } }, 'Torn market value' + (priceMem.at ? ', updated ' + timeAgo(priceMem.at) : '') + (unknown ? ' · ' + unknown + ' item(s) not priced yet' : '') + ' · ',
          el('a', { href: '#', style: { color: '#8fc0ff' }, onclick: async ev => { ev.preventDefault(); ev.target.textContent = '…'; await refreshPrices(true); rebuildContent(); } }, 'update prices'))));
    }
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
        el('div', { class: 'bm-log-what' }, 'sent you ' + describeItems(e.items), (v => v.value ? el('span', { class: 'bm-log-val' }, ' ≈ ' + fmtCash(v.value)) : null)(entryValue(e))),
        e.message ? el('div', { class: 'bm-log-msg' }, '"' + e.message + '"') : null));
    });
    container.appendChild(list);

    container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '4px' } },
      el('button', { class: 'remove-btn', onclick: () => { if (confirm('Clear the detected items list?')) { const s = readLog(); s.entries = []; writeLog(s); refreshIndicators(); rebuildContent(); } } }, 'Clear list')));

    // Viewing the log clears the bells for what's on screen.
    setTimeout(() => markSeen(LOG_FILTER), 1500);
  }

  /* ---------------- PORTFOLIO ----------------
     Where your weekly money comes from:
     - your own stock blocks (user -> stocks, torn -> stocks): dividend value x increments, per week
     - buddy stocks: the item they send (market value) minus the cash you send back, on each stock's schedule
     - your share of the company's recorded profit (Company -> Income)
     - manual income and expenses you add yourself.
     API: refreshed once per Torn day when you open it, or with Refresh (2 calls; items list and points price once a day). */
  const PORT_KEY = 'bm-portfolio-v1';
  let portMem = {}, portBusy = false, portOpen = {}, rankAll = false;
  const portReady = IDB.get(PORT_KEY).then(x => { portMem = Object.assign({}, x || {}, portMem); }).catch(() => {});
  function writePort(x) { portMem = JSON.parse(JSON.stringify(x)); persist(PORT_KEY, portMem); }
  // "$12.5m" / "1,000,000" / "1.2m" / "250k" -> number (first amount in the text)
  function parseAmount(t) {
    const m = /(\d[\d,]*(?:\.\d+)?)\s*([kmb])?/i.exec(String(t == null ? '' : t));
    if (!m) return null;
    const v = Number(m[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || '').toLowerCase()] || 1);
    return isNaN(v) ? null : v;
  }
  const itemByName = name => { const idx = portMem.itemIdx || {}; const n = String(name || '').toLowerCase().trim(); return idx[n] || idx[n.replace(/s$/, '')] || idx[n.replace(/es$/, '')] || null; };
  // Market value of one item: today's log price if we have it, else the daily items list.
  const itemValue = id => { const p = itemPrice(String(id)); if (p != null && p > 0) return p; const v = (portMem.itemVal || {})[id]; return v == null ? null : v; };
  // A stock's payout text -> { kind, value, qty, itemId, label }  ("1x Erotic DVD", "$80,000,000", "100 Points", "a Box of Grenades")
  function benefitValue(desc) {
    const d = String(desc || '').trim();
    let m = /^\$\s?([\d,]+)/.exec(d);
    if (m) return { kind: 'cash', value: Number(m[1].replace(/,/g, '')), qty: 1, label: d };
    m = /^([\d,]+)\s+points?\b/i.exec(d);
    if (m) { const n = Number(m[1].replace(/,/g, '')); return { kind: 'points', qty: n, value: portMem.pts ? n * portMem.pts : null, label: d }; }
    m = /^(\d+)\s*x\s+(.+)$/i.exec(d);
    const qty = m ? Number(m[1]) : 1, name = (m ? m[2] : d.replace(/^(an?|one|1)\s+/i, '')).replace(/\.$/, '').trim();
    const id = itemByName(name);
    return { kind: 'item', qty, itemId: id, value: id ? (itemValue(id) || 0) * qty : null, label: d, name };
  }
  /* Income and costs from your activity log, like the "API Logs" part of a budget sheet. Each source is a set of
     log types; amounts come from the entry's money fields (refills: points x points price; Xanax: market price). */
  const LOG_SOURCES = [
    { k: 'mug', label: 'Money mugged', icon: '💰', kind: 'in', ids: [8155] },
    { k: 'crime', label: 'Crime cash', icon: '🕵\ufe0f', kind: 'in', ids: [9015, 9053, 5720] },
    { k: 'bounty', label: 'Bounty claims', icon: '🎯', kind: 'in', ids: [6710] },
    { k: 'mission', label: 'Mission cash', icon: '📋', kind: 'in', ids: [7815] },
    { k: 'mugged', label: 'Money mugged from you', icon: '🥷', kind: 'out', ids: [8156] },
    { k: 'rehab', label: 'Rehab', icon: '🏥', kind: 'out', ids: [6005] },
    { k: 'travel', label: 'Travel tickets', icon: '\u2708\ufe0f', kind: 'out', ids: [6001, 6002] },
    { k: 'xanax', label: 'Xanax used', icon: '💊', kind: 'out', ids: [2290, 2291], item: 206 },
    { k: 'refill', label: 'Points refills', icon: '\u26a1', kind: 'out', ids: [4900, 4905, 4910], points: 30 },
    // priced at market value from the item named in each log entry
    { k: 'boost', label: 'Boosters used', icon: '🥤', kind: 'out', ids: [2020, 2030, 2040, 2180, 2190, 2500, 2510, 2520], byItem: true },
    { k: 'med', label: 'Medical items used', icon: '🩹', kind: 'out', ids: [2060, 2070, 2080, 2090, 2100, 2105], byItem: true },
    { k: 'race', label: 'Race winnings', icon: '🏎\ufe0f', kind: 'in', ids: [8742] },
    { k: 'raced', label: 'Races finished', icon: '🏁', kind: 'in', ids: [8730, 8731], hide: true } // counted for the Home overview only
  ];
  // the item a log entry is about (field names vary)
  function logItemId(d) {
    if (!d || typeof d !== 'object') return '';
    const v = d.item != null ? d.item : d.item_id != null ? d.item_id : d.itemid != null ? d.itemid : d.items;
    if (v == null) return '';
    if (typeof v === 'object') { const f = Array.isArray(v) ? v[0] : v; return f && typeof f === 'object' ? String(f.id || f.ID || f.item || '') : String(f || ''); }
    return String(v);
  }
  // money value of a bucket { n, sum, pts, items } for one source, at today's prices (null if a price is missing)
  function logBucketValue(src, L) {
    if (!L) return 0;
    if (src.points) return portMem.pts ? (L.pts || 0) * portMem.pts : null;
    if (src.item) { const v = itemValue(src.item); return v != null ? v * (L.n || 0) : null; }
    if (src.byItem) { let t = 0; Object.keys(L.items || {}).forEach(id => { const v = itemValue(id); if (v != null) t += v * L.items[id]; }); return t; }
    return L.sum || 0;
  }
  const MONEY_KEYS = ['money_mugged', 'money_gained', 'money_paid', 'money', 'bounty_reward', 'reward', 'cost_total', 'total_cost', 'cost', 'fee', 'price', 'amount', 'value', 'total'];
  // money in one log entry (first money-like field; nested objects one level down)
  function logMoney(d) {
    if (!d || typeof d !== 'object') return 0;
    for (const k of MONEY_KEYS) { const v = Number(d[k]); if (d[k] != null && !isNaN(v) && v) return Math.abs(v); }
    for (const k of Object.keys(d)) { const o = d[k]; if (o && typeof o === 'object' && !Array.isArray(o)) { for (const m of MONEY_KEYS) { const v = Number(o[m]); if (o[m] != null && !isNaN(v) && v) return Math.abs(v); } } }
    return 0;
  }
  async function fetchLogSource(src, key, from) {
    // Torn takes at most 10 log types per request (more returns nothing), so ask in groups of 10.
    if (src.ids.length > 10) {
      let all = [];
      for (let i = 0; i < src.ids.length; i += 10) all = all.concat(await fetchLogSource({ ids: src.ids.slice(i, i + 10) }, key, from));
      return all;
    }
    const out = []; let to = null;
    for (let page = 0; page < 6; page++) {
      const lj = await apiGet('/user/?selections=log&log=' + src.ids.join(',') + '&from=' + from + (to ? '&to=' + to : ''), key);
      const lg = lj.log || {};
      const rows = Array.isArray(lg) ? lg : Object.keys(lg).map(id => Object.assign({ id }, lg[id]));
      rows.forEach(r => out.push({ ts: Number(r.timestamp) || 0, log: Number(r.log) || 0, data: r.data || {} }));
      if (rows.length < 100) break;
      to = Math.min(...rows.map(r => Number(r.timestamp) || Infinity)) - 1;
      if (!(to > from)) break;
    }
    return out;
  }
  async function refreshPortfolio(force) {
    await portReady; await storeReady;
    if (portBusy) return;
    const now = Date.now(), day = lastTornMidnight();
    if (!force && portMem.at && (portMem.error ? now - portMem.at < 600000 : portMem.at >= day && portMem.ocAt && portMem.logsAt && portMem.logsV === 3 && LOG_SOURCES.every(src => portMem.logs && portMem.logs[src.k]))) return; // a newly added log source fetches straight away // errors: retry after 10 min
    if (force && portMem.at && now - portMem.at < 15000) return;
    const { key } = getKey(); if (!key) { if (force) toast('No API key yet', '\u26a0\ufe0f'); return; }
    portBusy = true;
    const x = JSON.parse(JSON.stringify(portMem || {}));
    try {
      const mine = (await apiGet('/user/?selections=stocks', key)).stocks || {};
      const all = (await apiGet('/torn/?selections=stocks', key)).stocks || {};
      const stocks = {};
      Object.keys(all).forEach(k => { const t = all[k] || {}; const id = String(t.stock_id || k);
        stocks[id] = { id, acr: String(t.acronym || ''), name: String(t.name || ''), price: Number(t.current_price) || 0, desc: t.benefit ? String(t.benefit.description || '') : '', freq: t.benefit ? Number(t.benefit.frequency) || 0 : 0, req: t.benefit ? Number(t.benefit.requirement) || 0 : 0, type: t.benefit ? String(t.benefit.type || '') : '' }; });
      // the full list may leave out payout details: look those up for the stocks you own (a few calls, first time only)
      const ownIds = Object.keys(mine).map(k => String((mine[k] || {}).stock_id || k));
      // every stock's payout (for the ROI ranking): looked up once and kept, your own stocks first
      const needDesc = ownIds.concat(Object.keys(stocks).filter(id => ownIds.indexOf(id) === -1));
      for (const id of needDesc.filter(id => stocks[id] && !stocks[id].desc && !(x.stocks && x.stocks[id] && x.stocks[id].desc)).slice(0, 12)) { // a few per refresh, the rest next time
        try { const one = ((await apiGet('/torn/' + id + '?selections=stocks', key)).stocks || {}); const t = one[id] || one[Object.keys(one)[0]] || one;
          if (t && t.benefit) Object.assign(stocks[id], { desc: String(t.benefit.description || ''), freq: Number(t.benefit.frequency) || 0, req: Number(t.benefit.requirement) || 0, type: String(t.benefit.type || '') }); } catch (e) { break; }
      }
      Object.keys(stocks).forEach(id => { const old = x.stocks && x.stocks[id]; if (!stocks[id].desc && old && old.desc) Object.assign(stocks[id], { desc: old.desc, freq: old.freq, req: old.req, type: old.type }); });
      x.stocks = stocks;
      x.own = ownIds.map(id => { const o = mine[id] || Object.keys(mine).map(k => mine[k]).find(v => String(v.stock_id) === id) || {}; const dv = o.dividend || null, bf = o.benefit || null;
        // Torn lists cash payouts under "dividend" and item payouts (e.g. PRN, SYM) under "benefit" - both pay out.
        // Only a stock whose benefit is passive (e.g. a bank bonus) has nothing to collect.
        const passive = !dv && !!bf && ((stocks[id] && /passive/i.test(stocks[id].type)) || !(Number(bf.frequency) > 0));
        const pay = passive ? null : (dv || bf);
        return { id, shares: Number(o.total_shares) || 0, inc: pay ? Number(pay.increment) || 0 : 0, ready: pay ? !!Number(pay.ready) : false, progress: pay ? Number(pay.progress) || 0 : 0, freq: pay ? Number(pay.frequency) || 0 : 0, passive,
          tx: (Array.isArray(o.transactions) ? o.transactions : Object.keys(o.transactions || {}).map(k => o.transactions[k])).map(t => ({ shares: Number(t.shares) || 0, price: Number(t.bought_price) || 0, t: Number(t.time_bought) || 0 })).filter(t => t.shares > 0 && t.t > 0) }; });
      // items list (names and market values) and the points price: once a day
      if (!x.itemsDay || x.itemsDay !== day || force) {
        try {
          const it = (await apiGet('/torn/?selections=items', key)).items || {};
          const idx = {}, val = {};
          Object.keys(it).forEach(id => { const v = it[id] || {}; if (v.name) idx[String(v.name).toLowerCase()] = id; val[id] = Number(v.market_value) || 0; if (v.name && !itemNames[id]) itemNames[id] = String(v.name); });
          x.itemIdx = idx; x.itemVal = val; x.itemsDay = day;
        } catch (e) { /* keep yesterday's */ }
        try { // City bank interest rates (APR %) for the ranking's bank rows
          const bk = (await apiGet('/torn/?selections=bank', key)).bank || {};
          const r3 = Number(bk['3m']);
          if (r3 > 0) x.bankApr = r3;
        } catch (e) { /* keep the old rate */ }
        try {
          const pm = (await apiGet('/market/?selections=pointsmarket', key)).pointsmarket || {};
          const costs = Object.keys(pm).map(k => Number((pm[k] || {}).cost) || 0).filter(c => c > 0);
          if (costs.length) x.pts = Math.min(...costs);
        } catch (e) { /* keep the old price */ }
      }
      // Faction OC payouts (log 6795 "Faction payout money balance receive"): last 90 days, 1 call
      try {
        const lj = await apiGet('/user/?selections=log&log=6795&from=' + Math.floor((now - 90 * 86400000) / 1000), key);
        const lg = lj.log || {};
        const rows = (Array.isArray(lg) ? lg : Object.keys(lg).map(id => Object.assign({ id }, lg[id]))).map(r => {
          const d = r.data || {};
          return { id: String(r.id || ''), ts: Number(r.timestamp) || 0, amt: Number(d.balance_change) || 0, scenario: String(d.scenario || ''), role: String(d.role || ''), pct: Number(d.percentage) || null };
        }).filter(r => r.ts && r.amt);
        const keep = (x.oc || []).filter(r => r.ts >= Math.floor((now - 365 * 86400000) / 1000));
        const ids = new Set(keep.map(r => r.id + r.ts));
        rows.forEach(r => { if (!ids.has(r.id + r.ts)) keep.push(r); });
        x.oc = keep.sort((a, b) => b.ts - a.ts);
        x.ocAt = now; x.ocError = null;
      } catch (e) { x.ocError = (e.code != null ? 'Error ' + e.code + ': ' : '') + (e.message || 'failed'); }
      // Log income and costs: last 30 days, one call per source (more only if a source has 100+ entries)
      try {
        const from = Math.floor((now - 30 * 86400000) / 1000), logs = {};
        // crimes on their own (they can be many), everything else in one call, then split by log type
        const crimeSrc = LOG_SOURCES.filter(src => src.k === 'crime'), otherSrc = LOG_SOURCES.filter(src => src.k !== 'crime');
        const crimeRows = crimeSrc.length ? await fetchLogSource({ ids: [].concat(...crimeSrc.map(x => x.ids)) }, key, from) : [];
        const otherRows = await fetchLogSource({ ids: [].concat(...otherSrc.map(x => x.ids)) }, key, from);
        for (const src of LOG_SOURCES) {
          const rows = (src.k === 'crime' ? crimeRows : otherRows).filter(r => src.ids.indexOf(r.log) !== -1);
          const entries = rows.map(r => ({ ts: r.ts, amt: src.points || src.item || src.byItem || src.hide ? 0 : logMoney(r.data), pts: src.points ? (Number(r.data.points) || Number(r.data.cost) || src.points) : 0, item: src.byItem ? logItemId(r.data) : '' }));
          const sample = rows[0] ? Object.keys(rows[0].data || {}).slice(0, 8).join(', ') : '';
          const bucket = list => { const b = { n: list.length, sum: list.reduce((a, e) => a + e.amt, 0), pts: list.reduce((a, e) => a + e.pts, 0) };
            if (src.byItem) { b.items = {}; list.forEach(e => { if (e.item) b.items[e.item] = (b.items[e.item] || 0) + 1; }); } return b; };
          // per Torn day for the last 8 days (for the Home overview)
          const days = {};
          entries.filter(e => e.ts * 1000 >= day - 8 * 86400000).forEach(e => { const dk = Math.floor(e.ts / 86400) * 86400000; (days[dk] = days[dk] || []).push(e); });
          Object.keys(days).forEach(dk => { days[dk] = bucket(days[dk]); });
          logs[src.k] = Object.assign(bucket(entries), { sample, days });
        }
        x.logs = logs; x.logsAt = now; x.logsV = 3; x.logsError = null; // only the current sources are kept
      } catch (e) { x.logsError = (e.code != null ? 'Error ' + e.code + ': ' : '') + (e.message || 'failed'); x.logsAt = x.logsAt || now; }
      delete x.fbal; // no longer used
      x.at = now; x.error = null;
    } catch (e) {
      x.at = now; x.error = (e.code != null ? 'Error ' + e.code + ': ' : '') + (e.message || 'failed');
    } finally {
      writePort(x);
      portBusy = false;
      if (isMenuOpen() && (VIEW === 'portfolio' || VIEW === 'home')) rebuildContent();
    }
  }
  // "SYMx2", "SYM x2", "2xSYM", "2 x SYM", "SYM" -> { acr: 'SYM', mult: 2 | null }
  function parseStockLabel(label) {
    const t = String(label || '').trim();
    let m = /^([A-Za-z]{2,5})\s*[x\u00d7*]\s*(\d+)$/.exec(t);
    if (m) return { acr: m[1].toUpperCase(), mult: Number(m[2]) };
    m = /^(\d+)\s*[x\u00d7*]\s*([A-Za-z]{2,5})$/.exec(t);
    if (m) return { acr: m[2].toUpperCase(), mult: Number(m[1]) };
    return { acr: t.toUpperCase(), mult: null };
  }
  // Every increment of every dividend stock, ranked by ROI (like colaman32's "Stocks 3.0" sheet).
  // Increment n needs requirement x 2^(n-1) more shares, so it costs that many shares at today's price and pays one more payout.
  // Plus City bank rows: $2b for 3 months at today's rate, without merits and with your merits (+5% each, up to 10).
  function incrementRanking() {
    const st = portMem.stocks || {}, own = {};
    (portMem.own || []).forEach(o => { own[o.id] = o; });
    const rows = [];
    Object.keys(st).forEach(id => {
      const t = st[id];
      if (!t || !t.desc || !t.req || !t.freq || !t.price || /passive/i.test(t.type)) return;
      const b = benefitValue(t.desc); if (b.value == null || b.value <= 0) return;
      const owned = own[id] ? own[id].inc || 0 : 0;
      for (let n = 1; n <= 8; n++) {
        const cost = t.req * Math.pow(2, n - 1) * t.price;
        if (n > owned + 1 && cost > 50e9) break;
        const r = roiInfo(cost, b.value * 7 / t.freq);
        rows.push({ key: id + ':' + n, acr: t.acr, name: t.name, n, payout: b.value, label: b.label, freq: t.freq, cost, r, owned: n <= owned, shares: t.req * Math.pow(2, n - 1) });
      }
    });
    const apr = Number(portMem.bankApr) || 0;
    if (apr > 0) {
      const merits = prefs.bankMerits == null ? 10 : Math.max(0, Math.min(10, Number(prefs.bankMerits) || 0));
      const tci = (portMem.own || []).some(o => { const t = st[o.id]; return t && t.acr === 'TCI' && (o.passive || o.inc); });
      const base = 2e9 * apr / 100 * 90 / 365;
      const mk = (label, mult) => { const pay = base * mult; return { key: 'bank' + label, acr: 'Bank', name: 'City bank, 3 months', n: null, bankLabel: label, payout: pay, freq: 90, cost: 2e9, r: roiInfo(2e9, pay * 7 / 90), owned: null }; };
      if (merits) rows.push(mk(merits + ' merits' + (tci ? ' + TCI' : ''), (1 + 0.05 * merits) * (tci ? 1.1 : 1)));
      rows.push(mk('No merits' + (tci ? ' + TCI' : ''), tci ? 1.1 : 1));
    }
    return rows.filter(r => r.r).sort((a, b) => b.r.pct - a.r.pct);
  }
  // When an owned increment was completed and what it cost, from your stock purchases (oldest shares count first).
  // Increment n is the shares from req x (2^(n-1) - 1) up to req x (2^n - 1). n = null: your whole holding.
  function purchaseInfo(tx, req, n) {
    const list = (tx || []).slice().sort((a, b) => a.t - b.t);
    if (!list.length) return null;
    const lo = n ? req * (Math.pow(2, n - 1) - 1) : 0, hi = n ? req * (Math.pow(2, n) - 1) : list.reduce((a, t) => a + t.shares, 0);
    let cum = 0, paid = 0, at = null, first = null;
    list.forEach(t => {
      const a = cum, b = cum + t.shares, ov = Math.max(0, Math.min(b, hi) - Math.max(a, lo));
      if (ov > 0) { paid += ov * t.price; if (first == null) first = t.t; }
      if (at == null && b >= hi) at = t.t;
      cum = b;
    });
    return at && paid > 0 ? { at: at * 1000, first: (first || at) * 1000, paid } : null;
  }
  const stockByAcr = acr => { const st = portMem.stocks || {}; const a = String(acr || '').trim().toUpperCase(); return Object.keys(st).map(k => st[k]).find(t => t.acr.toUpperCase() === a) || null; };
  // Everything the portfolio shows, worked out from saved data (no API).
  function portfolioModel() {
    const out = { own: [], buddy: [], company: null, manual: [], weekly: 0, value: 0 };
    // own stock blocks
    (portMem.own || []).forEach(o => {
      const t = (portMem.stocks || {})[o.id] || { acr: '#' + o.id, name: '', price: 0, desc: '', freq: 0 };
      const b = benefitValue(t.desc), freq = o.freq || t.freq;
      const weekly = o.inc && freq && b.value != null ? b.value * o.inc * 7 / freq : (o.inc ? null : 0);
      const cost = o.shares * (t.price || 0);
      out.own.push({ id: o.id, acr: t.acr, name: t.name, inc: o.inc, shares: o.shares, freq, cost, weekly, b, ready: o.ready, progress: o.progress, passive: o.passive, tx: o.tx || [] });
      out.value += cost; if (weekly) out.weekly += weekly;
    });
    out.own.sort((a, b) => byRoi(b.cost, b.weekly) - byRoi(a.cost, a.weekly) || (b.weekly || 0) - (a.weekly || 0));
    // buddy stocks
    const entries = readLog().entries;
    Object.keys(users).forEach(u => (users[u] || []).forEach(o => {
      if (!o || !o.label || !o.label.trim()) return;
      const sc = (schedules[u] || {})[o.id] || {};
      const every = Math.max(1, parseInt(sc.interval, 10) || 1);
      const lab = parseStockLabel(o.label);
      const t = stockByAcr(lab.acr);
      let b = t ? benefitValue(t.desc) : null;
      // what this buddy actually sends: the latest received entry with that item (or anything, if the stock is unknown)
      const recent = buddyEntries(entries, u).slice().sort((a, c) => c.ts - a.ts);
      const hit = recent.find(e => (e.items || []).some(i => b && b.itemId && String(i.id) === String(b.itemId))) || (!b || b.kind !== 'item' || !b.itemId ? recent[0] : null);
      if (hit && (!b || b.kind === 'item')) {
        const it = (hit.items || []).find(i => !b || !b.itemId || String(i.id) === String(b.itemId)) || (hit.items || [])[0];
        if (it) { const v = itemValue(it.id); b = { kind: 'item', itemId: it.id, qty: Number(it.qty) || 1, value: v != null ? v * (Number(it.qty) || 1) : null, label: (it.qty > 1 ? it.qty + 'x ' : '') + (itemNames[it.id] || 'Item #' + it.id), fromLog: true }; }
      }
      // "SYMx2": they send two payouts at once - the number in the label wins over what the log shows
      if (b && lab.mult && b.kind === 'item' && b.itemId) {
        const unit = itemValue(b.itemId), each = t ? Math.max(1, benefitValue(t.desc).qty || 1) : 1, qty = each * lab.mult;
        b = Object.assign({}, b, { qty, value: unit != null ? unit * qty : null, label: qty + 'x ' + (itemNames[b.itemId] || b.name || 'item'), fromLog: false, fromLabel: true });
      } else if (b && lab.mult && b.value != null && b.kind !== 'item') b = Object.assign({}, b, { value: b.value * lab.mult, label: lab.mult + ' \u00d7 ' + b.label, fromLabel: true });
      const payback = o.payback != null && o.payback !== '' ? parseAmount(o.payback) : parseAmount(o.text);
      const per = b && b.value != null ? b.value - (payback || 0) : null;
      const weekly = per != null ? per * 7 / every : null;
      const invested = parseAmount(o.invested) || 0;
      out.buddy.push({ u, id: o.id, label: o.label.trim(), every, b, payback, per, weekly, invested, start: sc.start || '' });
      out.value += invested; if (weekly) out.weekly += weekly;
    }));
    out.buddy.sort((a, b) => byRoi(b.invested, b.weekly) - byRoi(a.invested, a.weekly) || (b.weekly || 0) - (a.weekly || 0));
    // company share
    const c = readComp();
    if (c.days.length) {
      const share = prefs.portShare == null ? 30 : Number(prefs.portShare) || 0;
      const last7 = c.days.slice(0, 7), sum = sumDays(last7, 'profit');
      const weekProfit = last7.length >= 7 ? sum : sum / last7.length * 7;
      // director's cut first, then your share of what's left
      const cut = prefs.portCut == null ? 35 : Math.min(100, Math.max(0, Number(prefs.portCut) || 0));
      const cutAmt = weekProfit * cut / 100, rest = weekProfit - cutAmt, shareAmt = rest * share / 100;
      out.company = { name: c.name || 'Company', share, cut, cutAmt, rest, shareAmt, weekProfit, weekly: cutAmt + shareAmt, days: last7.length };
      out.weekly += out.company.weekly;
    }
    // travel: profit of trips in the last 30 days, per week
    if (travelMem.trips && !(prefs.portLogOff && prefs.portLogOff.flying)) { const t30 = travelSummary(30); out.flying = t30.profit / 30 * 7; out.weekly += out.flying; }
    // log income and costs: last 30 days, per week (sources you've switched off are left out)
    if (portMem.logs) {
      const off = prefs.portLogOff || {};
      out.logs = LOG_SOURCES.filter(src => !src.hide).map(src => {
        const L = portMem.logs[src.k] || { n: 0, sum: 0, pts: 0 };
        const total = logBucketValue(src, L);
        const weekly = total == null ? null : total / 30 * 7;
        const on = !off[src.k];
        if (on && weekly) out.weekly += src.kind === 'out' ? -weekly : weekly;
        return Object.assign({}, src, { n: L.n, total, weekly, on, sample: L.sample });
      });
    }
    // faction OC payouts: average over the chosen window, per week
    if (Array.isArray(portMem.oc) && portMem.ocAt) {
      const win = prefs.portOcDays === 90 ? 90 : 30, since = Date.now() / 1000 - win * 86400;
      const inWin = portMem.oc.filter(r => r.ts >= since), total = inWin.reduce((a, r) => a + r.amt, 0);
      out.oc = { win, count: inWin.length, total, weekly: total / win * 7, last: portMem.oc[0] || null, recent: portMem.oc.slice(0, 5) };
      out.weekly += out.oc.weekly;
    }
    // manual
    (Array.isArray(prefs.portManual) ? prefs.portManual : []).forEach(m => {
      const w = (Number(m.weekly) || 0) * (m.kind === 'out' ? -1 : 1);
      out.manual.push(Object.assign({}, m, { signed: w }));
      out.weekly += w; out.value += Number(m.invested) || 0;
    });
    return out;
  }
  // ROI like your sheet: yearly return at 365 days (payout per day x 365 / cost) and days until it has paid for itself.
  // Paste "Buddy  Stock  Amount" lines (e.g. from a spreadsheet) to set Amount invested in one go.
  // Stock can be the acronym (PRN, SYM, FHG) or the item (EDVD, DP, FHC). Same buddy + stock twice = added together.
  const STOCK_ALIAS = { EDVD: 'PRN', DVD: 'PRN', DP: 'SYM', FHC: 'FHG' };
  function applyInvestedPaste(text) {
    const want = {}, notFound = [];
    String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
      const m = /^(.*?)[\s\t]+\$?\s*([\d][\d,.]*\s*[kmb]?)\s*$/i.exec(line);
      if (!m) return;
      const amount = parseAmount(m[2]); if (amount == null) return;
      const words = m[1].replace(/[\t,]+/g, ' ').trim().split(/\s+/);
      const nameTxt = words[0].toLowerCase(), stockTxt = words.slice(1).join(' ');
      const buddy = Object.keys(users).find(u => u.toLowerCase() === nameTxt) || Object.keys(users).find(u => u.toLowerCase().startsWith(nameTxt) || nameTxt.startsWith(u.toLowerCase()));
      if (!buddy) { notFound.push(line); return; }
      const stocks = (users[buddy] || []).filter(o => o && o.label && o.label.trim());
      const acrs = stockTxt.toUpperCase().split(/[^A-Z]+/).filter(Boolean).map(w => STOCK_ALIAS[w] || w);
      const target = stocks.length === 1 ? stocks[0] : stocks.find(o => acrs.indexOf(parseStockLabel(o.label).acr) !== -1);
      if (!target) { notFound.push(line); return; }
      const k = buddy + '\u0000' + target.id;
      want[k] = { buddy, o: target, amount: (want[k] ? want[k].amount : 0) + amount };
    });
    Object.keys(want).forEach(k => { want[k].o.invested = String(Math.round(want[k].amount)); });
    if (Object.keys(want).length) saveConfig();
    return { set: Object.keys(want).map(k => want[k]), notFound };
  }
  const roiInfo = (cost, weekly) => (cost > 0 && weekly > 0 ? { pct: weekly / 7 * 365 / cost * 100, days: Math.ceil(cost / (weekly / 7)) } : null);
  const roiCls = r => (r == null ? 'na' : r.pct >= 25 ? 'good' : r.pct >= 12.5 ? 'ok' : 'bad');
  const fmtPct = r => r.pct.toFixed(r.pct >= 100 ? 0 : 2) + '%';
  const byRoi = (cost, weekly) => { const r = roiInfo(cost, weekly); return r ? r.pct : -1; };
  function savePortManual(list) { prefs.portManual = list; saveConfig(); rebuildContent(); }
  function buildPortfolio(container) {
    if (!buildPortfolio._loaded) { buildPortfolio._loaded = true; portReady.then(() => { if (VIEW === 'portfolio' && isMenuOpen()) rebuildContent(); }); }
    refreshPortfolio(false); ensurePrices('portfolio');
    const k = getKey();
    container.appendChild(el('div', { class: 'bm-sticky', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
      el('div', { class: 'bm-status', style: { textAlign: 'left' } }, portMem.at ? 'Stocks & prices ' + timeAgo(portMem.at) : 'Loading your stocks\u2026'),
      el('button', { class: 'refresh-btn', disabled: k.key ? null : 'disabled', onclick: async ev => { ev.currentTarget.textContent = '\u2026'; await refreshPortfolio(true); rebuildContent(); } }, '\u21bb Refresh')));
    if (portMem.error) container.appendChild(el('div', { class: 'bm-error' }, '\u274c ' + portMem.error));
    const m = portfolioModel(), w = m.weekly;
    // headline
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-pf-grid' },
        [['Daily profit', w / 7], ['Weekly profit', w], ['Monthly profit', w * 52 / 12], ['Annual profit', w * 52]].map(([l, v]) =>
          el('div', { class: 'bm-val-tot' }, el('b', { class: v < 0 ? 'neg' : '' }, fmtCash(v)), el('small', null, l)))),
      el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-home-l' }, '💼 Portfolio value', el('div', { class: 'bm-chk-sub' }, 'stock blocks + money invested with buddies + manual')), el('b', null, fmtCash(m.value)))));
    const roiTag = r => el('span', { class: 'bm-roi ' + roiCls(r), title: r ? 'Return per year at 365 days \u00b7 breaks even in ' + fmtN(r.days) + ' days' : null },
      r == null ? '-' : [fmtPct(r), el('small', null, fmtN(r.days) + 'd')]);
    const dmy = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    // For something you already own: bought on, paid, and when it breaks even (or did, and the profit since).
    const ownedLine = (p, perDay) => {
      if (!p || !(perDay > 0)) return null;
      const be = p.at + p.paid / perDay * 86400000, now = Date.now(), earned = perDay * Math.max(0, now - p.at) / 86400000;
      return el('div', null, 'Bought ', el('b', null, dmy(p.at)), ' for ', el('b', null, fmtCash(p.paid)), ' \u00b7 ',
        be <= now ? ['broke even ', el('b', null, dmy(be)), ' \u00b7 profit so far ', el('b', { class: 'pos' }, fmtCash(earned - p.paid))]
                  : ['breaks even ', el('b', null, dmy(be)), ' (' + fmtN(Math.ceil((be - now) / 86400000)) + ' days to go) \u00b7 earned so far ', el('b', null, fmtCash(earned))]);
    };
    const roiLine = (r, start) => { if (!r) return null; const st = start ? parseLocalDate(start) : null;
      return el('div', null, 'ROI @365d ', el('b', null, fmtPct(r)), ' \u00b7 breaks even in ', el('b', null, fmtN(r.days) + ' days'),
        st ? ' (paid back by ' + dmy(st.getTime() + r.days * 86400000) + ')' : ' (' + dmy(Date.now() + r.days * 86400000) + ' if bought today)'); };
    // own stock blocks
    const nwCard = buildNetworthCard(); if (nwCard) container.appendChild(nwCard);
    const ownW = m.own.reduce((a, r) => a + (r.weekly || 0), 0);
    container.appendChild(el('div', { class: 'bm-section bm-tr-card bm-inc' },
      el('div', { class: 'bm-tr-head' }, '📈 My stock blocks', el('small', null, fmtCash(ownW) + '/wk')),
      m.own.length ? [el('div', { class: 'bm-pf-row bm-inc-hd' }, el('span', null, 'Stock'), el('span', null, 'Inc'), el('span', null, 'Weekly'), el('span', null, 'Value'), el('span', null, 'ROI/yr')),
        m.own.map(r => {
          const key = 'own' + r.id, open = !!portOpen[key];
          return [el('div', { class: 'bm-pf-row' + (open ? ' open' : ''), onclick: () => { portOpen[key] = !open; rebuildContent(); } },
            el('span', null, el('b', null, r.acr)), el('span', null, r.passive ? 'P' : String(r.inc)), el('span', { class: r.weekly ? 'pos' : '' }, r.weekly == null ? '?' : fmtCash(r.weekly)), el('span', null, fmtCash(r.cost)), roiTag(roiInfo(r.cost, r.weekly))),
            open ? el('div', { class: 'bm-inc-more' },
              el('div', null, r.name), el('div', null, 'Payout: ', el('b', null, r.b.label || '-'), r.freq ? ' every ' + r.freq + ' days' : ''),
              el('div', null, 'Payout worth ', el('b', null, r.b.value == null ? 'unknown' : fmtCash(r.b.value)), r.inc > 1 ? ' \u00d7 ' + r.inc + ' increments' : ''),
              ownedLine(purchaseInfo(r.tx, 0, null), r.weekly / 7) || roiLine(roiInfo(r.cost, r.weekly)),
              el('div', null, fmtN(r.shares) + ' shares', r.inc ? ' \u00b7 next payout ' + (r.ready ? 'ready to collect' : (r.progress + '/' + r.freq + ' days')) : (r.passive ? ' \u00b7 passive benefit' : ' \u00b7 not enough shares for a payout'))) : null];
        })] : el('div', { class: 'bm-status', style: { textAlign: 'left' } }, portMem.at ? 'No stocks found on your account.' : 'Loading\u2026')));
    // ROI ranking of every increment
    const rk = incrementRanking();
    if (rk.length) {
      const nextBuy = rk.find(r => r.owned === false);
      const shown = rankAll ? rk : rk.slice(0, 15);
      const mer = el('input', { class: 'bm-input', type: 'number', min: '0', max: '10', value: prefs.bankMerits == null ? 10 : prefs.bankMerits, style: { width: '52px' } });
      container.appendChild(el('div', { class: 'bm-section bm-tr-card bm-inc' },
        el('div', { class: 'bm-tr-head' }, '🏆 Best ROI to buy', el('small', null, rk.filter(r => r.owned).length + ' owned')),
        nextBuy ? el('div', { class: 'bm-pf-next' }, '\u27a1\ufe0f Next best buy: ', el('b', null, nextBuy.acr + (nextBuy.n ? ' ' + nextBuy.n : ' (' + nextBuy.bankLabel + ')')), ' \u00b7 ' + fmtCash(nextBuy.cost) + ' \u00b7 ' + fmtPct(nextBuy.r) + ' a year') : null,
        el('div', { class: 'bm-rk-row bm-inc-hd' }, el('span', null, 'Stock'), el('span', null, 'Payout'), el('span', null, 'Cost'), el('span', null, 'ROI/yr'), el('span', null, 'Own')),
        shown.map(r => {
          const open = !!portOpen['rk' + r.key];
          return [el('div', { class: 'bm-rk-row' + (r.owned ? ' own' : '') + (r === nextBuy ? ' next' : '') + (open ? ' open' : ''), onclick: () => { portOpen['rk' + r.key] = !open; rebuildContent(); } },
            el('span', null, el('b', null, r.acr), r.n ? ' ' + r.n : el('small', null, r.bankLabel)),
            el('span', null, fmtCash(r.payout), el('small', null, '/' + r.freq + 'd')),
            el('span', null, fmtCash(r.cost)), roiTag(r.r),
            el('span', { class: 'bm-rk-own' }, r.owned == null ? '\u2013' : r.owned ? '\u2713' : '')),
            open ? el('div', { class: 'bm-inc-more' },
              el('div', null, r.name + (r.n ? ' \u00b7 increment ' + r.n : '')),
              r.n ? el('div', null, 'Pays ', el('b', null, r.label), ' (' + fmtCash(r.payout) + ') every ' + r.freq + ' days') : el('div', null, 'Interest at ' + (Number(portMem.bankApr) || 0).toFixed(2) + '% APR on $2b for 90 days'),
              r.n ? el('div', null, 'Needs ', el('b', null, fmtN(r.shares)), ' more shares (' + fmtN(r.shares * (2 - 1 / Math.pow(2, r.n - 1))) + ' in total for ' + r.n + ' increment' + (r.n > 1 ? 's' : '') + ')') : null,
              r.owned ? (ownedLine(purchaseInfo(((portMem.own || []).find(o => String(o.id) === String(r.key.split(':')[0])) || {}).tx, r.shares / Math.pow(2, r.n - 1), r.n), r.payout / r.freq)
                          || el('div', null, 'You own this \u00b7 ROI @365d ', el('b', null, fmtPct(r.r)), ' at today\u2019s price (no purchase record to date it)'))
                : roiLine(r.r)) : null];
        }),
        rk.length > 15 ? el('button', { class: 'bm-cal-all', onclick: () => { rankAll = !rankAll; rebuildContent(); } }, rankAll ? 'Show top 15' : 'Show all ' + rk.length) : null,
        portMem.bankApr ? el('div', { class: 'bm-tr-row', style: { alignItems: 'center', marginTop: '4px' } }, 'Bank merits', mer,
          el('button', { class: 'refresh-btn', onclick: () => { prefs.bankMerits = Math.min(10, Math.max(0, parseInt(mer.value, 10) || 0)); saveConfig(); rebuildContent(); } }, 'Save')) : null,
        el('div', { class: 'bm-sub', style: { marginTop: '3px' } }, 'Increment n costs requirement \u00d7 2^(n\u22121) shares at today\u2019s price. Payouts at today\u2019s market values. ROI = payout per day \u00d7 365 \u00f7 cost.')));
    }
    // buddy stocks
    const budW = m.buddy.reduce((a, r) => a + (r.weekly || 0), 0);
    container.appendChild(el('div', { class: 'bm-section bm-tr-card bm-inc' },
      el('div', { class: 'bm-tr-head' }, '🤝 Buddy stocks', el('small', null, fmtCash(budW) + '/wk')),
      m.buddy.length ? [el('div', { class: 'bm-pf-row bm-inc-hd' }, el('span', null, 'Buddy'), el('span', null, 'Every'), el('span', null, 'Weekly'), el('span', null, 'Invested'), el('span', null, 'ROI/yr')),
        m.buddy.map(r => {
          const key = 'b' + r.u + r.id, open = !!portOpen[key];
          return [el('div', { class: 'bm-pf-row' + (open ? ' open' : ''), onclick: () => { portOpen[key] = !open; rebuildContent(); } },
            el('span', null, r.u + ' ', el('b', null, r.label)), el('span', null, r.every + 'd'), el('span', { class: r.weekly < 0 ? 'neg' : r.weekly ? 'pos' : '' }, r.weekly == null ? '?' : fmtCash(r.weekly)),
            el('span', null, r.invested ? fmtCash(r.invested) : '-'), roiTag(roiInfo(r.invested, r.weekly))),
            open ? el('div', { class: 'bm-inc-more' },
              el('div', null, 'They send ', el('b', null, r.b ? r.b.label : 'unknown'), r.b && r.b.value != null ? ' (worth ' + fmtCash(r.b.value) + ')' : '', r.b && r.b.fromLog ? ' \u00b7 from your log' : '', r.b && r.b.fromLabel ? ' \u00b7 from the stock name' : ''),
              el('div', null, 'You send back ', el('b', null, r.payback == null ? 'not set' : fmtCash(r.payback)), ' \u00b7 profit per payout ', el('b', null, r.per == null ? '-' : fmtCash(r.per))),
              roiLine(roiInfo(r.invested, r.weekly), r.start),
              r.start ? el('div', null, 'Started ' + r.start) : null,
              el('div', { style: { opacity: '.7' } }, 'Set the amount invested and what you send back in Buddies \u2192 \u270f\ufe0f Edit.')) : null];
        })] : el('div', { class: 'bm-status', style: { textAlign: 'left' } }, 'No buddy stocks yet.'),
      m.buddy.length ? (() => {
        const ta = el('textarea', { class: 'bm-input', rows: '5', placeholder: 'Hydraxis EDVD 633,000,000\nHydraxis DP 700,000,000\nFissure PRN 631.5m', style: { fontSize: '9.5px', resize: 'vertical' } });
        return el('details', { style: { marginTop: '4px' } },
          el('summary', { style: { cursor: 'pointer', fontSize: '9.5px', opacity: '.85' } }, '📋 Paste amounts invested'),
          el('div', { class: 'bm-sub', style: { margin: '4px 0' } }, 'One per line: buddy, stock, amount. Stock can be PRN/SYM/FHG or EDVD/DP/FHC. The same buddy and stock twice are added together. It replaces what\u2019s set now.'),
          ta,
          el('button', { class: 'refresh-btn', style: { marginTop: '4px' }, onclick: () => {
            const r = applyInvestedPaste(ta.value);
            if (!r.set.length && !r.notFound.length) { toast('Nothing to read \u2013 use: buddy stock amount', '\u26a0\ufe0f'); return; }
            if (r.notFound.length) alert('Set ' + r.set.length + ' stock(s). These lines didn\u2019t match a buddy or stock, so add them in Buddies \u2192 Edit:\n\n' + r.notFound.join('\n'));
            else toast('Set the amount invested for ' + r.set.length + ' stock' + (r.set.length === 1 ? '' : 's'), '📋');
            rebuildContent();
          } }, 'Apply'));
      })() : null));
    // company share
    if (m.company) {
      const mc = m.company;
      const cutIn = el('input', { class: 'bm-input', type: 'number', min: '0', max: '100', value: mc.cut, style: { width: '56px' } });
      const pct = el('input', { class: 'bm-input', type: 'number', min: '0', max: '100', value: mc.share, style: { width: '56px' } });
      const line = (l, v, cls) => el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-home-l' }, l), el('b', { class: cls || '' }, v));
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-head' }, '🏢 ' + mc.name, el('small', null, fmtCash(mc.weekly) + '/wk')),
        el('div', { class: 'bm-sub' }, 'Profit recorded in Company \u2192 Income (' + (mc.days >= 7 ? 'last 7 days' : 'average of ' + mc.days + ' day' + (mc.days === 1 ? '' : 's') + ' \u00d7 7') + ').'),
        line('Weekly profit', fmtCash(mc.weekProfit)),
        line('Director\u2019s cut (' + mc.cut + '%)', fmtCash(mc.cutAmt), 'pos'),
        line('Your ' + mc.share + '% of the other ' + fmtCash(mc.rest), fmtCash(mc.shareAmt), 'pos'),
        line('You get', fmtCash(mc.weekly) + ' a week', 'pos'),
        el('div', { class: 'bm-tr-row', style: { alignItems: 'center', flexWrap: 'wrap', marginTop: '4px' } }, 'Director\u2019s cut', cutIn, '%', el('span', { style: { width: '6px' } }), 'Your share', pct, '%',
          el('button', { class: 'refresh-btn', onclick: () => {
            prefs.portCut = Math.min(100, Math.max(0, Number(cutIn.value) || 0));
            prefs.portShare = Math.min(100, Math.max(0, Number(pct.value) || 0));
            saveConfig(); rebuildContent();
          } }, 'Save'))));
    }
    // faction OC payouts
    if (m.oc) {
      const o = m.oc, winPill = d => el('div', { class: 'bm-pill' + (o.win === d ? ' active' : ''), onclick: () => { prefs.portOcDays = d; saveConfig(); rebuildContent(); } }, d + ' days');
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-head' }, '🎯 Faction OC payouts', el('small', null, fmtCash(o.weekly) + '/wk')),
        el('div', { class: 'bm-sub' }, o.count + ' payout' + (o.count === 1 ? '' : 's') + ' in the last ' + o.win + ' days, ' + fmtCash(o.total) + ' in total \u2013 averaged per week and added to your profit. No money is invested, so it has no ROI of its own.'),
        el('div', { style: { display: 'flex', gap: '6px', margin: '2px 0' } }, winPill(30), winPill(90)),
        o.recent.map(r => el('div', { class: 'bm-home-row' },
          el('span', { class: 'bm-home-l' }, r.scenario || 'OC', el('div', { class: 'bm-chk-sub' }, (r.role ? r.role + ' \u00b7 ' : '') + timeAgo(r.ts * 1000) + (r.pct ? ' \u00b7 ' + r.pct.toFixed(1) + '% cut' : ''))),
          el('b', { class: 'pos' }, fmtCash(r.amt)))),
        portMem.ocError ? el('div', { class: 'bm-rk-note' }, '\u26a0\ufe0f ' + portMem.ocError) : null));
    }
    // travel
    refreshTravel(false);
    const trCard = buildTravelCard(); if (trCard) container.appendChild(trCard);
    // log income and costs
    if (m.logs) {
      const shown = m.logs; // every source, even with nothing in 30 days
      const net = m.logs.filter(r => r.on && r.weekly).reduce((a, r) => a + (r.kind === 'out' ? -r.weekly : r.weekly), 0);
      const tog = r => el('button', { class: 'bm-fold', title: r.on ? 'Leave this out of your profit' : 'Count this in your profit', onclick: () => {
        prefs.portLogOff = Object.assign({}, prefs.portLogOff || {}); if (r.on) prefs.portLogOff[r.k] = true; else delete prefs.portLogOff[r.k]; saveConfig(); rebuildContent(); } }, r.on ? '\u2611' : '\u2610');
      const row = r => el('div', { class: 'bm-home-row' + (r.on ? '' : ' bm-off') },
        el('span', { class: 'bm-home-l' }, r.icon + ' ' + r.label, el('div', { class: 'bm-chk-sub' }, (r.n ? r.n : 'none') + ' in 30 days' + (r.total != null ? ' \u00b7 ' + fmtCash(r.total) : '') + (r.n && !r.total && !r.item && !r.points && r.sample ? ' \u00b7 no amount found (' + r.sample + ')' : ''))),
        el('b', { class: r.weekly ? (r.kind === 'out' ? 'neg' : 'pos') : '' }, r.weekly == null ? '?' : (r.kind === 'out' && r.weekly ? '\u2212' : '') + fmtCash(r.weekly)), tog(r));
      const inc = shown.filter(r => r.kind === 'in'), exp = shown.filter(r => r.kind === 'out');
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-head' }, '🧾 From your log', el('small', null, (net < 0 ? '\u2212' : '') + fmtCash(Math.abs(net)) + '/wk')),
        el('div', { class: 'bm-sub' }, 'Last 30 days from your activity log, shown per week. Tick or untick to count it in your profit.'),
        inc.length ? [el('div', { class: 'bm-tr-cap' }, 'Income'), inc.map(row)] : null,
        exp.length ? [el('div', { class: 'bm-tr-cap' }, 'Costs'), exp.map(row)] : null,
        !shown.length ? el('div', { class: 'bm-status', style: { textAlign: 'left' } }, 'Nothing in the last 30 days.') : null,
        portMem.logsError ? el('div', { class: 'bm-rk-note' }, '\u26a0\ufe0f ' + portMem.logsError) : null));
    }
    // manual income / expenses
    const list = Array.isArray(prefs.portManual) ? prefs.portManual.slice() : [];
    const nm = el('input', { class: 'bm-input', type: 'text', placeholder: 'Name (e.g. Sizzle Bank, Xanax)' });
    const amt = el('input', { class: 'bm-input', type: 'text', inputmode: 'decimal', placeholder: 'Weekly $ (e.g. 13.5m)' });
    const inv = el('input', { class: 'bm-input', type: 'text', inputmode: 'decimal', placeholder: 'Invested $ (optional)' });
    let kind = 'in';
    const kindBtn = el('button', { class: 'bm-pill active', type: 'button', onclick: () => { kind = kind === 'in' ? 'out' : 'in'; kindBtn.textContent = kind === 'in' ? '+ Income' : '\u2212 Expense'; kindBtn.classList.toggle('neg', kind === 'out'); } }, '+ Income');
    const mIn = m.manual.filter(x => x.kind !== 'out'), mOut = m.manual.filter(x => x.kind === 'out');
    const mRow = x => el('div', { class: 'bm-home-row' },
      el('span', { class: 'bm-home-l' }, x.name, x.invested ? el('div', { class: 'bm-chk-sub' }, 'invested ' + fmtCash(x.invested) + ' \u00b7 ROI ' + (roiInfo(x.invested, x.weekly) ? fmtPct(roiInfo(x.invested, x.weekly)) + ' \u00b7 ' + fmtN(roiInfo(x.invested, x.weekly).days) + 'd to break even' : '-')) : null),
      el('b', { class: x.kind === 'out' ? 'neg' : 'pos' }, (x.kind === 'out' ? '\u2212' : '') + fmtCash(x.weekly)),
      el('button', { class: 'bm-fold', title: 'Edit', onclick: () => {
        const v = prompt('Weekly amount for ' + x.name + ':', String(x.weekly)); if (v == null) return;
        const n = parseAmount(v); if (n == null) return;
        savePortManual(list.map(y => (y.id === x.id ? Object.assign({}, y, { weekly: n }) : y)));
      } }, '\u270f\ufe0f'),
      el('button', { class: 'bm-fold', title: 'Remove', onclick: () => { if (confirm('Remove ' + x.name + '?')) savePortManual(list.filter(y => y.id !== x.id)); } }, '\u2715'));
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '\u270d\ufe0f Manual income & expenses', el('small', null, fmtCash(m.manual.reduce((a, x) => a + x.signed, 0)) + '/wk')),
      mIn.length ? [el('div', { class: 'bm-tr-cap' }, 'Income'), mIn.map(mRow)] : null,
      mOut.length ? [el('div', { class: 'bm-tr-cap' }, 'Expenses'), mOut.map(mRow)] : null,
      !m.manual.length ? el('div', { class: 'bm-sub' }, 'Add anything the script can\u2019t see, like Sizzle Bank, OCS, Kami or Trains income, and Xanax or Refills costs.') : null,
      el('div', { class: 'bm-pf-add' }, nm, el('div', { style: { display: 'flex', gap: '6px' } }, amt, kindBtn), inv,
        el('button', { class: 'refresh-btn', onclick: () => {
          const name = nm.value.trim(), n = parseAmount(amt.value);
          if (!name || n == null) { toast('Add a name and a weekly amount', '\u26a0\ufe0f'); return; }
          list.push({ id: uuid(), name, weekly: n, kind, invested: parseAmount(inv.value) || 0 });
          savePortManual(list); toast('Added ' + name);
        } }, '+ Add'))));
  }
  function buildPortfolioHomeCard() {
    if (!portMem.at && !(prefs.portManual || []).length && !readNw().days.length) return null;
    const m = portfolioModel();
    return el('div', { class: 'bm-section bm-tr-card' }, el('div', { class: 'bm-tr-cap' }, 'Portfolio'),
      el('div', { class: 'bm-home-row link', onclick: () => setView('portfolio') }, el('span', { class: 'bm-home-l' }, '💼 Weekly profit', el('div', { class: 'bm-chk-sub' }, fmtCash(m.weekly / 7) + ' a day \u00b7 ' + fmtCash(m.weekly * 52) + ' a year')), el('b', { class: m.weekly < 0 ? 'neg' : '' }, fmtCash(m.weekly))),
      el('div', { class: 'bm-home-row link', onclick: () => setView('portfolio') }, el('span', { class: 'bm-home-l' }, '💰 Portfolio value'), el('b', null, fmtCash(m.value))),
      (() => { const d = readNw().days; if (!d.length) return null; const w = nwChange(7);
        return el('div', { class: 'bm-home-row link', onclick: () => setView('portfolio') }, el('span', { class: 'bm-home-l' }, '📊 Networth', w ? el('div', { class: 'bm-chk-sub' }, (w.diff >= 0 ? '+' : '') + fmtCash(w.diff) + ' this week') : null), el('b', null, fmtCash(d[0].total))); })());
  }

  /* ---------------- TRAVEL ----------------
     Trips rebuilt from your log: travel depart (6000), arrive (6003) and abroad buys (4201). Each trip = what you bought
     between landing abroad and flying home, valued at today's market prices. Last 30 days, once a day (or with Refresh). */
  const TRAVEL_KEY = 'bm-travel-v1';
  let travelMem = {}, travelBusy = false;
  const travelReady = IDB.get(TRAVEL_KEY).then(x => { travelMem = Object.assign({}, x || {}, travelMem); }).catch(() => {});
  const COUNTRIES = ['Mexico', 'Cayman Islands', 'Canada', 'Hawaii', 'United Kingdom', 'Argentina', 'Switzerland', 'Japan', 'China', 'UAE', 'United Arab Emirates', 'South Africa'];
  function logCountry(d) {
    const t = JSON.stringify(d || {});
    const c = COUNTRIES.find(n => t.toLowerCase().indexOf(n.toLowerCase()) !== -1);
    return c ? c.replace('United Arab Emirates', 'UAE') : null;
  }
  // one abroad buy: item id, quantity, total cost (field names vary, so try the likely ones)
  function abroadBuy(d) {
    d = d || {};
    const id = String(d.item || d.item_id || (d.items && d.items[0] && (d.items[0].id || d.items[0].item)) || '');
    const qty = Number(d.quantity || d.qty || d.amount || (d.items && d.items[0] && (d.items[0].qty || d.items[0].quantity)) || 1) || 1;
    let cost = Number(d.cost_total || d.total_cost || d.total || 0);
    if (!cost) { const each = Number(d.cost_each || d.cost || d.price || d.unit_price || 0); cost = each * qty; }
    return { id, qty, cost };
  }
  // Torn's travel area numbers (abroad buy logs give "area": 12 etc; sell logs give "in Mexico")
  const AREA_COUNTRY = { 2: 'Mexico', 3: 'Hawaii', 4: 'South Africa', 5: 'Japan', 6: 'China', 7: 'Argentina', 8: 'Switzerland', 9: 'Canada', 10: 'United Kingdom', 11: 'UAE', 12: 'Cayman Islands' };
  // standard one-way flight minutes, used when the depart/arrive logs aren't there
  const FLIGHT_MIN = { 'Mexico': 26, 'Cayman Islands': 35, 'Canada': 41, 'Hawaii': 134, 'United Kingdom': 159, 'Argentina': 167, 'Switzerland': 175, 'Japan': 225, 'China': 242, 'UAE': 271, 'South Africa': 297 };
  function areaCountry(d) {
    d = d || {};
    if (d.area != null && AREA_COUNTRY[Number(d.area)]) return AREA_COUNTRY[Number(d.area)];
    return logCountry(d);
  }
  function abroadSell(d) {
    d = d || {};
    const qty = Number(d.quantity || 1) || 1;
    return { id: String(d.item || ''), qty, got: Number(d.total_value || 0) || Number(d.value_each || 0) * qty };
  }
  // trips: abroad buys (4201) and sells (4211) in the same country, close together in time
  function buildTrips(rows) {
    rows = rows.slice().sort((a, b) => a.ts - b.ts);
    const trips = []; let cur = null;
    rows.forEach(r => {
      if (r.log !== 4201 && r.log !== 4211) return;
      const c = areaCountry(r.data) || 'Abroad';
      if (!cur || cur.country !== c || r.ts - cur.last > 2 * 3600) { cur = { t: r.ts, last: r.ts, country: c, buys: [], sells: [] }; trips.push(cur); }
      cur.last = r.ts;
      if (r.log === 4201) cur.buys.push(abroadBuy(r.data)); else cur.sells.push(abroadSell(r.data));
    });
    // real flight time when the depart/arrive logs are there: the last depart before the last arrival before the trip
    const deps = rows.filter(r => r.log === 6000), arrs = rows.filter(r => r.log === 6003);
    trips.forEach(t => {
      const arr = arrs.filter(a => a.ts <= t.t && t.t - a.ts < 3 * 3600).pop();
      const dep = arr && deps.filter(d => d.ts < arr.ts).pop();
      if (dep && arr.ts - dep.ts < 6 * 3600) t.flight = Math.round((arr.ts - dep.ts) / 60);
      else if (FLIGHT_MIN[t.country]) { t.flight = FLIGHT_MIN[t.country]; t.std = true; }
    });
    const merge = (list, f) => { const o = {}; list.forEach(b => { if (!b.id) return; o[b.id] = o[b.id] || { id: b.id, qty: 0, [f]: 0 }; o[b.id].qty += b.qty; o[b.id][f] += b[f]; }); return Object.keys(o).map(k => o[k]); };
    return trips.map(t => ({ t: t.t, country: t.country, flight: t.flight || null, std: !!t.std, items: merge(t.buys, 'cost'), sold: merge(t.sells, 'got') }))
      .filter(t => t.items.length || t.sold.length);
  }
  async function refreshTravel(force) {
    await travelReady; await storeReady;
    if (travelBusy) return;
    const now = Date.now(), day = lastTornMidnight();
    if (!force && travelMem.at && (travelMem.error ? now - travelMem.at < 600000 : travelMem.at >= day)) return;
    if (force && travelMem.at && now - travelMem.at < 30000) return;
    const { key } = getKey(); if (!key) return;
    travelBusy = true;
    const x = JSON.parse(JSON.stringify(travelMem || {}));
    try {
      const rows = await fetchLogSource({ ids: [6000, 6003, 4201, 4211] }, key, Math.floor((now - 30 * 86400000) / 1000));
      x.trips = buildTrips(rows);
      const s4201 = rows.find(r => r.log === 4201);
      x.sample = s4201 ? JSON.stringify(s4201.data || {}).slice(0, 140) : '';
      x.at = now; x.error = null;
    } catch (e) { x.at = now; x.error = (e.code != null ? 'Error ' + e.code + ': ' : '') + (e.message || 'failed'); }
    finally { travelMem = x; persist(TRAVEL_KEY, travelMem); travelBusy = false; if (isMenuOpen() && (VIEW === 'portfolio')) rebuildContent(); }
  }
  // value each trip at today's prices
  function tripValue(t) {
    let cost = 0, worth = 0, unknown = 0, sold = 0;
    t.items.forEach(i => { cost += i.cost; const v = itemValue(i.id); if (v == null) unknown++; else worth += v * i.qty; });
    // selling abroad: what you got, minus what those items are worth at home
    (t.sold || []).forEach(i => { const v = itemValue(i.id); sold += i.got - (v == null ? 0 : v * i.qty); });
    return { cost, worth, sold, profit: worth - cost + sold, unknown };
  }
  function travelSummary(days) {
    const since = Date.now() / 1000 - days * 86400, trips = (travelMem.trips || []).filter(t => t.t >= since);
    const tot = trips.reduce((a, t) => { const v = tripValue(t); a.cost += v.cost; a.worth += v.worth; a.profit += v.profit; a.mins += (t.flight || 0) * 2; return a; }, { cost: 0, worth: 0, profit: 0, mins: 0 });
    return Object.assign(tot, { n: trips.length, trips });
  }
  function buildTravelCard() {
    if (!travelMem.at) return null;
    const s30 = travelSummary(30), s7 = travelSummary(7), on = !(prefs.portLogOff && prefs.portLogOff.flying);
    const tog = el('button', { class: 'bm-fold', title: on ? 'Leave this out of your profit' : 'Count this in your profit', onclick: () => {
      prefs.portLogOff = Object.assign({}, prefs.portLogOff || {}); if (on) prefs.portLogOff.flying = true; else delete prefs.portLogOff.flying; saveConfig(); rebuildContent(); } }, on ? '☑' : '☐');
    return el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '✈️ Travel', el('small', null, fmtCash(s30.profit / 30 * 7) + '/wk')),
      travelMem.error ? el('div', { class: 'bm-error' }, '❌ ' + travelMem.error) : null,
      el('div', { class: 'bm-val-tots' },
        el('div', { class: 'bm-val-tot' }, el('b', { class: s7.profit < 0 ? 'neg' : '' }, fmtCash(s7.profit)), el('small', null, '7 days · ' + s7.n + ' trips')),
        el('div', { class: 'bm-val-tot' }, el('b', { class: s30.profit < 0 ? 'neg' : '' }, fmtCash(s30.profit)), el('small', null, '30 days · ' + s30.n + ' trips')),
        el('div', { class: 'bm-val-tot' }, el('b', { class: 'na' }, s30.mins ? fmtCash(s30.profit / s30.mins) : '-'), el('small', null, 'per minute flying'))),
      el('div', { class: 'bm-home-row' + (on ? '' : ' bm-off') }, el('span', { class: 'bm-home-l' }, 'Count in Portfolio profit', el('div', { class: 'bm-chk-sub' }, 'average of the last 30 days, per week')), el('b', { class: 'pos' }, fmtCash(s30.profit / 30 * 7)), tog),
      s30.trips.slice().reverse().slice(0, 8).map(t => { const v = tripValue(t);
        return el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-home-l' }, t.country + ' · ' + new Date(t.t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
          el('div', { class: 'bm-chk-sub' }, [t.items.length ? t.items.map(i => i.qty + 'x ' + (itemNames[i.id] || '#' + i.id)).join(', ') + ' \u00b7 cost ' + fmtCash(v.cost) : '',
            (t.sold || []).length ? 'sold ' + t.sold.map(i => i.qty + 'x ' + (itemNames[i.id] || '#' + i.id)).join(', ') + ' for ' + fmtCash(t.sold.reduce((a, i) => a + i.got, 0)) : '',
            t.flight ? t.flight + ' min each way' + (t.std ? ' (standard)' : '') : ''].filter(Boolean).join(' \u00b7 '))),
          el('b', { class: v.profit < 0 ? 'neg' : 'pos' }, (v.profit >= 0 ? '+' : '') + fmtCash(v.profit))); }),
      !s30.n ? el('div', { class: 'bm-status', style: { textAlign: 'left' } }, 'No abroad buys or sells in the last 30 days.' + (travelMem.sample ? '' : '')) : null,
      el('div', { class: 'bm-sub' }, 'Profit = what you bought, at today\u2019s market value, minus what you paid. Selling abroad counts what you got minus the items\u2019 value at home. Tickets are under \u201cFrom your log\u201d. Updated ' + timeAgo(travelMem.at) + '.'));
  }

  /* Abroad shop page: a summary bar above the store - what you've bought this trip, its worth and profit, slots left,
     the best item to fill them with and profit per minute. Reads the page and today's market values; no API calls. */
  function abroadInfo() {
    const box = Array.from(document.querySelectorAll('div, p, span')).find(e => e.children.length < 8 && /You are in .+ and have \$[\d,]+\. You have purchased \d+ \/ \d+ items/.test(e.textContent || ''));
    if (!box) return null;
    const m = /You are in (.+?) and have \$([\d,]+)\. You have purchased (\d+) \/ (\d+) items/.exec(box.textContent);
    return { el: box, country: m[1].trim(), cash: Number(m[2].replace(/,/g, '')), bought: Number(m[3]), cap: Number(m[4]) };
  }
  function abroadStock() {
    const out = [], seen = {};
    Array.from(document.querySelectorAll('li, tr, [class*="row"]')).forEach(r => {
      if (r.closest('#bm-menu, #bm-abroad')) return;
      const lines = (r.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
      if (lines.length < 3 || lines.length > 8) return;
      const name = lines.find(l => itemByName(l)); if (!name || seen[name]) return;
      const costL = lines.find(l => /^\$[\d,.]+k?$/i.test(l)); if (!costL) return;
      const nums = lines.filter(l => /^[\d,]+$/.test(l)); if (!nums.length) return;
      const cost = parseAmount(costL), stock = Number(nums[nums.length - 1].replace(/,/g, '')), id = itemByName(name);
      seen[name] = 1; out.push({ name, id, cost, stock, value: itemValue(id) });
    });
    return out;
  }
  let abroadTrip = null;
  function syncAbroad() {
    let bar = document.getElementById('bm-abroad');
    const info = prefs.abroadBar === false ? null : abroadInfo();
    if (!info) { if (bar) bar.remove(); return; }
    if (!portMem.itemIdx && !syncAbroad.asked) { syncAbroad.asked = 1; refreshPortfolio(false); } // item names and market values (daily)
    const stock = abroadStock();
    // what's been bought on this visit: from the page's "You bought Nx Item for a total of $X" messages, kept for the visit
    const visit = info.country + ':' + lastTornMidnight();
    if (!abroadTrip || abroadTrip.visit !== visit) abroadTrip = { visit, buys: {}, seenMsgs: {} };
    (document.body.innerText.match(/You bought \d+x .+? for a total of \$[\d,]+/g) || []).forEach(msg => {
      if (abroadTrip.seenMsgs[msg]) return; abroadTrip.seenMsgs[msg] = 1;
      const mm = /You bought (\d+)x (.+?) for a total of \$([\d,]+)/.exec(msg); const id = itemByName(mm[2]);
      const k = id || mm[2]; abroadTrip.buys[k] = abroadTrip.buys[k] || { id, name: mm[2], qty: 0, cost: 0 }; abroadTrip.buys[k].qty += Number(mm[1]); abroadTrip.buys[k].cost += Number(mm[3].replace(/,/g, ''));
    });
    const buys = Object.keys(abroadTrip.buys).map(k => abroadTrip.buys[k]);
    let cost = 0, worth = 0; buys.forEach(b => { if (!b.id) b.id = itemByName(b.name); cost += b.cost; const v = b.id ? itemValue(b.id) : null; if (v != null) worth += v * b.qty; });
    const left = Math.max(0, info.cap - info.bought);
    const best = stock.filter(r => r.stock > 0 && r.value != null && r.cost > 0).map(r => Object.assign({}, r, { each: r.value - r.cost })).sort((a, b) => b.each - a.each)[0];
    const fill = best && left ? Math.min(left, best.stock, Math.floor(info.cash / best.cost)) : 0;
    const flight = (() => { const t = (travelMem.trips || []).filter(x => x.country === info.country && x.flight).slice(-1)[0]; return t ? t.flight : null; })();
    const profitTrip = (worth - cost) + (best && fill ? best.each * fill : 0);
    if (!bar) { bar = el('div', { id: 'bm-abroad' }); info.el.parentNode.insertBefore(bar, info.el.nextSibling); }
    else if (bar.previousSibling !== info.el) info.el.parentNode.insertBefore(bar, info.el.nextSibling);
    const lines = [
      el('div', { class: 'bm-ab-h' }, '✈️ Trip to ' + info.country, el('small', null, info.bought + ' / ' + info.cap + ' items')),
      buys.length ? el('div', { class: 'bm-ab-r' }, el('span', null, buys.map(b => b.qty + 'x ' + b.name).join(', ') + ' · cost ' + fmtCash(cost)), el('b', { class: worth - cost >= 0 ? 'pos' : 'neg' }, (worth - cost >= 0 ? '+' : '') + fmtCash(worth - cost))) : null,
      left ? el('div', { class: 'bm-ab-r' }, el('span', null, left + ' slot' + (left === 1 ? '' : 's') + ' left' + (best ? ' · best: ' + best.name + ' (' + (best.each >= 0 ? '+' : '') + fmtCash(best.each) + ' each)' : '')), best && fill ? el('b', { class: 'pos' }, '+' + fmtCash(best.each * fill)) : null) : el('div', { class: 'bm-ab-r' }, el('span', null, 'All slots used')),
      el('div', { class: 'bm-ab-r' }, el('span', null, 'Whole trip' + (flight ? ' · ' + flight + ' min each way' : '')), el('b', { class: profitTrip >= 0 ? 'pos' : 'neg' }, (profitTrip >= 0 ? '+' : '') + fmtCash(profitTrip) + (flight ? ' · ' + fmtCash(profitTrip / (flight * 2)) + '/min' : '')))
    ];
    const sig = JSON.stringify([info.bought, info.cap, info.cash, buys.map(b => b.qty), best && best.name, flight]);
    if (bar.getAttribute('data-sig') !== sig) { bar.innerHTML = ''; lines.forEach(l => l && bar.appendChild(l)); bar.setAttribute('data-sig', sig); }
  }
  setInterval(() => { try { syncAbroad(); } catch (e) { /* ignore */ } }, 2000);

  /* ---------------- GYM ----------------
     Battle stats: one snapshot a day (user -> battlestats, bars). Energy: your gym trains over the last 7 days from the
     log (5300-5303), with Xanax and energy refills, against your natural regen. Refreshed once a day or with Refresh. */
  const GYM_KEY = 'bm-gym-v1';
  let gymMem = {}, gymBusy = false, gymOpen = {};
  const gymReady = IDB.get(GYM_KEY).then(x => { gymMem = Object.assign({}, x || {}, gymMem); }).catch(() => {});
  const readGym = () => { const c = JSON.parse(JSON.stringify(gymMem || {})); c.snaps = Array.isArray(c.snaps) ? c.snaps : []; return c; };
  function writeGym(c) { gymMem = JSON.parse(JSON.stringify(c)); persist(GYM_KEY, gymMem); }
  const STATS = [['strength', 'Strength', 'STR'], ['speed', 'Speed', 'SPD'], ['defense', 'Defense', 'DEF'], ['dexterity', 'Dexterity', 'DEX']];
  const GYM_LOG_STAT = { 5300: 'strength', 5301: 'defense', 5302: 'speed', 5303: 'dexterity' };
  // stat gained in one gym log entry: a field with "increase"/"gain" in its name, else after - before
  function gymGain(d, stat) {
    if (!d) return 0;
    const ks = Object.keys(d).filter(k => /increase|gain/i.test(k) && !isNaN(Number(d[k])));
    const own = ks.find(k => k.toLowerCase().indexOf(stat.slice(0, 3)) !== -1);
    if (own) return Number(d[own]);
    if (ks.length === 1) return Number(d[ks[0]]);
    const a = Number(d[stat + '_after']), b = Number(d[stat + '_before']);
    return !isNaN(a) && !isNaN(b) ? a - b : 0;
  }
  async function refreshGym(force) {
    await gymReady; await storeReady;
    if (gymBusy) return;
    const c = readGym(), day = lastTornMidnight(), now = Date.now();
    if (!force && c.at && (c.error ? now - c.at < 600000 : c.at >= day && c.snaps[0] && c.snaps[0].mod)) return; // older snapshots without modifiers refetch once
    if (force && c.at && now - c.at < 15000) return;
    const { key } = getKey(); if (!key) return;
    gymBusy = true;
    const x = readGym();
    try {
      const j = await apiGet('/user/?selections=battlestats,bars', key);
      const snap = { day, at: now };
      STATS.forEach(([k]) => { snap[k] = Number(j[k]) || 0; });
      snap.total = Number(j.total) || STATS.reduce((a, [k]) => a + snap[k], 0);
      // effective stats: base x (1 + modifier %), with what makes up each modifier (merits, faction, education...)
      snap.mod = {}; snap.info = {};
      STATS.forEach(([k]) => { snap.mod[k] = Number(j[k + '_modifier']) || 0; const inf = j[k + '_info']; if (Array.isArray(inf)) snap.info[k] = inf.map(String).slice(0, 8); });
      STATS.forEach(([k]) => { snap['eff_' + k] = snap[k] * (1 + snap.mod[k] / 100); });
      snap.effTotal = STATS.reduce((a, [k]) => a + snap['eff_' + k], 0);
      x.snaps = x.snaps.filter(r => r.day !== day).concat([snap]).sort((a, b) => b.day - a.day).slice(0, 400);
      const e = j.energy || {};
      x.regen = e.interval ? { perDay: (Number(e.increment) || 5) * 86400 / Number(e.interval), max: Number(e.maximum) || 150 } : x.regen || null;
      // last 7 days of gym trains, Xanax and energy refills
      const from = Math.floor((now - 7 * 86400000) / 1000), days = {};
      const add = (ts, f) => { const d = new Date(ts * 1000); d.setUTCHours(0, 0, 0, 0); const k = d.getTime(); days[k] = days[k] || { e: 0, n: 0, g: {}, xan: 0, ref: 0 }; f(days[k]); };
      const gymRows = await fetchLogSource({ ids: [5300, 5301, 5302, 5303] }, key, from);
      let sample = '';
      gymRows.forEach(r => {
        const stat = GYM_LOG_STAT[r.log] || 'strength', d = r.data || {};
        if (!sample) sample = Object.keys(d).slice(0, 8).join(', ');
        const en = Number(d.energy_used) || Number(d.energy) || 0;
        add(r.ts, o => { o.e += en; o.n++; o.g[stat] = (o.g[stat] || 0) + gymGain(d, stat); });
      });
      const boost = await fetchLogSource({ ids: [2290, 4900] }, key, from);
      boost.forEach(r => add(r.ts, o => { if (r.log === 2290) o.xan++; else o.ref++; }));
      x.week = { from: from * 1000, days, sample, trains: gymRows.length };
      x.at = now; x.error = null;
    } catch (err) {
      x.at = now; x.error = (err.code != null ? 'Error ' + err.code + ': ' : '') + (err.message || 'failed');
    } finally { writeGym(x); gymBusy = false; if (isMenuOpen() && (VIEW === 'gym' || VIEW === 'home')) rebuildContent(); }
  }
  function gymChange(k, days) {
    const sn = readGym().snaps; if (sn.length < 2) return null;
    const ref = sn.find(r => r.day <= sn[0].day - days * 86400000) || sn[sn.length - 1];
    return ref === sn[0] ? null : sn[0][k] - ref[k];
  }
  function sparkSvg(values, color) {
    if (values.length < 2) return null;
    const W = 240, H = 40, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
    const box = el('div', { class: 'bm-nw-spark' });
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" width="100%" height="' + H + '"><polyline fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke" points="' +
      values.map((v, i) => (Math.round(i / (values.length - 1) * W * 10) / 10) + ',' + (Math.round((H - 3 - (v - min) / span * (H - 6)) * 10) / 10)).join(' ') + '"/></svg>';
    return box;
  }
  // What a point of energy costs from each source, at today's prices. Energy per item is Torn's base amount
  // (faction and job perks can raise what cans give). Natural regen is free.
  const ENERGY_ITEMS = [['Xanax', 250, 'drug'], ['LSD', 50, 'drug'], ['Feathery Hotel Coupon', 150, 'booster'],
    ['Can of Goose Juice', 5, 'booster'], ['Can of Damp Valley', 10, 'booster'], ['Can of Crocozade', 15, 'booster'], ['Can of Munster', 20, 'booster'], ['Can of Santa Shooters', 20, 'booster'],
    ['Can of Red Cow', 25, 'booster'], ['Can of Rockstar Rudolph', 25, 'booster'], ['Can of Taurine Elite', 30, 'booster'], ['Can of X-MASS', 30, 'booster']];
  function energyCosts(g) {
    const idx = portMem.itemIdx || {}, rows = [];
    const used = {}; ['boost'].forEach(k => { const L = portMem.logs && portMem.logs[k]; Object.keys((L && L.items) || {}).forEach(id => { used[id] = (used[id] || 0) + L.items[id]; }); });
    const xan = portMem.logs && portMem.logs.xanax ? portMem.logs.xanax.n : 0;
    ENERGY_ITEMS.forEach(([name, e, kind]) => {
      const id = idx[name.toLowerCase()], v = id ? itemValue(id) : null;
      if (v == null || !(v > 0)) return;
      rows.push({ name, e, kind, cost: v, per: v / e, used: name === 'Xanax' ? xan : (id && used[id]) || 0 });
    });
    const max = g && g.regen ? g.regen.max : 150;
    if (portMem.pts) rows.push({ name: 'Energy refill (30 points)', e: max, kind: 'refill', cost: 30 * portMem.pts, per: 30 * portMem.pts / max, used: 0 });
    return rows.sort((a, b) => a.per - b.per);
  }
  function buildEnergyCostCard(g) {
    if (!portMem.itemIdx) { refreshPortfolio(false); return null; } // prices come with the daily Portfolio refresh
    const rows = energyCosts(g); if (!rows.length) return null;
    const best = rows[0];
    return el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '💸 Cost per energy', el('small', null, 'cheapest $' + fmtN(Math.round(best.per)) + '/e')),
      el('div', { class: 'bm-sub' }, 'Today\u2019s market price divided by the energy it gives, cheapest first. Natural regen is free. Cans use Torn\u2019s base energy \u2013 faction or job perks make them cheaper per point.'),
      rows.map((r, i) => el('div', { class: 'bm-home-row' },
        el('span', { class: 'bm-home-l' }, r.name, el('div', { class: 'bm-chk-sub' }, fmtCash(r.cost) + ' for ' + r.e + 'e' + (r.kind === 'drug' ? ' \u00b7 drug cooldown' : r.kind === 'booster' ? ' \u00b7 booster cooldown' : ' \u00b7 once a day') + (r.used ? ' \u00b7 you used ' + r.used + ' in 30 days' : ''))),
        el('b', { class: i === 0 ? 'pos' : '' }, '$' + fmtN(Math.round(r.per)) + '/e'))));
  }
  function buildGym(container) {
    if (!buildGym._loaded) { buildGym._loaded = true; gymReady.then(() => { if (VIEW === 'gym' && isMenuOpen()) rebuildContent(); }); }
    refreshGym(false);
    const g = readGym(), last = g.snaps[0];
    container.appendChild(el('div', { class: 'bm-sticky', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
      el('div', { class: 'bm-status', style: { textAlign: 'left' } }, g.at ? 'Updated ' + timeAgo(g.at) + ' · once a day' : 'Loading…'),
      el('button', { class: 'refresh-btn', onclick: async ev => { ev.currentTarget.textContent = '…'; await refreshGym(true); rebuildContent(); } }, '↻ Refresh')));
    if (g.error) container.appendChild(el('div', { class: 'bm-error' }, '❌ ' + g.error));
    if (!last) return;
    const fs = v => { const a = Math.abs(v); return a >= 1e9 ? (a / 1e9).toFixed(2) + 'b' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'm' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'k' : fmtN(Math.round(a)); };
    const sgn = v => (v == null ? '-' : (v >= 0 ? '+' : '\u2212') + fs(v));
    const d1 = gymChange('total', 1), d7 = gymChange('total', 7), d30 = gymChange('total', 30);
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '💪 Battle stats', el('small', null, fs(last.total) + ' total')),
      el('div', { class: 'bm-val-tots' }, [['today', d1], ['7 days', d7], ['30 days', d30]].map(([l, v]) => el('div', { class: 'bm-val-tot' }, el('b', { class: v == null ? 'na' : '' }, sgn(v)), el('small', null, l)))),
      sparkSvg(g.snaps.slice(0, 30).reverse().map(r => r.total), '#85b200'),
      last.effTotal != null ? el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-home-l' }, '\u2728 Effective total', el('div', { class: 'bm-chk-sub' }, 'with your stat modifiers')), el('b', { class: 'pos' }, fs(last.effTotal))) : null,
      STATS.map(([k, name]) => {
        const mod = last.mod ? last.mod[k] : null, eff = last['eff_' + k], open = !!gymOpen[k], has = !!(last.info && last.info[k] && last.info[k].length);
        return [el('div', { class: 'bm-home-row' + (has ? ' link' : ''), onclick: () => { if (has) { gymOpen[k] = !open; rebuildContent(); } } },
          el('span', { class: 'bm-home-l' }, name, el('div', { class: 'bm-chk-sub' }, (last.total ? Math.round(last[k] / last.total * 100) : 0) + '% of total \u00b7 7d ' + sgn(gymChange(k, 7)))),
          el('span', { class: 'bm-gym-v' }, el('b', null, fmtN(Math.round(last[k]))),
            eff != null ? el('small', { class: mod > 0 ? 'pos' : mod < 0 ? 'neg' : '' }, 'effective ' + fmtN(Math.round(eff)) + (mod ? ' (' + (mod > 0 ? '+' : '') + mod + '%)' : '')) : null)),
          open ? el('div', { class: 'bm-inc-more' }, last.info[k].map(t => el('div', null, t))) : null];
      }),
      el('div', { class: 'bm-sub' }, g.snaps.length + ' daily snapshot' + (g.snaps.length === 1 ? '' : 's') + (g.snaps.length < 8 ? ' – the 7 and 30 day gains fill in as days are recorded' : ''))));
    // energy, last 7 days
    const wk = g.week; if (!wk) { const ec0 = buildEnergyCostCard(g); if (ec0) container.appendChild(ec0); return; }
    const keys = Object.keys(wk.days).map(Number).sort((a, b) => b - a);
    const tot = keys.reduce((a, k) => { const o = wk.days[k]; a.e += o.e; a.n += o.n; a.xan += o.xan; a.ref += o.ref; return a; }, { e: 0, n: 0, xan: 0, ref: 0 });
    const regen = g.regen ? g.regen.perDay * 7 : null, max = g.regen ? g.regen.max : 150;
    const avail = regen != null ? regen + tot.xan * 250 + tot.ref * max : null;
    const unused = avail != null && tot.e ? Math.max(0, avail - tot.e) : null;
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '⚡ Energy – last 7 days', el('small', null, fmtN(tot.e) + ' trained')),
      el('div', { class: 'bm-val-tots' },
        el('div', { class: 'bm-val-tot' }, el('b', null, fmtN(Math.round(tot.e / 7))), el('small', null, 'trained a day')),
        el('div', { class: 'bm-val-tot' }, el('b', { class: 'na' }, avail == null ? '-' : fmtN(Math.round(avail / 7))), el('small', null, 'available a day')),
        el('div', { class: 'bm-val-tot' }, el('b', { class: unused ? 'neg' : '' }, unused == null ? '-' : fmtN(Math.round(unused / 7))), el('small', null, 'unused a day'))),
      el('div', { class: 'bm-sub' }, 'Available ≈ natural regen' + (g.regen ? ' (' + fmtN(Math.round(g.regen.perDay)) + '/day)' : '') + ' + Xanax × 250 (' + tot.xan + ') + energy refills × ' + max + ' (' + tot.ref + ').'),
      keys.map(k => { const o = wk.days[k], gains = STATS.filter(([s]) => o.g[s]).map(([s, , ab]) => ab + ' +' + fs(o.g[s]));
        return el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-home-l' }, new Date(k).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
          el('div', { class: 'bm-chk-sub' }, (o.n ? o.n + ' train' + (o.n === 1 ? '' : 's') : 'no gym') + (gains.length ? ' · ' + gains.join(' ') : '') + (o.xan ? ' · ' + o.xan + ' xan' : '') + (o.ref ? ' · refill' : ''))),
          el('b', null, fmtN(o.e) + 'e')); }),
      !keys.length ? el('div', { class: 'bm-status', style: { textAlign: 'left' } }, 'No gym trains in the last 7 days.') : null,
      wk.trains && !tot.e ? el('div', { class: 'bm-rk-note' }, 'Couldn\u2019t read the energy in your gym log (' + wk.sample + ').') : null));
    const ec = buildEnergyCostCard(g); if (ec) container.appendChild(ec);
  }

  /* ---------------- LISTS (targets / friends / enemies) ----------------
     user -> list (v2): who on your list is okay to hit, in hospital, in jail or travelling. Only called when you open it. */
  let listMem = { cat: 'Targets', rows: {}, at: {}, err: {} }, listBusy = false;
  async function refreshList(cat, force) {
    if (listBusy) return;
    const now = Date.now();
    if (!force && listMem.at[cat] && now - listMem.at[cat] < 60000) return;
    const { key } = getKey(); if (!key) return;
    listBusy = true;
    try {
      let rows = [];
      for (let off = 0; off < 500; off += 100) {
        const j = await apiGet('/v2/user/list?cat=' + cat + '&limit=100&offset=' + off, key);
        const L = Array.isArray(j.list) ? j.list : [];
        rows = rows.concat(L.map(u => ({ id: String(u.id), name: String(u.name || u.id), level: Number(u.level) || 0, faction: u.faction_id || null,
          state: String((u.status || {}).state || ''), desc: String((u.status || {}).description || ''), until: Number((u.status || {}).until) || 0,
          online: String((u.last_action || {}).status || ''), last: String((u.last_action || {}).relative || '') })));
        if (L.length < 100) break;
      }
      listMem.rows[cat] = rows; listMem.at[cat] = now; listMem.err[cat] = null;
    } catch (e) { listMem.err[cat] = (e.code != null ? 'Error ' + e.code + ': ' : '') + (e.message || 'failed'); listMem.at[cat] = now; }
    finally { listBusy = false; if (isMenuOpen() && VIEW === 'war') rebuildContent(); }
  }
  function buildListCard() {
    const cat = listMem.cat, rows = (listMem.rows[cat] || []).slice(), now = Date.now() / 1000;
    refreshList(cat, false);
    const rank = r => (/okay/i.test(r.state) ? 0 : /hospital/i.test(r.state) ? 1 : /jail/i.test(r.state) ? 2 : /travel|abroad/i.test(r.state) ? 3 : 4);
    rows.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 || rank(a) === 2 ? a.until - b.until : b.level - a.level));
    const okay = rows.filter(r => rank(r) === 0).length;
    const pill = c => el('div', { class: 'bm-pill' + (cat === c ? ' active' : ''), onclick: () => { listMem.cat = c; rebuildContent(); } }, c);
    return el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '🎯 ' + cat, el('small', null, rows.length ? okay + ' of ' + rows.length + ' okay' : '')),
      el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, pill('Targets'), pill('Friends'), pill('Enemies'),
        el('button', { class: 'refresh-btn', style: { marginLeft: 'auto' }, onclick: () => refreshList(cat, true) }, '\u21bb')),
      listMem.err[cat] ? el('div', { class: 'bm-error' }, '\u274c ' + listMem.err[cat]) : null,
      !listMem.at[cat] ? el('div', { class: 'bm-status', style: { textAlign: 'left' } }, 'Loading\u2026') : !rows.length ? el('div', { class: 'bm-status', style: { textAlign: 'left' } }, 'Nobody on your ' + cat.toLowerCase() + ' list.') : null,
      rows.map(r => {
        const k = rank(r), cls = ['ok', 'hosp', 'jail', 'away', ''][k];
        const stateTxt = (k === 1 || k === 2) && r.until > now ? [r.state + ' ', el('span', { class: 'bm-cd', 'data-bm-cd': String(r.until * 1000), 'data-bm-zero': 'out' }, fmtCountdown(r.until * 1000 - Date.now()))] : (r.desc || r.state);
        return el('div', { class: 'bm-home-row bm-list-row' },
          el('span', { class: 'bm-home-l' },
            el('a', { href: TORN + 'profiles.php?XID=' + r.id, class: 'bm-list-name' }, el('i', { class: 'bm-dot-on ' + r.online.toLowerCase() }), r.name, el('small', null, ' [' + r.level + ']')),
            el('div', { class: 'bm-chk-sub' }, r.last ? 'last action ' + r.last : '')),
          el('span', { class: 'bm-list-st ' + cls }, stateTxt),
          k === 0 && cat !== 'Friends' ? el('a', { class: 'bm-list-hit', href: TORN + 'loader.php?sid=attack&user2ID=' + r.id, title: 'Attack' }, '\u2694\ufe0f') : null);
      }),
      listMem.at[cat] ? el('div', { class: 'bm-sub' }, 'Updated ' + timeAgo(listMem.at[cat]) + ' \u00b7 only when you open this or tap \u21bb') : null);
  }

  /* ---------------- RANKED WAR ----------------
     Your faction's current or next ranked war (faction -> basic, rankedwars) and your own war hits (user -> attacks).
     Checked at most every 30 minutes on page load; every 2 minutes while the War tab is open during a war. */
  const WAR_KEY = 'bm-war-v1';
  let warMem = {}, warBusy = false, warTimer = null;
  const warReady = IDB.get(WAR_KEY).then(x => { warMem = Object.assign({}, x || {}, warMem); }).catch(() => {});
  function writeWar(c) { warMem = JSON.parse(JSON.stringify(c)); persist(WAR_KEY, warMem); }
  const warLive = w => !!(w && w.start && w.start * 1000 <= Date.now() && !w.end);
  async function refreshWar(force) {
    await warReady; await storeReady;
    if (warBusy) return;
    const now = Date.now(), live = warLive(warMem.war);
    const gap = force ? 15000 : live ? 120000 : 1800000;
    if (warMem.at && now - warMem.at < gap) return;
    const { key } = getKey(); if (!key) return;
    warBusy = true;
    const x = JSON.parse(JSON.stringify(warMem || {}));
    try {
      const fj = await apiGet('/faction/?selections=basic,rankedwars', key);
      const myF = String(fj.ID || fj.id || ''), wars = fj.rankedwars || {};
      const list = (Array.isArray(wars) ? wars : Object.keys(wars).map(id => Object.assign({ id }, wars[id]))).map(r => {
        const w = r.war || r, fs = r.factions || {};
        const fl = Array.isArray(fs) ? fs : Object.keys(fs).map(id => Object.assign({ id }, fs[id]));
        const us = fl.find(f => String(f.id) === myF) || fl[0] || {}, them = fl.find(f => f !== us) || {};
        return { id: String(r.id || ''), start: Number(w.start) || 0, end: Number(w.end) || 0, target: Number(w.target) || 0, winner: String(w.winner || ''),
          us: { id: String(us.id || myF), name: String(us.name || fj.name || 'Your faction'), score: Number(us.score) || 0, chain: Number(us.chain) || 0 },
          them: { id: String(them.id || ''), name: String(them.name || '?'), score: Number(them.score) || 0, chain: Number(them.chain) || 0 } };
      }).sort((a, b) => b.start - a.start);
      const war = list.find(w => !w.end) || list.find(w => w.end * 1000 > now - 2 * 86400000) || null;
      x.faction = { id: myF, name: String(fj.name || '') };
      x.war = war;
      // your hits in this war
      if (war && war.start * 1000 <= now) {
        const from = war.start, to0 = war.end || null;
        let hits = 0, respect = 0, to = to0, me = x.me || null;
        for (let page = 0; page < 5; page++) {
          const aj = await apiGet('/user/?selections=basic,attacks&from=' + from + (to ? '&to=' + to : ''), key);
          me = String(aj.player_id || me || '');
          const at = aj.attacks || {}, rows = Array.isArray(at) ? at : Object.keys(at).map(k => at[k]);
          rows.forEach(a => { if (String(a.attacker_id) === me && Number(a.ranked_war) === 1) { hits++; respect += Number(a.respect_gain) || Number(a.respect) || 0; } });
          if (rows.length < 100) break;
          to = Math.min(...rows.map(a => Number(a.timestamp_started) || Infinity)) - 1;
          if (!(to > from)) break;
        }
        x.me = me; x.hits = { warId: war.id, n: hits, respect, at: now };
      }
      x.at = now; x.error = null;
    } catch (err) {
      x.at = now; x.error = (err.code != null ? 'Error ' + err.code + ': ' : '') + (err.message || 'failed');
    } finally { writeWar(x); warBusy = false; if (isMenuOpen() && (VIEW === 'war' || VIEW === 'home')) rebuildContent(); }
  }
  function warStatus(w) {
    const now = Date.now();
    if (!w) return null;
    if (w.start * 1000 > now) return { k: 'soon', t: w.start * 1000 };
    if (!w.end) return { k: 'live', t: w.start * 1000 };
    return { k: 'over', won: w.winner && w.winner === w.us.id };
  }
  function buildWarCard(compact) {
    const x = warMem || {}, w = x.war, st = warStatus(w);
    if (!w) return compact ? null : el('div', { class: 'bm-section bm-tr-card' }, el('div', { class: 'bm-tr-head' }, '⚔️ Ranked war'),
      el('div', { class: 'bm-status', style: { textAlign: 'left' } }, x.at ? 'No ranked war scheduled for ' + ((x.faction && x.faction.name) || 'your faction') + '.' : 'Checking…'));
    if (compact && st.k === 'over') return null;
    const lead = w.us.score - w.them.score, pct = w.target ? Math.max(0, Math.min(100, Math.abs(lead) / w.target * 100)) : 0;
    const hits = x.hits && x.hits.warId === w.id ? x.hits : null;
    return el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '⚔️ Ranked war', el('small', null, st.k === 'soon' ? 'starts in ' + fmtCountdown(st.t - Date.now()) : st.k === 'live' ? 'LIVE' : st.won ? 'won' : 'ended')),
      el('a', { class: 'bm-war-vs', href: TORN + 'factions.php?step=your#/war/rank' },
        el('div', { class: 'bm-war-side' }, el('span', null, w.us.name), el('b', null, fmtN(w.us.score))),
        el('div', { class: 'bm-war-mid' }, 'vs'),
        el('div', { class: 'bm-war-side them' }, el('span', null, w.them.name), el('b', null, fmtN(w.them.score)))),
      w.target && st.k !== 'soon' ? el('div', { class: 'bm-war-bar' + (lead < 0 ? ' behind' : '') }, el('i', { style: { width: pct + '%' } })) : null,
      el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-home-l' }, st.k === 'soon' ? 'Starts' : st.k === 'live' ? 'Lead' : 'Result'),
        st.k === 'soon' ? el('span', { class: 'bm-home-cd' }, el('span', { class: 'bm-cd', 'data-bm-cd': String(st.t), 'data-bm-zero': 'now' }, fmtCountdown(st.t - Date.now())))
          : st.k === 'live' ? el('b', { class: lead >= 0 ? 'pos' : 'neg' }, (lead >= 0 ? '+' : '−') + fmtN(Math.abs(lead)) + (w.target ? ' / ' + fmtN(w.target) : ''))
          : el('b', { class: st.won ? 'pos' : 'neg' }, st.won ? 'Won' : 'Lost')),
      compact ? null : [
        el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-home-l' }, 'Your war hits', el('div', { class: 'bm-chk-sub' }, hits ? 'checked ' + timeAgo(hits.at) : 'from your attacks once it starts')), el('b', null, hits ? hits.n + (hits.respect ? ' · ' + fmtN(Math.round(hits.respect * 100) / 100) + ' respect' : '') : '-')),
        el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-home-l' }, 'Chains'), el('b', null, fmtN(w.us.chain) + ' vs ' + fmtN(w.them.chain))),
        el('div', { class: 'bm-sub' }, (st.k === 'live' ? 'Updates every 2 minutes while this tab is open.' : 'Checked every 30 minutes.') + (x.at ? ' Last ' + timeAgo(x.at) + '.' : ''))]);
  }
  function buildWar(container) {
    if (!buildWar._loaded) { buildWar._loaded = true; warReady.then(() => { if (VIEW === 'war' && isMenuOpen()) rebuildContent(); }); }
    refreshWar(false);
    if (!warTimer) warTimer = setInterval(() => { if (VIEW === 'war' && isMenuOpen() && warLive(warMem.war)) refreshWar(false); else if (VIEW !== 'war' || !isMenuOpen()) { clearInterval(warTimer); warTimer = null; } }, 30000);
    container.appendChild(el('div', { class: 'bm-sticky', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
      el('div', { class: 'bm-status', style: { textAlign: 'left' } }, warMem.at ? 'Updated ' + timeAgo(warMem.at) : 'Loading…'),
      el('button', { class: 'refresh-btn', onclick: async ev => { ev.currentTarget.textContent = '…'; await refreshWar(true); rebuildContent(); } }, '↻ Refresh')));
    if (warMem.error) container.appendChild(el('div', { class: 'bm-error' }, '❌ ' + warMem.error));
    container.appendChild(buildWarCard(false));
    container.appendChild(buildListCard());
  }

  /* ---------------- OVERVIEW (Home card) ----------------
     Yesterday and the last 7 full days, from data already saved on this device. Nothing is sent anywhere. */
  // Overview of `n` Torn days starting at `from` (ms, a Torn midnight), from data already saved on this device.
  function overviewLines(from, n) {
    const out = [], to = from + n * 86400000, inWin = t => t >= from && t < to, dayKeys = []; for (let i = 0; i < n; i++) dayKeys.push(from + i * 86400000);
    const money = v => (v < 0 ? '\u2212' : '') + fmtCash(Math.abs(v));
    // money in and out, from the log (priced at today's values)
    let inc = 0, cost = 0; const incParts = [], costParts = []; let races = 0;
    try {
      LOG_SOURCES.forEach(src => {
        const L = portMem.logs && portMem.logs[src.k]; if (!L || !L.days) return;
        let cnt = 0, val = 0;
        dayKeys.forEach(k => { const b = L.days[k]; if (!b) return; cnt += b.n; const v = logBucketValue(src, b); if (v) val += v; });
        if (src.hide) { if (src.k === 'raced') races = cnt; return; }
        if (!cnt) return;
        const label = src.label + (src.item || src.byItem || src.points ? ' \u00d7' + cnt : '') + ' ' + fmtCash(val);
        if (src.kind === 'out') { cost += val; costParts.push(label); } else { inc += val; incParts.push(label); }
      });
    } catch (e) { /* no log data */ }
    let fly = 0, trips = 0;
    try { (travelMem.trips || []).forEach(t => { if (inWin(t.t * 1000)) { fly += tripValue(t).profit; trips++; } }); } catch (e) { /* no travel data */ }
    let oc = 0; try { (portMem.oc || []).forEach(r => { if (inWin(r.ts * 1000)) oc += r.amt; }); } catch (e) { /* none */ }
    let comp = null; try { readComp().days.forEach(r => { if (inWin(r.day)) comp = (comp || 0) + (Number(r.profit) || 0); }); } catch (e) { /* none */ }
    if (inc || incParts.length) out.push('💰 Income **' + fmtCash(inc) + '**' + (incParts.length ? ' \u2013 ' + incParts.join(', ') : ''));
    if (trips) out.push('\u2708\ufe0f Travel profit **' + money(fly) + '** from ' + trips + ' trip' + (trips === 1 ? '' : 's'));
    if (oc) out.push('🎯 Faction OC payouts **' + fmtCash(oc) + '**');
    if (comp != null) out.push('🏢 Company profit **' + money(comp) + '**');
    if (cost || costParts.length) out.push('💸 Costs **' + fmtCash(cost) + '**' + (costParts.length ? ' \u2013 ' + costParts.join(', ') : ''));
    const net = inc + fly + oc - cost;
    if (inc || fly || oc || cost) out.push('🧮 Net (without company) **' + money(net) + '**');
    // gym
    try {
      const wk = readGym().week, tot = { e: 0, n: 0, g: 0 };
      if (wk) dayKeys.forEach(k => { const o = wk.days[k]; if (!o) return; tot.e += o.e; tot.n += o.n; Object.keys(o.g || {}).forEach(s2 => { tot.g += o.g[s2]; }); });
      if (tot.n) out.push('💪 Gym **' + fmtN(tot.e) + 'e** in ' + tot.n + ' train' + (tot.n === 1 ? '' : 's') + (tot.g ? ', stats **+' + fmtN(Math.round(tot.g)) + '**' : ''));
    } catch (e) { /* no gym data */ }
    // offences
    try {
      const snaps = readCrimes().snaps || [], at = t => { const c = snaps.filter(x => x.total != null && x.t <= t).sort((a, b) => b.t - a.t)[0]; return c || null; };
      const a = at(from + 3600000) || at(from), b = at(to + 3600000) || at(to);
      if (a && b && b.t - a.t > 12 * 3600000 && b.total >= a.total) out.push('📈 Offences **+' + fmtN(b.total - a.total) + '**');
    } catch (e) { /* no crimes data */ }
    if (races) out.push('🏁 Races finished **' + races + '**');
    // networth
    try {
      const d = readNw().days, a = d.find(r => r.day === from), b = d.find(r => r.day === to);
      if (a && b) out.push('🏦 Networth **' + money(b.total - a.total) + '** (now ' + fmtCash(b.total) + ')');
    } catch (e) { /* no networth data */ }
    // buddies
    try {
      const got = buddyEntries(readLog().entries).filter(e => inWin(e.ts * 1000)), val = got.reduce((s2, e) => s2 + (entryValue(e).value || 0), 0);
      if (got.length) out.push('💬 Buddies sent **' + got.length + '** item drop' + (got.length === 1 ? '' : 's') + (val ? ' worth ' + fmtCash(val) : ''));
    } catch (e) { /* no buddy log */ }
    return out;
  }
  let ovBusy = false;
  function buildOverviewCard() {
    const day = lastTornMidnight(), mode = prefs.ovMode === 'week' ? 'week' : 'day';
    const fresh = portMem.logsAt >= day && portMem.logsV === 3;
    // the figures need today's log read: run the once-a-day refreshes the first time the card is shown each day
    if (!fresh && !ovBusy && getKey().key) {
      ovBusy = true;
      (async () => { try { await refreshPortfolio(false); await refreshGym(false); await refreshTravel(false); await refreshNetworth(false); } catch (e) { /* shown as not ready */ }
        finally { setTimeout(() => { ovBusy = false; }, 60000); if (isMenuOpen() && VIEW === 'home') rebuildContent(); } })();
    }
    const fmtD = t => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const from = mode === 'week' ? day - 7 * 86400000 : day - 86400000, n = mode === 'week' ? 7 : 1;
    const lines = fresh ? overviewLines(from, n) : [];
    const pill = (m, label) => el('div', { class: 'bm-pill' + (mode === m ? ' active' : ''), onclick: () => { prefs.ovMode = m; saveConfig(); rebuildContent(); } }, label);
    // "**bold**" parts become <b>
    const rich = t => String(t).split('**').map((part, i) => (i % 2 ? el('b', null, part) : part));
    return el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-cap' }, 'Overview'),
      el('div', { style: { display: 'flex', gap: '6px', margin: '2px 0 4px' } }, pill('day', 'Yesterday'), pill('week', 'Last week')),
      el('div', { class: 'bm-sub' }, mode === 'week' ? fmtD(from) + ' to ' + fmtD(day - 86400000) + ' (the last 7 full days)' : fmtD(from)),
      !fresh ? el('div', { class: 'bm-status', style: { textAlign: 'left' } }, getKey().key ? 'Getting today\u2019s figures…' : 'Needs an API key.')
        : lines.length ? lines.map(l => el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-home-l' }, rich(l))))
        : el('div', { class: 'bm-status', style: { textAlign: 'left' } }, 'Nothing recorded for ' + (mode === 'week' ? 'last week' : 'yesterday') + ' yet.'));
  }

  /* ---------------- NETWORTH ----------------
     One snapshot a day (user -> networth): total and where it sits (bank, stocks, items, points...). Kept 400 days. */
  const NW_KEY = 'bm-networth-v1';
  let nwMem = {}, nwBusy = false;
  const nwReady = IDB.get(NW_KEY).then(x => { nwMem = Object.assign({}, x || {}, nwMem); }).catch(() => {});
  const readNw = () => { const c = JSON.parse(JSON.stringify(nwMem || {})); c.days = Array.isArray(c.days) ? c.days : []; return c; };
  function writeNw(c) { nwMem = JSON.parse(JSON.stringify(c)); persist(NW_KEY, nwMem); }
  const NW_PARTS = { wallet: 'Wallet', bank: 'City bank', cayman: 'Cayman bank', vault: 'Property vault', piggybank: 'Piggy bank', points: 'Points', stockmarket: 'Stocks', items: 'Items', displaycase: 'Display case', bazaar: 'Bazaar', itemmarket: 'Item market', trade: 'Trades', auctionhouse: 'Auction house', properties: 'Properties', company: 'Company', bookie: 'Bookie', enlistedcars: 'Cars', pending: 'Pending', loan: 'Loan', unpaidfees: 'Unpaid fees' };
  async function refreshNetworth(force) {
    await nwReady; await storeReady;
    if (nwBusy) return;
    const c = readNw(), day = lastTornMidnight(), now = Date.now();
    if (!force && c.at && c.at >= day) return;           // once per Torn day
    if (force && c.at && now - c.at < 15000) return;
    const { key } = getKey(); if (!key) return;
    nwBusy = true;
    try {
      const nw = (await apiGet('/user/?selections=networth', key)).networth || {};
      const parts = {}; Object.keys(NW_PARTS).forEach(k => { const v = Number(nw[k]); if (v) parts[k] = v; });
      const total = Number(nw.total) || Object.keys(parts).reduce((a, k) => a + parts[k], 0);
      const x = readNw();
      x.days = x.days.filter(r => r.day !== day).concat([{ day, at: now, total, parts }]).sort((a, b) => b.day - a.day).slice(0, 400);
      x.at = now; x.error = null; writeNw(x);
    } catch (e) {
      const x = readNw(); x.at = now; x.error = (e.code != null ? 'Error ' + e.code + ': ' : '') + (e.message || 'failed'); writeNw(x);
    } finally { nwBusy = false; if (isMenuOpen() && (VIEW === 'portfolio' || VIEW === 'home')) rebuildContent(); }
  }
  // change vs the closest snapshot at least `days` ago (or the oldest one)
  function nwChange(days) {
    const d = readNw().days; if (d.length < 2) return null;
    const cutoff = d[0].day - days * 86400000;
    const ref = d.find(r => r.day <= cutoff) || d[d.length - 1];
    return ref === d[0] ? null : { diff: d[0].total - ref.total, from: ref };
  }
  function nwSpark(days) {
    const pts = days.slice().reverse(); if (pts.length < 2) return null;
    const W = 240, H = 44, min = Math.min(...pts.map(p => p.total)), max = Math.max(...pts.map(p => p.total)), span = max - min || 1;
    const xy = pts.map((p, i) => [Math.round(i / (pts.length - 1) * W * 10) / 10, Math.round((H - 3 - (p.total - min) / span * (H - 6)) * 10) / 10]);
    const up = pts[pts.length - 1].total >= pts[0].total;
    const box = el('div', { class: 'bm-nw-spark' });
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" width="100%" height="' + H + '"><polyline fill="none" stroke="' + (up ? '#85b200' : '#f0604d') + '" stroke-width="2" vector-effect="non-scaling-stroke" points="' + xy.map(p => p.join(',')).join(' ') + '"/></svg>';
    return box;
  }
  function buildNetworthCard() {
    const c = readNw(); if (!c.days.length && !c.error) return null;
    const last = c.days[0], d1 = nwChange(1), d7 = nwChange(7), d30 = nwChange(30);
    const chg = (l, v) => el('div', { class: 'bm-val-tot' }, el('b', { class: v == null ? 'na' : v.diff < 0 ? 'neg' : '' }, v == null ? '-' : (v.diff >= 0 ? '+' : '') + fmtCash(v.diff)), el('small', null, l));
    const parts = last ? Object.keys(last.parts || {}).map(k => [k, last.parts[k]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])) : [];
    return el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '📊 Networth', el('small', null, last ? fmtCash(last.total) : '')),
      c.error ? el('div', { class: 'bm-error' }, '\u274c ' + c.error) : null,
      last ? el('div', { class: 'bm-val-tots' }, chg('since yesterday', d1), chg('7 days', d7), chg('30 days', d30)) : null,
      nwSpark(c.days.slice(0, 30)),
      parts.map(([k, v]) => el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-home-l' }, NW_PARTS[k] || k),
        el('b', { class: v < 0 ? 'neg' : '' }, fmtCash(v)), el('span', { class: 'bm-nw-pct' }, last.total ? Math.round(v / last.total * 100) + '%' : ''))),
      el('div', { class: 'bm-sub' }, c.days.length + ' daily snapshot' + (c.days.length === 1 ? '' : 's') + ' \u00b7 taken once a day (Torn day)' + (c.days.length < 8 ? ' \u2013 the 7 and 30 day changes fill in as days are recorded' : '')));
  }

  /* ---------------- COMPANY INCOME ----------------
     A daily record like Torn Stats: income, wages, ad budget, stock, profit, customers, employees, rating.
     One call a day (company -> profile, detailed, employees, stock) on any page after 20:00 TCT, or when you tap Fetch.
     Torn's API has no history, so the record starts from your first fetch. */
  const COMPDAY_KEY = 'bm-compday-v1';
  let compMem = {}, compBusy = false, compOpen = {}, compWeeksShown = 8;
  const compReady = IDB.get(COMPDAY_KEY).then(c => { compMem = Object.assign({}, c || {}, compMem); }).catch(() => {});
  function syncComp() { return IDB.get(COMPDAY_KEY).then(c => { if (c) compMem = c; }).catch(() => {}); }
  const readComp = () => { const c = JSON.parse(JSON.stringify(compMem || {})); c.days = Array.isArray(c.days) ? c.days : []; return c; };
  function writeComp(c) { compMem = JSON.parse(JSON.stringify(c)); persist(COMPDAY_KEY, compMem); }
  // The day a fetch belongs to: the TCT date of the last 20:00 TCT (so a fetch at 10:00 records yesterday's figures).
  function compDayFor(t) { const d = new Date(lastRankUpdateTime(t)); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
  // Monday 00:00 TCT of the week a day belongs to (weeks run Monday to Sunday).
  const weekStart = day => day - ((new Date(day).getUTCDay() + 6) % 7) * 86400000;
  function parseCompanyDay(j) {
    const p = j.company || {}, det = j.company_detailed || {}, emps = j.company_employees || {}, st = j.company_stock || null;
    const num = v => (v == null || isNaN(Number(v)) ? null : Number(v));
    if (p.daily_income == null) return null;
    let wages = null;
    (Array.isArray(emps) ? emps : Object.keys(emps).map(k => emps[k])).forEach(e => { const w = e && num(e.wage); if (w != null) wages = (wages || 0) + w; });
    let stock = null;
    if (st && typeof st === 'object') { stock = 0; Object.keys(st).forEach(k => { const x = st[k] || {}; stock += (num(x.cost) || 0) * (num(x.sold_amount) || 0); }); }
    const income = num(p.daily_income), ad = num(det.advertising_budget);
    return { income, wages, ad, stock, profit: income - (wages || 0) - (ad || 0) - (stock || 0),
      cust: num(p.daily_customers), emp: num(p.employees_hired), cap: num(p.employees_capacity), rating: num(p.rating), weekly: num(p.weekly_income),
      funds: num(det.company_funds), pop: num(det.popularity), effi: num(det.efficiency), env: num(det.environment), name: String(p.name || '') };
  }
  async function refreshCompanyDay(force) {
    await compReady; await storeReady; await syncComp();
    if (compBusy) return;
    const now = Date.now(), c = readComp();
    if (!force) {
      if (c.at && c.at >= lastRankUpdateTime(now)) return; // already have today's figures (or today's error)
      if (c.none && now - c.at < 7 * 86400000) return;      // not in a company: check again weekly
    } else if (c.at && now - c.at < 15000) return;
    const { key } = getCompanyKey(); if (!key) { if (force) toast('No API key yet', '\u26a0\ufe0f'); return; }
    compBusy = true;
    try {
      let j, director = true;
      try { j = await apiGet('/company/?selections=profile,detailed,employees,stock', key); }
      catch (e) { if (e.code !== 7 && e.code !== 16) throw e; director = false; j = await apiGet('/company/?selections=profile,employees', key); }
      const d = parseCompanyDay(j);
      const x = readComp();
      if (!d) { x.at = now; x.none = true; x.error = 'No company found for this key'; writeComp(x); return; }
      const day = compDayFor(now);
      d.day = day; d.at = now;
      x.days = x.days.filter(r => r.day !== day).concat([d]).sort((a, b) => b.day - a.day).slice(0, 400);
      Object.assign(x, { at: now, error: null, none: false, director, name: d.name });
      writeComp(x);
    } catch (e) {
      const x = readComp(); x.at = now; x.error = (e.code != null ? 'Error ' + e.code + ': ' : '') + (e.message || 'failed'); writeComp(x);
    } finally {
      compBusy = false;
      if (isMenuOpen() && (VIEW === 'income' || VIEW === 'home')) rebuildContent();
    }
  }
  // Torn Stats company table, copied from the page and pasted in. Works whether the copy keeps the table's
  // tabs or puts every cell on its own line: each date starts a row, the amounts after it fill the columns
  // Income, Wages, Ad Budget, Stock, Profit, Cust, Employees, Rating. "Weekly Total" rows are skipped.
  function parseTornStatsCompany(text) {
    const toks = String(text || '').replace(/\u00a0/g, ' ').split(/[\s|]+/).filter(Boolean);
    const out = [];
    let cur = null;
    const money = t => { const m = /^(\()?(-)?\$?(-)?([\d,]+(?:\.\d+)?)\)?$/.exec(t); if (!m) return null; const v = Number(m[4].replace(/,/g, '')); return isNaN(v) ? null : (m[1] || m[2] || m[3] ? -v : v); };
    const finish = () => {
      if (!cur) return;
      const n = cur.nums;
      if (n.length >= 6) {
        const [income, wages, ad, stock, profit, cust, emp, rating] = n;
        out.push({ day: cur.day, income, wages, ad, stock, profit: profit != null ? profit : income - wages - ad - stock, cust,
          emp: emp != null ? emp : null, rating: rating != null && rating <= 10 ? rating : null, src: 'tornstats' });
      }
      cur = null;
    };
    toks.forEach(t => {
      const d = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
      if (d) {
        finish();
        const y = d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3]);
        const day = Date.UTC(y, Number(d[2]) - 1, Number(d[1]));
        cur = isNaN(day) ? null : { day, nums: [] };
        return;
      }
      if (!cur) return;
      const v = money(t);
      if (v == null) { finish(); return; } // "Weekly", "Total", icons ... end the row
      cur.nums.push(v);
    });
    finish();
    // one row per day (first copy wins)
    const seen = new Set();
    return out.filter(r => (seen.has(r.day) ? false : (seen.add(r.day), true)));
  }
  function importTornStats(text) {
    const rows = parseTornStatsCompany(text);
    if (!rows.length) return { added: 0, kept: 0, found: 0 };
    const x = readComp(), have = new Set(x.days.map(r => r.day));
    const add = rows.filter(r => !have.has(r.day));
    x.days = x.days.concat(add).sort((a, b) => b.day - a.day).slice(0, 400);
    writeComp(x);
    return { added: add.length, kept: rows.length - add.length, found: rows.length };
  }
  function buildTornStatsImport(open) {
    const box = el('textarea', { class: 'bm-input', rows: '4', placeholder: 'Paste the Torn Stats company table here', style: { fontSize: '9px', marginTop: '4px', resize: 'vertical' } });
    const det = el('details', { class: 'bm-section bm-tr-card' },
      el('summary', { style: { cursor: 'pointer', fontWeight: '800' } }, '📥 Import from Torn Stats'),
      el('div', { class: 'bm-sub', style: { lineHeight: '1.5', marginTop: '4px' } },
        'On Torn Stats open your company page, set 100 entries per page, select the table from the first date to the last row and copy it. Paste it below. Days already here are kept; weekly totals are skipped.'),
      box,
      el('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } },
        el('button', { class: 'refresh-btn', onclick: () => {
          const r = importTornStats(box.value);
          if (!r.found) { toast('No days found \u2013 copy the table including the dates', '\u26a0\ufe0f'); return; }
          toast('Imported ' + r.added + ' day' + (r.added === 1 ? '' : 's') + (r.kept ? ' \u00b7 ' + r.kept + ' already here' : ''), '📥');
          compWeeksShown = Math.max(compWeeksShown, 8); rebuildContent();
        } }, 'Import'),
        el('button', { class: 'remove-btn', onclick: () => { box.value = ''; } }, 'Clear')));
    if (open) det.setAttribute('open', '');
    return det;
  }
  const sumDays = (days, k) => days.reduce((a, r) => a + (r[k] || 0), 0);
  const fmtDay = day => { const d = new Date(day); return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
  const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // This week so far vs the same days last week.
  function compWeekCompare(days) {
    if (!days.length) return null;
    const latest = days[0].day, ws = weekStart(latest), n = Math.round((latest - ws) / 86400000) + 1;
    const cur = days.filter(r => r.day >= ws && r.day <= latest);
    const prev = days.filter(r => r.day >= ws - 7 * 86400000 && r.day < ws - 7 * 86400000 + n * 86400000);
    return { cur, prev, n, profit: sumDays(cur, 'profit'), income: sumDays(cur, 'income'), prevProfit: prev.length === cur.length && prev.length ? sumDays(prev, 'profit') : null };
  }
  function buildIncome(container) {
    if (!buildIncome._loaded) { buildIncome._loaded = true; compReady.then(() => { if (VIEW === 'income' && isMenuOpen()) rebuildContent(); }); }
    const c = readComp(), k = getCompanyKey();
    container.appendChild(el('div', { class: 'bm-sticky', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
      el('div', { class: 'bm-status', style: { textAlign: 'left' } }, c.at ? 'Fetched ' + timeAgo(c.at) + ' \u00b7 auto after 20:00 TCT' : 'Not fetched yet'),
      el('button', { class: 'refresh-btn', disabled: k.key ? null : 'disabled', onclick: async ev => { ev.currentTarget.textContent = '\u2026'; await refreshCompanyDay(true); rebuildContent(); } }, '\u21bb Fetch today')));
    if (c.error) container.appendChild(el('div', { class: 'bm-error' }, '\u274c ' + c.error));
    if (c.at && c.director === false) container.appendChild(el('div', { class: 'bm-rk-note' }, 'Only the director can see wages, ad budget and stock \u2013 profit shown is income only.'));
    const days = c.days;
    if (!days.length) {
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' }, el('div', { class: 'bm-status', style: { textAlign: 'left' } },
        'Tap \u21bb Fetch today to record your first day. After that it records itself once a day after 20:00 TCT. Torn\u2019s API has no history \u2013 to see earlier days, import them from Torn Stats below.')));
      container.appendChild(buildTornStatsImport(true));
      return;
    }
    // Summary
    const wk = compWeekCompare(days), last = days[0];
    const diff = wk.prevProfit != null && wk.prevProfit !== 0 ? Math.round((wk.profit - wk.prevProfit) / Math.abs(wk.prevProfit) * 100) : null;
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-cap' }, (c.name || 'Your company') + ' \u00b7 ' + (last.rating != null ? last.rating + '\u2605' : '')),
      el('div', { class: 'bm-val-tots' },
        el('div', { class: 'bm-val-tot' }, el('b', { class: last.profit < 0 ? 'neg' : '' }, fmtCash(last.profit)), el('small', null, 'Profit ' + fmtDay(last.day))),
        el('div', { class: 'bm-val-tot' }, el('b', { class: wk.profit < 0 ? 'neg' : '' }, fmtCash(wk.profit)), el('small', null, 'Week so far \u00b7 ' + wk.cur.length + (wk.cur.length < wk.n ? '/' + wk.n : '') + 'd')),
        el('div', { class: 'bm-val-tot' }, el('b', { class: diff == null ? 'na' : diff < 0 ? 'neg' : '' }, diff == null ? '-' : (diff > 0 ? '+' : '') + diff + '%'), el('small', null, 'vs last week'))),
      // profit bars, last 14 days (oldest left)
      days.length < 3 ? null : el('div', { class: 'bm-sub', style: { marginTop: '2px' } }, 'Daily profit, last ' + Math.min(14, days.length) + ' days (tap a bar)'),
      days.length < 3 ? null : (() => {
        const d14 = days.slice(0, 14).reverse(), max = Math.max(1, ...d14.map(r => Math.abs(r.profit || 0)));
        return el('div', { class: 'bm-inc-bars' }, d14.map(r => el('div', { class: 'bm-inc-bar' + (r.profit < 0 ? ' neg' : '') + (new Date(r.day).getUTCDay() === 1 ? ' mon' : ''), title: fmtDay(r.day) + ': ' + fmtCash(r.profit), onclick: () => toast(WEEKDAY[new Date(r.day).getUTCDay()] + ' ' + fmtDay(r.day) + ': profit ' + fmtCash(r.profit), '💵') },
          el('i', { style: { height: Math.max(4, Math.round(Math.abs(r.profit || 0) / max * 100)) + '%' } }))));
      })(),
      el('div', { class: 'bm-sub' }, 'Profit = income \u2212 wages \u2212 ad budget \u2212 stock' + (days.length < 3 ? ' \u00b7 a daily profit chart appears after 3 days' : ''))));
    // Table grouped by week (Mon-Sun), newest first, weekly totals under each week
    // table cells: $310m / $43.9m / $2.5m so a column never needs more than 6 characters
    const fmtT = n => (n != null && Math.abs(n) >= 1e8 && Math.abs(n) < 1e9 ? (n < 0 ? '\u2212$' : '$') + Math.round(Math.abs(n) / 1e6) + 'm' : fmtCash(n));
    const table = el('div', { class: 'bm-section bm-tr-card bm-inc' },
      el('div', { class: 'bm-tr-cap' }, 'Daily record', el('small', null, days.length + ' days')),
      el('div', { class: 'bm-inc-row bm-inc-hd' }, el('span', null, 'Date'), el('span', null, 'Income'), el('span', null, 'Wages'), el('span', null, 'Ad'), el('span', null, 'Profit'), el('span', null, 'Cust')));
    const weeks = [];
    days.forEach(r => { const ws = weekStart(r.day); let w = weeks[weeks.length - 1]; if (!w || w.ws !== ws) { w = { ws, days: [] }; weeks.push(w); } w.days.push(r); });
    weeks.slice(0, compWeeksShown).forEach(w => {
      w.days.forEach(r => {
        const open = !!compOpen[r.day];
        table.appendChild(el('div', { class: 'bm-inc-row' + (open ? ' open' : ''), onclick: () => { compOpen[r.day] = !open; rebuildContent(); } },
          el('span', null, WEEKDAY[new Date(r.day).getUTCDay()] + ' ' + fmtDay(r.day)), el('span', null, fmtT(r.income)), el('span', null, r.wages == null ? '-' : fmtT(r.wages)), el('span', null, r.ad == null ? '-' : fmtT(r.ad)),
          el('span', { class: r.profit < 0 ? 'neg' : 'pos' }, fmtT(r.profit)), el('span', null, r.cust == null ? '-' : String(r.cust))));
        if (open) table.appendChild(el('div', { class: 'bm-inc-more' },
          el('div', null, 'Stock ', el('b', null, r.stock == null ? '-' : fmtT(r.stock))),
          el('div', null, 'Employees ', el('b', null, r.emp == null ? '-' : r.emp + (r.cap ? '/' + r.cap : '')), ' \u00b7 Rating ', el('b', null, r.rating == null ? '-' : r.rating + '\u2605')),
          r.pop != null ? el('div', null, 'Popularity ', el('b', null, String(r.pop)), ' \u00b7 Efficiency ', el('b', null, String(r.effi)), ' \u00b7 Environment ', el('b', null, String(r.env))) : null,
          r.funds != null ? el('div', null, 'Company funds ', el('b', null, fmtT(r.funds))) : null,
          el('div', null, 'Exact: income $' + fmtN(r.income) + (r.wages != null ? ' \u00b7 wages $' + fmtN(r.wages) : '') + (r.ad != null ? ' \u00b7 ad $' + fmtN(r.ad) : '') + ' \u00b7 profit $' + fmtN(r.profit)),
          r.src === 'tornstats' ? el('div', { style: { opacity: '.7' } }, 'Imported from Torn Stats') : null,
          el('a', { href: '#', style: { color: '#ff8a8a' }, onclick: ev => { ev.preventDefault(); ev.stopPropagation(); if (!confirm('Remove ' + fmtDay(r.day) + ' from the record?')) return; const x = readComp(); x.days = x.days.filter(y => y.day !== r.day); writeComp(x); rebuildContent(); } }, 'Remove this day')));
      });
      table.appendChild(el('div', { class: 'bm-inc-row bm-inc-tot' },
        el('span', { class: 'bm-inc-wk' }, 'Week ' + fmtDay(w.ws) + ' \u2013 ' + fmtDay(w.ws + 6 * 86400000) + ' total' + (w.days.length < 7 ? ' (' + w.days.length + ' of 7 days)' : '')), el('span', null, ''), el('span', null, fmtT(sumDays(w.days, 'income'))), el('span', null, fmtT(sumDays(w.days, 'wages'))), el('span', null, (v => (v >= 1e7 ? '$' + Math.round(v / 1e6) + 'm' : fmtT(v)))(sumDays(w.days, 'ad'))),
        el('span', { class: sumDays(w.days, 'profit') < 0 ? 'neg' : 'pos' }, fmtT(sumDays(w.days, 'profit'))), el('span', null, String(sumDays(w.days, 'cust')))));
    });
    container.appendChild(table);
    if (weeks.length > compWeeksShown) container.appendChild(el('button', { class: 'bm-cal-all', onclick: () => { compWeeksShown += 8; rebuildContent(); } },
      'Show 8 more weeks (' + days.length + ' days recorded)'));
    container.appendChild(buildTornStatsImport(false));
  }
  // Home card: latest day and the week so far.
  function buildCompanyHomeCard() {
    const c = readComp(); if (!c.days.length) return null;
    const last = c.days[0], wk = compWeekCompare(c.days);
    return el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-cap' }, 'Company'),
      el('div', { class: 'bm-home-row link', onclick: () => setView('income') }, el('span', { class: 'bm-home-l' }, '💵 Profit ' + WEEKDAY[new Date(last.day).getUTCDay()] + ' ' + fmtDay(last.day), el('div', { class: 'bm-chk-sub' }, 'income ' + fmtCash(last.income) + (last.wages != null ? ' \u00b7 wages ' + fmtCash(last.wages) : '') + (last.ad != null ? ' \u00b7 ad ' + fmtCash(last.ad) : ''))), el('b', null, fmtCash(last.profit))),
      el('div', { class: 'bm-home-row link', onclick: () => setView('income') }, el('span', { class: 'bm-home-l' }, '📅 Week so far', el('div', { class: 'bm-chk-sub' }, wk.cur.length + ' of 7 days recorded' + (wk.prevProfit != null ? ' \u00b7 last week ' + fmtCash(wk.prevProfit) + ' by now' : ''))), el('b', null, fmtCash(wk.profit))));
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
      employees: s.employees || {}, // id -> { name, position, MAN, INT, END, eff, last }, fetched with Check
      empAt: s.empAt || 0, // when last-action times were last fetched
      companyType: s.companyType || null,
      posReq: s.posReq || null, posReqAt: s.posReqAt || 0 // position -> { MAN, INT, END } required, for companyType
    };
  }
  function writeTrains(s) { trainsMem = JSON.parse(JSON.stringify(s)); persist(TRAINS_KEY, trainsMem); }
  const getCompanyKey = () => getKey(); // same key as the rest of the script

  // last_action: { status, timestamp, relative: "3 hours ago" } -> unix seconds (or null)
  function lastActionTs(la) {
    if (!la) return null;
    if (Number(la.timestamp) > 0) return Number(la.timestamp);
    const m = /(\d+)\s*(minute|hour|day)/i.exec(String(la.relative || ''));
    if (!m) return /now/i.test(String(la.relative || '')) ? Math.floor(Date.now() / 1000) : null;
    return Math.floor(Date.now() / 1000) - Number(m[1]) * ({ minute: 60, hour: 3600, day: 86400 })[m[2].toLowerCase()];
  }
  // company -> profile: { company: { ID, name, employees: { id: { name, position, ... } } } }
  function parseCompanyProfile(json) {
    const c = json && (json.company || json.profile);
    if (!c || (!c.name && !c.ID && !c.id)) return null;
    const emps = {};
    const list = c.employees || {};
    (Array.isArray(list) ? list.map(e => [String(e.id), e]) : Object.keys(list).map(id => [id, list[id]])).forEach(([id, e]) => {
      if (/^\d+$/.test(id)) emps[id] = { name: (e && e.name) || '', position: (e && e.position) || '', last: lastActionTs(e && e.last_action) };
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
        eff: e.effectiveness && e.effectiveness.total != null ? Number(e.effectiveness.total) : null, last: lastActionTs(e.last_action) };
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
      if (false && ctype && (!s.posReq || s.companyType !== ctype || now - s.posReqAt > 30 * 86400000)) { // position tips removed in 7.54.0
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
          t.employees = staff; t.empAt = now;
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
    return { snaps: Array.isArray(s.snaps) ? s.snaps : [], preds: Array.isArray(s.preds) ? s.preds : [], target: parseInt(s.target, 10) || 250, error: s.error || null, lastRefresh: s.lastRefresh || 0,
      hist: s.hist && typeof s.hist === 'object' ? s.hist : {} }; // local midnight (ms) -> offences total then (from Torn's stat history)
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
  // Local midnights for the last `days` days plus tomorrow's (ms).
  function crimeMidnights(days) {
    const out = [];
    for (let i = days - 1; i >= -1; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); out.push(d.getTime()); }
    return out;
  }
  function dailyOffences(snaps, days, hist) {
    const key = t => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
    const lastOf = {};
    snaps.slice().sort((a, b) => a.t - b.t).forEach(x => { if (x.total != null) lastOf[key(x.t)] = x; });
    const h = hist || {}, mids = crimeMidnights(days);
    const latest = snaps.slice().sort((a, b) => b.t - a.t).find(x => x.ps != null); // Torn's own counter, same source as the history
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
      const m0 = mids[days - 1 - i], m1 = mids[days - i];
      let n = null;
      // from the stat history: total at the next midnight minus total at this one (today: latest count minus midnight)
      if (h[m0] != null) {
        if (i === 0) { if (latest && latest.t >= m0) n = Math.max(0, latest.ps - h[m0]); }
        else if (h[m1] != null) n = Math.max(0, h[m1] - h[m0]);
      }
      if (n == null) { // fall back to refreshes on this day and the day before
        const prev = new Date(d); prev.setDate(prev.getDate() - 1);
        const a = lastOf[key(prev.getTime())], b = lastOf[key(d.getTime())];
        n = a && b ? b.total - a.total : null;
      }
      out.push({ date: d, n, today: i === 0 });
    }
    return out;
  }
  // Torn's personal-stat history: the offences total at a moment (or now). Returns a number or null.
  async function offencesAt(key, ts) {
    const j = await apiGet('/v2/user/personalstats?stat=criminaloffenses' + (ts ? '&timestamp=' + Math.floor(ts / 1000) : ''), key);
    const ps = j && j.personalstats;
    if (Array.isArray(ps)) { const r = ps.find(x => x && /criminaloffen/i.test(String(x.name))) || ps[0]; return r && r.value != null ? Number(r.value) : null; }
    if (ps && typeof ps === 'object') {
      if (ps.criminaloffenses != null) return Number(ps.criminaloffenses);
      const c = ps.crimes && ps.crimes.offenses; if (c && c.total != null) return Number(c.total);
    }
    return null;
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
      // Per-day counts from Torn's stat history, so days you didn't refresh still fill in. Past midnights never change,
      // so each is asked once (up to 8 the first time, then about one a day) plus 1 call for the count right now.
      try {
        const hist = Object.assign({}, s.hist || {}), mids = crimeMidnights(7).slice(0, 7);
        for (const m of mids.filter(m => hist[m] == null)) { const v = await offencesAt(key, m); if (v != null) hist[m] = v; else break; }
        const keep = mids[0] - 7 * 86400000; Object.keys(hist).forEach(k => { if (Number(k) < keep) delete hist[k]; });
        s.hist = hist;
        const nowV = await offencesAt(key, 0); if (nowV != null) snap.ps = nowV;
      } catch (e) { if (e.guard) throw e; /* keep the old way */ }
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
    const daily = dailyOffences(r.snaps, 7, s.hist);
    if (daily.some(d => d.n != null) || r.dayRef) {
      // "today so far" from the last refresh before midnight - only when the history didn't give it, and only if that
      // refresh was yesterday (an older one would lump several days into today)
      const mid0 = new Date(); mid0.setHours(0, 0, 0, 0);
      const todaySoFar = r.dayRef && r.dayRef.t >= mid0.getTime() - 86400000 ? L.total - r.dayRef.total : null;
      if (daily[daily.length - 1].n == null && todaySoFar != null) daily[daily.length - 1].n = todaySoFar;
      const max = Math.max.apply(null, daily.map(d => d.n || 0).concat([1]));
      const known = daily.filter(d => d.n != null && !d.today);
      const avg = known.length ? known.reduce((a, d) => a + d.n, 0) / known.length : null;
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-cap' }, 'Offences per day' + (avg != null ? ' \u00b7 avg ' + fmtN(avg) : '')),
        el('div', { class: 'bm-cr-days' }, daily.map(d => [
          el('span', { class: 'lbl' }, d.today ? 'Today' : d.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })),
          el('span', { class: 'bar' }, el('i', { style: { width: (d.n ? Math.max(3, Math.round(d.n / max * 100)) : 0) + '%' }, class: d.today ? 'today' : '' })),
          el('span', { class: 'num' }, d.n == null ? '-' : fmtN(d.n))])),
        el('div', { class: 'bm-tr-foot' }, 'From Torn\u2019s stat history, midnight to midnight (your time).')));
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
  // Where a bar is now: Torn adds `inc` every `every` seconds, the first at `tick` seconds after the refresh.
  const fmtK = n => (n >= 1000 ? (n / 1000).toFixed(n >= 100000 || n % 1000 === 0 ? 0 : 1) + 'k' : String(n)); // 65193 -> 65.2k
  function barNow(b, at, now) {
    now = now || Date.now();
    const out = { cur: b.cur, full: b.cur >= b.max, nextTick: null, fullAt: at + (b.full || 0) * 1000 };
    if (out.full || !b.inc || !b.every) return out; // full/over max, or no regen info: value as of refresh
    const elapsed = (now - at) / 1000;
    const ticks = elapsed >= b.tick ? 1 + Math.floor((elapsed - b.tick) / b.every) : 0;
    out.cur = Math.min(b.max, b.cur + ticks * b.inc);
    out.full = out.cur >= b.max;
    out.nextTick = at + (b.tick + ticks * b.every) * 1000;
    return out;
  }
  // Booster cooldown cap shown after the countdown (as in Torn's tooltip): 24h base + your faction's
  // "Booster cooldown" upgrade (Voracity branch), read once a day from faction -> upgrades.
  const BOOSTER_BASE_H = 24, MEDICAL_BASE_H = 6; // medical: + your faction's Fortitude "medical cooldown" upgrade
  // Hours added to a cooldown cap by your faction's current upgrades ("Adds 24 hours" / "Adds 180 minutes" ...).
  function upgradeBonusHours(json, what) {
    const set = json && (json.upgrades || {});
    let h = 0;
    const re = new RegExp('(\\d+)\\s*(hours?|minutes?|mins?)\\s+of\\s+maximum\\s+' + what + '\\s+cooldown', 'i');
    Object.keys(set).forEach(k => { const m = re.exec(String((set[k] || {}).ability || '')); if (m) h = Math.max(h, Number(m[1]) / (/^h/i.test(m[2]) ? 1 : 60)); });
    return h;
  }
  const boosterBonusHours = json => upgradeBonusHours(json, 'booster');
  // 116652000 ms -> "32:24:12" (hours can go past 24)
  function fmtHMS(ms) { const t = Math.max(0, Math.floor(ms / 1000)); const p = n => String(n).padStart(2, '0'); return p(Math.floor(t / 3600)) + ':' + p(Math.floor(t % 3600 / 60)) + ':' + p(t % 60); }
  const TORN = 'https://www.torn.com/';
  const HOME_LINKS = {
    drug: TORN + 'item.php#drugs-items',
    booster: TORN + 'item.php#boosters-items',
    medical: TORN + 'factions.php?step=your#/tab=armoury&start=0&sub=medical',
    refills: TORN + 'points.php',
    energy: TORN + 'gym.php',
    nerve: TORN + 'loader.php?sid=crimes',
    life: TORN + 'factions.php?step=your#/tab=armoury&start=0&sub=medical',
    hof: TORN + 'halloffame.php#/type=offences',
    shops: TORN + 'city.php',
    missions: TORN + 'page.php?sid=missions',
    wheel: TORN + 'page.php?sid=spinTheWheel',
    oc: TORN + 'factions.php?step=your#/tab=crimes',
    events: TORN + 'events.php#/step=all',
    messages: TORN + 'messages.php',
    hospital: TORN + 'hospitalview.php',
    jail: TORN + 'jailview.php',
    travel: TORN + 'index.php',
    chain: TORN + 'factions.php?step=your#/war/chain',
    bank: TORN + 'bank.php',
    cash: TORN + 'properties.php#/p=options&tab=vault',
    virus: TORN + 'pc.php',
    racing: TORN + 'loader.php?sid=racing',
    education: TORN + 'education.php',
    travelAgency: TORN + 'travelagency.php'
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
  const num0 = v => (v == null || isNaN(Number(v)) ? null : Number(v));
  // auto = page-load refresh: silent, and skipped if any page refreshed in the last 30s (Torn caches 30s anyway).
  // Home's Refresh: everything the script reads, in one go (about 15-20 calls, well under Torn's 100 a minute).
  let refreshingAll = false;
  async function refreshEverything(btn) {
    if (refreshingAll) return;
    refreshingAll = true;
    if (btn) btn.textContent = '\u2026';
    const quiet = p => Promise.resolve().then(() => p).catch(() => {});
    try {
      await quiet(refreshHome());
      // one after another; the API pacing keeps the whole lot under Torn's limit
      for (const f of [() => refreshCalendar(true), () => pollLogs(true), () => pollTrains(true), () => refreshCrimes(), () => refreshCompanyDay(true), () => refreshNetworth(true),
        () => refreshGym(true), () => refreshWar(true), () => refreshBusts(true), () => refreshTravel(true), () => refreshPortfolio(true), () => refreshPrices(true), () => refreshRank(true)]) await quiet(f());
      toast('Everything refreshed', '\u21bb');
    } finally {
      refreshingAll = false;
      if (isMenuOpen()) rebuildContent();
      refreshIndicators();
    }
  }
  async function refreshHome(auto) {
    await homeReady; await storeReady; await syncHome();
    if (homeBusy) return;
    const h = readHome();
    if (Date.now() - (h.at || 0) < (auto ? 30000 : 15000)) { if (!auto) toast('Refreshed a moment ago', '\u23f3'); return; }
    const { key } = getKey(); if (!key) { if (!auto) toast('No API key yet', '\u26a0\ufe0f'); return; }
    homeBusy = true;
    try {
      // One call: cooldowns, refills, bars + personal stats (shop purchases, contracts) + Duke missions.
      // + money (city bank) and education for the Timers card. A key below Limited access can't read money:
      // then retry once without it and remember.
      const sel = 'cooldowns,refills,bars,personalstats,missions,basic,travel,notifications,education,icons';
      let noMoney = !!h.noMoney, j;
      try { j = await apiGet('/user/?selections=' + sel + (noMoney ? '' : ',money'), key); }
      catch (e) { if (e.code !== 16 || noMoney) throw e; noMoney = true; j = await apiGet('/user/?selections=' + sel, key); }
      const at = Date.now();
      // Education course names: looked up once (1 call) when you start a course we haven't named yet.
      const eduCur = Number(j.education_current) || 0;
      let eduNames = h.eduNames || {};
      if (eduCur && !eduNames[eduCur]) {
        try {
          const ej = (await apiGet('/torn/?selections=education', key)).education || {};
          const list = Array.isArray(ej) ? ej : Object.keys(ej).map(id => Object.assign({ id }, ej[id]));
          const nn = {}; list.forEach(x => { if (x && x.id != null && x.name) nn[x.id] = String(x.name); (x && Array.isArray(x.courses) ? x.courses : []).forEach(c => { if (c && c.id != null && c.name) nn[c.id] = String(c.name); }); });
          eduNames = Object.assign({}, eduNames, nn);
        } catch (e) { /* name stays unknown */ }
      }
      const cd = j.cooldowns || {}, rf = j.refills || {}, ps = j.personalstats || {};
      const bar = b => b ? { cur: Number(b.current) || 0, max: Number(b.maximum) || 0, full: Number(b.fulltime) || 0,
        inc: Number(b.increment) || 0, every: Number(b.interval) || 0, tick: Number(b.ticktime) || 0 } : null;
      const stats = { shop: num0(ps.cityitemsbought), contracts: num0(ps.contractscompleted) };
      const duke = ((j.missions || {}).Duke || []).map(m => ({ title: m.title || '', status: String(m.status || '') }));
      // Baseline = the same stats at Torn midnight, looked up once a day (1 call); first refresh of the day as a fallback.
      const midnight = lastTornMidnight();
      let base = h.base && h.base.day === midnight ? h.base : null;
      if (!base) {
        try {
          const hj = await apiGet('/v2/user/personalstats?stat=cityitemsbought,contractscompleted&timestamp=' + Math.floor(midnight / 1000), key);
          const hv = {}; (hj.personalstats || []).forEach(x => { hv[x.name] = num0(x.value); });
          base = { day: midnight, shop: hv.cityitemsbought != null ? hv.cityitemsbought : stats.shop, contracts: hv.contractscompleted != null ? hv.contractscompleted : stats.contracts, exact: hv.cityitemsbought != null };
        } catch (e) { base = { day: midnight, shop: stats.shop, contracts: stats.contracts, exact: false }; }
      }
      // Organised crime: at most every 10 minutes (it changes slowly).
      let oc = h.oc || null;
      if (!oc || at - (oc.at || 0) > 600000) {
        try {
          const o = (await apiGet('/v2/user/organizedcrime', key)).organizedCrime;
          oc = { at, has: !!o, name: o ? String(o.name || 'OC') : '', status: o ? String(o.status || '') : '', ready: o && o.ready_at ? Number(o.ready_at) : null, err: null };
        } catch (e) { oc = { at, has: false, err: (e.code != null ? 'Error ' + e.code : 'unavailable') }; }
      }
      // Wheel of Awesome: the casino's daily spin (resets at midnight TCT). The spin log types are looked up
      // once a week; today's spins are checked at most every 10 minutes and not at all once it's been spun.
      let wheel = h.wheel && h.wheel.day === midnight ? h.wheel : { day: midnight, spun: false, at: 0 };
      let wheelTypes = h.wheelTypes || null;
      if (!wheelTypes || at - (wheelTypes.at || 0) > 7 * 86400000) {
        try {
          let lt = (await apiGet('/torn/?selections=logtypes', key)).logtypes || {};
          lt = Array.isArray(lt) ? lt.map(x => ({ id: String(x.id), title: String(x.title || '') })) : Object.keys(lt).map(id => ({ id, title: String(lt[id] && lt[id].title ? lt[id].title : lt[id]) }));
          wheelTypes = { at, ids: lt.filter(x => /spin the wheel/i.test(x.title)).map(x => x.id), titles: lt.filter(x => /wheel/i.test(x.title)).map(x => x.title).slice(0, 12) };
        } catch (e) { if (!wheelTypes) wheelTypes = null; }
      }
      if (!wheelTypes || !wheelTypes.ids.length) wheelTypes = { at, ids: ['8370', '8371', '8372', '8373', '8374', '8375', '8376', '8377', '8378', '8379'], titles: [] }; // Torn's spin-the-wheel log types
      if (!wheel.spun && at - (wheel.at || 0) > (auto ? 600000 : 30000)) { // every 10 min, or 30s when you tap Refresh
        try {
          const wl = (await apiGet('/user/?selections=log&log=' + wheelTypes.ids.slice(0, 20).join(',') + '&from=' + Math.floor(midnight / 1000), key)).log || {};
          const rows = Array.isArray(wl) ? wl : Object.keys(wl).map(id => wl[id]);
          // Which wheel? By name if the entry has one, otherwise by price: the Wheel of Awesome costs $1,000,000 a spin.
          const txt = r => JSON.stringify(r.data || {}).toLowerCase();
          const named = rows.some(r => /awesome|mediocrity|lame/.test(txt(r)));
          const isAwesome = r => /awesome/.test(txt(r)) || (!named && Object.keys(r.data || {}).some(k => Number((r.data || {})[k]) === 1000000));
          const awesome = rows.filter(isAwesome);
          const hit = awesome.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
          const start = rows.find(r => Number(r.log) === 8370) || rows[0];
          wheel = { day: midnight, at, spun: !!hit, ts: hit ? Number(hit.timestamp) || 0 : 0, title: hit ? String(hit.title || '') : '', other: rows.length - awesome.length,
            sample: start ? (String(start.title || start.log || '') + ' ' + JSON.stringify(start.data || {})).slice(0, 140) : '' };
        } catch (e) { wheel = Object.assign({}, wheel, { at, err: e.code != null ? 'Error ' + e.code : 'unavailable' }); }
      }
      // Booster cap: once a day from your faction's upgrades (keeps the last known value if it fails).
      let boostMaxH = h.boostMaxH || null, medMaxH = h.medMaxH || null, boostDay = h.medMaxH ? (h.boostDay || 0) : 0; // (re-check once so the medical cap is filled in)
      if (boostDay !== midnight) {
        try {
          const up = await apiGet('/faction/?selections=upgrades', key);
          boostMaxH = BOOSTER_BASE_H + upgradeBonusHours(up, 'booster');
          medMaxH = MEDICAL_BASE_H + upgradeBonusHours(up, 'medical');
          boostDay = midnight;
        } catch (e) { if (!e.guard) boostDay = midnight; /* no faction or no access: try again tomorrow */ }
      }
      // Virus being coded (Programming Center): 1 call, at most every 30 minutes or once the last one should be done
      let virus = h.virus || null;
      if (!virus || at - (virus.at || 0) > 1800000 || (virus.until && virus.until * 1000 <= at && (virus.at || 0) < virus.until * 1000)) {
        try {
          const vj = await apiGet('/v2/user/virus', key), v = vj && (vj.virus || (vj.data && vj.data.virus) || null);
          virus = { at, name: v && v.item ? String(v.item.name || '') : v && v.name ? String(v.name) : '', until: v && v.until ? Number(v.until) : 0, last: virus && virus.until && !(v && v.until) ? virus.until : (virus && virus.last) || 0, lastName: virus && virus.name && !(v && v.until) ? virus.name : (virus && virus.lastName) || '' };
        } catch (e) { virus = Object.assign({}, virus || {}, { at, err: e.code != null ? 'Error ' + e.code : 'unavailable' }); }
      }
      // Racing: Torn's status icons say if you're waiting for or in a race; skill once a day
      let racing = null;
      try {
        const ic = j.icons || {}, txt = Object.keys(ic).map(k => String(ic[k] || '')).find(t => /^Racing\b/i.test(t)) || '';
        const tm = /(\d+):(\d{2}):(\d{2})\s*$/.exec(txt), left = tm ? Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3]) : 0;
        racing = { text: txt.replace(/^Racing\s*-\s*/i, '').replace(/\s*-?\s*\d+:\d{2}:\d{2}\s*$/, ''), left, on: !!txt, skill: h.racing ? h.racing.skill : null, skillDay: h.racing ? h.racing.skillDay : 0 };
        if (racing.skillDay !== midnight) {
          try { const sk = await apiGet('/user/?selections=skills', key); if (sk && sk.racing != null) racing.skill = Number(sk.racing) || 0; racing.skillDay = midnight; } catch (e) { if (!e.guard) racing.skillDay = midnight; }
        }
      } catch (e) { racing = h.racing || null; }
      writeHome({ at, error: null, boostMaxH, medMaxH, boostDay, noMoney, eduNames, virus, racing, cash: j.money_onhand != null ? Number(j.money_onhand) || 0 : null,
        bank: j.city_bank ? { amt: Number(j.city_bank.amount) || 0, left: Number(j.city_bank.time_left) || 0 } : null,
        edu: { cur: eduCur, left: Number(j.education_timeleft) || 0 },
        cd: { drug: Number(cd.drug) || 0, booster: Number(cd.booster) || 0, medical: Number(cd.medical) || 0 },
        rf: { energy: !!rf.energy_refill_used, nerve: !!rf.nerve_refill_used, token: !!rf.token_refill_used, special: Number(rf.special_refills_available) || 0 },
        bars: { energy: bar(j.energy), nerve: bar(j.nerve), happy: bar(j.happy), life: bar(j.life) },
        chain: j.chain ? { cur: Number(j.chain.current) || 0, max: Number(j.chain.maximum) || 0, mod: Number(j.chain.modifier) || 0, timeout: Number(j.chain.timeout) || 0, cooldown: Number(j.chain.cooldown) || 0 } : null,
        stats, base, duke, oc, wheel, wheelTypes,
        status: j.status ? { state: String(j.status.state || ''), desc: String(j.status.description || ''), details: String(j.status.details || ''), until: Number(j.status.until) || 0 } : null,
        travel: j.travel ? { dest: String(j.travel.destination || ''), arrive: Number(j.travel.timestamp) || 0, left: Number(j.travel.time_left) || 0 } : null,
        notes: j.notifications ? { messages: Number(j.notifications.messages) || 0, events: Number(j.notifications.events) || 0, awards: Number(j.notifications.awards) || 0 } : null });
      refreshIndicators();
    } catch (e) {
      const x = readHome(); x.error = { code: e.code == null ? null : e.code, msg: e.message || 'Network error' }; writeHome(x);
    } finally {
      homeBusy = false;
      if (VIEW === 'home' && isMenuOpen()) rebuildContent();
    }
  }

  /* ---- Torn calendar: events & competitions (v2 torn/calendar + your start time from v2 user/calendar).
         Fetched once a day (2 calls), shared by all open pages. Times shown in TCT. */
  const CAL_KEY = 'bm-calendar-v2'; // v2: corrected personal start times (forces a fresh fetch)
  let calMem = {}, calOpen = {}, calShowAll = false;
  const calReady = IDB.get(CAL_KEY).then(c => { calMem = Object.assign({}, c || {}, calMem); }).catch(() => {});
  function syncCal() { return IDB.get(CAL_KEY).then(c => { if (c) calMem = c; }).catch(() => {}); }
  // "11:15 TCT" / "11.15" / "11:15:00" -> seconds after midnight (TCT)
  function parseStartTime(str) {
    const m = /(\d{1,2})[:.](\d{2})(?::(\d{2}))?/.exec(String(str || ''));
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));
  }
  function normaliseCalendar(torn, mine) {
    const cal = (torn && torn.calendar) || {};
    const offset = parseStartTime(mine && mine.calendar && mine.calendar.start_time);
    const out = [];
    [['events', 'Event'], ['competitions', 'Competition']].forEach(([k, kind]) => (cal[k] || []).forEach(a => {
      let start = Number(a.start) || 0, end = Number(a.end) || 0;
      // Events without a fixed start run on the listed days at the start time you picked in Torn:
      // keep the start and end days (TCT) and set the time of day to your start time.
      // A single-day listing spans from the day before to the day after at that time.
      const flexible = a.fixed_start_time === false;
      if (flexible && offset != null) {
        const sd = Math.floor(start / 86400), ed = Math.floor(end / 86400), single = sd === ed;
        start = (sd - (single ? 1 : 0)) * 86400 + offset;
        end = (ed + (single ? 1 : 0)) * 86400 + offset;
      }
      if (start && end) out.push({ title: String(a.title || kind), desc: String(a.description || ''), start, end, kind, flexible });
    }));
    return out.sort((a, b) => a.start - b.start);
  }
  let calBusy = false;
  async function refreshCalendar(force) {
    await calReady; await storeReady; await syncCal();
    if (calBusy) return;
    if (!force && calMem.at && Date.now() - calMem.at < 86400000 && new Date(calMem.at).getUTCFullYear() === new Date().getUTCFullYear()) return;
    if (force && calMem.at && Date.now() - calMem.at < 15000) return;
    const { key } = getKey(); if (!key) return;
    calBusy = true;
    try {
      const torn = await apiGet('/v2/torn/calendar', key);
      let mine = null;
      try { mine = await apiGet('/v2/user/calendar', key); } catch (e) { mine = null; }
      calMem = { at: Date.now(), items: normaliseCalendar(torn, mine), startTime: mine && mine.calendar ? mine.calendar.start_time : null, error: null };
    } catch (e) {
      calMem = Object.assign({}, calMem, { at: Date.now() - 86400000 + 300000, error: (e.code != null ? 'Error ' + e.code + ': ' : '') + (e.message || 'failed') }); // retry in 5 min
    } finally {
      persist(CAL_KEY, calMem);
      calBusy = false;
      if (VIEW === 'home' && isMenuOpen()) rebuildContent();
    }
  }
  const fmtTCT = t => new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' TCT';
  function fmtDur(secs) { const d = Math.floor(secs / 86400), h = Math.round(secs % 86400 / 3600); return d ? d + 'd' + (h ? ' ' + h + 'h' : '') : h + 'h'; }
  function buildCalendarCard() {
    const items = (calMem.items || []).slice();
    const now = Date.now() / 1000;
    const live = items.filter(a => a.start <= now && a.end > now).sort((a, b) => a.end - b.end);
    const next = items.filter(a => a.start > now);
    const nextCount = calShowAll ? 12 : Math.max(1, 3 - live.length); // 3 rows normally, at least 1 upcoming
    const shown = live.concat(next.slice(0, nextCount));
    const row = a => {
      const isLive = a.start <= now;
      const target = (isLive ? a.end : a.start) * 1000;
      const soon = !isLive && a.start - now < 86400, near = !isLive && a.start - now < 3 * 86400;
      const id = a.title + a.start;
      const open = !!calOpen[id];
      return el('div', { class: 'bm-cal-row' + (isLive ? ' live' : soon ? ' soon' : near ? ' near' : ''), onclick: () => { calOpen[id] = !open; rebuildContent(); } },
        el('div', { class: 'bm-home-row' },
          el('span', { class: 'bm-home-l' }, el('span', { class: 'bm-cal-tag' }, isLive ? 'LIVE' : a.kind === 'Competition' ? 'COMP' : 'NEXT'), ' ', el('b', null, a.title)),
          el('span', { class: 'bm-home-cd' }, isLive ? 'ends ' : 'in ', el('span', { class: 'bm-cd', 'data-bm-cd': String(target), 'data-bm-zero': isLive ? 'ended' : 'now' }, fmtCountdown(target - Date.now())))),
        open ? el('div', { class: 'bm-cal-more' },
          el('div', null, fmtTCT(a.start) + ' \u2192 ' + fmtTCT(a.end) + ' (' + fmtDur(a.end - a.start) + ')' + (a.flexible ? ' \u00b7 your start time' : '')),
          a.desc ? el('div', { class: 'bm-cal-desc' }, a.desc) : null) : null);
    };
    const card = el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, el('a', { href: 'https://www.torn.com/calendar.php', class: 'bm-cal-title' }, '📅 Torn calendar \u203a'),
        el('small', null, calMem.at && !calMem.error ? 'updated ' + timeAgo(calMem.at) : '')));
    if (calMem.error) card.appendChild(el('div', { class: 'bm-status', style: { textAlign: 'left' } }, '\u26a0\ufe0f ' + calMem.error));
    if (!items.length) card.appendChild(el('div', { class: 'bm-status', style: { textAlign: 'left' } }, calMem.at ? 'No upcoming events.' : 'Loading the calendar\u2026'));
    shown.forEach(a => card.appendChild(row(a)));
    if (calShowAll || next.length > nextCount) card.appendChild(el('button', { class: 'bm-cal-all', onclick: () => { calShowAll = !calShowAll; rebuildContent(); } },
      calShowAll ? 'Show less' : 'Show more (' + next.length + ' upcoming)'));
    return card;
  }

  /* ---- Late-day reminders: from prefs.lateHour (TCT) until Torn midnight, list what's still undone. No API calls. */
  const lateOn = () => prefs.lateOn !== false;
  const lateHour = () => (prefs.lateHour == null ? 22 : prefs.lateHour);
  function lateDayItems() {
    if (!lateOn() || new Date().getUTCHours() < lateHour()) return [];
    let h = null; try { h = homeMem; } catch (e) { return []; }
    const out = [], fresh = h && h.at && h.at >= lastTornMidnight();
    if (fresh && h.rf) {
      if (!h.rf.energy) out.push({ what: 'Energy refill unused', href: HOME_LINKS.refills });
      if (!h.rf.nerve) out.push({ what: 'Nerve refill unused', href: HOME_LINKS.refills });
    }
    const base = h && h.base && h.base.day === lastTornMidnight() ? h.base : null;
    if (fresh && base && h.stats && h.stats.shop != null) {
      const n = Math.max(0, h.stats.shop - base.shop);
      if (n < 100) out.push({ what: 'City-shop items ' + n + '/100', href: HOME_LINKS.shops });
    }
    if (fresh && base && h.stats && h.stats.contracts != null && h.stats.contracts - base.contracts <= 0) out.push({ what: 'Daily mission not done', href: HOME_LINKS.missions });
    if (fresh && h.wheelTypes && h.wheelTypes.ids && h.wheelTypes.ids.length && !(h.wheel && h.wheel.day === lastTornMidnight() && h.wheel.spun)) out.push({ what: 'Wheel of Awesome not spun', href: HOME_LINKS.wheel });
    let due = 0;
    try { Object.keys(users).forEach(u => (users[u] || []).forEach(o => { if (o && o.label) { const li = labelInfo(u, o.id); if (li.dueToday && !li.done && !li.received) due++; } })); } catch (e) { /* ignore */ }
    if (due) out.push({ what: due + (due === 1 ? ' stock due, not ticked' : ' stocks due, not ticked'), view: 'user' });
    return out;
  }
  function nextTornMidnight() { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); }
  // What needs you right now: the same things the badge counts, one tappable line each, at the top of Home.
  function homeAlerts(h) {
    const out = [], notes = h.notes || {};
    if (notes.messages) out.push({ icon: '\u2709\ufe0f', text: notes.messages + ' unread message' + (notes.messages > 1 ? 's' : ''), href: HOME_LINKS.messages, cls: 'warn' });
    if (notes.events) out.push({ icon: '🔔', text: notes.events + ' new event' + (notes.events > 1 ? 's' : ''), href: HOME_LINKS.events, cls: 'warn' });
    if (notes.awards) out.push({ icon: '🏅', text: notes.awards + ' new award' + (notes.awards > 1 ? 's' : ''), href: TORN + 'awards.php', cls: 'ok' });
    let buddies = 0; try { buddies = unseenCount(); } catch (e) { buddies = 0; }
    if (buddies) out.push({ icon: '🤝', text: buddies + ' new from buddies', view: 'log', cls: 'ok' });
    const ready = readyAlerts();
    ready.forEach(k => {
      const a = READY_ALERTS.find(x => x[0] === k); if (!a) return;
      if (k === 'cash') out.push({ icon: '💵', text: 'Carrying ' + fmtCash(h.cash) + ' \u2013 put it in the vault', href: HOME_LINKS.cash, cls: 'warn' });
      else out.push({ icon: a[1].split(' ')[0], text: a[1].replace(/^\S+\s/, ''), href: HOME_LINKS[k], cls: 'ok' });
    });
    try {
      const own = (portMem && portMem.own) || [], st = (portMem && portMem.stocks) || {};
      const rdy = own.filter(o => o.ready && !o.passive).map(o => (st[o.id] && st[o.id].acr) || '#' + o.id);
      if (rdy.length) out.push({ icon: '📈', text: 'Stock payout' + (rdy.length > 1 ? 's' : '') + ' ready: ' + rdy.join(', '), href: TORN + 'page.php?sid=stocks', cls: 'ok' });
    } catch (e) { /* no portfolio yet */ }
    return out;
  }
  function buildAlertStrip(h) {
    if (prefs.homeAlerts === false) return null;
    const items = homeAlerts(h); if (!items.length) return null;
    return el('div', { class: 'bm-alerts', role: 'status' },
      el('div', { class: 'bm-alerts-head' }, 'Needs your attention', el('span', { class: 'bm-alerts-n' }, String(items.length))),
      items.map(x => {
        const kids = [el('span', null, x.icon), el('span', { class: 'bm-alert-t' }, x.text), el('span', { class: 'bm-alert-go' }, '\u203a')];
        return x.href ? el('a', { class: 'bm-alert ' + (x.cls || ''), href: x.href }, kids)
                      : el('div', { class: 'bm-alert ' + (x.cls || ''), role: 'button', onclick: () => setView(x.view) }, kids);
      }));
  }
  function buildLateBanner() {
    const items = lateDayItems(); if (!items.length) return null;
    const reset = nextTornMidnight();
    return el('div', { class: 'bm-late' },
      el('div', { class: 'bm-late-head' }, '\u26a0\ufe0f Before the daily reset', el('span', { class: 'bm-late-cd' }, 'in ', el('span', { class: 'bm-cd', 'data-bm-cd': String(reset), 'data-bm-zero': 'now' }, fmtCountdown(reset - Date.now())))),
      items.map(x => x.href ? el('a', { class: 'bm-late-row', href: x.href }, '\u2022 ' + x.what + ' \u203a')
                            : el('div', { class: 'bm-late-row', role: 'button', onclick: () => setView(x.view) }, '\u2022 ' + x.what + ' \u203a')));
  }

  // Daily checklist: city shop items, daily mission, organised crime. 'ok' | 'part' | 'no' | 'na'
  // Status (okay / hospital / jail / flying / abroad) + unread messages and events. From the Home call.
  function buildStatusCard(h) {
    const rows = [];
    const st = h.status || {}, tr = h.travel || {}, now = Date.now();
    const cd = (t, zero) => el('span', { class: 'bm-cd', 'data-bm-cd': String(t), 'data-bm-zero': zero }, fmtCountdown(t - now));
    const state = st.state || '';
    if (/travel/i.test(state) && tr.arrive) {
      const land = tr.arrive * 1000;
      rows.push(homeLink(HOME_LINKS.travel, 'bm-home-row bm-st-row fly', el('span', { class: 'bm-home-l' }, '\u2708\ufe0f Flying to ' + (tr.dest || '?')),
        land > now ? el('span', { class: 'bm-home-cd' }, 'lands in ', cd(land, 'now')) : el('b', null, 'Landed')));
    } else if (/abroad/i.test(state)) {
      rows.push(homeLink(HOME_LINKS.travel, 'bm-home-row bm-st-row fly', el('span', { class: 'bm-home-l' }, '🌍 ' + (st.desc || 'Abroad')), el('b', null, tr.dest || '')));
    } else if (/hospital/i.test(state) || /jail|federal/i.test(state)) {
      const hosp = /hospital/i.test(state), end = st.until * 1000;
      rows.push(homeLink(hosp ? HOME_LINKS.hospital : HOME_LINKS.jail, 'bm-home-row bm-st-row ' + (hosp ? 'hosp' : 'jail'),
        el('span', { class: 'bm-home-l' }, (hosp ? '🏥 ' : '🔒 ') + (st.desc || state), st.details ? el('div', { class: 'bm-chk-sub' }, st.details) : null),
        end > now ? el('span', { class: 'bm-home-cd' }, 'out in ', cd(end, 'now')) : el('b', null, 'Out')));
    } else {
      rows.push(el('div', { class: 'bm-home-row bm-st-row ok' }, el('span', { class: 'bm-home-l' }, '\u2705 ' + (st.desc || 'Okay')), el('b', null, 'Okay')));
    }
    const n = h.notes;
    if (n) {
      const box = (label, icon, count, href) => homeLink(href, 'bm-home-row' + (count ? ' bm-unread-row' : ''),
        el('span', { class: 'bm-home-l' }, icon + ' ' + label), el('b', { class: 'bm-unread-n' + (count ? ' on' : '') }, count ? String(count) + ' new' : 'none'));
      rows.push(box('Messages', '📨', n.messages, HOME_LINKS.messages));
      rows.push(box('Events', '🔔', n.events, HOME_LINKS.events));
    }
    return el('div', { class: 'bm-section bm-tr-card' }, el('div', { class: 'bm-tr-cap' }, 'Status & inbox'), rows);
  }
  // Timers: city bank investment, education course, flight. From the Home call.
  // "Bank 73% vs SYM #4 63%": the bank's yearly return next to the best stock increment you don't own yet (from the ROI ranking).
  function bankVsStocks() {
    try {
      const rk = incrementRanking(); if (!rk || !rk.length) return null;
      const bank = rk.find(r => r.acr === 'Bank'), stock = rk.find(r => r.acr !== 'Bank' && !r.owned);
      if (!bank || !stock) return null;
      const better = bank.r.pct >= stock.r.pct;
      return el('div', { class: 'bm-chk-sub' }, 'Bank ' + bank.r.pct.toFixed(0) + '% vs ' + stock.acr + ' #' + stock.n + ' ' + stock.r.pct.toFixed(0) + '% a year \u00b7 ',
        el('b', { style: { color: better ? '#85b200' : '#e8a92c' } }, better ? 'reinvest' : 'stock wins'));
    } catch (e) { return null; }
  }
  function buildTimersCard(h) {
    const now = Date.now(), rows = [];
    const cd = (t, zero) => el('span', { class: 'bm-cd', 'data-bm-cd': String(t), 'data-bm-zero': zero }, fmtCountdown(t - now));
    const sub = t => el('div', { class: 'bm-chk-sub' }, t);
    const b = h.bank;
    if (h.noMoney) rows.push(homeLink(HOME_LINKS.bank, 'bm-home-row', el('span', { class: 'bm-home-l' }, '🏦 City bank', sub('your key can\u2019t read money (needs Limited access)')), el('b', null, '-')));
    else if (b && b.amt > 0) {
      const end = h.at + b.left * 1000;
      rows.push(homeLink(HOME_LINKS.bank, 'bm-home-row' + (end <= now ? ' todo' : ''), el('span', { class: 'bm-home-l' }, '🏦 City bank', sub(fmtCash(b.amt) + ' invested'), bankVsStocks()),
        end > now ? el('span', { class: 'bm-home-cd' }, 'ends in ', cd(end, 'now')) : el('span', { class: 'bm-home-todo' }, 'Ready to collect')));
    } else if (b) rows.push(homeLink(HOME_LINKS.bank, 'bm-home-row todo', el('span', { class: 'bm-home-l' }, '🏦 City bank'), el('span', { class: 'bm-home-todo' }, 'No investment')));
    const e = h.edu;
    if (e && e.cur && e.left > 0) {
      const end = h.at + e.left * 1000;
      rows.push(homeLink(HOME_LINKS.education, 'bm-home-row', el('span', { class: 'bm-home-l' }, '🎓 Education', sub((h.eduNames || {})[e.cur] || 'Course #' + e.cur)),
        end > now ? el('span', { class: 'bm-home-cd' }, 'done in ', cd(end, 'now')) : el('span', { class: 'bm-home-ok' }, 'Finished \u2713')));
    } else if (e) rows.push(homeLink(HOME_LINKS.education, 'bm-home-row todo', el('span', { class: 'bm-home-l' }, '🎓 Education'), el('span', { class: 'bm-home-todo' }, 'No course running')));
    const tr = h.travel, st = h.status || {};
    if (tr && tr.arrive && /travel/i.test(st.state || '')) {
      const land = tr.arrive * 1000;
      rows.push(homeLink(HOME_LINKS.travel, 'bm-home-row', el('span', { class: 'bm-home-l' }, '\u2708\ufe0f Flight', sub('to ' + (tr.dest || '?'))),
        land > now ? el('span', { class: 'bm-home-cd' }, 'lands in ', cd(land, 'now')) : el('span', { class: 'bm-home-ok' }, 'Landed')));
    } else rows.push(homeLink(HOME_LINKS.travelAgency, 'bm-home-row', el('span', { class: 'bm-home-l' }, '\u2708\ufe0f Flight'), el('b', null, /abroad/i.test(st.state || '') ? 'Abroad' : 'Not flying')));
    // Virus (Programming Center)
    const v = h.virus;
    if (v && v.until * 1000 > now) rows.push(homeLink(HOME_LINKS.virus, 'bm-home-row', el('span', { class: 'bm-home-l' }, '🦠 Virus', sub(v.name || 'coding')), el('span', { class: 'bm-home-cd' }, 'done in ', cd(v.until * 1000, 'now'))));
    else if (v && (v.until || v.last) && now - (v.until || v.last) * 1000 < 86400000) rows.push(homeLink(HOME_LINKS.virus, 'bm-home-row todo', el('span', { class: 'bm-home-l' }, '🦠 Virus', sub(v.name || v.lastName || '')), el('span', { class: 'bm-home-todo' }, 'Finished \u2013 collect')));
    else if (v && !v.err) rows.push(homeLink(HOME_LINKS.virus, 'bm-home-row todo', el('span', { class: 'bm-home-l' }, '🦠 Virus'), el('span', { class: 'bm-home-todo' }, 'Nothing coding')));
    // Racing
    const rc = h.racing;
    if (rc) {
      const skill = rc.skill != null ? sub('Racing skill ' + Number(rc.skill).toFixed(2)) : null, end = h.at + (rc.left || 0) * 1000;
      if (rc.on) rows.push(homeLink(HOME_LINKS.racing, 'bm-home-row', el('span', { class: 'bm-home-l' }, '🏎\ufe0f Racing', sub(rc.text || 'In a race'), skill),
        rc.left && end > now ? el('span', { class: 'bm-home-cd' }, cd(end, 'now')) : el('span', { class: 'bm-home-ok' }, rc.left ? 'Done \u2013 check result' : 'In a race')));
      else rows.push(homeLink(HOME_LINKS.racing, 'bm-home-row todo', el('span', { class: 'bm-home-l' }, '🏎\ufe0f Racing', skill), el('span', { class: 'bm-home-todo' }, 'Not in a race')));
    }
    return el('div', { class: 'bm-section bm-tr-card' }, el('div', { class: 'bm-tr-cap' }, 'Timers'), rows);
  }

  // Last 7 days, from saved data only (no API): crimes, trains, company rank, stocks received.
  function weekReport() {
    const now = Date.now(), since = now - 7 * 86400000, out = [];
    try {
      const cr = crimeRates(readCrimes());
      if (cr && cr.weekRef) {
        const a = cr.weekRef, z = cr.latest, days = Math.max(1, Math.round((z.t - a.t) / 86400000));
        out.push({ k: 'crimes', icon: '📈', label: 'Offences', value: '+' + fmtN(z.total - a.total) + (days < 7 ? ' (' + days + 'd)' : ''),
          sub: a.rank != null && z.rank != null ? 'HOF rank #' + fmtN(a.rank) + ' \u2192 #' + fmtN(z.rank) : null, view: 'crimes' });
      }
    } catch (e) { /* no crimes data */ }
    try {
      const t = readTrains();
      if (t.buyers.length || t.events.length) {
        const ev = t.events.filter(x => x.ts * 1000 >= since);
        const who = {}; ev.forEach(x => { who[x.name || x.uid] = (who[x.name || x.uid] || 0) + 1; });
        out.push({ k: 'trains', icon: '🏢', label: 'Trains given', value: String(ev.length),
          sub: Object.keys(who).length ? Object.keys(who).map(n => n + ' ' + who[n]).join(', ') : null, view: 'trains' });
      }
    } catch (e) { /* no trains data */ }
    try {
      const hist = (rankMem && Array.isArray(rankMem.hist) ? rankMem.hist : []).filter(x => x.rank != null);
      const wk = hist.filter(x => x.day >= since - 86400000);
      if (wk.length) {
        const a = wk[0], z = wk[wk.length - 1], d = a.rank - z.rank;
        out.push({ k: 'rank', icon: '🏆', label: 'Company rank', value: '#' + z.rank + (wk.length > 1 && d ? (d > 0 ? ' \u25b2' + d : ' \u25bc' + (-d)) : ''),
          sub: (wk.length > 1 ? 'was #' + a.rank + ' \u00b7 ' : '') + 'weekly income ' + fmtCash(z.weekly), href: TORN + 'companies.php?step=your&type=1' });
      }
    } catch (e) { /* no rank data */ }
    try {
      const cd = readComp().days.filter(r => r.day >= compDayFor(now) - 6 * 86400000);
      if (cd.length) out.push({ k: 'profit', icon: '💵', label: 'Company profit', value: fmtCash(sumDays(cd, 'profit')) + (cd.length < 7 ? ' (' + cd.length + 'd)' : ''),
        sub: 'income ' + fmtCash(sumDays(cd, 'income')), view: 'income' });
    } catch (e) { /* no company record */ }
    try {
      const v = valueSince(readLog().entries, since);
      const per = Object.keys(users).map(u => [u, valueSince(readLog().entries, since, u)]).filter(x => x[1].count);
      out.push({ k: 'stocks', icon: '💬', label: 'Stocks received', value: v.count + (v.value ? ' \u00b7 ' + fmtCash(v.value) : ''),
        sub: per.length ? per.map(x => x[0] + ' ' + x[1].count).join(', ') : null, view: 'log' });
    } catch (e) { /* no log */ }
    return out;
  }
  function weekReportText() {
    const d = x => new Date(x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return ['Buddy Manager \u2013 week ' + d(Date.now() - 7 * 86400000) + ' to ' + d(Date.now())]
      .concat(weekReport().map(r => r.label + ': ' + r.value + (r.sub ? ' (' + r.sub + ')' : ''))).join('\n');
  }
  function buildWeekCard() {
    const rows = weekReport();
    return el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-cap', style: { display: 'flex', alignItems: 'center' } }, 'Last 7 days',
        el('button', { class: 'bm-wk-copy', onclick: () => { copyText(weekReportText()); toast('Weekly report copied', '📋'); } }, '📋 Copy')),
      rows.length ? rows.map(r => {
        const kids = [el('span', { class: 'bm-home-l' }, r.icon + ' ' + r.label, r.sub ? el('div', { class: 'bm-chk-sub' }, r.sub) : null), el('b', null, r.value)];
        return r.href ? homeLink(r.href, 'bm-home-row', ...kids) : el('div', { class: 'bm-home-row link', onclick: () => setView(r.view) }, kids);
      }) : el('div', { class: 'bm-status' }, 'Not enough history yet.'));
  }

  function buildChecklistCard(h) {
    const today = h.base && h.base.day === lastTornMidnight() && h.stats ? h.base : null; // baseline from before midnight is stale
    const mark = st => el('span', { class: 'bm-chk ' + st }, st === 'ok' ? '\u2713' : st === 'part' ? '/' : st === 'no' ? '\u2717' : '\u2013');
    const row = (st, label, value, href, sub) => homeLink(href, 'bm-home-row bm-chk-row ' + st, mark(st),
      el('span', { class: 'bm-home-l' }, label, sub ? el('div', { class: 'bm-chk-sub' }, sub) : null), el('b', { class: 'bm-chk-v ' + st }, value));
    const rows = [];
    // City shop items: Torn allows 100 a day
    if (today && h.stats.shop != null) {
      const n = Math.max(0, h.stats.shop - today.shop);
      rows.push(row(n >= 100 ? 'ok' : n > 0 ? 'part' : 'no', 'Buy city-shop items', Math.min(n, 100) + ' / 100', HOME_LINKS.shops, today.exact ? null : 'counting since your first refresh today'));
    } else rows.push(row('na', 'Buy city-shop items', 'refresh', HOME_LINKS.shops));
    // Daily mission: a contract completed today, or one in progress
    const doneToday = today && h.stats.contracts != null ? Math.max(0, h.stats.contracts - today.contracts) : null;
    const active = (h.duke || []).filter(m => /accepted/i.test(m.status));
    if (doneToday) rows.push(row('ok', 'Daily Mission', doneToday > 1 ? doneToday + ' done' : 'Done', HOME_LINKS.missions));
    else if (active.length) rows.push(row('part', 'Daily Mission', 'In progress', HOME_LINKS.missions, active[0].title));
    else rows.push(row('no', 'Daily Mission', 'Not started', HOME_LINKS.missions));
    // Organised crime
    const oc = h.oc;
    if (!oc || oc.err) rows.push(row('na', 'Organised Crime', oc && oc.err ? oc.err : '-', HOME_LINKS.oc));
    else if (oc.has) {
      const ready = oc.ready ? oc.ready * 1000 : null;
      rows.push(row('ok', 'Organised Crime', 'In OC', HOME_LINKS.oc,
        [oc.name + (oc.status ? ' \u00b7 ' + oc.status : ''), ready && ready > Date.now() ? [' \u00b7 ready in ', el('span', { class: 'bm-cd', 'data-bm-cd': String(ready), 'data-bm-zero': 'now' }, fmtCountdown(ready - Date.now()))] : null]));
    } else rows.push(row('no', 'Organised Crime', 'Not in OC', HOME_LINKS.oc));
    // Wheel of Awesome (daily, resets at midnight TCT)
    const wh = h.wheel && h.wheel.day === lastTornMidnight() ? h.wheel : null;
    const reset = (() => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); })();
    if (!h.wheelTypes || !h.wheelTypes.ids || !h.wheelTypes.ids.length) rows.push(row('na', 'Spin the Wheel of Awesome', h.wheelTypes ? 'check' : 'refresh', HOME_LINKS.wheel, h.wheelTypes ? 'couldn\u2019t find the wheel in your log types' : null));
    else if (wh && wh.spun) rows.push(row('ok', 'Spin the Wheel of Awesome', 'Spun', HOME_LINKS.wheel,
      ['spun ' + timeAgo(wh.ts * 1000) + ' \u00b7 next in ', el('span', { class: 'bm-cd', 'data-bm-cd': String(reset), 'data-bm-zero': 'now' }, fmtCountdown(reset - Date.now()))]));
    else rows.push(row('no', 'Spin the Wheel of Awesome', wh && wh.err ? wh.err : 'Not spun', HOME_LINKS.wheel, wh && wh.at ? 'checked ' + timeAgo(wh.at) + (wh.other ? ' \u00b7 ' + wh.other + ' other wheel spin' + (wh.other === 1 ? '' : 's') + ' today (' + (wh.sample || '') + ')' : '') : null));
    return el('div', { class: 'bm-section bm-tr-card' }, el('div', { class: 'bm-tr-cap' }, 'Daily checklist'), rows);
  }

  function buildHome(container) {
    if (!buildHome._loaded) { buildHome._loaded = true; homeReady.then(() => { if (VIEW === 'home' && isMenuOpen()) rebuildContent(); }); }
    const h = readHome();
    const k = getKey();
    const go = v => () => setView(v);

    container.appendChild(el('div', { class: 'bm-sticky', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
      el('div', { class: 'bm-status', style: { textAlign: 'left' } }, h.at ? 'Updated ' + timeAgo(h.at) : 'Tap Refresh for cooldowns & refills'),
      el('button', { class: 'refresh-btn', disabled: k.key ? null : 'disabled', onclick: ev => refreshEverything(ev.currentTarget) }, '\u21bb Refresh all')));
    const alerts = buildAlertStrip(h); if (alerts) container.appendChild(alerts);
    const grd = guardReason(k.key);
    if (grd) container.appendChild(el('div', { class: 'bm-error' }, (grd.pause ? '\u23f8\ufe0f ' : '\u26d4 API key rejected \u2013 checks stopped. ') + (grd.pause ? grd.msg : ''),
      el('a', { href: '#', style: { color: '#8fc0ff', marginLeft: '4px' }, onclick: ev => { ev.preventDefault(); setView('settings'); } }, 'Settings \u203a')));
    else if (h.error) container.appendChild(el('div', { class: 'bm-error' }, '\u274c ' + (h.error.code != null ? 'Error ' + h.error.code + ': ' : '') + h.error.msg));
    const late = homeArrange ? null : buildLateBanner(); if (late) container.appendChild(late);
    const cards = {}; // id -> card element; placed in your saved order at the end
    cards.calendar = buildCalendarCard();
    if (!buildHome._cal) { buildHome._cal = true; calReady.then(() => { if (VIEW === 'home' && isMenuOpen()) rebuildContent(); }); }

    if (h.at) {
      // Cooldowns: live countdown to ready
      // maxH: show as "32:24:12 / 48:00:00" (like Torn's tooltip) instead of "1d 8h"
      const cdRow = (label, icon, secs, href, maxH) => {
        const end = h.at + secs * 1000, ready = end <= Date.now();
        const hms = !!maxH;
        const row = homeLink(href, 'bm-home-row' + (ready ? ' ready' : ''),
          el('span', { class: 'bm-home-l' }, icon + ' ' + label),
          ready ? el('span', { class: 'bm-home-ok' }, 'Ready \u2713')
                : el('span', { class: 'bm-home-cd' + (hms ? ' bm-hms' : '') },
                    el('span', { class: 'bm-cd', 'data-bm-cd': String(end), 'data-bm-zero': 'Ready \u2713', 'data-bm-fmt': hms ? 'hms' : null }, hms ? fmtHMS(end - Date.now()) : fmtCountdown(end - Date.now())),
                    hms ? el('span', { class: 'bm-cd-max' }, ' / ' + fmtHMS(maxH * 3600000)) : null));
        row.setAttribute('data-bm-ready', '1');
        return row;
      };
      cards.cooldowns = el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-cap' }, 'Cooldowns'),
        cdRow('Drug', '💊', h.cd.drug, HOME_LINKS.drug), cdRow('Booster', '\u26a1', h.cd.booster, HOME_LINKS.booster, h.boostMaxH || 48), cdRow('Medical', '🩹', h.cd.medical, HOME_LINKS.medical, h.medMaxH || MEDICAL_BASE_H));

      // Refills: reset at Torn midnight, so older data is shown as "reset"
      const stale = h.at < lastTornMidnight();
      const rfRow = (label, icon, used) => homeLink(HOME_LINKS.refills, 'bm-home-row' + (stale || !used ? ' todo' : ''),
        el('span', { class: 'bm-home-l' }, icon + ' ' + label),
        stale ? el('span', { class: 'bm-home-todo' }, 'Reset - refresh') : used ? el('span', { class: 'bm-home-used' }, 'Used \u2713') : el('span', { class: 'bm-home-todo' }, 'Available'));
      cards.refills = el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-cap' }, 'Refills today' + (h.rf.special ? ' \u00b7 ' + h.rf.special + ' special available' : '')),
        rfRow('Energy refill', '\u26a1', h.rf.energy), rfRow('Nerve refill', '🧠', h.rf.nerve), rfRow('Token refill', '🪙', h.rf.token));

      // Bars: value as of refresh, live time-to-full
      // Bars count up live between refreshes from Torn's regen data (increment every interval, next tick at ticktime).
      const barRow = (label, key) => {
        const b = h.bars[key]; if (!b) return null;
        const est = barNow(b, h.at);
        const pct = b.max ? Math.min(100, Math.round(est.cur / b.max * 100)) : 0;
        const href = HOME_LINKS[key];
        let right;
        if (est.full) right = el('span', { class: 'bm-home-ok' }, est.cur > b.max ? 'Over max' : 'Full');
        else right = el('span', { class: 'bm-home-cd' },
          b.inc ? ['+' + fmtN(b.inc) + ' in ', el('span', { class: 'bm-cd', 'data-bm-cd': String(est.nextTick), 'data-bm-zero': 'now' }, fmtCountdown(est.nextTick - Date.now()))]
                : ['full in ', el('span', { class: 'bm-cd', 'data-bm-cd': String(est.fullAt), 'data-bm-zero': 'now' }, fmtCountdown(est.fullAt - Date.now()))]);
        return el(href ? 'a' : 'div', { class: 'bm-home-bar b-' + key + (href ? ' link' : ''), href: href || null },
          el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-bar-l' }, label + ' ', el('b', null, fmtN(est.cur) + '/' + fmtN(b.max))), right),
          el('div', { class: 'bm-tr-bar' }, el('span', { style: { width: pct + '%' } })),
          !est.full && b.inc && est.fullAt > Date.now() ? el('div', { class: 'bm-bar-sub' }, 'full in ', el('span', { class: 'bm-cd', 'data-bm-cd': String(est.fullAt), 'data-bm-zero': 'now' }, fmtCountdown(est.fullAt - Date.now()))) : null);
      };
      // Faction chain (only while one is running or on cooldown)
      const ch = h.chain;
      let chainRow = null;
      if (ch && (ch.cur > 0 || ch.cooldown > 0)) {
        const tEnd = h.at + ch.timeout * 1000, cEnd = h.at + ch.cooldown * 1000;
        chainRow = el('a', { class: 'bm-home-bar b-chain link', href: HOME_LINKS.chain },
          el('div', { class: 'bm-home-row' },
            el('span', { class: 'bm-bar-l' }, '⛓️ Chain ', el('b', null, fmtK(ch.cur) + '/' + fmtK(ch.max))),
            ch.cooldown > 0 && cEnd > Date.now() ? el('span', { class: 'bm-home-cd' }, 'cooldown ', el('span', { class: 'bm-cd', 'data-bm-cd': String(cEnd), 'data-bm-zero': 'over' }, fmtCountdown(cEnd - Date.now())))
              : ch.timeout > 0 && tEnd > Date.now() ? el('span', { class: 'bm-home-cd bm-chain-to' }, 'timeout ', el('span', { class: 'bm-cd', 'data-bm-cd': String(tEnd), 'data-bm-zero': 'refresh' }, fmtCountdown(tEnd - Date.now())))
              : el('span', { class: 'bm-bar-full' }, 'refresh for timeout')),
          el('div', { class: 'bm-tr-bar' }, el('span', { style: { width: (ch.max ? Math.min(100, Math.round(ch.cur / ch.max * 100)) : 0) + '%' } })),
          ch.mod ? el('div', { class: 'bm-bar-sub' }, 'bonus \u00d7' + ch.mod) : null);
      }
      cards.bars = el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-cap' }, 'Bars'),
        barRow('Energy', 'energy'), barRow('Nerve', 'nerve'), barRow('Happy', 'happy'), barRow('Life', 'life'), chainRow);
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
    const wkVal = valueSince(readLog().entries, Date.now() - 7 * 86400000);
    if (wkVal.count) rows.push(el('div', { class: 'bm-home-row link', onclick: go('log') },
      el('span', null, '💰 Received this week'), el('b', null, fmtCash(wkVal.value) + ' \u00b7 ' + wkVal.count + ' sent')));
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
    cards.today = el('div', { class: 'bm-section bm-tr-card' }, el('div', { class: 'bm-tr-cap' }, 'Today'), rows);
    if (h.at) cards.checklist = buildChecklistCard(h);
    if (h.at && (h.status || h.notes)) cards.status = buildStatusCard(h);
    if (h.at && (h.bank || h.edu || h.noMoney || h.virus || h.racing)) cards.timers = buildTimersCard(h);
    cards.week = buildWeekCard();
    cards.overview = buildOverviewCard();
    const compCard = buildCompanyHomeCard(); if (compCard) cards.company = compCard;
    const pfCard = buildPortfolioHomeCard(); if (pfCard) cards.portfolio = pfCard;
    const warCard = buildWarCard(true); if (warCard) cards.war = warCard;
    const bustCard = buildBustCard(); if (bustCard) cards.busts = bustCard;
    if (!buildHome._comp) { buildHome._comp = true; compReady.then(() => { if (VIEW === 'home' && isMenuOpen()) rebuildContent(); }); }
    ensurePrices('home');

    // Arrange mode: a compact list with up/down buttons (taps work everywhere, including Torn PDA).
    if (homeArrange) {
      const order = homeOrder();
      const move = (i, d) => { const o = order.slice(); const j = i + d; [o[i], o[j]] = [o[j], o[i]]; prefs.homeOrder = o; saveConfig(); rebuildContent(); };
      container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
        el('div', { class: 'bm-tr-head' }, '\u2195 Arrange cards', el('small', null, 'tap \u25b2 \u25bc to move')),
        order.map((id, i) => el('div', { class: 'bm-arr-row' },
          el('span', { class: 'bm-arr-n' }, String(i + 1)),
          el('span', { class: 'bm-arr-name' }, HOME_CARD_NAMES[id] || id),
          el('button', { class: 'bm-arr-btn', disabled: i === 0 ? 'disabled' : null, onclick: () => move(i, -1), title: 'Move up' }, '\u25b2'),
          el('button', { class: 'bm-arr-btn', disabled: i === order.length - 1 ? 'disabled' : null, onclick: () => move(i, 1), title: 'Move down' }, '\u25bc'))),
        el('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } },
          el('button', { class: 'refresh-btn', onclick: () => { homeArrange = false; rebuildContent(); } }, '\u2713 Done'),
          el('button', { class: 'remove-btn', onclick: () => { delete prefs.homeOrder; saveConfig(); rebuildContent(); } }, '\u21ba Reset'))));
      return;
    }
    homeOrder().forEach(id => { if (cards[id]) container.appendChild(makeFoldable(id, cards[id], h)); });
    container.appendChild(el('button', { class: 'bm-cal-all', onclick: () => { homeArrange = true; rebuildContent(); } }, '\u2195 Arrange cards'));
  }

  /* ---- Home card order (drag the \u283f handle; saved with your settings) ---- */
  /* ---- Folding Home cards: tap a card's title (or the chevron) to fold it to one line with a short summary. Saved in prefs.homeFold. */
  const isFolded = id => !!(prefs.homeFold && prefs.homeFold[id]);
  function toggleFold(id) {
    prefs.homeFold = Object.assign({}, prefs.homeFold || {});
    if (prefs.homeFold[id]) delete prefs.homeFold[id]; else prefs.homeFold[id] = true;
    saveConfig(); rebuildContent();
  }
  const foldCd = (t, zero) => el('span', { class: 'bm-cd', 'data-bm-cd': String(t), 'data-bm-zero': zero || 'now' }, fmtCountdown(t - Date.now()));
  // One-line summary shown in a folded card's title bar.
  function foldSummary(id, h, card) {
    const now = Date.now(), sep = ' \u00b7 ';
    const join = parts => { const out = []; parts.filter(Boolean).forEach((p, i) => { if (i) out.push(sep); out.push(p); }); return out.length ? out : null; };
    try {
      if (id === 'status') {
        const st = h.status || {}, n = h.notes || {};
        return join([/travel/i.test(st.state || '') && h.travel && h.travel.arrive ? ['\u2708\ufe0f ', foldCd(h.travel.arrive * 1000)] : (st.desc || st.state || 'Okay'),
          n.messages ? '📨 ' + n.messages : null, n.events ? '🔔 ' + n.events : null]);
      }
      if (id === 'timers') {
        const b = h.bank, e = h.edu, tr = h.travel, st = h.status || {};
        return join([b && b.amt > 0 ? ['🏦 ', foldCd(h.at + b.left * 1000, 'ready')] : b ? '🏦 none' : null,
          e && e.cur && e.left > 0 ? ['🎓 ', foldCd(h.at + e.left * 1000, 'done')] : e ? '🎓 none' : null,
          tr && tr.arrive && /travel/i.test(st.state || '') ? ['\u2708\ufe0f ', foldCd(tr.arrive * 1000)] : null]);
      }
      if (id === 'calendar') {
        const t = Date.now() / 1000, items = calMem.items || [];
        const live = items.filter(a => a.start <= t && a.end > t), next = items.filter(a => a.start > t);
        if (live.length) return join(['LIVE ' + live[0].title + (live.length > 1 ? ' +' + (live.length - 1) : '')]);
        return next.length ? join([next[0].title + ' in ', foldCd(next[0].start * 1000)]) : join(['nothing coming up']);
      }
      if (id === 'cooldowns') {
        const c = (l, secs) => { const end = h.at + secs * 1000; return end > now ? [l + ' ', foldCd(end, '\u2713')] : l + ' \u2713'; };
        return join([c('💊', h.cd.drug), c('\u26a1', h.cd.booster), c('🩹', h.cd.medical)]);
      }
      if (id === 'refills') {
        if (h.at < lastTornMidnight()) return join(['reset - refresh']);
        const r = (l, used) => l + (used ? ' \u2713' : ' \u2717');
        return join([r('\u26a1', h.rf.energy), r('🧠', h.rf.nerve), r('🪙', h.rf.token)]);
      }
      if (id === 'bars') {
        const b = (l, k) => { const x = h.bars && h.bars[k]; return x ? l + ' ' + fmtK(barNow(x, h.at).cur) + '/' + fmtK(x.max) : null; };
        return join([b('E', 'energy'), b('N', 'nerve'), b('H', 'happy'), b('L', 'life')]);
      }
      if (id === 'checklist') {
        const all = card.querySelectorAll('.bm-chk').length, ok = card.querySelectorAll('.bm-chk.ok').length;
        return join([ok + '/' + all + ' done']);
      }
      if (id === 'today') {
        const vals = Array.from(card.querySelectorAll('.bm-home-row')).slice(0, 2).map(r => { const b = r.querySelector('b'); return b ? b.textContent : ''; });
        return join(['stocks ' + (vals[0] || '-'), vals[1] && vals[1] !== 'none' ? '🔔 ' + vals[1] : null]);
      }
      if (id === 'busts') { const b = bustModel(); return b ? join([b.avail + ' available', b.next ? ['+1 in ', foldCd(b.next)] : null]) : null; }
      if (id === 'war') { const w = warMem.war, st = warStatus(w); if (!w) return null; return join([st.k === 'soon' ? ['starts in ', foldCd(st.t)] : st.k === 'live' ? (w.us.score - w.them.score >= 0 ? '+' : '\u2212') + fmtN(Math.abs(w.us.score - w.them.score)) : (st.won ? 'won' : 'ended')]); }
      if (id === 'portfolio') { const pm = portfolioModel(); return join([fmtCash(pm.weekly) + '/wk', 'value ' + fmtCash(pm.value)]); }
      if (id === 'company') {
        const c = readComp(); if (!c.days.length) return null;
        return join(['day ' + fmtCash(c.days[0].profit), 'week ' + fmtCash(compWeekCompare(c.days).profit)]);
      }
      if (id === 'week') {
        return join(weekReport().map(r => r.icon + ' ' + r.value));
      }
      if (id === 'overview') {
        const d0 = lastTornMidnight(); if (!(portMem.logsAt >= d0 && portMem.logsV === 3)) return null;
        const net = overviewLines(d0 - 86400000, 1).find(l => l.indexOf('Net') !== -1);
        return net ? 'yesterday ' + (net.split('**')[1] || '') : null;
      }
    } catch (e) { /* summary is optional */ }
    return null;
  }
  // Give a card a foldable title bar. Taps on links or other buttons in the title still work as before.
  function makeFoldable(id, card, h) {
    const head = card.firstElementChild; if (!head) return card;
    const folded = isFolded(id);
    card.setAttribute('data-bm-fold', id);
    head.classList.add('bm-fold-head');
    if (folded) {
      card.classList.add('bm-folded');
      const sum = foldSummary(id, h, card);
      if (sum) head.appendChild(el('span', { class: 'bm-fold-sum' }, sum));
      Array.from(head.querySelectorAll('small, button')).forEach(x => x.remove()); // notes and extra buttons make room for the summary
    }
    head.appendChild(el('button', { class: 'bm-fold', title: folded ? 'Expand' : 'Fold', 'aria-expanded': folded ? 'false' : 'true' }, folded ? '\u25b8' : '\u25be'));
    head.addEventListener('click', ev => {
      const t = ev.target;
      if (t.closest('a') || (t.closest('button') && !t.closest('.bm-fold'))) return;
      ev.preventDefault(); toggleFold(id);
    });
    return card;
  }

  // Every other tab: cards with a title bar fold the same way, in place (no redraw, so anything you're typing stays).
  // Folded, the title shows the card's own note (e.g. "$45.0m/wk"). Saved per tab and card title.
  function foldCards(container, view) {
    Array.from(container.children).forEach(card => {
      if (!card.classList || !card.classList.contains('bm-section') || card.tagName === 'DETAILS' || card.classList.contains('bm-fold-done')) return;
      const head = card.firstElementChild;
      if (!head || !/\b(bm-tr-head|bm-tr-cap|bm-user-header|bm-tr-bhead)\b/.test(head.className) || card.children.length < 2) return;
      card.classList.add('bm-fold-done');
      const note = head.querySelector('small');
      const noteTxt = note ? note.textContent.trim() : '';
      const title = (head.textContent || '').replace(noteTxt, '').replace(/[\d.,$%]+[kmb]?/gi, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const id = view + '|' + title;
      card.setAttribute('data-bm-fold', id);
      head.classList.add('bm-fold-head');
      const btn = el('button', { class: 'bm-fold' });
      const sum = el('span', { class: 'bm-fold-sum' }, noteTxt);
      const paint = () => {
        const f = isFolded(id);
        card.classList.toggle('bm-folded', f);
        btn.textContent = f ? '\u25b8' : '\u25be'; btn.title = f ? 'Expand' : 'Fold'; btn.setAttribute('aria-expanded', f ? 'false' : 'true');
        if (note) note.style.display = f ? 'none' : '';
        if (f && noteTxt) { if (!sum.isConnected) head.insertBefore(sum, btn); } else if (sum.isConnected) sum.remove();
      };
      head.appendChild(btn); paint();
      head.addEventListener('click', ev => {
        const t = ev.target;
        if (t.closest('a, input, select, textarea') || (t.closest('button') && !t.closest('.bm-fold'))) return;
        ev.preventDefault();
        prefs.homeFold = Object.assign({}, prefs.homeFold || {});
        if (prefs.homeFold[id]) delete prefs.homeFold[id]; else prefs.homeFold[id] = true;
        saveConfig(); paint();
      });
    });
  }

  // "Collapse all / Open all" for the tab you're on (only when it has 2+ foldable cards).
  function addFoldAll(content) {
    const cards = Array.from(content.children).filter(c => c.getAttribute && c.getAttribute('data-bm-fold'));
    if (cards.length < 2) return;
    const anyOpen = cards.some(c => !c.classList.contains('bm-folded'));
    const btn = el('button', { class: 'bm-foldall', onclick: () => {
      prefs.homeFold = Object.assign({}, prefs.homeFold || {});
      content.querySelectorAll('[data-bm-fold]').forEach(c => { const id = c.getAttribute('data-bm-fold'); if (anyOpen) prefs.homeFold[id] = true; else delete prefs.homeFold[id]; });
      saveConfig(); rebuildContent();
    } }, anyOpen ? '\u25b8 Collapse all' : '\u25be Open all');
    const row = el('div', { class: 'bm-foldall-row' }, btn);
    const sticky = Array.from(content.children).filter(c => c.classList && c.classList.contains('bm-sticky')).pop();
    if (sticky && sticky.nextSibling) content.insertBefore(row, sticky.nextSibling); else if (sticky) content.appendChild(row); else content.insertBefore(row, content.firstChild);
  }

  const HOME_CARDS = ['war', 'status', 'timers', 'calendar', 'checklist', 'cooldowns', 'refills', 'bars', 'today', 'busts', 'portfolio', 'company', 'overview', 'week'];
  function homeOrder() {
    const saved = Array.isArray(prefs.homeOrder) ? prefs.homeOrder.filter(id => HOME_CARDS.indexOf(id) !== -1) : [];
    return saved.concat(HOME_CARDS.filter(id => saved.indexOf(id) === -1)); // new cards go at the end
  }
  let homeArrange = false; // the Arrange cards list is showing
  const HOME_CARD_NAMES = { status: '🧭 Status & inbox', calendar: '📅 Torn calendar', checklist: '✅ Daily checklist', timers: '\u23f1\ufe0f Timers', war: '\u2694\ufe0f Ranked war', busts: '🔓 Busting', portfolio: '💼 Portfolio', company: '🏢 Company', week: '📆 Last 7 days', overview: '🌅 Yesterday & last week', cooldowns: '💊 Cooldowns', refills: '⚡ Refills today', bars: '📊 Bars', today: '📋 Today' };

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
              el('input', { class: 'bm-input', type: 'text', inputmode: 'decimal', placeholder: 'Amount invested (e.g. 631.5m)', title: 'Money you put into this deal (Portfolio)', value: code.invested || '', style: { width: '50%' }, oninput: e => { code.invested = e.target.value.trim(); } }),
              el('input', { class: 'bm-input', type: 'text', inputmode: 'decimal', placeholder: 'Pay back (default: amount above)', title: 'Cash you send back each payout (Portfolio)', value: code.payback || '', style: { width: '50%' }, oninput: e => { code.payback = e.target.value.trim(); } })),
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
  // Everything worth keeping (never the API key): buddies/stocks/settings + trains, crimes, ranking history, item log.
  async function backupData() {
    await Promise.all([syncTrains(), syncCrimes(), storeReady, rankReady.catch(() => {}), syncComp()]);
    const t = readTrains(), c = readCrimes(), l = readLog();
    return Object.assign({ app: 'buddy-manager', version: SCRIPT_VERSION, exportedAt: new Date().toISOString() }, configObj(), {
      data: {
        trains: { buyers: t.buyers, events: t.events, names: t.names, company: t.company, companyType: t.companyType },
        crimes: { snaps: c.snaps, preds: c.preds, target: c.target },
        rankHist: Array.isArray(rankMem.hist) ? rankMem.hist : [],
        companyDays: readComp().days,
        networthDays: readNw().days,
        itemLog: { entries: l.entries, lastTs: l.lastTs },
        itemNames
      }
    });
  }
  function backupSummary(d) {
    const x = d.data || {}, parts = [Object.keys(d.users || {}).length + ' buddies'];
    if (x.trains) parts.push((x.trains.buyers || []).length + ' train buyers');
    if (x.crimes) parts.push((x.crimes.snaps || []).length + ' crime snapshots');
    if (x.itemLog) parts.push((x.itemLog.entries || []).length + ' logged items');
    if (Array.isArray(x.companyDays)) parts.push(x.companyDays.length + ' company days');
    if (Array.isArray(x.networthDays)) parts.push(x.networthDays.length + ' networth days');
    return parts.join(', ');
  }
  function buildBackup() {
    const box = el('textarea', { class: 'bm-input', rows: '4', placeholder: 'Paste a backup here to restore it', style: { fontFamily: 'monospace', fontSize: '9px', marginTop: '4px', resize: 'vertical' } });
    const exportNow = async () => {
      const data = await backupData();
      const text = JSON.stringify(data);
      box.value = text; box.focus(); box.select();
      const copied = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false);
      copied.then(ok => toast((ok ? 'Backup copied: ' : 'Backup shown below: ') + backupSummary(data)));
      try { // also offer a file, where the browser allows downloads
        const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })), download: 'buddy-manager-backup-' + todayStrLocal() + '.json' });
        document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } catch (e) { /* downloads not supported here */ }
      prefs.lastBackup = Date.now(); saveConfig();
    };
    const importNow = async () => {
      let data;
      try { data = JSON.parse(box.value.trim()); } catch (e) { alert('That isn\u2019t a valid backup (could not read it).'); return; }
      if (!data || typeof data.users !== 'object' || Array.isArray(data.users)) { alert('That isn\u2019t a Buddy Manager backup.'); return; }
      if (!confirm('Replace your current data with this backup?\n\n' + backupSummary(data) + (data.exportedAt ? '\nSaved ' + new Date(data.exportedAt).toLocaleString('en-GB') : ''))) return;
      users = data.users; schedules = data.schedules || {}; usersMeta = data.usersMeta || {};
      prefs = Object.assign({ overdueHour: 18, onlyToday: false }, data.prefs || {});
      await saveConfig();
      const x = data.data || {}; // older backups only have buddies/settings
      if (x.trains) await updateTrains(t => { Object.assign(t, { buyers: x.trains.buyers || [], events: x.trains.events || [], names: x.trains.names || {} });
        if (x.trains.company) t.company = x.trains.company; if (x.trains.companyType) t.companyType = x.trains.companyType; });
      if (x.crimes) { const c = readCrimes(); c.snaps = x.crimes.snaps || []; c.preds = x.crimes.preds || []; if (x.crimes.target) c.target = x.crimes.target; writeCrimes(c); }
      if (Array.isArray(x.companyDays)) { const cm = readComp(); cm.days = x.companyDays; writeComp(cm); }
      if (Array.isArray(x.networthDays)) { const nm = readNw(); nm.days = x.networthDays; writeNw(nm); }
      if (Array.isArray(x.rankHist)) { rankMem = Object.assign({}, rankMem, { hist: x.rankHist }); persist(RANK_KEY, rankMem); }
      if (x.itemLog) { const l = readLog(); l.entries = x.itemLog.entries || []; if (x.itemLog.lastTs > l.lastTs) l.lastTs = x.itemLog.lastTs; writeLog(l); }
      if (x.itemNames) { itemNames = Object.assign({}, itemNames, x.itemNames); persist(ITEMNAMES_KEY, itemNames); }
      toast('Restored ' + backupSummary(data));
      rebuildContent(); renderProfile(); renderCompany(true); refreshIndicators();
    };
    const last = prefs.lastBackup ? 'Last export ' + timeAgo(prefs.lastBackup) + '.' : 'Not exported yet.';
    const storeLine = el('div', { class: 'bm-sub', style: { margin: '2px 0 4px' } },
      IDB.state.pda ? '💽 Saved in Torn PDA\u2019s script storage (kept if the browser cache is cleared), with a backup copy in the browser.' : '💽 Saved in this browser (IndexedDB).');
    IDB.usage().then(u => { if (u && u.quota) storeLine.appendChild(document.createTextNode(' Using ' + (u.used / 1048576).toFixed(2) + ' MB of ' + (u.quota / 1048576).toFixed(0) + ' MB.' + (IDB.state.full ? ' \u26a0\ufe0f Full \u2013 new data is only in the browser copy.' : ''))); });
    return el('details', { class: 'bm-section' },
      el('summary', { style: { cursor: 'pointer', fontWeight: '800', color: '#b9d2ff' } }, '💾 Backup & restore'),
      el('div', { class: 'bm-sub', style: { margin: '4px 0' } }, 'Export saves your buddies, stocks, schedules and settings, train buyers and their trained history, crimes history, company ranking history and the buddy item log (your API key is never included). ' + last), storeLine,
      el('div', { style: { display: 'flex', gap: '6px' } },
        el('button', { class: 'refresh-btn', onclick: exportNow }, '\u2b06 Export'),
        el('button', { class: 'refresh-btn', onclick: importNow }, '\u2b07 Import')),
      box);
  }

  /* ---------------- SETTINGS ---------------- */
  function buildSettingsTab(container) {
    const k = getKey();
    const gr = guardReason(k.key);
    if (gr) container.appendChild(el('div', { class: 'bm-error' },
      (gr.pause ? '\u23f8\ufe0f ' : '\u26d4 ') + (gr.pause ? gr.msg : 'Torn rejected this API key (Error ' + gr.code + ': ' + gr.msg + '). Automatic checks are stopped so the key isn\u2019t retried \u2013 Torn can briefly IP-ban repeated bad keys.'),
      el('button', { class: 'refresh-btn', style: { marginLeft: '6px' }, onclick: () => { clearApiGuard(); toast('Retrying with this key'); rebuildContent(); refreshHome(false); } }, '\u21bb Retry')));
    const pdaOk = isValidKey(PDA_KEY);
    // API key
    const keyInput = el('input', { class: 'bm-input', type: 'password', placeholder: '16-character API key', value: ownKeyMem || jget(APIKEY_KEY, '') || '' });
    const saveKey = v => {
      if (v && !isValidKey(v)) { alert('That doesn\u2019t look like a 16-character Torn API key.'); return; }
      ownKeyMem = v; jset(APIKEY_KEY, v); persist(APIKEY_KEY, v); clearApiGuard();
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
      const feats = ['Home', 'Calendar', 'Item log', 'Item values', 'Portfolio', 'Gym', 'Ranked war', 'Busting', 'Trains', 'Company income', 'Company rank', 'Crimes'];
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
      usageBox.appendChild(el('div', { class: 'bm-tr-foot' }, 'This page: ' + apiCallsLastMinute() + ' call' + (apiCallsLastMinute() === 1 ? '' : 's') + ' in the last minute (kept to at most ' + API_BUDGET + ' a minute, spaced out). Torn\u2019s limit is 100 a minute for all your keys and apps together, including Torn PDA itself.'));
      usageBox.appendChild(el('div', { class: 'bm-tr-foot' }, 'Automatic: Home on page load (max every 30s), Item log about once a minute, Calendar, Company income, Networth, Gym and Portfolio once a day, Ranked war every 30 min (2 min while the War tab is open in a war). Trains and Crimes only when you tap Check / Refresh. Counted on this device only.'));
      usageBox.classList.remove('bm-fold-done'); try { foldCards(container, 'settings'); } catch (e) { /* optional */ }
    });

    // Terms
    container.appendChild(el('details', { class: 'bm-section' },
      el('summary', { style: { cursor: 'pointer', fontWeight: '800', color: '#b9d2ff' } }, '📜 API terms (Torn ToS)'),
      el('table', { class: 'bm-tos' },
        el('tr', null, el('td', null, 'Data storage'), el('td', null, 'Only locally (Torn PDA storage / this browser)')),
        el('tr', null, el('td', null, 'Data sharing'), el('td', null, 'Nobody')),
        el('tr', null, el('td', null, 'Purpose of use'), el('td', null, 'Personal: buddy stock items received, company trains, crimes progress, cooldowns, bars and the Torn calendar. The company ranking also reads swc-bsd.com\u2019s public company list once a day (no key or data sent).')),
        el('tr', null, el('td', null, 'Key storage & sharing'), el('td', null, 'Stored locally / Not shared. Only sent to api.torn.com')),
        el('tr', null, el('td', null, 'Key access level'), el('td', null, 'Limited (for HOF). Custom: user \u2192 log (item receive, faction OC payout, spin the wheel, gym trains, bust success, travel and abroad buys, mugs, crime cash, bounties, missions, rehab, travel, xanax, refills), hof, criminalrecord, cooldowns, refills, bars, personalstats, missions, basic, travel, notifications, money, education, stocks, networth, battlestats, attacks, organizedcrime, calendar; faction \u2192 upgrades, basic, rankedwars; company \u2192 news, employees, profile, detailed, stock, companies; user (v2) \u2192 list; torn \u2192 companies, logtypes, items, education, stocks, bank; market \u2192 pointsmarket')))));

    // Late-day reminder
    const hrIn = el('input', { class: 'bm-input', type: 'number', min: '0', max: '23', value: lateHour(), style: { width: '64px' } });
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '\u23f0 Daily reset reminder', el('small', null, lateOn() ? 'on' : 'off')),
      el('div', { class: 'bm-sub' }, 'From this time (TCT) until Torn\u2019s midnight reset, Home and the BM button flag unused refills, city-shop items, the daily mission and stocks still due.'),
      el('div', { class: 'bm-tr-row', style: { alignItems: 'center' } }, 'From', hrIn, ':00 TCT',
        el('button', { class: 'refresh-btn', onclick: () => { const v = Math.min(23, Math.max(0, parseInt(hrIn.value, 10) || 0)); prefs.lateHour = v; prefs.lateOn = true; saveConfig(); refreshIndicators(); toast('Reminder from ' + pad(v) + ':00 TCT'); rebuildContent(); } }, 'Save'),
        el('button', { class: lateOn() ? 'remove-btn' : 'refresh-btn', onclick: () => { prefs.lateOn = !lateOn(); saveConfig(); refreshIndicators(); rebuildContent(); } }, lateOn() ? 'Turn off' : 'Turn on'))));
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '🧠 Crimes nerve bar', el('small', null, prefs.nerveBar === false ? 'off' : 'on')),
      el('div', { class: 'bm-sub' }, 'A small nerve bar at the top of the Crimes page: your nerve, time to the next +1 and to full. Tap it there to hide it for that visit.'),
      el('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } },
        el('div', { class: 'bm-pill' + (prefs.nerveBar === false ? '' : ' active'), onclick: () => { prefs.nerveBar = true; saveConfig(); rebuildContent(); } }, 'On'),
        el('div', { class: 'bm-pill' + (prefs.nerveBar === false ? ' active' : ''), onclick: () => { prefs.nerveBar = false; saveConfig(); syncNerveBar(); rebuildContent(); } }, 'Off'))));
    const capIn = el('input', { class: 'bm-input', type: 'number', min: '0', placeholder: 'auto', value: prefs.bustCap || '', style: { width: '90px' } });
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '🔓 Busting', el('small', null, prefs.bustBar === false ? 'jail bar off' : 'jail bar on')),
      el('div', { class: 'bm-sub' }, 'Busts available before a likely jail, from your bust log (shown on Home and as a bar on the jail page). Your limit is worked out from the highest penalty you\u2019ve reached; set your own if you know it.'),
      el('div', { class: 'bm-tr-row', style: { alignItems: 'center', flexWrap: 'wrap', marginTop: '4px' } }, 'Limit', capIn,
        el('button', { class: 'refresh-btn', onclick: () => { prefs.bustCap = Math.max(0, parseInt(capIn.value, 10) || 0) || null; saveConfig(); rebuildContent(); } }, 'Save'),
        el('div', { class: 'bm-pill' + (prefs.bustBar === false ? '' : ' active'), onclick: () => { prefs.bustBar = prefs.bustBar === false; saveConfig(); syncBustBar(); rebuildContent(); } }, prefs.bustBar === false ? '\u2610 Jail bar' : '\u2611 Jail bar'),
        el('div', { class: 'bm-pill' + (prefs.bustBadge === false ? '' : ' active'), onclick: () => { prefs.bustBadge = prefs.bustBadge === false; saveConfig(); syncJailBadge(); rebuildContent(); } }, prefs.bustBadge === false ? '\u2610 Count on Jail icon' : '\u2611 Count on Jail icon'),
        el('div', { class: 'bm-pill' + (prefs.jailHard === false ? '' : ' active'), onclick: () => { prefs.jailHard = prefs.jailHard === false; saveConfig(); jailHardness(); rebuildContent(); } }, prefs.jailHard === false ? '\u2610 Hardness' : '\u2611 Hardness'),
        el('div', { class: 'bm-pill' + (prefs.jailSort === false ? '' : ' active'), onclick: () => { prefs.jailSort = prefs.jailSort === false; saveConfig(); jailHardness(); rebuildContent(); } }, prefs.jailSort === false ? '\u2610 Sort easiest first' : '\u2611 Sort easiest first'))));
    // Badge alerts
    const aOff = prefs.alertOff || {};
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '🔔 Badge alerts', el('small', null, READY_ALERTS.filter(a => !aOff[a[0]]).length + ' on')),
      el('div', { class: 'bm-sub' }, 'Adds to the count on the BM button when one of these happens (checked every minute from your last Home refresh).'),
      el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' } }, READY_ALERTS.map(([k, label]) =>
        el('div', { class: 'bm-pill' + (aOff[k] ? '' : ' active'), onclick: () => { prefs.alertOff = Object.assign({}, prefs.alertOff || {}); if (prefs.alertOff[k]) delete prefs.alertOff[k]; else prefs.alertOff[k] = true; saveConfig(); refreshIndicators(); rebuildContent(); } }, (aOff[k] ? '\u2610 ' : '\u2611 ') + label)),
        el('div', { class: 'bm-pill' + (prefs.homeAlerts === false ? '' : ' active'), onclick: () => { prefs.homeAlerts = prefs.homeAlerts === false; saveConfig(); rebuildContent(); } }, (prefs.homeAlerts === false ? '\u2610' : '\u2611') + ' List them at the top of Home')),
      (() => {
        const inp = el('input', { class: 'bm-input', inputmode: 'numeric', style: { width: '120px', display: 'inline-block' }, value: String(cashLimit()) });
        return el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '6px' } },
          el('span', { class: 'bm-sub', style: { margin: 0 } }, '💵 Warn when carrying at least $'), inp,
          el('button', { class: 'refresh-btn', onclick: () => { prefs.cashWarn = Number(String(inp.value).replace(/[^\d]/g, '')) || 0; saveConfig(); refreshIndicators(); toast(prefs.cashWarn ? 'Cash warning at ' + fmtCash(prefs.cashWarn) : 'Cash warning off', '💵'); rebuildContent(); } }, 'Save'),
          el('div', { class: 'bm-sub', style: { width: '100%', margin: 0 } }, 'Uses the cash figure from your last Home refresh (when a Torn page loads). 0 turns it off.'));
      })()));
    // Where the BM button lives
    const docked = !!$('#bm-dock-btn');
    const lOpt = (mode, label) => el('div', { class: 'bm-pill' + (launcherMode() === mode ? ' active' : ''), onclick: () => { prefs.launcher = mode; saveConfig(); syncDock(); rebuildContent(); } }, label);
    container.appendChild(el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-head' }, '\ud83d\udccd BM button', el('small', null, docked ? 'in Torn\u2019s icon bar' : 'floating')),
      el('div', { class: 'bm-sub' }, 'Icon bar puts it next to Torn\u2019s chat icons (faction, company, notes, people) when the page has them, and hides the floating button. Other pages keep the floating button.'),
      el('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } }, lOpt('auto', 'Icon bar'), lOpt('float', 'Floating only'))));
    container.appendChild(buildBackup());
    container.appendChild(el('div', { class: 'bm-status' }, 'Buddy Manager v' + SCRIPT_VERSION));
  }

  /* ---------------- menu ---------------- */
  const TITLES = { gym: 'Gym', war: 'Ranked War', portfolio: 'Portfolio', income: 'Company Income', home: 'Home', user: 'Buddies', log: 'Buddies', config: 'Buddies', trains: 'Company Trains', crimes: 'Crimes', settings: 'Settings' };
  const BUDDY_VIEWS = ['user', 'log', 'config'];
  const COMPANY_VIEWS = ['trains', 'income'];
  // Five tabs: Home, Buddies, Money (company + portfolio), Activity (crimes, gym, war); Settings is the cog.
  const MONEY_VIEWS = ['portfolio', 'trains', 'income'];
  const ACTIVITY_VIEWS = ['crimes', 'gym', 'war'];
  const lastIn = { money: 'portfolio', activity: 'crimes' };
  const tabGroup = v => (BUDDY_VIEWS.indexOf(v) !== -1 ? 'user' : MONEY_VIEWS.indexOf(v) !== -1 ? 'money' : ACTIVITY_VIEWS.indexOf(v) !== -1 ? 'activity' : v);
  const isMenuOpen = () => { const m = $('#bm-menu'); return !!(m && m.style.display === 'flex'); };

  function rebuildContent() {
    const content = $('#bm-content'); if (!content) return;
    const h = $('#bm-menu h2 .bm-h2-t'); if (h) h.textContent = TITLES[VIEW];
    document.querySelectorAll('#bm-menu .bm-tab').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === tabGroup(VIEW)));
    const cog = $('#bm-menu .bm-h2-cog'); if (cog) cog.classList.toggle('active', VIEW === 'settings');
    if (MONEY_VIEWS.indexOf(VIEW) !== -1) lastIn.money = VIEW;
    if (ACTIVITY_VIEWS.indexOf(VIEW) !== -1) lastIn.activity = VIEW;
    // Same view redrawn (refresh, sync, a tick): stay where you were. New view: start at the top.
    const keepScroll = content.getAttribute('data-bm-view') === VIEW ? content.scrollTop : 0;
    content.innerHTML = '';
    if (BUDDY_VIEWS.indexOf(VIEW) !== -1) {
      const sub = (v, label) => el('button', { class: 'bm-subtab' + (VIEW === v ? ' active' : ''), 'data-view': v, onclick: () => setView(v) }, label);
      content.appendChild(el('div', { class: 'bm-sticky' }, el('div', { class: 'bm-subtabs' }, sub('user', 'Buddy'), sub('log', '📜 Log'), sub('config', '✏️ Edit'))));
    }
    if (MONEY_VIEWS.indexOf(VIEW) !== -1) {
      const sub = (v, label) => el('button', { class: 'bm-subtab' + (VIEW === v ? ' active' : ''), 'data-view': v, onclick: () => setView(v) }, label);
      content.appendChild(el('div', { class: 'bm-sticky' }, el('div', { class: 'bm-subtabs' }, sub('portfolio', '💼 Portfolio'), sub('income', '📊 Income'), sub('trains', '🚂 Trains'))));
      const al = buildTabAlerts('money'); if (al) content.appendChild(al);
    }
    if (ACTIVITY_VIEWS.indexOf(VIEW) !== -1) {
      const sub = (v, label) => el('button', { class: 'bm-subtab' + (VIEW === v ? ' active' : ''), 'data-view': v, onclick: () => setView(v) }, label);
      content.appendChild(el('div', { class: 'bm-sticky' }, el('div', { class: 'bm-subtabs' }, sub('crimes', '📈 Crimes'), sub('gym', '💪 Gym'), sub('war', '\u2694\ufe0f War'))));
      const al = buildTabAlerts('activity'); if (al) content.appendChild(al);
    }
    if (VIEW === 'config') buildConfig(content);
    else if (VIEW === 'income') buildIncome(content);
    else if (VIEW === 'settings') buildSettingsTab(content);
    else if (VIEW === 'log') buildLog(content);
    else if (VIEW === 'trains') buildTrains(content);
    else if (VIEW === 'crimes') buildCrimes(content);
    else if (VIEW === 'portfolio') buildPortfolio(content);
    else if (VIEW === 'gym') buildGym(content);
    else if (VIEW === 'war') buildWar(content);
    else if (VIEW === 'home') buildHome(content);
    else buildBuddy(content);
    if (VIEW !== 'home' && VIEW !== 'config') { try { foldCards(content, VIEW); } catch (e) { /* folding is optional */ } }
    if (VIEW !== 'config' && !(VIEW === 'home' && homeArrange)) { try { addFoldAll(content); } catch (e) { /* optional */ } }
    content.setAttribute('data-bm-view', VIEW);
    content.scrollTop = keepScroll;
    refreshIndicators();
  }
  function setView(v) { if (v !== 'home') homeArrange = false; VIEW = v; if (v !== 'log') LOG_FILTER = null; if (!isMenuOpen()) buildMenu(); else rebuildContent(); }

  // Pull the latest saved data (another open page may have changed it) and redraw.
  function syncAll() {
    return Promise.all([IDB.get(STORAGE_KEY), IDB.get(DONE_KEY), IDB.get(ITEMLOG_KEY), syncTrains(), syncCrimes(), syncHome(), syncCal(), syncComp(), IDB.get(NW_KEY).then(x => { if (x) nwMem = x; }).catch(() => {})])
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
    // Torn-style tabs: icon with a short label underneath
    const tab = (v, ic, label, title, go) => el('button', { class: 'bm-tab', 'data-view': v, title, 'aria-label': title, onclick: () => setView(go ? go() : v) },
      el('span', { class: 'bm-tab-ic' }, ic), el('span', { class: 'bm-tab-tx' }, label));
    const close = () => { const m = $('#bm-menu'); if (m) m.style.display = 'none'; const d = $('#bm-dock-btn'); if (d) d.classList.remove('bm-open'); };
    const menu = el('div', { id: 'bm-menu', style: { display: 'flex' } },
      el('h2', null, el('span', { class: 'bm-h2-t' }, 'Buddy Manager'),
        el('button', { class: 'bm-h2-cog', title: 'Settings', 'aria-label': 'Settings', onclick: () => setView('settings') }, '\u2699\ufe0f'),
        el('button', { class: 'bm-h2-x', title: 'Close', 'aria-label': 'Close', onclick: close }, '\u2715')),
      el('div', { class: 'bm-tabs' },
        tab('home', '🏠', 'Home', 'Home'),
        tab('user', '💬', 'Buddies', 'Buddies: buddy list, item log, edit'),
        tab('money', '💼', 'Money', 'Money: portfolio, company income and trains', () => lastIn.money),
        tab('activity', '💪', 'Activity', 'Activity: crimes, gym and ranked war', () => lastIn.activity)),
      el('div', { id: 'bm-content' }));
    let bd = $('#bm-backdrop');
    if (!bd) { bd = el('div', { id: 'bm-backdrop', onclick: ev => { ev.preventDefault(); ev.stopPropagation(); close(); } }); document.body.appendChild(bd); }
    document.body.appendChild(menu);
    const syncBd = () => { const b = $('#bm-backdrop'); if (b) b.style.display = menu.isConnected && menu.style.display === 'flex' ? 'block' : 'none'; };
    new MutationObserver(syncBd).observe(menu, { attributes: true, attributeFilter: ['style'] }); syncBd();
    placeMenu(menu);
    rebuildContent();
  }
  // Opened from the icon bar: drop the menu down below it (or up from it, if the bar is at the bottom of the screen).
  let launchFrom = null;
  function placeMenu(menu) {
    const st = menu.style;
    st.top = st.bottom = st.left = st.right = ''; // full-width sheet (CSS)
    // Stay clear of app bars that sit over the page (Torn PDA's bottom bar): use the visible height, minus room at the bottom.
    const viewH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    st.maxHeight = Math.max(240, Math.round(viewH - 8 - 88)) + 'px';
    return; // the old anchoring is kept below for reference
    const b = launchFrom && launchFrom.isConnected ? launchFrom : null;
    if (!b || !b.offsetParent) { st.top = st.bottom = st.left = st.right = st.maxHeight = ''; return; }
    const r = b.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(menu.offsetWidth || 258, vw - 16);
    st.left = Math.max(8, Math.min(r.right - w, vw - w - 8)) + 'px'; st.right = 'auto';
    if (r.top < vh / 2) { st.top = Math.round(r.bottom + 6) + 'px'; st.bottom = 'auto'; st.maxHeight = Math.max(200, vh - r.bottom - 18) + 'px'; }
    else { st.bottom = Math.round(vh - r.top + 6) + 'px'; st.top = 'auto'; st.maxHeight = Math.max(200, r.top - 18) + 'px'; }
  }
  // On-screen keyboard: keep the menu inside the part of the screen you can still see, hide the title and
  // tabs to make room, and scroll the box you're typing in into view. Works whether the keyboard shrinks the
  // page (Android / Torn PDA) or slides over it (iOS).
  let fullH = window.innerHeight;
  function fitMenuToKeyboard() {
    const m = $('#bm-menu'); if (!m || m.style.display !== 'flex') return;
    const vv = window.visualViewport, h = vv ? vv.height : window.innerHeight, top = vv ? vv.offsetTop : 0;
    const a = document.activeElement;
    const typing = !!(a && m.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
    if (!typing && h > fullH * 0.85) fullH = Math.max(h, window.innerHeight); // remember the full height while no keyboard is up
    const kb = typing && h < fullH * 0.8;
    m.classList.toggle('bm-kb', kb);
    if (kb) {
      m.style.top = Math.round(top + 6) + 'px'; m.style.bottom = 'auto';
      m.style.maxHeight = Math.max(160, Math.round(h - 12)) + 'px';
      setTimeout(() => { try { a.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ } }, 60);
    } else if (m.getAttribute('data-bm-kb') === '1') placeMenu(m);
    m.setAttribute('data-bm-kb', kb ? '1' : '0');
  }
  if (window.visualViewport) { window.visualViewport.addEventListener('resize', fitMenuToKeyboard); window.visualViewport.addEventListener('scroll', fitMenuToKeyboard); }
  window.addEventListener('resize', fitMenuToKeyboard);
  window.addEventListener('orientationchange', () => setTimeout(() => { const m = $('#bm-menu'); if (m && !m.classList.contains('bm-kb')) placeMenu(m); }, 300));
  document.addEventListener('focusin', ev => { if (ev.target && ev.target.closest && ev.target.closest('#bm-menu')) { setTimeout(fitMenuToKeyboard, 250); setTimeout(fitMenuToKeyboard, 700); } });
  document.addEventListener('focusout', () => setTimeout(fitMenuToKeyboard, 300));
  function toggleMenu(ev) {
    const m = $('#bm-menu');
    if (m && m.style.display === 'flex') m.style.display = 'none';
    else {
      launchFrom = ev && ev.currentTarget && ev.currentTarget.id === 'bm-dock-btn' ? ev.currentTarget : null;
      VIEW = 'home'; LOG_FILTER = null; homeArrange = false; buildMenu(); // the BM button always opens on Home
    }
    const d = $('#bm-dock-btn'); if (d) d.classList.toggle('bm-open', isMenuOpen());
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
  // Inactivity: hours since each employee's last action (from the company API).
  const IDLE_WARN_H = 18;
  const fmtIdle = h => (h >= 48 ? Math.floor(h / 24) + 'd ' + Math.floor(h % 24) + 'h' : Math.floor(h) + 'h');
  function idleList(s) {
    const now = Date.now() / 1000, out = [];
    Object.keys(s.employees || {}).forEach(id => { const e = s.employees[id]; if (e && e.last) out.push({ id, h: Math.max(0, (now - e.last) / 3600) }); });
    return out;
  }
  // On the employees page, keep last-action times fresh: 1 call when they're over 10 minutes old.
  let staffBusy = false;
  async function staffActivity(s) {
    if (staffBusy || !onCompanyPage() || document.hidden) return;
    if (s.empAt && Date.now() - s.empAt < 600000) return;
    const { key } = getKey(); if (!key) return;
    staffBusy = true;
    try {
      const emps = parseCompanyEmployees(await apiGet('/company/?selections=employees', key));
      if (emps) await updateTrains(t => { t.employees = emps; t.empAt = Date.now(); Object.keys(emps).forEach(id => { if (emps[id].name) t.names[id] = emps[id].name; }); });
    } catch (e) { await updateTrains(t => { t.empAt = Date.now(); }); } // don't retry straight away
    finally { staffBusy = false; renderCompany(true); }
  }
  function renderCompany(force) {
    if (!onCompanyPage()) return;
    const rows = companyRows();
    const oldCard = document.getElementById('bm-emp-card');
    const oldPos = document.getElementById('bm-pos-card');
    if (!rows.length) { if (oldCard) oldCard.remove(); if (oldPos) oldPos.remove(); return; }
    const s = readTrains();
    const order = trainOrder(s);
    staffActivity(s);
    const sig = JSON.stringify([rows.length, s.buyers, s.events.length, s.trainsLeft, order.map(o => [o.b.id, o.from, o.to]), s.employees, Math.floor(Date.now() / 300000)]);
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
        (() => { const n = idleList(s).filter(x => x.h >= IDLE_WARN_H).length; return n ? el('span', { class: 'bm-emp-posnote warn' }, '💤 ' + n + ' inactive') : null; })()));
    const list = rows[0].parentElement;
    list.parentElement.insertBefore(card, list);
    if (oldPos) oldPos.remove();

    // Tags on employee rows: inactivity (all employees) + train info (buyers)
    const idleBy = {}; idleList(s).forEach(x => { idleBy[x.id] = x.h; });
    rows.forEach(li => {
      li.__bmDone = true;
      Array.from(li.children).forEach(c => { if (c.classList && c.classList.contains('bm-emp-chip')) c.remove(); });
      li.classList.remove('bm-emp-next', 'bm-emp-idle', 'bm-emp-idle24');
      const id = rowUserId(li);
      const b = s.buyers.find(x => String(x.id) === id);
      const h = idleBy[id];
      const idle = h != null && h >= IDLE_WARN_H;
      if (idle) li.classList.add(h >= 24 ? 'bm-emp-idle24' : 'bm-emp-idle');
      if (!b && !idle) return;
      if (getComputedStyle(li).position === 'static') li.style.position = 'relative';
      const parts = [], cls = ['bm-emp-chip'], tips = [];
      if (idle) {
        parts.push(el('span', { class: h >= 24 ? 'bm-idle-24' : 'bm-idle-soon' }, '💤 ' + fmtIdle(h) + ' inactive'));
        tips.push('Last action ' + fmtIdle(h) + ' ago' + (h >= 24 ? ' - over 24 hours' : ' - coming up to 24 hours'));
        cls.push(h >= 24 ? 'idle24' : 'idle');
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
  /* ---------------- company daily ranking ----------------
     On your company's page, under "Company Details": where you rank among every company of your type,
     from Torn's public company list (company/<type> -> companies: 1 call a day after 20:00 TCT, or when you tap \u21bb).
     Idea and labels inspired by swc-bsd.com/torn/dailycompany (linked for the full list). */
  const RANK_KEY = 'bm-rank-v1';
  let rankMem = {}, rankSig = '', rankBusy = false;
  const rankReady = IDB.get(RANK_KEY).then(r => { rankMem = Object.assign({}, r || {}, rankMem); }).catch(() => {});
  const fmtM = n => (n == null || isNaN(n) ? '-' : '$' + (Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + 'b' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'm' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(Math.round(n))));
  // company/<type>?selections=companies -> { company: { <id>: { ID, rating, name, daily_income, weekly_income, ... } } }
  // Decode "&#039;" / "&amp;" etc. safely (DOMParser documents are inert: nothing loads or runs).
  function decodeEntities(str) {
    if (!/&[#a-z0-9]+;/i.test(str || '')) return String(str || '');
    try { return new DOMParser().parseFromString('<!doctype html><body>' + str, 'text/html').body.textContent || ''; } catch (e) { return String(str); }
  }
  // company/<type>?selections=companies -> { company: [ {ID, rating, name, daily_income, weekly_income, ...} ] } (top 100 only)
  function parseCompanyList(json) {
    if (!json || typeof json !== 'object') return [];
    const isCo = v => v && typeof v === 'object' && 'daily_income' in v;
    let rows = null;
    Object.keys(json).forEach(k => {
      const v = json[k];
      if (rows || !v || typeof v !== 'object') return;
      if (Array.isArray(v) && v.some(isCo)) rows = v;
      else if (!Array.isArray(v) && Object.keys(v).some(id => isCo(v[id]))) rows = Object.keys(v).map(id => Object.assign({ ID: id }, v[id]));
    });
    return (rows || []).filter(isCo).map(c => ({ id: String(c.ID), name: decodeEntities(c.name), rating: Number(c.rating) || 0,
      daily: Number(c.daily_income) || 0, weekly: Number(c.weekly_income) || 0, dc: Number(c.daily_customers) || 0,
      staff: (Number(c.employees_hired) || 0) + '/' + (Number(c.employees_capacity) || 0), age: Number(c.days_old) || 0 }));
  }
  // swc-bsd.com/torn/dailycompany page -> every company of the type. Each company reads like:
  //   "10* <a href=...corpinfo&ID=85070>Salty Dog Mining</a> Rank#1 performed WEAK today
  //    $101.28m vs average $101.37m ($709.59m weekly) 2,374 days old with 20/20 employees"
  const SWC_URL = 'https://swc-bsd.com/torn/dailycompany?companyType=';
  function swcMoney(n, unit) { const v = parseFloat(String(n).replace(/,/g, '')); const u = (unit || '').toLowerCase(); return Math.round(v * (u === 'b' ? 1e9 : u === 'm' ? 1e6 : u === 'k' ? 1e3 : 1)); }
  function parseSwcPage(html) {
    let doc;
    try { doc = new DOMParser().parseFromString(String(html || ''), 'text/html'); } catch (e) { return []; }
    if (!doc || !doc.body) return [];
    // Flatten the page to text in reading order, marking each company link as \u0001id\u0002name\u0003.
    // Works whatever their layout is (table, cards or plain blocks).
    const idOf = a => { const m = /[?&#!]ID=(\d+)/i.exec(a.getAttribute('href') || ''); return m && /corpinfo|joblist|compan/i.test(a.getAttribute('href') || '') ? m[1] : null; };
    let buf = '';
    const walk = node => {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { buf += n.nodeValue; continue; }
        if (n.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.tagName)) continue;
        const id = n.tagName === 'A' ? idOf(n) : null;
        if (id) { buf += ' \u0001' + id + '\u0002' + (n.textContent || '').trim() + '\u0003 '; continue; }
        buf += ' '; walk(n); buf += ' ';
      }
    };
    walk(doc.body);
    buf = buf.replace(/\s+/g, ' ');
    const parts = buf.split('\u0001'), out = [], seen = new Set();
    for (let k = 1; k < parts.length; k++) {
      const head = parts[k], idEnd = head.indexOf('\u0002'), nameEnd = head.indexOf('\u0003');
      if (idEnd < 0 || nameEnd < 0) continue;
      const id = head.slice(0, idEnd), name = head.slice(idEnd + 1, nameEnd), text = head.slice(nameEnd + 1);
      const money = /\$\s*([\d,.]+)\s*([kmb])?\s*vs\s*average\s*\$\s*([\d,.]+)\s*([kmb])?\s*\(\s*\$\s*([\d,.]+)\s*([kmb])?\s*weekly/i.exec(text);
      if (!money || seen.has(id)) continue;
      // the rating ("10*") sits just before the link, i.e. at the end of the previous chunk
      const prev = parts[k - 1].slice(parts[k - 1].lastIndexOf('\u0003') + 1);
      const ratings = prev.match(/(\d{1,2})\s*\*/g);
      const rank = /Rank\s*#\s*(\d+)/i.exec(text), perf = /performed\s+(STRONG|WEAK)/i.exec(text);
      const age = /([\d,]+)\s*days?\s*old/i.exec(text), staff = /with\s+(\d+\s*\/\s*\d+)\s*employees/i.exec(text);
      seen.add(id);
      out.push({ id, name, rating: ratings ? parseInt(ratings[ratings.length - 1], 10) : 0,
        daily: swcMoney(money[1], money[2]), avg: swcMoney(money[3], money[4]), weekly: swcMoney(money[5], money[6]),
        swcRank: rank ? Number(rank[1]) : null, perf: perf ? perf[1].toUpperCase() : null,
        age: age ? Number(age[1].replace(/,/g, '')) : 0, staff: staff ? staff[1].replace(/\s/g, '') : '' });
    }
    return out;
  }
  // Plain-text GET for a non-Torn page: Torn PDA's handler (no cross-site limits) or fetch.
  async function httpGetText(url) {
    if (typeof window.PDA_httpGet === 'function') {
      const r = await withTimeout(window.PDA_httpGet(url, {}), REQUEST_TIMEOUT);
      return String(r && (r.responseText != null ? r.responseText : (r.body != null ? r.body : r)) || '');
    }
    const res = await withTimeout(fetch(url, { cache: 'no-store' }), REQUEST_TIMEOUT);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  }
  // Ranks and neighbours for company `myId` in a list.
  function companyRanking(list, myId) {
    const byDaily = list.slice().sort((a, b) => b.daily - a.daily);
    const i = byDaily.findIndex(c => c.id === String(myId));
    if (i < 0) return null;
    const me = byDaily[i];
    const byWeekly = list.slice().sort((a, b) => b.weekly - a.weekly);
    const tier = byDaily.filter(c => c.rating === me.rating);
    const avg = me.weekly / 7;
    return {
      me, total: list.length, rank: i + 1, pct: Math.max(1, Math.ceil((i + 1) / list.length * 100)),
      wRank: byWeekly.findIndex(c => c.id === me.id) + 1,
      tRank: tier.findIndex(c => c.id === me.id) + 1, tTotal: tier.length,
      perf: avg > 0 ? (me.daily - avg) / avg : null,
      above: i > 0 ? byDaily[i - 1] : null,
      // Star tiers compared on weekly income: the weakest company one star up, the best one star down.
      upTier: (() => { const up = list.filter(c => c.rating === me.rating + 1); return up.length ? up.reduce((a, b) => (b.weekly < a.weekly ? b : a)) : null; })(),
      downTier: (() => { const dn = list.filter(c => c.rating === me.rating - 1); return dn.length ? dn.reduce((a, b) => (b.weekly > a.weekly ? b : a)) : null; })(),
      near: byDaily.slice(Math.max(0, i - 2), i + 3).map((c, k) => Object.assign({ pos: Math.max(0, i - 2) + k + 1 }, c))
    };
  }
  // company -> profile (your own company): { company: { ID, company_type, name, rating, daily_income, weekly_income, ... } }
  function parseOwnCompany(json) {
    const c = json && (json.company || json.profile);
    if (!c || (c.ID == null && c.id == null)) return null;
    return { id: String(c.ID != null ? c.ID : c.id), type: String(c.company_type != null ? c.company_type : ''), name: String(c.name || ''),
      rating: Number(c.rating) || 0, daily: Number(c.daily_income) || 0, weekly: Number(c.weekly_income) || 0 };
  }
  // Latest 20:00 TCT that has passed (company figures and swc-bsd's list are final by then).
  function lastRankUpdateTime(now) { const d = new Date(now || Date.now()); const n = d.getTime(); d.setUTCHours(20, 0, 0, 0); if (d.getTime() > n) d.setUTCDate(d.getUTCDate() - 1); return d.getTime(); }
  async function refreshRank(force) {
    await rankReady; await storeReady; await trainsReady;
    if (rankBusy) return;
    const now = Date.now();
    if (!force && rankMem.at && !rankMem.error && rankMem.at >= lastRankUpdateTime()) return;
    if (force && rankMem.at && now - rankMem.at < 15000) return;
    const { key } = getKey(); if (!key) return;
    rankBusy = true;
    try {
      // Your own company first (reliable ID, type and today's figures), then every company of that type.
      const own = parseOwnCompany(await apiGet('/company/?selections=profile', key));
      if (!own || !own.type) throw new Error('Could not read your company (are you in one?)');
      updateTrains(x => { x.company = { name: own.name, id: own.id }; x.companyType = own.type; });
      // Full list from swc-bsd (once a day, no key sent); Torn's API only lists the top 100 companies.
      let list = [], source = 'swc';
      try { list = parseSwcPage(await httpGetText(SWC_URL + encodeURIComponent(own.type))); } catch (e) { list = []; }
      if (list.length < 101) {
        const api = parseCompanyList(await apiGet('/company/' + own.type + '?selections=companies', key));
        if (api.length > list.length) { list = api; source = 'api'; }
      }
      // Find yourself by ID, then by name; if the list hasn't caught up, add your own figures so ranks still work.
      let me = list.find(c => c.id === own.id) || list.find(c => c.name && c.name.toLowerCase() === own.name.toLowerCase());
      if (me) { me.id = own.id; me.daily = own.daily || me.daily; me.weekly = own.weekly || me.weekly; me.rating = own.rating || me.rating; }
      else list.push({ id: own.id, name: own.name, rating: own.rating, daily: own.daily, weekly: own.weekly, dc: 0, staff: '', age: 0 });
      const day = lastTornMidnight();
      const hist = (Array.isArray(rankMem.hist) ? rankMem.hist.slice() : []).filter(x => x.day !== day);
      const r = companyRanking(list, own.id);
      hist.push({ day, daily: own.daily, weekly: own.weekly, rank: r ? r.rank : null, tRank: r ? r.tRank : null });
      rankMem = { at: now, type: own.type, myId: own.id, list, source, hist: hist.sort((a, b) => a.day - b.day).slice(-60), error: null, listed: !!me };
    } catch (e) {
      rankMem = Object.assign({}, rankMem, { at: now, error: (e.code != null ? 'Error ' + e.code + ': ' : '') + (e.message || 'failed') });
    } finally {
      persist(RANK_KEY, rankMem);
      rankBusy = false;
      renderRankCard(true);
    }
  }
  // The "Company Details:" block on your company's page (where the card goes). Scans text only (cheap).
  function findHeading(re) {
    const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: t => (t.nodeValue && t.nodeValue.length < 40 && re.test(t.nodeValue) && !(t.parentElement && t.parentElement.closest('#bm-menu,#bm-rank-card')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)
    });
    let n, last = null; while ((n = w.nextNode())) last = n;
    return last && last.parentElement;
  }
  function companyDetailsAnchor() {
    const head = findHeading(/^\s*Company Details:?\s*$/i);
    if (!head) return null;
    // Insert before the next section header ("Your Details:") if there is one, otherwise after the details block.
    let y = findHeading(/^\s*Your Details:?\s*$/i);
    if (y) { while (y.parentElement && y.parentElement.children.length === 1) y = y.parentElement; return { before: y }; }
    let blk = head; while (blk.parentElement && blk.parentElement.children.length === 1) blk = blk.parentElement;
    return { after: blk.nextElementSibling || blk };
  }
  // History-based changes: today vs the previous Torn day, this week vs 7 days ago.
  function rankChanges(hist, me) {
    const h = (hist || []).slice().sort((a, b) => a.day - b.day);
    const today = lastTornMidnight();
    const prev = h.filter(x => x.day < today).pop();
    const weekAgo = h.filter(x => x.day <= today - 7 * 86400000).pop();
    const rel = (a, b) => (b ? (a - b) / b : null);
    return {
      day: prev && prev.daily ? rel(me.daily, prev.daily) : null,
      vsAvg: me.weekly ? rel(me.daily, me.weekly / 7) : null,
      week: weekAgo && weekAgo.weekly ? rel(me.weekly, weekAgo.weekly) : null
    };
  }
  const pctTxt = x => (x > 0 ? '+' : x < 0 ? '\u2212' : '') + Math.abs(Math.round(x * 100)) + '%';
  const note = (x, label, tip) => (x == null ? null : el('span', { class: 'bm-co-note ' + (x >= 0 ? 'up' : 'down'), title: tip }, pctTxt(x) + ' ' + label));
  // Put small notes after Torn's own "Daily income" / "Weekly income" values.
  function annotateIncome(label, notes) {
    const head = findHeading(new RegExp('^\\s*' + label + ':?\\s*$', 'i'));
    if (!head) return;
    let box = head; while (box.parentElement && box.parentElement.children.length === 1) box = box.parentElement;
    const scope = box.parentElement || box;
    scope.querySelectorAll('.bm-co-note').forEach(n => n.remove());
    const parts = notes.filter(Boolean); if (!parts.length) return;
    // the value is the first "$..." text after the label inside the same block
    const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, { acceptNode: t => (/\$\s?[\d,]+/.test(t.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
    const val = w.nextNode();
    const target = val ? val.parentElement : scope;
    parts.forEach(p => target.appendChild(p));
  }
  let rankOpen = false;
  function renderRankCard(force) {
    if (!onCompanyPage()) return;
    const old = document.getElementById('bm-rank-card');
    const anchor = companyDetailsAnchor();
    if (!anchor) { if (old) old.remove(); return; }
    const r = rankMem.list && rankMem.myId ? companyRanking(rankMem.list, rankMem.myId) : null;
    const sig = JSON.stringify([rankMem.at, rankMem.error, !!r, r && r.rank, rankOpen]);
    if (old && old.isConnected && !force && sig === rankSig && (!r || document.querySelector('.bm-co-note'))) return;
    rankSig = sig;
    if (old) old.remove();

    // Inline notes next to Torn's figures
    if (r) {
      const ch = rankChanges(rankMem.hist, r.me);
      annotateIncome('Daily income', [note(ch.day, 'day', 'Daily income vs the previous day'), note(ch.vsAvg, 'wk', 'Daily income vs your 7-day average (weekly \u00f7 7)')]);
      annotateIncome('Weekly income', [note(ch.week, 'wk', 'Weekly income vs 7 days ago')]);
    }

    const card = el('div', { id: 'bm-rank-card' });
    if (!rankMem.error && rankMem.source === 'api') card.appendChild(el('div', { class: 'bm-rk-note' }, '\u26a0\ufe0f swc-bsd list unavailable \u2013 compared with Torn\u2019s top 100 only.'));
    if (rankMem.error) card.appendChild(el('div', { class: 'bm-rk-note' }, '\u26a0\ufe0f ' + rankMem.error,
      el('button', { class: 'refresh-btn', style: { marginLeft: '6px' }, onclick: async ev => { ev.preventDefault(); ev.currentTarget.textContent = '\u2026'; await refreshRank(true); } }, '\u21bb Retry')));
    if (!r) {
      if (!rankMem.error) card.appendChild(el('div', { class: 'bm-rk-note' }, 'Loading the company list\u2026'));
    } else {
      const up = r.upTier, dn = r.downTier, gapUp = up ? r.me.weekly - up.weekly : null, gapDn = dn ? dn.weekly - r.me.weekly : null;
      // Summary line, like "#62 of 81 ▸ $8.8m ahead of weakest 6★ · $166m behind best 4★"
      card.appendChild(el('div', { class: 'bm-rk-sum', role: 'button', onclick: () => { rankOpen = !rankOpen; renderRankCard(true); } },
        el('span', { class: 'bm-rk-pos' }, '#' + r.tRank + ' of ' + r.tTotal), el('span', { class: 'bm-rk-arrow' }, rankOpen ? '\u25be' : '\u25b8'),
        el('span', { class: 'bm-rk-tiers' },
          up ? el('span', { class: gapUp >= 0 ? 'up' : 'down' }, fmtM(Math.abs(gapUp)) + (gapUp >= 0 ? ' ahead of weakest ' : ' behind weakest ') + up.rating + '\u2605') : null,
          dn ? el('span', { class: gapDn > 0 ? 'down' : 'up' }, fmtM(Math.abs(gapDn)) + (gapDn > 0 ? ' behind best ' : ' ahead of best ') + dn.rating + '\u2605') : null)));
      if (rankOpen) {
        card.appendChild(el('div', { class: 'bm-rk-big' },
          el('div', null, el('div', { class: 'bm-rk-num' }, '#' + r.rank), el('div', { class: 'bm-rk-cap' }, 'of ' + r.total + ' by daily \u00b7 top ' + r.pct + '%')),
          el('div', null, el('div', { class: 'bm-rk-num sm' }, '#' + r.tRank), el('div', { class: 'bm-rk-cap' }, 'of ' + r.tTotal + ' at ' + r.me.rating + '\u2605')),
          el('div', null, el('div', { class: 'bm-rk-num sm' }, '#' + r.wRank), el('div', { class: 'bm-rk-cap' }, 'by weekly'))));
        if (r.perf != null) card.appendChild(el('div', { class: 'bm-rk-line' },
          el('span', { class: 'bm-rk-pill ' + (r.perf >= 0 ? 'good' : 'bad') }, (r.perf >= 0 ? 'STRONG ' : 'WEAK ') + pctTxt(r.perf) + ' vs 7-day avg')));
        if (r.above) card.appendChild(el('div', { class: 'bm-rk-note' }, fmtM(r.above.daily - r.me.daily) + ' more daily income to pass #' + (r.rank - 1) + ' ' + r.above.name));
        card.appendChild(el('div', { class: 'bm-rk-table' },
          el('span', { class: 'h' }, '#'), el('span', { class: 'h' }, 'Company'), el('span', { class: 'h n' }, 'Daily'), el('span', { class: 'h n' }, 'Weekly'),
          r.near.map(c => {
            const cls = c.id === r.me.id ? ' me' : '';
            return [el('span', { class: 'c' + cls }, String(c.pos)),
              el('a', { class: 'c nm' + cls, href: 'https://www.torn.com/joblist.php#/p=corpinfo&ID=' + c.id }, c.rating + '\u2605 ' + c.name),
              el('span', { class: 'c n' + cls }, fmtM(c.daily)), el('span', { class: 'c n' + cls }, fmtM(c.weekly))];
          })));
        card.appendChild(el('div', { class: 'bm-rk-foot' },
          (rankMem.source === 'swc' ? 'Company list: swc-bsd.com (' + rankMem.list.length + ' companies)' : 'Company list: Torn API top 100') + ' \u00b7 star tiers on weekly income \u00b7 updated ' + (rankMem.at ? timeAgo(rankMem.at) : '-') + ' \u00b7 auto at 20:00 TCT \u00b7 ',
          el('a', { href: '#', onclick: async ev => { ev.preventDefault(); await refreshRank(true); } }, '\u21bb refresh'), ' \u00b7 ',
          el('a', { href: 'https://swc-bsd.com/torn/dailycompany?companyType=' + encodeURIComponent(rankMem.type), target: '_blank', rel: 'noopener' }, 'full list \u2197')));
      }
    }
    if (anchor.before) anchor.before.parentElement.insertBefore(card, anchor.before);
    else anchor.after.insertAdjacentElement('afterend', card);
  }

  if (onCompanyPage()) {
    // The employee list loads after the page and is redrawn when switching tabs; ignore our own changes.
    let compQueued = false;
    const ours = n => n && n.nodeType === 1 && (n.id === 'bm-emp-card' || n.id === 'bm-pos-card' || n.id === 'bm-rank-card' || (n.classList && (n.classList.contains('bm-emp-chip') || n.classList.contains('bm-co-note'))) || (n.closest && n.closest('#bm-emp-card,#bm-pos-card,#bm-rank-card,.bm-emp-chip')));
    try {
      new MutationObserver(muts => {
        if (muts.every(m => ours(m.target) || (m.addedNodes.length + m.removedNodes.length > 0 &&
            Array.from(m.addedNodes).concat(Array.from(m.removedNodes)).every(ours)))) return;
        if (compQueued) return; compQueued = true;
        requestAnimationFrame(() => { compQueued = false; renderCompany(); renderRankCard(); });
      }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
    window.addEventListener('hashchange', () => setTimeout(() => { renderCompany(true); renderRankCard(true); }, 300));
    trainsReady.then(() => renderCompany(true));
    Promise.all([trainsReady, rankReady]).then(() => { renderRankCard(true); refreshRank(false); });
  }

  // Live countdowns anywhere (menu + profile badges).
  setInterval(() => {
    document.querySelectorAll('[data-bm-cd]').forEach(n => {
      const ms = Number(n.getAttribute('data-bm-cd')) - Date.now();
      const zero = n.getAttribute('data-bm-zero');
      if (ms <= 0 && zero != null) { if (n.textContent !== zero) { n.textContent = zero; const row = n.closest('[data-bm-ready]'); if (row) row.classList.add('ready'); } }
      else n.textContent = n.getAttribute('data-bm-fmt') === 'hms' ? fmtHMS(ms) : fmtCountdown(ms);
    });
  }, 1000);

  /* ---------------- launcher ---------------- */
  function ensureButton() {
    if (!document.body) return;
    if (!$('#bm-btn')) {
      const fb = el('button', { id: 'bm-btn', title: 'Buddy Manager', 'aria-label': 'Buddy Manager', onclick: toggleMenu });
      fb.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' + boltSvgInner('bm-fb-grad') + '</svg>';
      document.body.appendChild(fb);
      refreshIndicators();
    }
  }
  // Tap anywhere outside the menu (and outside the BM buttons) to close it. Scrolling the page doesn't count.
  document.addEventListener('click', ev => {
    if (!isMenuOpen()) return;
    const t = ev.target;
    if (!t || !t.isConnected || !t.closest) return; // the tap already redrew part of the menu
    if (t.closest('#bm-menu, #bm-btn, #bm-dock-btn, .bm-toast, #bm-toast')) return;
    const m = $('#bm-menu'); if (m) m.style.display = 'none';
    const d = $('#bm-dock-btn'); if (d) d.classList.remove('bm-open');
  }, true);

  /* Icon bar button: sits in Torn's own row of chat icons (faction, company, notes, people, settings),
     just before the People icon, styled like its neighbours. The floating BM button hides while it's there.
     Settings > Launcher: 'auto' (icon bar when Torn shows one) or 'float' (always the floating button). */
  const launcherMode = () => (prefs.launcher === 'float' ? 'float' : 'auto');
  function peopleIcon() {
    return document.getElementById('people_panel_button') || document.querySelector('[id*="people_panel_button"], button[aria-label="People" i]');
  }
  // Where to sit in Torn's icon bar: before People if it's there, otherwise before Settings, otherwise after the last icon.
  // Some pages draw the bar without every icon, so any of Torn's chat-bar buttons will do.
  function dockAnchor() {
    const ppl = peopleIcon(); if (ppl && ppl.parentNode) return { ref: ppl, before: true };
    const set = document.getElementById('settings_panel_button') || document.querySelector('[id*="settings_panel_button"]');
    if (set && set.parentNode) return { ref: set, before: true };
    const any = Array.from(document.querySelectorAll('[id$="_panel_button"]')).filter(b => b.id !== 'bm-dock-btn' && b.parentNode);
    return any.length ? { ref: any[any.length - 1], before: false } : null;
  }
  // Plain bolt in the same grey-white as Torn's own icons.
  function boltSvgInner(gid) {
    return '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2f2f2"/><stop offset="1" stop-color="#a8a8a8"/></linearGradient></defs>' +
      '<path d="M14 2 5 13.5h6l-2 8.5 10-12.5h-6.2L14 2z" fill="url(#' + gid + ')"/>';
  }
  function buildDockIcon(sample) {
    const NS = 'http://www.w3.org/2000/svg', gid = 'bm-dock-grad-' + Math.random().toString(36).slice(2, 8);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '24'); svg.setAttribute('height', '24'); svg.setAttribute('aria-hidden', 'true');
    const sc = sample && sample.getAttribute('class'); // Torn's icon classes keep the size and hover colour consistent
    if (sc) svg.setAttribute('class', sc.split(/\s+/).filter(c => /^(root|icon)/.test(c)).join(' '));
    svg.innerHTML = boltSvgInner(gid);
    return svg;
  }
  function syncDock() {
    const anc = launcherMode() === 'auto' ? dockAnchor() : null, ppl = anc ? anc.ref : null;
    let d = $('#bm-dock-btn');
    if (!ppl || !ppl.parentNode) {
      if (d) d.remove();
      document.body && document.body.classList.remove('bm-docked');
      return;
    }
    if (!d) {
      d = el('button', { id: 'bm-dock-btn', type: 'button', title: 'Buddy Manager', 'aria-label': 'Buddy Manager' });
      d.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); toggleMenu(ev); });
      d.appendChild(buildDockIcon(ppl.querySelector('svg')));
    }
    // borrow the People button's classes (minus its open/active state) so it lines up with Torn's icons
    const cls = String(ppl.className || '').split(/\s+/).filter(c => c && !/open|active|selected/i.test(c));
    if (!cls.length) cls.push('bm-plain');
    const want = cls.concat(d.classList.contains('bm-open') ? ['bm-open'] : []).concat(d.classList.contains('bm-keydead') ? ['bm-keydead'] : []).join(' ');
    if (d.className !== want) d.className = want;
    const placed = anc.before ? (d.nextSibling === ppl && d.parentNode === ppl.parentNode) : (ppl.nextSibling === d && d.parentNode === ppl.parentNode);
    if (!placed) { ppl.parentNode.insertBefore(d, anc.before ? ppl : ppl.nextSibling); refreshIndicators(); }
    document.body.classList.add('bm-docked');
  }
  let ensureQueued = false;
  try {
    new MutationObserver(() => {
      if (ensureQueued) return; ensureQueued = true;
      requestAnimationFrame(() => { ensureQueued = false; ensureButton(); try { syncDock(); } catch (e) { /* ignore */ } });
    }).observe(document.body || document.documentElement, { childList: true });
  } catch (e) { /* ignore */ }
  ensureButton();
  setTimeout(ensureButton, 1500);
  /* Crimes page: a small nerve bar pinned to the top of the screen - current nerve (read from the page, so it drops as you
     do crimes), time to the next +1 and to full (from your last Home refresh). No API calls. Tap it to hide it for this visit. */
  const onCrimesPage = () => /sid=crimes/i.test(location.search) && /\/(page|loader)\.php$/i.test(location.pathname);
  function pageNerve() {
    const bar = document.getElementById('barNerve') || document.querySelector('[id^="barNerve"], a[href*="sid=crimes"][class*="bar"]');
    const t = bar ? bar.textContent : '';
    let m = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/.exec(t);
    if (m) return { cur: Number(m[1].replace(/,/g, '')), max: Number(m[2].replace(/,/g, '')) };
    m = /Nerve\s*:?\s*(\d[\d,]*)\s*\/\s*(\d[\d,]*)/i.exec(document.body ? document.body.innerText.slice(0, 20000) : '');
    return m ? { cur: Number(m[1].replace(/,/g, '')), max: Number(m[2].replace(/,/g, '')) } : null;
  }
  let nerveHidden = false;
  function syncNerveBar() {
    let box = document.getElementById('bm-nerve');
    if (!onCrimesPage() || prefs.nerveBar === false || nerveHidden) { if (box) box.remove(); return; }
    const h = homeMem || {}, b = h.bars && h.bars.nerve, now = Date.now();
    const pg = pageNerve();
    const calc = b ? barNow(b, h.at, now) : null;
    const max = (pg && pg.max) || (b && b.max) || 0;
    const cur = pg ? pg.cur : calc ? calc.cur : null;
    if (cur == null || !max) { if (box) box.remove(); return; }
    let next = null, fullAt = null;
    if (b && b.inc && b.every && cur < max) {
      next = calc && calc.nextTick ? calc.nextTick : null;
      if (next) { while (next < now) next += b.every * 1000; fullAt = next + Math.max(0, Math.ceil((max - cur - b.inc) / b.inc)) * b.every * 1000; }
    }
    if (!box) {
      box = el('div', { id: 'bm-nerve', title: 'Tap to hide', onclick: () => { nerveHidden = true; syncNerveBar(); } },
        el('i', { class: 'bm-nerve-fill' }), el('span', { class: 'bm-nerve-t' }));
      document.body.appendChild(box);
    }
    box.querySelector('.bm-nerve-fill').style.width = Math.min(100, cur / max * 100) + '%';
    const fmt = ms => { const sec = Math.max(0, Math.round(ms / 1000)), hh = Math.floor(sec / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60; return hh ? hh + 'h ' + mm + 'm' : mm + ':' + String(ss).padStart(2, '0'); };
    box.querySelector('.bm-nerve-t').textContent = '🧠 ' + cur + ' / ' + max + (cur >= max ? ' \u00b7 full' : next ? ' \u00b7 +' + b.inc + ' in ' + fmt(next - now) + (fullAt ? ' \u00b7 full in ' + fmt(fullAt - now) : '') : '');
    box.classList.toggle('full', cur >= max);
  }
  setInterval(() => { try { syncNerveBar(); } catch (e) { /* ignore */ } }, 1000);

  /* Busting: how many busts you can do before a likely jail (BUSTR's model). Each bust in the last 72h adds
     128 / 2^(hours since / 7.2) to a penalty; you can do floor((your limit - penalty) / 128) more. Your limit is the highest
     penalty you've reached before (or one you set). Your busts come from the log (5360 "Bust success"): every 15 min with
     Home, every minute on the jail page. "You busted" on the jail page counts straight away. */
  const BUST_KEY = 'bm-busts-v1';
  let bustMem = {}, bustBusy = false;
  const bustReady = IDB.get(BUST_KEY).then(x => { bustMem = Object.assign({}, x || {}, bustMem); }).catch(() => {});
  const onJailPage = () => /jailview\.php$/i.test(location.pathname);
  function bustPenalty(times, at) {
    let p = 0; times.forEach(t => { const h = (at - t) / 3600000; if (h >= 0 && h < 72) p += 128 / Math.pow(2, h / 7.2); });
    return Math.floor(p);
  }
  function bustModel(now) {
    now = now || Date.now();
    const times = (bustMem.ts || []).map(t => t * 1000).concat(bustMem.local || []).filter(t => now - t < 30 * 86400000).sort((a, b) => a - b);
    if (!times.length) return null;
    let cap = Number(prefs.bustCap) || 0, est = false;
    if (!cap) { est = true; times.forEach(t => { cap = Math.max(cap, bustPenalty(times.filter(x => x <= t), t)); }); }
    const pen = bustPenalty(times, now), avail = Math.max(0, Math.floor((cap - pen) / 128));
    // when the next one frees up: step forward in 1-minute steps (penalty only falls)
    let next = null;
    for (let m = 1; m <= 72 * 60; m++) { if (Math.floor((cap - bustPenalty(times, now + m * 60000)) / 128) > avail) { next = now + m * 60000; break; } }
    return { pen, cap, est, avail, next, last24: times.filter(t => now - t < 86400000).length };
  }
  async function refreshBusts(force) {
    await bustReady; await storeReady;
    if (bustBusy) return;
    const now = Date.now(), gap = force ? 30000 : onJailPage() ? 60000 : 900000;
    if (bustMem.at && now - bustMem.at < gap) return;
    const { key } = getKey(); if (!key) return;
    bustBusy = true;
    const x = JSON.parse(JSON.stringify(bustMem || {}));
    try {
      const rows = await fetchLogSource({ ids: [5360] }, key, Math.floor((now - 14 * 86400000) / 1000));
      x.ts = rows.map(r => r.ts).filter(Boolean).sort((a, b) => a - b);
      x.local = []; // the log now includes them
      x.at = now; x.error = null;
    } catch (e) { x.at = now; x.error = (e.code != null ? 'Error ' + e.code : 'failed'); }
    finally { bustMem = x; persist(BUST_KEY, bustMem); bustBusy = false; if (isMenuOpen() && VIEW === 'home') rebuildContent(); }
  }
  function buildBustCard() {
    const b = bustModel(); if (!b) return null;
    const cls = b.avail <= 0 ? 'neg' : b.avail >= 3 ? 'pos' : '';
    return el('div', { class: 'bm-section bm-tr-card' },
      el('div', { class: 'bm-tr-cap' }, 'Busting'),
      homeLink(TORN + 'jailview.php', 'bm-home-row', el('span', { class: 'bm-home-l' }, '🔓 Busts available', el('div', { class: 'bm-chk-sub' }, 'penalty ' + fmtN(b.pen) + ' of ' + fmtN(b.cap) + (b.est ? ' (your highest so far)' : ' (your limit)') + ' · ' + b.last24 + ' in 24h')),
        el('b', { class: cls }, String(b.avail))),
      b.next ? el('div', { class: 'bm-home-row' }, el('span', { class: 'bm-home-l' }, '⏳ Next one free'), el('span', { class: 'bm-home-cd' }, el('span', { class: 'bm-cd', 'data-bm-cd': String(b.next), 'data-bm-zero': 'now' }, fmtCountdown(b.next - Date.now())))) : null);
  }
  // Jail page: a pill like the nerve one, and live counting of "You busted ..."
  function syncBustBar() {
    let box = document.getElementById('bm-bust');
    if (!onJailPage() || prefs.bustBar === false) { if (box) box.remove(); return; }
    const b = bustModel(); if (!b) { if (box) box.remove(); return; }
    if (!box) { box = el('div', { id: 'bm-bust', class: 'bm-pillbar', title: 'Busts before a likely jail' }, el('span', { class: 'bm-nerve-t' })); document.body.appendChild(box); }
    box.className = 'bm-pillbar ' + (b.avail <= 0 ? 'red' : b.avail >= 3 ? 'green' : 'amber');
    box.querySelector('.bm-nerve-t').textContent = '🔓 ' + b.avail + ' bust' + (b.avail === 1 ? '' : 's') + ' available' + (b.next ? ' · +1 in ' + fmtCountdown(b.next - Date.now()) : '');
  }
  // Busts available as a count bubble on Torn's own Jail link (top icon menu on mobile, sidebar on desktop), on every page.
  function syncJailBadge() {
    const b = prefs.bustBadge === false ? null : bustModel();
    const links = Array.from(document.querySelectorAll('#nav-jail a, a[href*="jailview.php"]')).filter(a => {
      if (a.closest('#bm-menu, #bm-bust, .bm-section, .user-info-list-wrap, .users-list, li[class*="user"]')) return false;
      if (a.closest('#nav-jail')) return true;
      try { const u = new URL(a.getAttribute('href'), location.href); return /\/jailview\.php$/i.test(u.pathname) && !u.search && !/#./.test(u.hash); } catch (e) { return false; }
    });
    document.querySelectorAll('.user-info-list-wrap .bm-jail-badge').forEach(x => x.remove()); // from v7.48.0
    links.forEach(a => {
      let bb = a.querySelector(':scope > .bm-jail-badge');
      if (!b) { if (bb) bb.remove(); a.classList.remove('bm-jail-on', 'green', 'amber', 'red'); return; }
      if (!bb) { bb = el('span', { class: 'bm-jail-badge' }); if (getComputedStyle(a).position === 'static') a.style.position = 'relative'; a.appendChild(bb); }
      const tone = b.avail <= 0 ? 'red' : b.avail >= 3 ? 'green' : 'amber', cls = 'bm-jail-badge ' + tone;
      if (bb.className !== cls) bb.className = cls;
      // like Torn's own Events icon: the icon and label turn the same colour as the number
      a.classList.add('bm-jail-on'); ['green', 'amber', 'red'].forEach(t => a.classList.toggle(t, t === tone));
      const txt = String(b.avail > 99 ? '99+' : b.avail);
      if (bb.textContent !== txt) bb.textContent = txt;
      bb.title = b.avail + ' bust' + (b.avail === 1 ? '' : 's') + ' available' + (b.next ? ', +1 in ' + fmtCountdown(b.next - Date.now()) : '');
    });
  }
  // Jail list: BUSTR's hardness score for each prisoner, floor(level x (hours left + 3)) - lower is easier - and the list
  // sorted easiest first. Torn reloads the list as you page through it, so this re-runs every couple of seconds.
  function jailHardness() {
    if (!onJailPage() || prefs.jailHard === false) { document.querySelectorAll('.bm-hard').forEach(x => x.remove()); return; }
    const list = document.querySelector('ul.user-info-list-wrap'); if (!list) return;
    const rows = Array.from(list.children).filter(li => li.tagName === 'LI');
    rows.forEach(li => {
      const lv = li.querySelector('.level'), tm = li.querySelector('.time'); if (!lv || !tm) return;
      const level = Number((lv.innerText.match(/\d+/) || [0])[0]);
      const t = tm.innerText, h = Number((t.match(/(\d+)\s*h/) || [0, 0])[1]), m = Number((t.match(/(\d+)\s*m/) || [0, 0])[1]);
      const score = Math.floor(level * (h + m / 60 + 3));
      let cell = li.querySelector('.bm-hard');
      if (!cell) { cell = el('span', { class: 'bm-hard' }, el('span', { class: 'bm-hard-t' }, 'HARDNESS'), el('span', { class: 'bm-hard-v' })); lv.parentNode.insertBefore(cell, lv.nextSibling); }
      const v = cell.querySelector('.bm-hard-v'); if (v.textContent !== fmtN(score)) v.textContent = fmtN(score);
      li.style.order = prefs.jailSort === false ? '' : String(score);
      li.setAttribute('data-bm-hard', String(score));
    });
    if (prefs.jailSort !== false && rows.length) { if (getComputedStyle(list).display !== 'flex') { list.style.display = 'flex'; list.style.flexDirection = 'column'; } }
    else if (list.style.display === 'flex') { list.style.display = ''; list.style.flexDirection = ''; }
  }
  let bustSeen = 0;
  setInterval(() => {
    try {
      if (onJailPage()) {
        const n = (document.body.innerText.match(/You busted /g) || []).length;
        if (n > bustSeen) { bustMem.local = (bustMem.local || []).concat(Array(n - bustSeen).fill(Date.now())); }
        bustSeen = n;
        refreshBusts(false);
      }
      syncBustBar(); syncJailBadge(); jailHardness();
    } catch (e) { /* ignore */ }
  }, 2000);
  // The recruiter was removed in 7.53.0: tidy away its settings and saved player list.
  if (prefs.recruit || prefs.recruitOff != null) { delete prefs.recruit; delete prefs.recruitOff; try { saveConfig(); } catch (e) { /* ignore */ } }
  IDB.get('bm-recruit-v1').then(x => { if (x) persist('bm-recruit-v1', null); }).catch(() => {});

  // Torn draws its chat icons after load and redraws them now and then: check cheaply every 2s.
  try { syncDock(); } catch (e) { /* ignore */ }
  setInterval(() => { try { syncDock(); } catch (e) { /* ignore */ } }, 1000);

  // Other tabs may have polled; keep the bell in sync.

  /* ---------------- polling ---------------- */
  storeReady.then(() => setTimeout(() => pollLogs(false), 1500));
  homeReady.then(() => { refreshIndicators(); setTimeout(() => refreshHome(true), 800); });
  setInterval(() => refreshIndicators(), 60000);
  // Discord posting was removed in 7.58.0: forget the saved webhook.
  IDB.get('bm-discord-v1').then(x => { if (x) persist('bm-discord-v1', null); }).catch(() => {});
  // keep live bar values moving while Home is open (redraws every 30s; not while arranging cards)
  setInterval(() => { if (VIEW === 'home' && isMenuOpen() && !homeArrange && !document.hidden) rebuildContent(); }, 30000);
  nwReady.then(() => setTimeout(() => refreshNetworth(false), 2600));
  gymReady.then(() => setTimeout(() => refreshGym(false), 3000)); // Gym: once a day (2-3 calls)
  warReady.then(() => setTimeout(() => refreshWar(false), 3400));
  bustReady.then(() => setTimeout(() => refreshBusts(false), 3800)); // Busting: every 15 min (1 call), every minute on the jail page // Ranked war: at most every 30 min (1-2 calls) // Networth: one snapshot a day (1 call)
  compReady.then(() => setTimeout(() => refreshCompanyDay(false), 2200)); // Company income: once a day after 20:00 TCT (1 call)
  calReady.then(() => setTimeout(() => refreshCalendar(false), 1200)); // Calendar: once a day (2 calls) // Home: cooldowns, refills, bars on every page load (1 call)
  setInterval(() => pollLogs(false), 15000); // trains and crimes only call the API when you tap Check / Refresh
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    storeReady.then(syncAll).then(() => { if (isMenuOpen() && VIEW !== 'config') rebuildContent(); renderProfile(true); renderCompany(true); pollLogs(false); });
  });
})();
