// ==UserScript==
// @name         桃園打卡系統 - VDS 場站即時動態覆蓋
// @namespace    https://taoyuan-punch-service
// @version      0.8.7
// @description  VDS 地圖點站掛打卡即時動態 + 有人作業的站閃爍半透明塗層(工種色、點擊穿透)+ 可拖拉縮放的「打卡設定」面板(活躍清單下拉切 作業/移動/休息、全螢幕保留、工種配色、可收合設定、刪除/點擊定位、X 連動地圖彈窗、自動關人員彈窗)
// @author       桃園營運處
// @match        https://vds.youbike2.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
/* global google */
(function vdsStationOverlay() {
  "use strict";

  const CONFIG = {
    ENDPOINT: "https://taoyuan-punch.onrender.com",
    VDS_TOKEN: "zxc123",
    DEBUG: true
  };
  const STALE_MIN = 240; // open 超過這時間(分)= 疑似忘記離站

  const log = (...a) => CONFIG.DEBUG && console.log("[VDS Overlay]", ...a);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const JOBS = [["dispatch", "調度"], ["level1", "一級"], ["swap", "換電"], ["pump", "打氣"], ["clean", "清潔"], ["rest", "休息"]];
  const JOB_ZH = Object.fromEntries(JOBS);
  // 跟打卡系統 / LIFF 前台對齊:調度=綠 / 一級=琥珀 / 換電=藍 / 打氣=粉 / 清潔=青 / 休息=灰
  const JOB_COLOR = {
    dispatch: { bg: "#dcfce7", fg: "#166534", bar: "#22c55e" },
    level1:   { bg: "#fef3c7", fg: "#92400e", bar: "#f59e0b" },
    swap:     { bg: "#dbeafe", fg: "#1e40af", bar: "#3b82f6" },
    pump:     { bg: "#fce7f3", fg: "#9d174d", bar: "#ec4899" },
    clean:    { bg: "#ccfbf1", fg: "#0f766e", bar: "#14b8a6" },
    rest:     { bg: "#f1f5f9", fg: "#334155", bar: "#475569" }
  };
  const jobCol = (j) => JOB_COLOR[j] || { bg: "#f1f5f9", fg: "#334155", bar: "#94a3b8" };
  const jobChip = (j) => { const c = jobCol(j); return `<span style="display:inline-block;padding:0 6px;border-radius:4px;background:${c.bg};color:${c.fg};font-weight:600;">${esc(JOB_ZH[j] || j)}</span>`; };
  // 活躍清單要看哪一組(下拉切換)
  const VIEWS = [["work", "🟢 現在在作業"], ["moving", "🔵 現在在移動"], ["rest", "🟣 現在在休息"]];
  // 時間排序(作業/休息=到站到現在;移動=離站到現在)
  const SORTS = [["durAsc", "時間 小→大"], ["durDesc", "時間 大→小"]];

  const DEFAULTS = {
    jobs: { dispatch: true, level1: true, swap: true, pump: true, clean: true, rest: false },
    overtime: { dispatch: 60, level1: 120, swap: 30, pump: 30, clean: 60, rest: 60, move: 15 }, // 每類超時門檻(分,0=不標;rest=休息、move=移動)
    hours: 24,
    hideDriver: true,
    showMarkers: true,        // 在地圖上標出「有人在作業」的站
    settingsCollapsed: false, // 「顯示設定」整區(作業/超時 + 最近範圍 + 自動關閉)收合
    view: "work",             // 活躍清單預設看「現在在作業」
    sort: "durAsc",           // 時間排序:小→大(預設)
    layout: null
  };
  let SETTINGS;
  try { SETTINGS = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("vdsOverlaySettings") || "{}") }; } catch (e) { SETTINGS = { ...DEFAULTS }; }
  SETTINGS.jobs = { ...DEFAULTS.jobs, ...(SETTINGS.jobs || {}) };
  SETTINGS.overtime = { ...DEFAULTS.overtime, ...(SETTINGS.overtime || {}) };
  const saveSettings = () => localStorage.setItem("vdsOverlaySettings", JSON.stringify(SETTINGS));
  // 一次性升級:舊版 休息門檻=0、無移動門檻 → 帶到 休息60 / 移動15(只動「還沒設過」的)
  if (!SETTINGS._v || SETTINGS._v < 2) {
    if (!(Number(SETTINGS.overtime.move) > 0)) SETTINGS.overtime.move = 15;
    if (!(Number(SETTINGS.overtime.rest) > 0)) SETTINGS.overtime.rest = 60;
    SETTINGS._v = 2; saveSettings();
  }
  const jobOn = (j) => !!SETTINGS.jobs[j];
  const otOf = (j) => Number(SETTINGS.overtime[j]) || 0;

  // 已隱藏的「現在在作業」筆(避免一直判讀到忘記離站/測試的垃圾資料)。key = 代號|員編|到站時間。
  let DISMISSED;
  try { DISMISSED = new Set(JSON.parse(localStorage.getItem("vdsOverlayDismissed") || "[]")); } catch (e) { DISMISSED = new Set(); }
  const saveDismissed = () => localStorage.setItem("vdsOverlayDismissed", JSON.stringify([...DISMISSED]));
  const dKey = (s) => `${s.code}|${s.employeeNo}|${s.arrive}`;
  const mKey = (m) => `MOVE|${m.employeeNo}|${m.leave}`; // 移動卡片的隱藏 key

  let panelBox = null; // 保留面板參考:全螢幕進出時 Google 會重建地圖 DOM,靠這個把面板救回來

  // ───── 抓 Google Map 實例(點卡片才能 panTo 定位)─────
  // 單純掛建構式有 race(VDS 可能在補丁前就建好圖,或自己 cache 了 class / 用 importLibrary)。
  // 所以多重掛鉤:建構式 + Map.prototype 共用方法(VDS 一定會在地圖綁事件/設中心 → 抓到 this)。
  const MAPS = [];
  const remember = (m) => { try { if (m && typeof m.panTo === "function" && !MAPS.includes(m)) { MAPS.push(m); log("captured map", MAPS.length); } } catch (e) { /* ignore */ } };
  function installHooks() {
    if (!(window.google && google.maps && google.maps.Map)) return false;
    const M = google.maps.Map;
    if (M.__punchHooked) return true;
    // 1) 建構式(抓 VDS 直接 new google.maps.Map(...) 的情形)
    try {
      const Patched = function (...a) { const inst = new M(...a); remember(inst); return inst; };
      Object.setPrototypeOf(Patched, M); // 繼承 static 成員
      Patched.prototype = M.prototype;
      Patched.__punchHooked = true;
      google.maps.Map = Patched;
    } catch (e) { /* 不可寫就算了,靠 prototype 掛鉤 */ }
    // 2) prototype 共用方法(不怕 VDS 把 class reference 自己存起來)
    ["addListener", "setCenter", "panTo", "setZoom", "setOptions", "fitBounds", "moveCamera"].forEach((name) => {
      const orig = M.prototype[name];
      if (typeof orig === "function" && !orig.__punchWrapped) {
        const wrapped = function (...a) { remember(this); return orig.apply(this, a); };
        wrapped.__punchWrapped = true;
        try { M.prototype[name] = wrapped; } catch (e) { /* ignore */ }
      }
    });
    M.__punchHooked = true;
    log("map hooks installed");
    return true;
  }
  installHooks();
  (function poll() { let n = 0; const t = setInterval(() => { if (installHooks() || ++n > 1200) clearInterval(t); }, 25); })();

  // 最後保險:從地圖 DOM 容器往上掃,找出長得像 Map 的物件(某些框架會把 instance 掛在元素上)
  function domScanMap() {
    for (const s of document.querySelectorAll(".gm-style")) {
      let el = s.parentElement;
      for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
        for (const k in el) { try { const v = el[k]; if (v && typeof v === "object" && typeof v.panTo === "function" && typeof v.getCenter === "function") return v; } catch (e) { /* ignore */ } }
      }
    }
    return null;
  }
  function bestMap() {
    let best = null, area = -1;
    for (const m of MAPS) {
      try { const d = m.getDiv && m.getDiv(); if (!d) continue; const r = d.getBoundingClientRect(); const a = r.width * r.height; if (a > area) { area = a; best = m; } } catch (e) { /* ignore */ }
    }
    if (best) return best;
    if (MAPS[0]) return MAPS[0];
    const dom = domScanMap(); if (dom) { remember(dom); return dom; }
    return null;
  }
  function focusStation(s) {
    if (s.lat == null || s.lng == null) { alert(`「${s.name}」在打卡系統沒有座標,無法定位`); return; }
    const map = bestMap();
    if (!map || typeof map.panTo !== "function") { alert("還沒抓到 VDS 地圖(重新整理頁面後再試一次)"); return; }
    try {
      map.panTo({ lat: s.lat, lng: s.lng });
      const z = map.getZoom ? (map.getZoom() || 0) : 0;
      if (typeof map.setZoom === "function" && z < 17) map.setZoom(17);
      log("定位", s.name, s.lat, s.lng);
    } catch (e) { alert("定位失敗:" + e.message); }
  }

  // ───── 在站點位置掛「有人作業」的閃爍半透明塗層(OverlayView)─────
  // pointer-events:none → 點擊穿透,不會擋到 VDS 自己的站圖標;顏色用該站最近作業者的工種色。
  let activeOverlays = [];
  let lastWork = [];
  let PulseClass = null;
  function ensurePulseStyle() {
    if (document.getElementById("vop-pulse-style")) return;
    const st = document.createElement("style"); st.id = "vop-pulse-style";
    st.textContent = "@keyframes vopPulse{0%{transform:scale(.6);opacity:.55}70%{transform:scale(1.35);opacity:.1}100%{transform:scale(.6);opacity:.55}}";
    (document.head || document.documentElement).appendChild(st);
  }
  function getPulseClass() {
    if (PulseClass) return PulseClass;
    if (!(window.google && google.maps && google.maps.OverlayView)) return null;
    class Pulse extends google.maps.OverlayView {
      constructor(latlng, color, size) { super(); this.latlng = latlng; this.color = color; this.size = size || 52; this.div = null; }
      onAdd() {
        const d = document.createElement("div");
        d.style.cssText = `position:absolute;pointer-events:none;width:${this.size}px;height:${this.size}px;margin-left:${-this.size / 2}px;margin-top:${-this.size / 2}px;border-radius:50%;background:${this.color};animation:vopPulse 1.4s ease-in-out infinite;will-change:transform,opacity;`;
        this.div = d;
        const panes = this.getPanes();
        (panes.overlayLayer || panes.mapPane).appendChild(d); // 非互動層,且 pointer-events:none
      }
      draw() { if (!this.div) return; const p = this.getProjection().fromLatLngToDivPixel(this.latlng); if (p) { this.div.style.left = p.x + "px"; this.div.style.top = p.y + "px"; } }
      onRemove() { if (this.div && this.div.parentNode) this.div.parentNode.removeChild(this.div); this.div = null; }
    }
    PulseClass = Pulse;
    return PulseClass;
  }
  function clearOverlays() { activeOverlays.forEach((o) => { try { o.setMap(null); } catch (e) { /* ignore */ } }); activeOverlays = []; }
  function renderMapMarkers(workList) {
    if (workList) lastWork = workList; else workList = lastWork;
    if (!SETTINGS.showMarkers) { clearOverlays(); return; }
    const map = bestMap();
    const Pulse = getPulseClass();
    if (!map || !Pulse || !google.maps.LatLng) return; // 還沒抓到地圖/API → 下次再試
    clearOverlays();
    ensurePulseStyle();
    // 依站聚合;塗層顏色 = 該站「最近到站者」的工種色
    const byStation = new Map();
    for (const s of workList) {
      if (s.lat == null || s.lng == null) continue;
      const key = s.code || s.name;
      const at = new Date(s.arrive).getTime() || 0;
      const g = byStation.get(key);
      if (!g) byStation.set(key, { lat: s.lat, lng: s.lng, job: s.job, at });
      else if (at > g.at) { g.job = s.job; g.at = at; }
    }
    for (const g of byStation.values()) {
      try { const o = new Pulse(new google.maps.LatLng(g.lat, g.lng), jobCol(g.job).bar, 52); o.setMap(map); activeOverlays.push(o); }
      catch (e) { log("掛塗層失敗", e.message); }
    }
  }

  async function api(path) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12000);
    try { const r = await fetch(`${CONFIG.ENDPOINT}${path}`, { method: "GET", headers: { "X-VDS-Token": CONFIG.VDS_TOKEN }, signal: ctrl.signal, cache: "no-store" }); return await r.json(); }
    catch (e) { throw new Error(e.name === "AbortError" ? "逾時(再點一次)" : "連線失敗:" + e.message); } finally { clearTimeout(timer); }
  }
  const fetchStationInfo = (code) => api(`/api/vds/station-info?code=${encodeURIComponent(code)}&hours=${SETTINGS.hours}`);
  const fetchActive = () => api(`/api/vds/active-stations?hours=${SETTINGS.hours}`);

  const hhmm = (iso) => { if (!iso) return "—"; return new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }); };
  const elapsedMin = (iso) => iso ? Math.round((Date.now() - new Date(iso).getTime()) / 60000) : 0;
  const minLabel = (m) => m < 60 ? `${m}分` : `${Math.floor(m / 60)}時${m % 60}分`;
  const person = (p) => esc((p.employeeNo ? p.employeeNo + " " : "") + p.worker);

  // ───── 站點彈窗(無標題,省空間)─────
  function renderBlock(block, code, data) {
    block.dataset.code = code;
    if (!data || !data.ok) { const msg = data && data.message === "unauthorized" ? "打卡:token 不對" : "打卡:" + ((data && data.message) || "查詢失敗"); block.innerHTML = `<span style="color:#b91c1c">${esc(msg)}</span>`; return; }
    if (!data.found) { block.innerHTML = `<span style="color:#999">打卡系統查無此站</span>`; return; }
    // X 掉的(垃圾/忘記離站)同步在地圖彈窗也藏起來,跟面板清單連動
    const cur = (data.current || []).filter((p) => jobOn(p.job) && !DISMISSED.has(`${code}|${p.employeeNo || ""}|${p.arrive}`));
    const rec = (data.recent || []).filter((p) => jobOn(p.job));
    // >4h 視為忘記離站 = 垃圾,地圖彈窗直接不顯示(不再列「疑似忘記離站」)
    const active = cur.filter((p) => elapsedMin(p.arrive) <= STALE_MIN);
    let html = "";
    if (active.length) {
      html += `<div style="margin-top:2px;"><b style="color:#15803d">🟢 現在在作業(${active.length})</b></div>`;
      html += active.map((p) => { const e = elapsedMin(p.arrive); const over = otOf(p.job) > 0 && e > otOf(p.job); const c = over ? "#b91c1c" : "#333";
        return `<div style="padding-left:6px;color:${c};">${over ? "⚠ " : "・"}${person(p)} ${jobChip(p.job)} <span style="color:#888;">已 ${minLabel(e)}${over ? " 超時!" : ""}</span></div>`; }).join("");
    } else { html += `<div style="margin-top:2px;color:#999;">🟢 現在沒人在作業</div>`; }
    if (rec.length) {
      html += `<div style="margin-top:4px;"><b style="color:#374151">🕐 最近來過(${SETTINGS.hours}h)</b></div>`;
      html += rec.slice(0, 12).map((p) => { const over = otOf(p.job) > 0 && p.durationMin != null && p.durationMin > otOf(p.job); const c = over ? "#b91c1c" : "#333";
        return `<div style="padding-left:6px;color:${c};">${over ? "⚠ " : "・"}${esc(hhmm(p.arrive))}-${esc(hhmm(p.leave))} ${person(p)} ${jobChip(p.job)}${p.durationMin != null ? ` <span style="color:#888;">${p.durationMin}分${over ? "超時!" : ""}</span>` : ""}</div>`; }).join("");
    } else { html += `<div style="margin-top:4px;color:#999;">🕐 此範圍內沒人來過</div>`; }
    block.innerHTML = html;
  }

  // 站點彈窗:讀代號 → 查 → 注入(無標題);人員彈窗:自動關
  function handlePopup(iw) {
    const text = iw.textContent || "";
    const m = text.match(/\b(50\d{7})\b/);
    if (!m) {
      if (SETTINGS.hideDriver && /人員(資訊|姓名)/.test(text)) {
        const root = iw.closest(".gm-style-iw") || iw.parentElement;
        const x = root && root.querySelector(".gm-ui-hover-effect");
        if (x) { x.click(); log("關掉人員彈窗"); }
      }
      return;
    }
    const code = m[1];
    const existing = iw.querySelector(".punch-overlay");
    if (existing && existing.dataset.code === code) return;
    if (existing) existing.remove();
    const block = document.createElement("div"); block.className = "punch-overlay"; block.dataset.code = code;
    block.style.cssText = "margin-top:6px;padding-top:6px;border-top:1px dashed #d1d5db;font-size:13px;line-height:1.5;";
    block.innerHTML = `<span style="color:#999">打卡查詢中…</span>`; iw.appendChild(block);
    fetchStationInfo(code).then((d) => { block._data = d; renderBlock(block, code, d); }).catch((e) => { block.innerHTML = `<span style="color:#b91c1c">${esc(e.message)}</span>`; });
  }

  function reapply(hoursChanged) {
    document.querySelectorAll(".punch-overlay").forEach((block) => { const code = block.dataset.code; if (!code) return;
      if (hoursChanged || !block._data) { block.innerHTML = `<span style="color:#999">打卡查詢中…</span>`; fetchStationInfo(code).then((d) => { block._data = d; renderBlock(block, code, d); }).catch((e) => { block.innerHTML = `<span style="color:#b91c1c">${esc(e.message)}</span>`; }); }
      else { renderBlock(block, code, block._data); } });
  }

  // ───── 活躍清單:作業 / 移動 / 休息 ─────
  // 依「已過時間」(作業/休息=到站到現在;移動=離站到現在)排序
  const sortByDur = (arr) => arr.slice().sort((a, b) => (SETTINGS.sort === "durDesc") ? (b.e - a.e) : (a.e - b.e));

  // 在站卡片(作業 / 休息):可點定位、可 X 隱藏
  function atStationCard(s) {
    const c = jobCol(s.job);
    const over = otOf(s.job) > 0 && s.e > otOf(s.job);
    const bar = over ? "#dc2626" : c.bar;
    const bg = over ? "#fef2f2" : c.bg;
    return `<div class="vop-card" data-k="${esc(dKey(s))}" title="點一下在 VDS 地圖上定位這站"
        style="position:relative;border-left:4px solid ${bar};background:${bg};border-radius:7px;padding:5px 24px 5px 8px;margin-bottom:5px;cursor:pointer;">
        <button class="vop-x" data-k="${esc(dKey(s))}" title="從清單移除(隱藏垃圾資料)"
          style="position:absolute;top:3px;right:3px;width:18px;height:18px;line-height:16px;text-align:center;border:none;background:rgba(0,0,0,.07);border-radius:4px;color:#555;cursor:pointer;font-size:13px;padding:0;">×</button>
        <div style="font-weight:700;color:#111;">${over ? "⚠ " : ""}${esc(s.name)}</div>
        <div style="margin-top:1px;">${jobChip(s.job)} <span style="color:${over ? "#b91c1c" : "#444"};">${person(s)} ・ ${minLabel(s.e)}${over ? " 超時!" : ""}</span></div>
      </div>`;
  }
  // 移動卡片(通勤中):無站點座標不可點;可 X 隱藏;超過「移動門檻」反紅
  function movingCard(m) {
    const ot = otOf("move");
    const over = ot > 0 && m.e > ot;
    const bar = over ? "#dc2626" : "#3b82f6";
    const bg = over ? "#fef2f2" : "#eff6ff";
    return `<div style="position:relative;border-left:4px solid ${bar};background:${bg};border-radius:7px;padding:5px 24px 5px 8px;margin-bottom:5px;">
        <button class="vop-x" data-k="${esc(mKey(m))}" title="從清單移除(隱藏垃圾資料)"
          style="position:absolute;top:3px;right:3px;width:18px;height:18px;line-height:16px;text-align:center;border:none;background:rgba(0,0,0,.07);border-radius:4px;color:#555;cursor:pointer;font-size:13px;padding:0;">×</button>
        <div style="font-weight:700;color:#111;">${over ? "⚠ " : ""}${person(m)}</div>
        <div style="margin-top:1px;color:${over ? "#b91c1c" : "#444"};">${jobChip(m.job)} 移動中 ・ 離開 ${esc(m.fromStation || "—")} ・ 已 ${minLabel(m.e)}${over ? " 超時!" : ""}</div>
      </div>`;
  }
  async function refreshActiveList() {
    const cont = document.getElementById("vop-active"); if (!cont) return;
    try {
      const data = await fetchActive();
      if (!data.ok) { cont.innerHTML = `<div style="color:#b91c1c;">${esc(data.message === "unauthorized" ? "token 不對" : data.message || "查詢失敗")}</div>`; return; }
      // 同一個人忘記離站會留多筆 open(到不同站)→ 只留最近到站那筆(rows 已 arrive desc,第一次看到=最近)
      // 後端已用 SQL 去重,這層是部署前的保險,重裝即生效
      const seenP = new Set();
      const openRows = [];
      for (const s of (data.stations || [])) {
        const pid = s.employeeNo || (s.worker ? "n:" + s.worker : "");
        if (pid) { if (seenP.has(pid)) continue; seenP.add(pid); }
        openRows.push(s);
      }
      // 清掉已不在線上的隱藏紀錄,避免 localStorage 無限長(含移動的 key)
      const liveKeys = new Set([...openRows.map(dKey), ...(data.moving || []).map(mKey)]);
      let pruned = false;
      for (const k of [...DISMISSED]) if (!liveKeys.has(k)) { DISMISSED.delete(k); pruned = true; }
      if (pruned) saveDismissed();

      const work = [], rest = [], moving = []; let staleCount = 0, hidden = 0;
      for (const s of openRows) {
        if (!jobOn(s.job)) continue;
        if (DISMISSED.has(dKey(s))) { hidden++; continue; }
        const e = elapsedMin(s.arrive);
        if (e > STALE_MIN) { staleCount++; continue; }      // >4h 忘記離站,不列細項
        (s.job === "rest" ? rest : work).push({ ...s, e });
      }
      for (const m of (data.moving || [])) {
        if (!jobOn(m.job)) continue;
        if (DISMISSED.has(mKey(m))) { hidden++; continue; }   // X 掉的移動筆
        moving.push({ ...m, e: elapsedMin(m.leave) });        // e = 離站到現在(分)
      }
      const workS = sortByDur(work), restS = sortByDur(rest), movingS = sortByDur(moving);
      renderMapMarkers(work); // 在地圖標出有人作業的站

      // 下拉切換要看哪一組(作業 / 移動 / 休息)+ 時間排序
      const counts = { work: workS.length, moving: movingS.length, rest: restS.length };
      const view = VIEWS.some(([v]) => v === SETTINGS.view) ? SETTINGS.view : "work";
      const viewSelHtml = `<select id="vop-view" style="flex:1;height:26px;font-weight:700;">${VIEWS.map(([v, t]) => `<option value="${v}" ${view === v ? "selected" : ""}>${esc(t)}(${counts[v]})</option>`).join("")}</select>`;
      const sortSelHtml = `<select id="vop-sort" title="依時間排序" style="flex:0 0 auto;height:26px;font-size:12px;">${SORTS.map(([v, t]) => `<option value="${v}" ${(SETTINGS.sort || "durAsc") === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
      const muted = (txt) => `<div style="color:#999;margin-bottom:6px;">${txt}</div>`;
      let html = `<div style="display:flex;gap:6px;margin-bottom:6px;">${viewSelHtml}${sortSelHtml}</div>`;
      if (view === "moving") html += movingS.length ? movingS.map(movingCard).join("") : muted("目前沒人在移動");
      else if (view === "rest") html += restS.length ? restS.map(atStationCard).join("") : muted(jobOn("rest") ? "目前沒人在休息" : "休息未勾選 → 上方「作業 / 超時門檻」打開「休息」");
      else html += workS.length ? workS.map(atStationCard).join("") : muted("目前沒人在作業");

      if (staleCount) html += `<div style="margin-top:4px;color:#b45309;font-size:12px;">🟠 疑似忘記離站 ${staleCount} 筆(>4h,未列入)</div>`;
      if (hidden) html += `<div style="margin-top:4px;color:#999;font-size:12px;">🙈 已隱藏 ${hidden} 筆 · <a href="#" id="vop-restore" style="color:#2563eb;">全部復原</a></div>`;
      cont.innerHTML = html;

      // 綁事件:× 刪除(同步藏地圖彈窗)、卡片點擊定位、復原、切換檢視
      const findCard = (k) => workS.find((x) => dKey(x) === k) || restS.find((x) => dKey(x) === k);
      cont.querySelectorAll(".vop-x").forEach((b) => b.addEventListener("click", (ev) => { ev.stopPropagation(); DISMISSED.add(b.dataset.k); saveDismissed(); refreshActiveList(); reapply(false); }));
      cont.querySelectorAll(".vop-card").forEach((card) => card.addEventListener("click", () => { const s = findCard(card.dataset.k); if (s) focusStation(s); }));
      const restore = cont.querySelector("#vop-restore");
      if (restore) restore.addEventListener("click", (ev) => { ev.preventDefault(); DISMISSED.clear(); saveDismissed(); refreshActiveList(); reapply(false); });
      const viewSel = cont.querySelector("#vop-view");
      if (viewSel) viewSel.addEventListener("change", (e) => { SETTINGS.view = e.target.value; saveSettings(); refreshActiveList(); });
      const sortSel = cont.querySelector("#vop-sort");
      if (sortSel) sortSel.addEventListener("change", (e) => { SETTINGS.sort = e.target.value; saveSettings(); refreshActiveList(); });
    } catch (e) { cont.innerHTML = `<div style="color:#b91c1c;">${esc(e.message)}</div>`; }
  }

  // ───── 面板(可拖拉/縮放)─────
  function saveLayout(box) {
    const r = box.getBoundingClientRect();
    SETTINGS.layout = { left: r.left, top: r.top, width: box.style.width || r.width + "px", height: box.style.height || r.height + "px" };
    saveSettings();
  }
  // 夾住位置:藍色標題列一定要留在畫面內,避免拖出螢幕外抓不回來
  function clampBox(box) {
    const left = parseFloat(box.style.left), top = parseFloat(box.style.top);
    if (isNaN(left) || isNaN(top)) return; // 還在 right/bottom 錨點,不用夾
    const maxLeft = Math.max(0, window.innerWidth - 60);  // 至少露出左上 60px
    const maxTop = Math.max(0, window.innerHeight - 36);  // 標題列至少露出
    box.style.left = Math.min(Math.max(left, 0), maxLeft) + "px";
    box.style.top = Math.min(Math.max(top, 0), maxTop) + "px";
  }
  function buildPanel() {
    const box = document.createElement("div"); box.id = "vds-overlay-panel";
    box.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:99999;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.2);font-size:13px;color:#1f2937;width:280px;height:auto;font-family:system-ui,-apple-system,'Microsoft JhengHei',sans-serif;display:flex;flex-direction:column;overflow:hidden;resize:both;min-width:230px;min-height:120px;";
    if (SETTINGS.layout) { const L = SETTINGS.layout; box.style.left = L.left + "px"; box.style.top = L.top + "px"; box.style.right = "auto"; box.style.bottom = "auto"; box.style.width = L.width; box.style.height = L.height; clampBox(box); }

    const jobRows = JOBS.map(([j, zh]) => `
      <div style="display:flex;align-items:center;gap:6px;padding:2px 0;">
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;width:62px;"><input type="checkbox" data-job="${j}" ${jobOn(j) ? "checked" : ""}>${zh}</label>
        <span style="color:#888;">超過</span><input type="number" data-ot="${j}" min="0" step="5" value="${otOf(j)}" style="width:52px;height:24px;"><span style="color:#888;">分標紅</span>
      </div>`).join("");

    box.innerHTML = `
      <div id="vop-head" style="display:flex;align-items:center;justify-content:space-between;padding:8px 11px;background:#2563eb;color:#fff;cursor:move;font-weight:700;user-select:none;flex:0 0 auto;">
        <span>📋 打卡設定</span><span id="vop-tog" style="font-size:12px;cursor:pointer;padding:0 4px;">▼</span>
      </div>
      <div id="vop-body" style="padding:10px;overflow:auto;flex:1 1 auto;">
        <div id="vop-set-head" style="display:flex;align-items:center;justify-content:space-between;padding:6px 9px;margin-bottom:8px;background:#eef2f7;border:1px solid #e2e8f0;border-radius:7px;cursor:pointer;user-select:none;font-weight:700;">
          <span>⚙ 顯示設定</span><span id="vop-set-tog" style="font-size:12px;color:#2563eb;">${SETTINGS.settingsCollapsed ? "展開 ▸" : "收合 ▾"}</span>
        </div>
        <div id="vop-set-body" style="display:${SETTINGS.settingsCollapsed ? "none" : "block"};">
          <div style="font-weight:700;margin-bottom:3px;">作業 / 超時門檻</div>
          ${jobRows}
          <div style="display:flex;align-items:center;gap:6px;padding:2px 0;">
            <span style="width:62px;">🔵 移動</span>
            <span style="color:#888;">超過</span><input type="number" data-ot="move" min="0" step="5" value="${otOf('move')}" style="width:52px;height:24px;"><span style="color:#888;">分標紅</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin:8px 0;">
            <span>最近範圍</span><select id="vop-hours" style="flex:1;height:26px;">${[1, 3, 6, 12, 24].map((h) => `<option value="${h}" ${SETTINGS.hours == h ? "selected" : ""}>${h} 小時</option>`).join("")}</select>
          </div>
          <label style="display:flex;align-items:center;gap:5px;margin-bottom:6px;cursor:pointer;"><input type="checkbox" id="vop-mk" ${SETTINGS.showMarkers ? "checked" : ""}>有人作業的站閃爍標示(工種色)</label>
          <label style="display:flex;align-items:center;gap:5px;margin-bottom:8px;cursor:pointer;"><input type="checkbox" id="vop-hd" ${SETTINGS.hideDriver ? "checked" : ""}>自動關掉誤點到的人員彈窗</label>
        </div>
        <div id="vop-active" style="border-top:1px solid #e5e7eb;padding-top:7px;">載入中…</div>
      </div>`;
    document.body.appendChild(box);
    panelBox = box;
    window.addEventListener("resize", () => clampBox(box)); // 視窗縮小也把面板夾回畫面內

    const body = box.querySelector("#vop-body");
    const head = box.querySelector("#vop-head");
    box.querySelector("#vop-tog").addEventListener("click", (e) => { e.stopPropagation(); const hidden = body.style.display === "none"; body.style.display = hidden ? "block" : "none"; box.querySelector("#vop-tog").textContent = hidden ? "▼" : "▲"; box.style.resize = hidden ? "both" : "none"; });
    // 「顯示設定」整區(作業/超時 + 最近範圍 + 自動關閉)收合
    box.querySelector("#vop-set-head").addEventListener("click", () => {
      SETTINGS.settingsCollapsed = !SETTINGS.settingsCollapsed; saveSettings();
      box.querySelector("#vop-set-body").style.display = SETTINGS.settingsCollapsed ? "none" : "block";
      box.querySelector("#vop-set-tog").textContent = SETTINGS.settingsCollapsed ? "展開 ▸" : "收合 ▾";
    });
    box.querySelectorAll("input[data-job]").forEach((cb) => cb.addEventListener("change", () => { SETTINGS.jobs[cb.dataset.job] = cb.checked; saveSettings(); reapply(false); refreshActiveList(); }));
    box.querySelectorAll("input[data-ot]").forEach((inp) => inp.addEventListener("change", () => { SETTINGS.overtime[inp.dataset.ot] = Math.max(0, Number(inp.value) || 0); saveSettings(); reapply(false); refreshActiveList(); }));
    box.querySelector("#vop-hours").addEventListener("change", (e) => { SETTINGS.hours = Number(e.target.value); saveSettings(); reapply(true); refreshActiveList(); });
    box.querySelector("#vop-mk").addEventListener("change", (e) => { SETTINGS.showMarkers = e.target.checked; saveSettings(); renderMapMarkers(); });
    box.querySelector("#vop-hd").addEventListener("change", (e) => { SETTINGS.hideDriver = e.target.checked; saveSettings(); });

    // 拖拉(抓標題列)
    head.addEventListener("mousedown", (e) => {
      if (e.target.id === "vop-tog") return;
      const sx = e.clientX, sy = e.clientY; const r = box.getBoundingClientRect(); const ox = r.left, oy = r.top;
      box.style.left = ox + "px"; box.style.top = oy + "px"; box.style.right = "auto"; box.style.bottom = "auto";
      const mm = (ev) => { box.style.left = (ox + ev.clientX - sx) + "px"; box.style.top = (oy + ev.clientY - sy) + "px"; clampBox(box); };
      const mu = () => { document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu); saveLayout(box); };
      document.addEventListener("mousemove", mm); document.addEventListener("mouseup", mu);
      e.preventDefault();
    });
    // 縮放後記住大小
    let rt = null;
    new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => saveLayout(box), 400); }).observe(box);
  }

  // Google 地圖按「全螢幕」時,只有全螢幕那個元素會被畫出來 → 把面板搬進去;退出時搬回 body。
  // 用保留的 panelBox 參考(不是 getElementById),因為 Google 退出全螢幕會重建 DOM 把面板拔掉。
  function relocatePanel() {
    if (!panelBox) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
    const target = fs || document.body;
    if (panelBox.parentElement !== target) target.appendChild(panelBox); // 移動不掉事件,position:fixed 仍對齊視窗
  }
  // Google 重建 DOM 可能在事件之後,延遲再確認一次面板還在
  function onFsChange() { relocatePanel(); setTimeout(relocatePanel, 0); setTimeout(relocatePanel, 300); }

  function init() {
    buildPanel(); refreshActiveList(); setInterval(refreshActiveList, 30000);
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    // 地圖實例通常晚幾秒才抓到 → 前 40 秒每 2 秒補畫一次圖標,抓到就停
    let mt = 0; const mTimer = setInterval(() => { if (activeOverlays.length || ++mt > 20) clearInterval(mTimer); else renderMapMarkers(); }, 2000);
    let pending = null;
    new MutationObserver(() => { if (pending) return; pending = setTimeout(() => { pending = null; document.querySelectorAll(".gm-style-iw-d").forEach(handlePopup); }, 120); }).observe(document.body, { childList: true, subtree: true });
    log("已啟動 v0.8.7");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
