/* Gunnison County Land Attribute Dashboard (RealWare edition).
   Data model comes from assets/data.js (LADData.load). */
(() => {
  "use strict";

  // ------------------------------------------------------------------ constants
  const NO_VALUE = -1, NO_LAND = -2, NO_LAND_OK = -3;
  const SPECIAL = { [NO_VALUE]: "No value recorded", [NO_LAND]: "No land data", [NO_LAND_OK]: "Mobile home / condo (no land line)" };
  const SPECIAL_HASH = { [NO_VALUE]: "_none", [NO_LAND]: "_noland", [NO_LAND_OK]: "_mhcondo" };
  const MAX_SEL = 6;
  const RECORD_URL = (acct) => `https://property.spatialest.com/co/gunnison#/property/${encodeURIComponent(acct)}`;
  const COUNTY_BOUNDS = [[-107.95, 38.15], [-106.25, 39.25]];
  const LABEL_MINZOOM = 14;
  // Categorical slots (validated reference palette, red/green left out so they never read as status).
  const SLOTS = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"],
    dark:  ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"],
  };
  const MULTI = { light: "#52514e", dark: "#c3c2b7" };
  const ISSUES = {
    missing:             { label: "Missing",                       group: "missing",  about: "A core land attribute is blank. When enough neighbors agree, the detail shows what they carry." },
    outlier:             { label: "Differs from neighbors",        group: "outlier",  about: "The account's value differs from the value most comparable properties around it carry (settings on Review & Stats)." },
    multiple:            { label: "More than one value",           group: "conflict", about: "A single-value attribute (primary/secondary land type, views) holds more than one value." },
    conflict:            { label: "Conflicting values",            group: "conflict", about: "A utility holds values that contradict each other (e.g. INSTALLED and NOT AVAILABLE)." },
    same_as_primary:     { label: "Secondary = primary",           group: "conflict", about: "Secondary land type is the same as the primary land type." },
    legacy:              { label: "Legacy access code only",       group: "legacy",   about: "Site access carries only the older YEAR ROUND / SEASONAL code with no road type." },
    improved_no_utility: { label: "Improved, utility shows none",  group: "improved", about: "Improved (residential, condo, commercial or mobile home with improvement value > $0) but a utility shows none / not installed / not available (off-grid excluded)." },
    no_land:             { label: "No land data",                  group: "no_land",  about: "No land attributes or LEA in RealWare. Mobile home (M) accounts and condos are excluded: they normally have no land line." },
    unmapped:            { label: "Not on parcel map",             group: "unmapped", about: "No parcel shape matches the account or parcel number (usually mineral interests or accounts newer than the parcel shapefile)." },
  };
  const ISSUE_COLS = [["missing", "Missing"], ["conflict", "Data conflicts"], ["legacy", "Legacy access code"],
                      ["improved", "Improved, no utility"], ["outlier", "Differs from neighbors"]];
  const BASEMAPS = {
    light:  { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"], maxzoom: 16, attribution: "Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors" },
    dark:   { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"], maxzoom: 16, attribution: "Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors" },
    aerial: { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
    topo:   { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"], maxzoom: 19, attribution: "Tiles © Esri" },
  };
  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const mode = () => (document.documentElement.dataset.theme || (prefersDark ? "dark" : "light")) === "dark" ? "dark" : "light";

  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null ? "—" : Math.round(n).toLocaleString());
  const pct = (a, b) => (b ? (100 * a / b) : 0);
  const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString());
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const mdy = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
  function downloadCSV(name, header, rows) {
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const url = URL.createObjectURL(new Blob([[header, ...rows].map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  // ------------------------------------------------------------------ appraisal periods
  // Gunnison County: reappraisal every odd year, values as of June 30 of the prior year,
  // minimum 24 months of sales (July 1 three years before → June 30 the year before).
  function periods() {
    const today = new Date(); const out = [];
    let y = today.getFullYear() + (today.getFullYear() % 2 === 0 ? 1 : 2);   // next odd year after this one
    for (let k = 0; k < 5; k++, y -= 2) {
      const start = new Date(y - 3, 6, 1), end = new Date(y - 1, 5, 30);
      out.push({ year: y, start, end, inProgress: end > today });
    }
    return out;
  }
  const PERIODS = periods();
  const defaultPeriod = () => (PERIODS.find((p) => !p.inProgress) || PERIODS[0]).year;

  // ------------------------------------------------------------------ state
  let M, A, GEO, CATS, CAT_IX, VALUES, fpAccts, LEA_CI, NBHD_CI, typesList, areasList;
  const S = {
    ci: 0, sel: new Map(), valueText: "",
    types: new Set(), leas: new Set(), nbhds: new Set(),
    showFlags: false, basemap: "light",
    labels: { acct: false, sale: false }, soldMark: false,
    period: { year: defaultPeriod(), extend: 0 },
    nb: { basis: "adjacent", min: 4, agree: 0.75 },
    review: { issue: "", ci: "", text: "", limit: 200, group: "" },
    distCi: 0,
  };
  let outliers = [], consensus = new Map(), _obA = null, _obSrc = null;
  let map, mapReady = false, prevH = null, prevF = null, selFp = -1;
  const whenReady = [];

  const periodRange = () => {
    const p = PERIODS.find((x) => x.year === S.period.year) || PERIODS[0];
    const start = new Date(p.start); start.setMonth(start.getMonth() - S.period.extend);
    return { start, end: p.end, year: p.year };
  };
  const saleInPeriod = (a) => { const { start, end } = periodRange(); return a.sales.find((s) => s.date >= start && s.date <= end) || null; };
  const anyIn = (a, ci, set) => ci == null || !set.size || a.attrs[ci].some((v) => set.has(v));
  const acctPass = (a) => (!S.types.size || S.types.has(a.type)) && anyIn(a, LEA_CI, S.leas) && anyIn(a, NBHD_CI, S.nbhds);
  const valName = (ci, v) => (v < 0 ? SPECIAL[v] : VALUES[ci][v]);
  const keyName = (ci, key) => (key === "" ? "(blank)" : key.split("|").map((v) => VALUES[ci][+v]).join(" + "));
  const accountMatches = (a, ci, v) =>
    v === NO_LAND ? !a.hasLand && a.landExpected :
    v === NO_LAND_OK ? !a.hasLand && !a.landExpected :
    !a.hasLand ? false : v === NO_VALUE ? a.attrs[ci].length === 0 : a.attrs[ci].includes(v);

  // ------------------------------------------------------------------ load
  LADData.load().then((m) => {
    M = m; ({ A, GEO, CATS, CAT_IX, VALUES, fpAccts } = m);
    LEA_CI = CAT_IX.LEA; NBHD_CI = CAT_IX.NEIGHBORHOOD;
    const tc = {}, ac = {};
    A.forEach((a) => { tc[a.type] = (tc[a.type] || 0) + 1; if (a.area) ac[a.area] = 1; });
    typesList = Object.entries(tc).sort((x, y) => y[1] - x[1]);
    areasList = Object.keys(ac).sort();
    S.ci = CAT_IX["LAND TYPE PRIMARY"] ?? 0; S.distCi = S.ci;
    readHash();
    if (!S.sel.size && VALUES[S.ci].length) S.sel.set(0, 0);
    computeOutliers();
    initControls(); initSearch(); initRefresh(); initMap();
    applyHighlight(); route();
  }).catch((e) => { $("loading").textContent = "Could not load data: " + e.message; console.error(e); });

  // ------------------------------------------------------------------ routing / hash
  const currentPage = () => (location.hash.slice(1).split("?")[0] || "map");
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1).split("?")[1] || "");
    if (p.has("c") && CAT_IX[p.get("c")] != null) S.ci = CAT_IX[p.get("c")];
    if (p.has("v")) {
      S.sel = new Map();
      const back = Object.fromEntries(Object.entries(SPECIAL_HASH).map(([k, v]) => [v, +k]));
      for (const name of p.get("v").split("|")) {
        const v = name in back ? back[name] : VALUES[S.ci].indexOf(name);
        if ((v >= 0 || v in SPECIAL) && S.sel.size < MAX_SEL) S.sel.set(v, S.sel.size);
      }
    }
  }
  function writeHash() {
    if (currentPage() !== "map") return;
    const v = [...S.sel.keys()].map((x) => (x < 0 ? SPECIAL_HASH[x] : VALUES[S.ci][x])).join("|");
    history.replaceState(null, "", `#map?c=${encodeURIComponent(CATS[S.ci].key)}&v=${encodeURIComponent(v)}`);
  }
  function route() {
    const page = ["map", "stats", "about"].includes(currentPage()) ? currentPage() : "map";
    for (const p of ["map", "stats", "about"]) $("page-" + p).hidden = p !== page;
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.page === page));
    if (page === "map" && map) { map.resize(); writeHash(); }
    if (page === "stats") renderStats();
    if (page === "about") renderAbout();
  }
  addEventListener("hashchange", () => { if (!M) return; if (currentPage() === "map" && location.hash.includes("?")) { readHash(); renderValues(); applyHighlight(); } route(); });

  // ------------------------------------------------------------------ multi-select dropdown (LEA / neighborhood filters)
  function multiSelect(el, { noun, ci, set }) {
    if (ci == null) { el.innerHTML = `<div class="ms-empty">No ${noun.toLowerCase()} data</div>`; return; }
    const counts = new Map(); for (const a of A) for (const v of a.attrs[ci]) counts.set(v, (counts.get(v) || 0) + 1);
    const items = VALUES[ci].map((name, v) => [v, name, counts.get(v) || 0]).sort((x, y) => x[1].localeCompare(y[1], undefined, { numeric: true }));
    const label = () => !set.size ? `All ${noun}s` : set.size === 1 ? VALUES[ci][[...set][0]] : `${set.size} ${noun}s selected`;
    el.innerHTML = `<button class="ms-btn" type="button" aria-haspopup="listbox"><span class="ms-label"></span><span aria-hidden="true">▾</span></button>
      <div class="ms-pop" hidden><input type="search" placeholder="Filter ${noun}s…" class="ms-q"><div class="ms-actions"><button class="linkbtn ms-clear" type="button">Clear</button><button class="linkbtn ms-zoom" type="button">Zoom to selection</button></div><ul class="ms-list" role="listbox"></ul></div>`;
    const btn = el.querySelector(".ms-btn"), pop = el.querySelector(".ms-pop"), q = el.querySelector(".ms-q"), ul = el.querySelector(".ms-list");
    const paint = () => {
      el.querySelector(".ms-label").textContent = label();
      const t = q.value.trim().toLowerCase();
      ul.innerHTML = items.filter(([, n]) => !t || n.toLowerCase().includes(t)).slice(0, 400).map(([v, n, c]) =>
        `<li data-v="${v}" role="option" aria-selected="${set.has(v)}"><input type="checkbox" tabindex="-1" ${set.has(v) ? "checked" : ""}><span class="nm">${esc(n)}</span><span class="n">${fmt(c)}</span></li>`).join("");
    };
    btn.onclick = () => { pop.hidden = !pop.hidden; if (!pop.hidden) { paint(); q.focus(); } };
    q.oninput = paint;
    ul.onclick = (e) => { const li = e.target.closest("li[data-v]"); if (!li) return; const v = +li.dataset.v; set.has(v) ? set.delete(v) : set.add(v); paint(); filtersChanged(); autoZoom(); };
    el.querySelector(".ms-clear").onclick = () => { set.clear(); paint(); filtersChanged(); };
    el.querySelector(".ms-zoom").onclick = () => { pop.hidden = true; location.hash = "#map"; setTimeout(() => zoomToAccounts(A.filter(acctPass)), 30); };
    document.addEventListener("mousedown", (e) => { if (!el.contains(e.target)) pop.hidden = true; });
    el._paint = paint; paint();
  }

  // Zoom the map to whatever the LEA / neighborhood filters select (debounced while ticking several).
  const autoZoom = debounce(() => { if (currentPage() === "map" && (S.leas.size || S.nbhds.size)) zoomToAccounts(A.filter(acctPass)); }, 450);

  // ------------------------------------------------------------------ controls
  function catOptions(sel, withAll) {
    const groups = {}; CATS.forEach((c, i) => (groups[c.group] ||= []).push([c, i]));
    sel.innerHTML = (withAll ? `<option value="">All attributes</option>` : "") +
      Object.entries(groups).map(([g, cs]) => `<optgroup label="${esc(g)}">${cs.map(([c, i]) => `<option value="${i}">${esc(c.label)}</option>`).join("")}</optgroup>`).join("");
  }
  function renderChips(el) {
    el.innerHTML = typesList.map(([t, n]) => `<button class="chip${S.types.has(t) ? " on" : ""}" data-t="${esc(t)}" data-tip="${fmt(n)} accounts">${esc(t)}</button>`).join("");
  }
  function filtersChanged() {
    renderChips($("type-chips")); renderChips($("s-type-chips"));
    for (const id of ["lea-ms", "nbhd-ms", "s-lea-ms", "s-nbhd-ms"]) $(id)._paint?.();
    renderFilterNote();
    if (currentPage() === "stats") renderStats();
    renderValues(); applyHighlight();
  }
  function renderFilterNote() {
    const n = S.types.size + S.leas.size + S.nbhds.size;
    $("filter-note").textContent = n ? `${fmt(A.filter(acctPass).length)} accounts match the filters` : "";
  }
  function initControls() {
    catOptions($("cat")); $("cat").value = S.ci;
    $("cat").onchange = () => { S.ci = +$("cat").value; S.sel = new Map([[0, 0]]); S.valueText = ""; $("value-filter").value = ""; renderValues(); applyHighlight(); writeHash(); };
    $("value-filter").oninput = () => { S.valueText = $("value-filter").value.trim().toLowerCase(); renderValues(); };
    $("values").onclick = (e) => {
      const li = e.target.closest("li[data-v]"); if (!li) return;
      const v = +li.dataset.v;
      if (e.target.closest(".box") || e.metaKey || e.ctrlKey || e.shiftKey) toggleValue(v); else selectOnly(v);
    };
    $("prev").onclick = () => flip(-1);
    $("next").onclick = () => flip(1);
    $("color-all").onclick = colorAll;
    $("clear-sel").onclick = () => { S.sel = new Map(); renderValues(); applyHighlight(); writeHash(); };
    addEventListener("keydown", (e) => {
      if (currentPage() !== "map" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      if (e.key === "ArrowDown" || e.key === "j") { flip(1); e.preventDefault(); }
      if (e.key === "ArrowUp" || e.key === "k") { flip(-1); e.preventDefault(); }
      if (e.key === "Escape") closeDetail();
    });
    for (const el of [$("type-chips"), $("s-type-chips")]) {
      el.onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; const t = b.dataset.t; S.types.has(t) ? S.types.delete(t) : S.types.add(t); filtersChanged(); };
    }
    renderChips($("type-chips")); renderChips($("s-type-chips"));
    multiSelect($("lea-ms"), { noun: "LEA", ci: LEA_CI, set: S.leas });
    multiSelect($("nbhd-ms"), { noun: "Neighborhood", ci: NBHD_CI, set: S.nbhds });
    multiSelect($("s-lea-ms"), { noun: "LEA", ci: LEA_CI, set: S.leas });
    multiSelect($("s-nbhd-ms"), { noun: "Neighborhood", ci: NBHD_CI, set: S.nbhds });
    $("show-flags").onchange = () => { S.showFlags = $("show-flags").checked; document.querySelector(".flag-legend").hidden = !S.showFlags; applyFlags(); };
    $("basemap").onclick = (e) => { const b = e.target.closest("button"); if (b) setBasemap(b.dataset.bm); };

    // labels + appraisal period
    $("sold-mark").onchange = () => { S.soldMark = $("sold-mark").checked; document.querySelector(".sold-legend").hidden = !S.soldMark; updateSold(); };
    $("lbl-acct").onchange = () => { S.labels.acct = $("lbl-acct").checked; updateLabels(); };
    $("lbl-sale").onchange = () => { S.labels.sale = $("lbl-sale").checked; updateLabels(); };
    $("period").innerHTML = PERIODS.map((p) => `<option value="${p.year}">${p.year} reappraisal: ${mdy(p.start)} – ${mdy(p.end)}${p.inProgress ? " (in progress)" : ""}</option>`).join("");
    $("period").value = S.period.year;
    $("extend").innerHTML = [0, 6, 12, 18, 24, 36].map((m) => `<option value="${m}">${m ? `Extend back ${m} months` : "No extension (24 months)"}</option>`).join("");
    const periodChanged = () => { S.period = { year: +$("period").value, extend: +$("extend").value }; renderPeriodNote(); updateLabels(); updateSold(); if (selFp >= 0 && !$("detail").hidden) openDetail(selFp, false, true); };
    $("period").onchange = $("extend").onchange = periodChanged;
    renderPeriodNote();

    $("detail-close").onclick = closeDetail;
    $("detail-body").onclick = (e) => {
      const b = e.target.closest("[data-show-all]"); if (b) openDetail(+b.dataset.showAll, true);
      const c = e.target.closest("[data-pick]"); if (c) { const [ci, v] = c.dataset.pick.split(":").map(Number); S.ci = ci; $("cat").value = ci; selectOnly(v); }
    };

    // stats controls
    $("nb-basis").onchange = $("nb-min").onchange = $("nb-agree").onchange = () => {
      S.nb = { basis: $("nb-basis").value, min: Math.max(2, +$("nb-min").value || 4), agree: +$("nb-agree").value };
      computeOutliers(); renderStats(); applyFlags();
    };
    catOptions($("dist-cat")); $("dist-cat").value = S.distCi;
    $("dist-cat").onchange = () => { S.distCi = +$("dist-cat").value; renderDist(); };
    $("r-issue").innerHTML = `<option value="">All issues</option>` + Object.entries(ISSUES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
    catOptions($("r-cat"), true);
    $("r-issue").onchange = () => { S.review.issue = $("r-issue").value; S.review.group = ""; S.review.limit = 200; renderReview(); };
    $("r-cat").onchange = () => { S.review.ci = $("r-cat").value; S.review.limit = 200; renderReview(); };
    $("r-text").oninput = debounce(() => { S.review.text = $("r-text").value.trim().toLowerCase(); S.review.limit = 200; renderReview(); }, 150);
    $("more").onclick = () => { S.review.limit += 500; renderReview(); };
    $("export").onclick = exportReview;
    $("coverage").onclick = (e) => {
      const td = e.target.closest("td[data-ci]"); if (!td) return;
      S.types = td.dataset.type ? new Set([td.dataset.type]) : new Set();
      setReview(td.dataset.ci === "land" ? "no_land" : "missing", td.dataset.ci === "land" ? "" : td.dataset.ci);
      filtersChanged(); $("review").closest(".card").scrollIntoView({ behavior: "smooth" });
    };
    $("issue-summary").onclick = (e) => {
      const b = e.target.closest("button[data-issue]"); if (!b) return;
      setReview(b.dataset.issue, b.dataset.ci); renderReview(); $("review").closest(".card").scrollIntoView({ behavior: "smooth" });
    };
    $("review").onclick = (e) => { const b = e.target.closest("button[data-go]"); if (b) goToIssue(+b.dataset.go, +b.dataset.ci); };
    $("dist").onclick = (e) => { const t = e.target.closest("[data-v]"); if (!t) return; S.ci = S.distCi; $("cat").value = S.ci; S.sel = new Map([[+t.dataset.v, 0]]); location.hash = "#map"; };

    const tip = $("tip");
    document.addEventListener("mouseover", (e) => { const el = e.target.closest("[data-tip]"); if (!el) { tip.hidden = true; return; } tip.innerHTML = el.dataset.tip; tip.hidden = false; });
    document.addEventListener("mousemove", (e) => { if (!tip.hidden) { tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = (e.clientY + 16) + "px"; } });
    renderValues(); renderFilterNote();
  }
  function renderPeriodNote() {
    const { start, end } = periodRange();
    $("period-note").textContent = `Qualified sales ${mdy(start)} – ${mdy(end)}`;
  }
  function setReview(issue, ci) {
    const m1 = { conflict: "", improved: "improved_no_utility" };
    S.review.issue = issue in m1 ? m1[issue] : issue;
    S.review.group = issue === "conflict" ? "conflict" : "";
    S.review.ci = ci ?? ""; S.review.limit = 200;
    $("r-issue").value = S.review.issue; $("r-cat").value = S.review.ci;
  }

  // ------------------------------------------------------------------ value list (multi-select with colors)
  function valueCounts(ci) {
    const counts = new Map(); let noVal = 0, noLand = 0, noLandOk = 0;
    for (const a of A) {
      if (!acctPass(a)) continue;
      if (!a.hasLand) { a.landExpected ? noLand++ : noLandOk++; continue; }
      const vs = a.attrs[ci]; if (!vs.length) noVal++;
      for (const v of vs) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return { counts, noVal, noLand, noLandOk };
  }
  const slotColor = (slot) => SLOTS[mode()][slot];
  let visibleVals = [];
  function renderValues() {
    const ci = S.ci; const { counts, noVal, noLand, noLandOk } = valueCounts(ci);
    const items = VALUES[ci].map((name, v) => [v, name, counts.get(v) || 0]).filter((x) => x[2] > 0 || S.sel.has(x[0])).sort((x, y) => y[2] - x[2]);
    const specials = [[NO_VALUE, SPECIAL[NO_VALUE], noVal], [NO_LAND, SPECIAL[NO_LAND], noLand], [NO_LAND_OK, SPECIAL[NO_LAND_OK], noLandOk]];
    const q = S.valueText;
    const all = [...items, ...specials].filter(([v, name]) => !q || name.toLowerCase().includes(q) || S.sel.has(v));
    visibleVals = all.map((x) => x[0]);
    $("values").innerHTML = all.map(([v, name, n]) => {
      const on = S.sel.has(v), col = on ? slotColor(S.sel.get(v)) : "";
      return `<li data-v="${v}" role="option" aria-selected="${on}" class="${on ? "on" : ""}${v < 0 ? " special" : ""}">
        <span class="box" title="Add / remove (up to ${MAX_SEL})" style="${on ? `background:${col};border-color:${col}` : ""}">${on ? "✓" : ""}</span>
        <span class="nm">${esc(v < 0 ? "— " + name : name)}</span><span class="n">${fmt(n)}</span></li>`;
    }).join("");
    $("sel-count").textContent = S.sel.size > 1 ? `${S.sel.size} of ${MAX_SEL} colors` : "";
    renderLegend();
  }
  function selectOnly(v) { S.sel = new Map([[v, 0]]); renderValues(); applyHighlight(); writeHash(); }
  function toggleValue(v) {
    if (S.sel.has(v)) S.sel.delete(v);
    else {
      if (S.sel.size >= MAX_SEL) { flash(`Up to ${MAX_SEL} values can be colored at once`); return; }
      const used = new Set(S.sel.values()); let slot = 0; while (used.has(slot)) slot++;   // color follows the value
      S.sel.set(v, slot);
    }
    renderValues(); applyHighlight(); writeHash();
  }
  function colorAll() {
    const { counts } = valueCounts(S.ci);
    const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, MAX_SEL).map(([v]) => v);
    S.sel = new Map(top.map((v, i) => [v, i]));
    if (counts.size > MAX_SEL) flash(`Showing the ${MAX_SEL} most common of ${counts.size} values`);
    renderValues(); applyHighlight(); writeHash();
  }
  function flip(d) {
    if (!visibleVals.length) return;
    const cur = S.sel.size === 1 ? [...S.sel.keys()][0] : visibleVals[0];
    const i = visibleVals.indexOf(cur);
    selectOnly(visibleVals[(i + d + visibleVals.length) % visibleVals.length]);
  }
  let flashT;
  function flash(msg) { const el = $("flash"); el.textContent = msg; el.hidden = false; clearTimeout(flashT); flashT = setTimeout(() => (el.hidden = true), 2600); }
  function renderLegend() {
    const rows = [...S.sel.entries()].sort((x, y) => x[1] - y[1]).map(([v, slot]) =>
      `<span><i class="sw" style="background:${slotColor(slot)}"></i>${esc(valName(S.ci, v))}</span>`);
    if (S.sel.size > 1) rows.push(`<span><i class="sw" style="background:${MULTI[mode()]}"></i>More than one selected value</span>`);
    $("legend-values").innerHTML = rows.join("") || `<span class="muted">Pick a value to light up parcels</span>`;
  }

  // ------------------------------------------------------------------ map
  function initMap() {
    const sources = {}, layers = [];
    for (const [k, b] of Object.entries(BASEMAPS)) {
      sources["bm-" + k] = { type: "raster", tiles: b.tiles, tileSize: 256, attribution: b.attribution, maxzoom: b.maxzoom };
      layers.push({ id: "bm-" + k, type: "raster", source: "bm-" + k, layout: { visibility: "none" } });
    }
    map = new maplibregl.Map({
      container: "map",
      style: { version: 8, glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf", sources, layers },
      bounds: COUNTY_BOUNDS, fitBoundsOptions: { padding: 20 }, maxZoom: 19, attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
    map.on("load", () => {
      map.addSource("parcels", { type: "geojson", data: "data/parcels.geojson", tolerance: 0.25, buffer: 32 });
      map.addSource("labels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("sold", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      addCalloutImages();
      map.addLayer({ id: "parcels-fill", type: "fill", source: "parcels", paint: {} });
      map.addLayer({ id: "parcels-line", type: "line", source: "parcels", paint: {} });
      map.addLayer({ id: "parcels-flag", type: "line", source: "parcels", paint: {
        "line-color": "#d03b3b", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 15, 2.6],
        "line-opacity": ["case", ["boolean", ["feature-state", "f"], false], 1, 0] } });
      map.addLayer({ id: "parcels-sel", type: "line", source: "parcels", paint: {
        "line-color": "#0b0b0b", "line-width": 3, "line-opacity": ["case", ["boolean", ["feature-state", "sel"], false], 1, 0] } });
      map.addLayer({ id: "sold", type: "circle", source: "sold", paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2, 12, 3.5, 16, 6], "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 14, 2] } });
      map.addLayer({ id: "labels", type: "symbol", source: "labels", minzoom: LABEL_MINZOOM, layout: {
        "text-field": ["get", "t"], "text-font": ["Noto Sans Medium"], "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 12.5],
        "text-max-width": 14, "text-line-height": 1.2, "text-padding": 3,
        "icon-image": "callout-light", "icon-text-fit": "both", "icon-text-fit-padding": [3, 6, 3, 6] }, paint: {} });
      setBasemap(S.basemap);
      const ready = () => {
        if (mapReady || !map.isSourceLoaded("parcels")) return;
        mapReady = true; $("loading").hidden = true; prevH = null; prevF = null;
        map.off("sourcedata", ready);
        applyHighlight(); updateLabels(); updateSold();
        for (const fn of whenReady.splice(0)) fn();
      };
      map.on("sourcedata", ready);
    });

    const tipEl = $("hover-tip"); let pending = null;
    map.on("mousemove", "parcels-fill", (e) => {
      map.getCanvas().style.cursor = "pointer";
      // MapLibre clears e.features after this handler returns, so capture what we need now.
      const f = e.features && e.features[0]; if (!f) return;
      const queued = pending; pending = { fp: f.id, point: e.point };
      if (queued) return;
      requestAnimationFrame(() => {
        if (!pending) return; const ev = pending; pending = null;
        const fp = ev.fp; const accts = fpAccts[fp] || [];
        const a = A[accts[0]];
        let html = a ? `<strong>${esc(a.address || a.account)}</strong>` : `<strong>Parcel ${esc(GEO[fp][1][0] || "")}</strong>`;
        if (accts.length > 1) html += ` <span class="m">+${accts.length - 1} more account${accts.length > 2 ? "s" : ""}</span>`;
        if (a) {
          const vs = a.hasLand ? a.attrs[S.ci].map((v) => VALUES[S.ci][v]) : null;
          html += `<div class="m">${esc(CATS[S.ci].label)}: ${esc(vs == null ? (a.landExpected ? "no land data" : "mobile home / condo, no land line") : vs.length ? vs.join(", ") : "—")}</div>`;
          const s = saleInPeriod(a); if (s) html += `<div class="m">Qualified sale ${mdy(s.date)} · ${money(s.price)}</div>`;
        } else html += `<div class="m">No account in current data</div>`;
        tipEl.innerHTML = html; tipEl.hidden = false;
        const { x, y } = ev.point; const w = map.getCanvas().clientWidth;
        tipEl.style.left = Math.min(x + 14, w - tipEl.offsetWidth - 6) + "px"; tipEl.style.top = (y + 14) + "px";
      });
    });
    map.on("mouseleave", "parcels-fill", () => { map.getCanvas().style.cursor = ""; tipEl.hidden = true; pending = null; });
    map.on("click", "parcels-fill", (e) => openDetail(e.features[0].id));
  }

  function setBasemap(bm) {
    S.basemap = bm;
    document.querySelectorAll("#basemap button").forEach((b) => b.classList.toggle("on", b.dataset.bm === bm));
    if (!map || !map.getLayer("parcels-fill")) return;
    const real = bm === "light" && mode() === "dark" ? "dark" : bm;
    for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty("bm-" + k, "visibility", k === real ? "visible" : "none");
    const imagery = bm === "aerial", dark = real === "dark" || imagery;
    const slots = SLOTS[mode()], fillA = imagery ? 0.72 : dark ? 0.66 : 0.6;
    const other = imagery ? "rgba(255,255,255,0.10)" : dark ? "rgba(200,200,190,0.10)" : "rgba(120,120,115,0.16)";
    const line = imagery ? "rgba(255,255,255,0.55)" : dark ? "rgba(200,200,190,0.35)" : "rgba(95,95,90,0.45)";
    const h = ["coalesce", ["feature-state", "h"], 0];
    const fill = ["match", h, 1, other]; slots.forEach((c, i) => fill.push(i + 2, hexA(c, fillA)));
    fill.push(8, hexA(MULTI[dark ? "dark" : "light"], fillA), "rgba(0,0,0,0)");
    const stroke = ["match", h]; slots.forEach((c, i) => stroke.push(i + 2, c)); stroke.push(8, MULTI[dark ? "dark" : "light"], line);
    map.setPaintProperty("parcels-fill", "fill-color", fill);
    map.setPaintProperty("parcels-line", "line-color", stroke);
    map.setPaintProperty("parcels-line", "line-width", ["interpolate", ["linear"], ["zoom"], 8, ["case", [">=", h, 2], 0.6, 0.15], 13, ["case", [">=", h, 2], 1, 0.5], 17, ["case", [">=", h, 2], 1.6, 1.1]]);
    map.setPaintProperty("parcels-sel", "line-color", dark ? "#ffffff" : "#0b0b0b");
    map.setPaintProperty("labels", "text-color", dark ? "#ffffff" : "#0b0b0b");
    map.setLayoutProperty("labels", "icon-image", dark ? "callout-dark" : "callout-light");
    map.setPaintProperty("sold", "circle-color", dark ? "#ffffff" : "#0b0b0b");
    map.setPaintProperty("sold", "circle-stroke-color", dark ? "#0b0b0b" : "#ffffff");
  }

  let lastMatchFps = [];
  function applyHighlight() {
    const ci = S.ci, sel = [...S.sel.entries()];
    const H = new Uint8Array(GEO.length);
    const per = new Map(sel.map(([v]) => [v, 0]));
    let nAcct = 0; const fps = [];
    A.forEach((a) => {
      if (!acctPass(a)) return;
      let slot = -1, hits = 0;
      for (const [v, s] of sel) if (accountMatches(a, ci, v)) { hits++; slot = s; per.set(v, per.get(v) + 1); }
      if (hits) nAcct++;
      if (a.fp < 0) return;
      const state = hits > 1 ? 8 : hits ? 2 + slot : a.hasLand ? 1 : 0;
      const cur = H[a.fp];
      if (state >= 2) {
        if (cur < 2) fps.push(a.fp);
        H[a.fp] = cur >= 2 && cur !== state ? 8 : state;      // stacked accounts with different selected values → "multiple"
      } else if (cur === 0) H[a.fp] = state;
    });
    lastMatchFps = fps;
    if (mapReady) {
      for (let i = 0; i < H.length; i++) if (!prevH || prevH[i] !== H[i]) map.setFeatureState({ source: "parcels", id: i }, { h: H[i] });
      prevH = H;
    }
    const lines = sel.sort((x, y) => x[1] - y[1]).map(([v, s]) =>
      `<div class="sum-row"><i class="sw" style="background:${slotColor(s)}"></i><span>${esc(valName(ci, v))}</span><strong>${fmt(per.get(v))}</strong></div>`).join("");
    $("summary").innerHTML = `<div><strong>${fmt(nAcct)}</strong> account${nAcct === 1 ? "" : "s"} on <strong>${fmt(fps.length)}</strong> parcel${fps.length === 1 ? "" : "s"}</div>
      ${sel.length > 1 ? `<div class="sum-list">${lines}</div>` : `<div>${esc(CATS[ci].label)}${sel.length ? " · " + esc(valName(ci, sel[0][0])) : ""}</div>`}
      <div class="actions"><button class="linkbtn" id="zoom-hl" ${fps.length ? "" : "disabled"}>Zoom to these</button><button class="linkbtn" id="dl-hl" ${nAcct ? "" : "disabled"}>Download list</button><button class="linkbtn" id="zoom-all">Whole county</button></div>`;
    $("zoom-hl").onclick = () => zoomToFps(lastMatchFps);
    $("zoom-all").onclick = () => map.fitBounds(COUNTY_BOUNDS, { padding: 20 });
    $("dl-hl").onclick = () => {
      const rows = A.filter((a) => acctPass(a) && sel.some(([v]) => accountMatches(a, ci, v))).map((a) => {
        const s = saleInPeriod(a);
        return [a.account, a.parcel, a.type, a.address, a.subdivision, a.hasLand ? a.attrs[ci].map((x) => VALUES[ci][x]).join("; ") : "",
                s ? mdy(s.date) : "", s ? s.price : "", s ? s.adj : ""];
      });
      downloadCSV(`${CATS[ci].key.replace(/\W+/g, "_")}.csv`, ["account", "parcel", "account_type", "address", "subdivision", CATS[ci].label, "qualified_sale_date", "sale_price", "adjusted_sale_price"], rows);
    };
    applyFlags();
    updateLabels(); updateSold();
    if (selFp >= 0 && !$("detail").hidden) openDetail(selFp, false, true);
  }

  function applyFlags() {
    if (!mapReady) return;
    const F = new Uint8Array(GEO.length);
    if (S.showFlags) {
      const ci = S.ci;
      A.forEach((a) => { if (a.fp >= 0 && acctPass(a) && a.flags.some((f) => f[0] === ci && f[1] !== "missing")) F[a.fp] = 1; });
      for (const o of outliers) if (o.ci === ci) { const a = A[o.a]; if (a.fp >= 0 && acctPass(a)) F[a.fp] = 1; }
    }
    for (let i = 0; i < F.length; i++) if (!prevF || prevF[i] !== F[i]) map.setFeatureState({ source: "parcels", id: i }, { f: !!F[i] });
    prevF = F;
  }

  // Callout labels: account number and/or most recent qualified sale in the appraisal period.
  function updateLabels() {
    if (!mapReady) return;
    const features = [];
    if (S.labels.acct || S.labels.sale) {
      GEO.forEach((g, fp) => {
        const pt = g[4]; if (!pt) return;
        const accts = fpAccts[fp].filter((i) => acctPass(A[i])); if (!accts.length) return;
        let best = null, bestA = accts[0];
        if (S.labels.sale) for (const i of accts) { const s = saleInPeriod(A[i]); if (s && (!best || s.date > best.date)) { best = s; bestA = i; } }
        const lines = [];
        if (S.labels.acct) lines.push(A[bestA].account + (accts.length > 1 ? ` +${accts.length - 1}` : ""));
        if (S.labels.sale && best) {
          lines.push(`${mdy(best.date)} · ${money(best.price)}`);
          if (best.adj != null && best.adj !== best.price) lines.push(`Adj ${money(best.adj)}`);
        }
        if (lines.length) features.push({ type: "Feature", geometry: { type: "Point", coordinates: pt }, properties: { t: lines.join("\n") } });
      });
    }
    map.getSource("labels").setData({ type: "FeatureCollection", features });
    $("label-note").hidden = !(S.labels.acct || S.labels.sale) || map.getZoom() >= LABEL_MINZOOM;
  }

  // Rounded callout box drawn once on a canvas; stretched behind each label (light + dark versions).
  function addCalloutImages() {
    for (const [id, fill, stroke] of [["callout-light", "rgba(255,255,255,0.94)", "rgba(11,11,11,0.35)"], ["callout-dark", "rgba(26,26,25,0.92)", "rgba(255,255,255,0.45)"]]) {
      const n = 32, c = document.createElement("canvas"); c.width = c.height = n;
      const g = c.getContext("2d"); g.fillStyle = fill; g.strokeStyle = stroke; g.lineWidth = 2;
      g.beginPath(); g.roundRect(1.5, 1.5, n - 3, n - 3, 7); g.fill(); g.stroke();
      map.addImage(id, g.getImageData(0, 0, n, n), { pixelRatio: 2, stretchX: [[9, 23]], stretchY: [[9, 23]], content: [8, 8, 24, 24] });
    }
  }

  // Dot on every parcel with a qualified sale in the selected appraisal period (respects filters).
  function updateSold() {
    if (!mapReady) return;
    const features = []; let nAcct = 0;
    if (S.soldMark) {
      GEO.forEach((g, fp) => {
        const pt = g[4]; if (!pt) return;
        const sold = fpAccts[fp].filter((i) => acctPass(A[i]) && saleInPeriod(A[i]));
        if (!sold.length) return;
        nAcct += sold.length;
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: pt }, properties: {} });
      });
    }
    map.getSource("sold").setData({ type: "FeatureCollection", features });
    const { start, end } = periodRange();
    $("sold-note").hidden = !S.soldMark;
    $("sold-note").textContent = `${fmt(features.length)} parcels (${fmt(nAcct)} accounts) with a qualified sale ${mdy(start)} – ${mdy(end)}`;
  }

  function zoomToFps(fps, maxZoom = 16) {
    if (!map) return;
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90, any = false;
    for (const f of fps) { const b = GEO[f][2]; if (!b) continue; any = true; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
    if (!any) return;
    const detailOpen = !$("detail").hidden && innerWidth > 760;
    map.fitBounds([[x0, y0], [x1, y1]], { padding: { top: 40, bottom: 40, left: 40, right: detailOpen ? 400 : 40 }, maxZoom, duration: 700 });
  }
  const zoomToAccounts = (accts) => zoomToFps([...new Set(accts.filter((a) => a.fp >= 0).map((a) => a.fp))], 15);

  // ------------------------------------------------------------------ detail card
  function setSel(fp) {
    if (!mapReady) return;
    if (selFp >= 0) map.setFeatureState({ source: "parcels", id: selFp }, { sel: false });
    selFp = fp;
    if (fp >= 0) map.setFeatureState({ source: "parcels", id: fp }, { sel: true });
  }
  function closeDetail() { $("detail").hidden = true; setSel(-1); }
  function openDetail(fp, showAll = false, keep = false, focusAcct = -1) {
    setSel(fp);
    let accts = fpAccts[fp] || [];
    if (focusAcct >= 0) accts = [focusAcct, ...accts.filter((i) => i !== focusAcct)];
    const LIMIT = 12, shown = showAll ? accts : accts.slice(0, LIMIT);
    let html = "";
    if (!accts.length) html = `<h3>Parcel ${esc(GEO[fp][1].join(", ") || "—")}</h3><div class="meta">No account in the current data matches this parcel.</div>`;
    else if (accts.length > 1) html += `<div class="meta">${fmt(accts.length)} accounts share this parcel shape</div>`;
    html += shown.map(acctHTML).join("");
    if (!showAll && accts.length > LIMIT) html += `<div class="more-accts"><button class="linkbtn" data-show-all="${fp}">Show all ${fmt(accts.length)} accounts</button></div>`;
    const scroll = keep ? $("detail").scrollTop : 0;
    $("detail-body").innerHTML = html; $("detail").hidden = false; $("detail").scrollTop = scroll;
  }
  function saleHTML(a) {
    const s = saleInPeriod(a), last = a.sales[0], { year } = periodRange();
    const line = (x) => `${mdy(x.date)} · ${money(x.price)}${x.adj != null && x.adj !== x.price ? ` (adjusted ${money(x.adj)})` : ""}${x.vacantImproved ? ` · ${esc(x.vacantImproved.toLowerCase())}` : ""}`;
    let h = `<div class="sale"><span class="k">Qualified sale, ${year} period</span>${s ? line(s) : `<span class="empty">none</span>`}</div>`;
    if (last && last !== s) h += `<div class="sale"><span class="k">Most recent qualified sale</span>${line(last)}</div>`;
    return h;
  }
  function acctHTML(i) {
    const a = A[i], rows = [];
    if (a.hasLand || a.attrs.some((v) => v.length)) {
      CATS.forEach((c, ci) => {
        const vs = a.attrs[ci];
        if (!vs.length && !M.core.includes(c.key) && ci !== S.ci) return;
        const cell = vs.length ? vs.map((v) => `<button class="linkbtn" data-pick="${ci}:${v}" title="Show on map">${esc(VALUES[ci][v])}</button>`).join(", ")
                               : `<button class="linkbtn empty" data-pick="${ci}:${NO_VALUE}" title="Show accounts missing this">—</button>`;
        rows.push(`<tr class="${ci === S.ci ? "cur" : ""}"><td>${esc(c.label)}</td><td>${cell}</td></tr>`);
      });
    }
    const issues = issuesFor(i);
    return `<div class="acct">
      <h3><a href="${RECORD_URL(a.account)}" target="_blank" rel="noopener">${esc(a.account)}</a> <span class="meta">· ${esc(a.type)}${a.improvedType && a.improvedType !== a.type ? " · " + esc(a.improvedType) : ""}</span></h3>
      <div class="meta">${esc(a.address || "No situs address")}${a.area ? " · " + esc(a.area) : ""}<br>
        Parcel ${esc(a.parcel || "—")}${a.subdivision ? " · " + esc(a.subdivision) : ""}${a.condo ? " · " + esc(a.condo) : ""}<br>
        ${a.acres ? `Land ${a.acres.toLocaleString(undefined, { maximumFractionDigits: 3 })} ac · ` : ""}Actual value: land ${money(a.landValue)}, impr. ${money(a.impValue)}, total ${money(a.totalValue)}</div>
      ${saleHTML(a)}
      ${rows.length ? `<table>${rows.join("")}</table>` : `<div class="empty">${a.landExpected ? "No land attributes or LEA in RealWare." : (a.account.startsWith("M") ? "Mobile home account" : "Condo unit") + " — no land line expected."}</div>`}
      ${issues.length ? `<ul class="flags">${issues.map((x) => `<li>⚠ <strong>${esc(x.cat)}</strong> — ${esc(ISSUES[x.code].label)}${x.detail ? ": " + esc(x.detail) : ""}</li>`).join("")}</ul>` : ""}
    </div>`;
  }

  // ------------------------------------------------------------------ neighborhood consistency
  function computeOutliers() {
    const cis = M.neighborCats.map((k) => CAT_IX[k]);
    const { basis, min, agree } = S.nb;
    outliers = []; consensus = new Map();
    const keyOf = (a, ci) => a.attrs[ci].slice().sort((x, y) => x - y).join("|");
    const utilCis = new Set(["ELECTRICITY", "SEWER", "WATER"].map((k) => CAT_IX[k]));
    const improved = (j) => (A[j].impValue || 0) > 0;
    const judge = (i, ci, counts, total) => {
      if (total < min) return;
      let top = null, topN = 0;
      for (const [k, n] of counts) if (n > topN) { top = k; topN = n; }
      if (topN / total < agree) return;
      const own = keyOf(A[i], ci);
      if (own === "") consensus.set(i + "|" + ci, { top, agree: topN, n: total });
      else if (own !== top) outliers.push({ a: i, ci, own, top, agree: topN, n: total });
    };
    if (basis === "adjacent") {
      A.forEach((a, i) => {
        if (!a.hasLand || a.fp < 0) return;
        const comps = [];
        for (const f of [a.fp, ...GEO[a.fp][3]]) for (const j of fpAccts[f]) if (j !== i && A[j].hasLand) comps.push(j);
        if (comps.length < min) return;
        const imp = improved(i);
        for (const ci of cis) {
          const counts = new Map(); let total = 0; const util = utilCis.has(ci);
          for (const j of comps) {
            if (util && improved(j) !== imp) continue;
            const k = keyOf(A[j], ci); if (k === "") continue; counts.set(k, (counts.get(k) || 0) + 1); total++;
          }
          judge(i, ci, counts, total);
        }
      });
    } else {
      const groups = new Map();
      A.forEach((a, i) => { if (a.hasLand && a.subdivision) (groups.get(a.subdivision) || groups.set(a.subdivision, []).get(a.subdivision)).push(i); });
      for (const all of groups.values()) {
        if (all.length <= min) continue;
        for (const ci of cis) for (const members of utilCis.has(ci) ? [all.filter(improved), all.filter((j) => !improved(j))] : [all]) {
          const counts = new Map(); let total = 0;
          const keys = members.map((i) => keyOf(A[i], ci));
          keys.forEach((k) => { if (k !== "") { counts.set(k, (counts.get(k) || 0) + 1); total++; } });
          members.forEach((i, m) => {
            const own = keys[m];
            if (own !== "") { counts.set(own, counts.get(own) - 1); total--; }
            judge(i, ci, counts, total);
            if (own !== "") { counts.set(own, counts.get(own) + 1); total++; }
          });
        }
      }
    }
  }
  const basisWord = () => (S.nb.basis === "adjacent" ? "neighbors" : "subdivision accounts");
  function outliersByAcct() {
    if (_obSrc === outliers) return _obA;
    _obA = new Map(); for (const o of outliers) (_obA.get(o.a) || _obA.set(o.a, []).get(o.a)).push(o);
    _obSrc = outliers; return _obA;
  }
  function issuesFor(i) {
    const a = A[i], out = [];
    if (!a.hasLand && a.landExpected) out.push({ code: "no_land", ci: -1, cat: "Land data", detail: a.improvedType || "" });
    if (a.fp < 0) out.push({ code: "unmapped", ci: -1, cat: "Map", detail: a.parcel ? "parcel " + a.parcel : "" });
    for (const [ci, code, detail] of a.flags) {
      let d = detail;
      if (code === "missing") { const c = consensus.get(i + "|" + ci); if (c) d = `${c.agree} of ${c.n} ${basisWord()} have ${keyName(ci, c.top)}`; }
      out.push({ code, ci, cat: CATS[ci].label, detail: d });
    }
    for (const o of outliersByAcct().get(i) || []) out.push({ code: "outlier", ci: o.ci, cat: CATS[o.ci].label, detail: `this: ${keyName(o.ci, o.own)} · ${o.agree} of ${o.n} ${basisWord()}: ${keyName(o.ci, o.top)}` });
    return out;
  }

  // ------------------------------------------------------------------ stats page
  function renderStats() {
    if (!M) return;
    renderChips($("s-type-chips"));
    const acc = A.map((a, i) => i).filter((i) => acctPass(A[i]));
    const land = acc.filter((i) => A[i].hasLand);
    const expected = acc.filter((i) => A[i].landExpected), expectedWith = expected.filter((i) => A[i].hasLand).length;
    const coreCis = M.core.map((k) => CAT_IX[k]);
    const missingAny = land.filter((i) => coreCis.some((ci) => !A[i].attrs[ci].length)).length;
    const conflictCodes = new Set(["multiple", "conflict", "same_as_primary"]);
    const conflictAccts = acc.filter((i) => A[i].flags.some((f) => conflictCodes.has(f[1]))).length;
    const ob = outliersByAcct(), outAccts = acc.filter((i) => ob.has(i)).length;
    const unmapped = acc.filter((i) => A[i].fp < 0).length;
    const filtered = S.types.size || S.leas.size || S.nbhds.size;
    $("tiles").innerHTML = [
      [fmt(acc.length), "Accounts", filtered ? "in current filter" : "all active accounts"],
      [pct(expectedWith, expected.length).toFixed(1) + "%", "Have land data", `${fmt(expected.length - expectedWith)} without · ${fmt(acc.length - expected.length)} mobile home / condo excluded`],
      [fmt(missingAny), "Missing a core attribute", `${pct(missingAny, land.length).toFixed(1)}% of accounts with land data`],
      [fmt(conflictAccts), "Data-entry conflicts", "multiple / conflicting values"],
      [fmt(outAccts), "Differ from neighbors", `≥${Math.round(S.nb.agree * 100)}% of ${S.nb.min}+ ${basisWord()} agree`],
      [fmt(unmapped), "Not on parcel map", "no matching parcel shape"],
    ].map(([v, l, s]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div><div class="s">${s}</div></div>`).join("");
    renderCoverage(acc); renderIssueSummary(acc); renderDist(); renderReview();
  }
  function seqColor(p) {
    const steps = ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600"];
    const i = p >= 98 ? 5 : p >= 90 ? 4 : p >= 75 ? 3 : p >= 50 ? 2 : p >= 25 ? 1 : 0;
    return [`var(${steps[i]})`, i >= 3 ? "#fff" : "#0b0b0b"];
  }
  function renderCoverage(acc) {
    const types = typesList.map((t) => t[0]).filter((t) => acc.some((i) => A[i].type === t));
    const cols = [...types.map((t) => [t, (i) => A[i].type === t]), ["All", () => true]];
    const optional = ["LAND TYPE SECONDARY", "UNIQUE CHARACTERISTICS", "NEIGHBORHOOD"].map((k) => CAT_IX[k]).filter((x) => x != null);
    const rowsCis = [...M.core.map((k) => CAT_IX[k]), ...optional];
    const cell = (ids, has, ci, t) => {
      if (!ids.length) return `<td class="c">—</td>`;
      const n = ids.filter(has).length, p = pct(n, ids.length), [bg, fg] = seqColor(p);
      return `<td class="c" style="background:${bg};color:${fg}" data-ci="${ci}" ${t === "All" ? "" : `data-type="${esc(t)}"`} data-tip="<strong>${esc(t)}</strong><br>${fmt(n)} of ${fmt(ids.length)} have it<br>${fmt(ids.length - n)} missing — click to list">${p.toFixed(p > 99 && p < 100 ? 1 : 0)}%</td>`;
    };
    const byCol = cols.map(([, f]) => acc.filter(f));
    let html = `<thead><tr><th>Attribute</th>${cols.map(([t], k) => `<th class="c">${esc(t)}<br><span class="th-n">${fmt(byCol[k].length)}</span></th>`).join("")}</tr></thead><tbody>`;
    html += `<tr><td>Has land data <span class="muted">(excl. mobile homes &amp; condos)</span></td>${cols.map(([t], k) => cell(byCol[k].filter((i) => A[i].landExpected), (i) => A[i].hasLand, "land", t)).join("")}</tr>`;
    for (const ci of rowsCis) {
      const opt = optional.includes(ci);
      html += `<tr><td>${esc(CATS[ci].label)}${opt ? ` <span class="muted">(optional)</span>` : ""}</td>${cols.map(([t], k) => cell(byCol[k].filter((i) => A[i].hasLand), (i) => A[i].attrs[ci].length > 0, ci, t)).join("")}</tr>`;
    }
    $("coverage").innerHTML = html + "</tbody>";
  }
  function renderIssueSummary(acc) {
    const accSet = new Set(acc), counts = new Map();
    const bump = (ci, g) => { const r = counts.get(ci) || counts.set(ci, {}).get(ci); r[g] = (r[g] || 0) + 1; };
    for (const i of acc) for (const [ci, code] of A[i].flags) bump(ci, ISSUES[code].group);
    for (const o of outliers) if (accSet.has(o.a)) bump(o.ci, "outlier");
    const cis = CATS.map((c, ci) => ci).filter((ci) => counts.has(ci));
    const colMax = Object.fromEntries(ISSUE_COLS.map(([g]) => [g, Math.max(1, ...cis.map((ci) => counts.get(ci)[g] || 0))]));
    let html = `<thead><tr><th>Attribute</th>${ISSUE_COLS.map(([, l]) => `<th class="num">${l}</th>`).join("")}</tr></thead><tbody>`;
    for (const ci of cis) {
      const r = counts.get(ci);
      html += `<tr><td>${esc(CATS[ci].label)}</td>${ISSUE_COLS.map(([g]) => {
        const n = r[g] || 0;
        return `<td class="num">${n ? `<div class="bar-cell"><button class="linkbtn" data-issue="${g}" data-ci="${ci}">${fmt(n)}</button><span class="b" style="width:${Math.max(2, 60 * n / colMax[g])}px"></span></div>` : `<span class="muted">—</span>`}</td>`;
      }).join("")}</tr>`;
    }
    $("issue-summary").innerHTML = html + "</tbody>";
  }
  function renderDist() {
    const ci = S.distCi; const { counts, noVal } = valueCounts(ci);
    const landN = A.filter((a) => acctPass(a) && a.hasLand).length;
    let items = [...counts.entries()].sort((x, y) => y[1] - x[1]);
    const MAX = 40, extra = items.length - MAX; items = items.slice(0, MAX);
    const max = Math.max(1, noVal, ...items.map((x) => x[1]));
    const bar = (v, name, n, muted) => `<div class="name" title="${esc(name)}">${esc(name)}</div>
      <div class="track" data-v="${v}" data-tip="<strong>${esc(name)}</strong><br>${fmt(n)} accounts · ${pct(n, landN).toFixed(1)}% of accounts with land data<br>Click to view on map" style="cursor:pointer">
      <span class="fill" style="width:${(78 * n / max).toFixed(2)}%;${muted ? "background:var(--axis)" : ""}"></span><span class="val">${fmt(n)}</span></div>`;
    $("dist").innerHTML = items.map(([v, n]) => bar(v, VALUES[ci][v], n)).join("") + bar(NO_VALUE, "No value recorded", noVal, true) +
      (extra > 0 ? `<div></div><div class="val muted">+ ${extra} more values (see the map's value list)</div>` : "");
  }
  function reviewRows() {
    const { issue, ci, text, group } = S.review, rows = [];
    A.forEach((a, i) => {
      if (!acctPass(a)) return;
      for (const x of issuesFor(i)) {
        if (issue && x.code !== issue) continue;
        if (!issue && group && ISSUES[x.code].group !== group) continue;
        if (ci !== "" && x.ci !== +ci) continue;
        rows.push([i, x]);
      }
    });
    if (!text) return rows;
    return rows.filter(([i, x]) => { const a = A[i]; return (a.account + " " + a.parcel + " " + a.address + " " + a.subdivision + " " + a.area + " " + x.cat + " " + x.detail + " " + ISSUES[x.code].label).toLowerCase().includes(text); });
  }
  function renderReview() {
    const rows = reviewRows(), shown = rows.slice(0, S.review.limit);
    $("review-count").textContent = `${fmt(rows.length)} issue${rows.length === 1 ? "" : "s"} across ${fmt(new Set(rows.map((r) => r[0])).size)} accounts${S.review.group === "conflict" && !S.review.issue ? " (all data-conflict types)" : ""}.`;
    $("review").innerHTML = `<thead><tr><th>Account</th><th>Type</th><th>Area</th><th>Subdivision / address</th><th>Attribute</th><th>Issue</th><th>Detail</th><th></th></tr></thead><tbody>` +
      shown.map(([i, x]) => { const a = A[i]; return `<tr>
        <td class="nw"><a href="${RECORD_URL(a.account)}" target="_blank" rel="noopener">${esc(a.account)}</a></td>
        <td class="nw">${esc(a.type)}</td><td>${esc(a.area)}</td><td>${esc(a.subdivision || a.address)}</td><td>${esc(x.cat)}</td>
        <td class="code" data-tip="${esc(ISSUES[x.code].about)}">${esc(ISSUES[x.code].label)}</td><td>${esc(x.detail)}</td>
        <td class="nw">${a.fp >= 0 ? `<button class="linkbtn" data-go="${i}" data-ci="${x.ci}">Map →</button>` : ""}</td></tr>`; }).join("") + "</tbody>";
    $("more").hidden = rows.length <= shown.length;
    $("more").textContent = `Show more (${fmt(rows.length - shown.length)} remaining)`;
  }
  function exportReview() {
    const rows = reviewRows().map(([i, x]) => { const a = A[i]; return [a.account, a.parcel, a.type, a.improvedType, a.address, a.area, a.subdivision, x.cat, ISSUES[x.code].label, x.detail, RECORD_URL(a.account)]; });
    downloadCSV("land_attribute_review.csv", ["account", "parcel", "account_type", "property_type", "address", "area", "subdivision", "attribute", "issue", "detail", "county_record"], rows);
  }
  function goToIssue(i, ci) {
    const a = A[i];
    if (ci >= 0) { S.ci = ci; S.sel = new Map([[a.hasLand && a.attrs[ci].length ? a.attrs[ci][0] : NO_VALUE, 0]]); }
    else if (!a.hasLand) S.sel = new Map([[a.landExpected ? NO_LAND : NO_LAND_OK, 0]]);
    $("cat").value = S.ci; S.valueText = ""; $("value-filter").value = "";
    renderValues(); applyHighlight();
    location.hash = "#map";
    setTimeout(() => focusAccount(i), 50);
  }
  function focusAccount(i) {
    const a = A[i]; if (a.fp < 0) return;
    const go = () => { openDetail(a.fp, false, false, i); zoomToFps([a.fp], 17); };
    mapReady ? go() : whenReady.push(go);
  }

  // ------------------------------------------------------------------ about page
  function renderAbout() {
    const meta = M.meta || {};
    const when = meta.refreshedAt ? new Date(meta.refreshedAt).toLocaleString() : "unknown";
    $("about-data").innerHTML = [
      ["Data refreshed", when], ["Source", meta.source || "RealWare ListBuilder searches"],
      ["Accounts", `${fmt(A.length)} (${fmt(A.filter((a) => a.hasLand).length)} with land data)`],
      ["Accounts with a qualified sale (10 yrs)", fmt(A.filter((a) => a.sales.length).length)],
      ["Parcel shapes", fmt(GEO.length)],
    ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    $("about-checks").innerHTML = Object.values(ISSUES).map((x) => `<li><strong>${esc(x.label)}</strong> — ${esc(x.about)}</li>`).join("");
    fetch("version.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).then((v) => {
      if (!v) return;
      $("about-data").insertAdjacentHTML("afterbegin", `<dt>App version</dt><dd>${esc(v.version)} (${esc(v.commit)}, built ${esc(new Date(v.built).toLocaleDateString())})</dd>`);
    }).catch(() => {});
  }

  // ------------------------------------------------------------------ refresh (only when served by the county server program)
  function initRefresh() {
    const meta = M.meta || {};
    const asOf = () => (M.meta?.refreshedAt ? "Data as of " + new Date(M.meta.refreshedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
    $("data-asof").textContent = asOf();
    const btn = $("refresh");
    fetch("api/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject())).then((st) => {
      btn.hidden = false;
      if (st.running) poll(meta.refreshedAt);
    }).catch(() => { /* static hosting (e.g. local preview): no refresh endpoint */ });
    btn.onclick = async () => {
      btn.disabled = true; $("data-asof").textContent = "Starting refresh…";
      try {
        const r = await fetch("api/refresh", { method: "POST" });
        if (!r.ok && r.status !== 409) throw new Error("HTTP " + r.status);
        poll(meta.refreshedAt);
      } catch (e) { $("data-asof").textContent = "Refresh failed: " + e.message; btn.disabled = false; }
    };
    function poll(before) {
      btn.disabled = true;
      const tick = async () => {
        try {
          const st = await (await fetch("api/status", { cache: "no-store" })).json();
          if (st.running) { $("data-asof").textContent = `Refreshing… ${st.step || ""}`; return setTimeout(tick, 3000); }
          if (st.lastError) { $("data-asof").textContent = "Refresh failed: " + st.lastError; btn.disabled = false; return; }
          const sec = (t) => Math.floor(Date.parse(t) / 1000);   // compare as times: the two sources format fractions differently
          if (st.lastRefresh && sec(st.lastRefresh) !== sec(before)) { $("data-asof").textContent = "Loading new data…"; location.reload(); return; }
          $("data-asof").textContent = asOf(); btn.disabled = false;
        } catch { setTimeout(tick, 5000); }
      };
      tick();
    }
  }

  // ------------------------------------------------------------------ search
  let index = null;
  function buildIndex() {
    index = [];
    A.forEach((a, i) => index.push({ kind: "Account", label: a.account, sub: [a.address, a.type].filter(Boolean).join(" · "), text: `${a.account} ${a.parcel} ${a.address}`.toLowerCase(), i }));
    const subs = new Map();
    A.forEach((a, i) => { if (a.subdivision && a.fp >= 0) (subs.get(a.subdivision) || subs.set(a.subdivision, []).get(a.subdivision)).push(i); });
    for (const [s, ids] of subs) index.push({ kind: "Subdivision", label: s, sub: `${ids.length} accounts`, text: s.toLowerCase(), ids });
    for (const [kind, ci] of [["LEA", LEA_CI], ["Neighborhood", NBHD_CI]]) if (ci != null) VALUES[ci].forEach((name, v) => index.push({ kind, label: name, sub: "add to filter", text: name.toLowerCase(), ci, v }));
    for (const ar of areasList) index.push({ kind: "Area", label: ar, sub: "", text: ar.toLowerCase(), area: ar });
  }
  function initSearch() {
    const inp = $("search"), ul = $("search-results"); let results = [], on = 0;
    const run = () => {
      if (!index) buildIndex();
      const q = inp.value.trim().toLowerCase();
      if (q.length < 2) { ul.hidden = true; return; }
      const qd = q.replace(/[-\s]/g, ""), scored = [];
      for (const e of index) {
        let s = -1; const l = e.label.toLowerCase();
        if (l === q) s = 0; else if (l.startsWith(q)) s = 1;
        else if (/^\d{4,}$/.test(qd) && e.kind === "Account" && e.text.includes(qd)) s = 1;
        else if (e.text.includes(q)) s = e.kind === "Account" ? 3 : 2;
        if (s >= 0) scored.push([s, e]);
        if (scored.length > 400) break;
      }
      scored.sort((x, y) => x[0] - y[0] || (x[1].kind === "Account") - (y[1].kind === "Account"));
      results = scored.slice(0, 12).map((x) => x[1]); on = 0;
      ul.innerHTML = results.length ? results.map((e, k) => `<li data-k="${k}" class="${k === 0 ? "on" : ""}"><span class="k">${e.kind}</span>${esc(e.label)} <span class="s">${esc(e.sub)}</span></li>`).join("") : `<li class="s">No matches</li>`;
      ul.hidden = false;
    };
    const pick = (e) => {
      ul.hidden = true; inp.blur();
      if (currentPage() !== "map") location.hash = "#map";
      setTimeout(() => {
        if (e.kind === "Account") focusAccount(e.i);
        else if (e.kind === "Subdivision") zoomToAccounts(e.ids.map((i) => A[i]));
        else if (e.kind === "LEA" || e.kind === "Neighborhood") { (e.kind === "LEA" ? S.leas : S.nbhds).add(e.v); filtersChanged(); zoomToAccounts(A.filter(acctPass)); }
        else zoomToAccounts(A.filter((a) => a.area === e.area));
      }, 30);
    };
    inp.addEventListener("input", debounce(run, 90));
    inp.addEventListener("focus", run);
    inp.addEventListener("keydown", (ev) => {
      const lis = ul.querySelectorAll("li[data-k]");
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { on = (on + (ev.key === "ArrowDown" ? 1 : -1) + lis.length) % Math.max(1, lis.length); lis.forEach((l, k) => l.classList.toggle("on", k === on)); ev.preventDefault(); }
      if (ev.key === "Enter" && results[on]) pick(results[on]);
      if (ev.key === "Escape") ul.hidden = true;
    });
    ul.addEventListener("mousedown", (ev) => { const li = ev.target.closest("li[data-k]"); if (li) { ev.preventDefault(); pick(results[+li.dataset.k]); } });
    inp.addEventListener("blur", () => setTimeout(() => (ul.hidden = true), 150));
  }

  // keep the "zoom in to see labels" hint current
  addEventListener("load", () => { const t = setInterval(() => { if (map && mapReady) { map.on("zoomend", () => { $("label-note").hidden = !(S.labels.acct || S.labels.sale) || map.getZoom() >= LABEL_MINZOOM; }); clearInterval(t); } }, 500); });
})();
