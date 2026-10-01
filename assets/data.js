/* Data layer: reads the LAD ListBuilder search output (data/raw/*.json, saved by the
   server program) plus the parcel geometry index, and builds the dashboard's model.
   All cleaning happens here so the server only has to fetch and save. */
(() => {
  "use strict";

  // Known attribute types: [RealWare Attribute Type, label, group]. Order = picker order.
  // Any type not listed here still appears automatically, under "Other".
  const KNOWN = [
    ["LEA", "Land Economic Area (LEA)", "Classification"],
    ["NEIGHBORHOOD", "Neighborhood", "Classification"],
    ["LAND TYPE PRIMARY", "Land Type – Primary", "Land Type"],
    ["LAND TYPE SECONDARY", "Land Type – Secondary", "Land Type"],
    ["TREE TYPE", "Tree Type", "Land Type"],
    ["VIEWS", "Views", "Site"],
    ["UNIQUE CHARACTERISTICS", "Unique Characteristics", "Site"],
    ["SITE ACCESS", "Site Access – Road Type", "Access"],
    ["SITE ACCESS MAINTENANCE", "Site Access – Maintenance", "Access"],
    ["SITE IMPROVEMENTS", "Site Improvements", "Access"],
    ["ELECTRICITY", "Electricity", "Utilities"],
    ["SEWER", "Sewer", "Utilities"],
    ["WATER", "Water", "Utilities"],
    ["EASEMENT", "Easement", "Restrictions"],
    ["DEED RESTRICTED", "Deed Restricted", "Restrictions"],
    ["MINING DISTRICT", "Mining District", "Other"],
    ["ARROWHEAD", "Arrowhead Lot Attributes", "Other"],
  ];
  // Attributes every account with land data is expected to carry (blank = "Missing").
  const CORE = ["LEA", "LAND TYPE PRIMARY", "VIEWS", "SITE ACCESS", "SITE ACCESS MAINTENANCE",
                "ELECTRICITY", "SEWER", "WATER"];
  const SINGLE = ["LAND TYPE PRIMARY", "LAND TYPE SECONDARY", "VIEWS"];
  const LEGACY_ACCESS = new Set(["YEAR ROUND", "SEASONAL"]);
  const ELECTRIC_STATUS = new Set(["INSTALLED", "NOT INSTALLED AVAILABLE NEAR SITE", "NO", "NOT AVAILABLE", "TO SITE"]);
  const NO_UTILITY = {
    ELECTRICITY: new Set(["NO", "NOT AVAILABLE", "NOT INSTALLED AVAILABLE NEAR SITE", "TO SITE"]),
    WATER: new Set(["NONE", "NOT INSTALLED", "DOMESTIC TO SITE NOT YET INSTALLED", "DOMESTIC AVAILABLE NEAR SITE"]),
    SEWER: new Set(["NONE", "ISDS ALLOWED NOT INSTALLED", "CENTRAL TO SITE NOT YET INSTALLED",
                    "CENTRAL AVAILABLE NEAR SITE", "ISDS NOT ALLOWED", "CENTRAL NOT AVAILABLE"]),
  };
  const IMPROVED_TYPES = new Set(["Residential", "Condo", "Commercial", "Mobile Home"]);

  // Column aliases as returned by the API, matched loosely (case/punctuation-insensitive)
  // so small renames in ListBuilder don't break the app.
  const FIELDS = {
    accounts: { account: ["ACCOUNT", "ACCOUNTNO"], type: ["ACCOUNTTYPE", "ACCTTYPE"], parcel: ["PARCEL", "PARCELNO"],
                improvedType: ["PROPERTYTYPE"], address: ["PROPERTYADDRESS"], area: ["PROPERTYAREA"],
                econ: ["ECONOMICAREA", "ECONOMICAREACODE"], subdivision: ["SUBDIVISION", "SUBDNAME"],
                condo: ["CONDO", "CONDONAME"], nbhdCode: ["NEIGHBORHOODCODE", "NBHDCODE"], nbhd: ["NEIGHBORHOOD", "NBHDDESCRIPTION"] },
    land_attributes: { account: ["ACCOUNT", "ACCOUNTNO"], type: ["ATTRIBUTETYPE"], sub: ["ATTRIBUTESUBTYPE"] },
    land_details: { account: ["ACCOUNT", "ACCOUNTNO"], lea: ["DEFAULTLEA", "LEA"], leaDesc: ["LEADESCRIPTION"],
                    acres: ["GROSSACRES"], sf: ["GROSSSQUAREFEET"] },
    sales: { account: ["ACCOUNTNO", "ACCOUNT"], reception: ["RECEPTIONNO"], deed: ["DEEDDESCRIPTION"], date: ["SALEDATE"],
             price: ["SALEPRICE"], adj: ["ADJUSTEDSALEPRICE"], vacantImproved: ["VACANTORIMPROVEDATTIMEOFSALE"],
             txn: ["TYPEOFTRANSACTION"], invalid: ["INVALIDSALEREASON"] },
    values: { account: ["ACCOUNTNO", "ACCOUNT"], land: ["LANDACTUAL"], imp: ["IMPSACTUAL", "IMPROVEMENTSACTUAL"], total: ["TOTALACTUAL"] },
  };

  const norm = (k) => String(k).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const str = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : null; };
  const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

  /** Map raw rows to canonical field names using FIELDS[name]. */
  function pick(rows, name) {
    if (!rows.length) return [];
    const keys = Object.keys(rows[0]);
    const byNorm = Object.fromEntries(keys.map((k) => [norm(k), k]));
    const map = Object.entries(FIELDS[name]).map(([field, alts]) => [field, alts.map((a) => byNorm[a]).find(Boolean)]);
    const missing = map.filter(([, k]) => !k).map(([f]) => f);
    if (missing.length) console.warn(`[LAD] ${name}: column(s) not found for`, missing.join(", "), "— have", keys.join(", "));
    return rows.map((r) => { const o = {}; for (const [f, k] of map) o[f] = k ? r[k] : undefined; return o; });
  }

  function parseDate(v) {
    const s = str(v);
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    return null;
  }

  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  async function load() {
    const [geoIdx, meta, acctRaw, attrRaw, detRaw, salesRaw, valRaw] = await Promise.all([
      getJSON("data/geo_index.json"), getJSON("data/raw/meta.json").catch(() => ({})),
      getJSON("data/raw/accounts.json"), getJSON("data/raw/land_attributes.json"),
      getJSON("data/raw/land_details.json"), getJSON("data/raw/sales.json"), getJSON("data/raw/values.json"),
    ]);
    const GEO = geoIdx.footprints;

    // ---------------- accounts (base list)
    const A = []; const ix = new Map();
    const getAcct = (acct) => {
      acct = str(acct); if (!acct) return null;
      let i = ix.get(acct);
      if (i == null) {
        i = A.length; ix.set(acct, i);
        A.push({ account: acct, type: "", parcel: "", improvedType: "", address: "", area: "", econ: "", subdivision: "",
                 condo: "", nbhdCode: "", nbhd: "", landValue: null, impValue: null, totalValue: null,
                 acres: 0, raw: new Map(), sales: [], flags: [], inAccounts: false });
      }
      return A[i];
    };
    for (const r of pick(acctRaw, "accounts")) {
      const a = getAcct(r.account); if (!a) continue;
      Object.assign(a, { type: str(r.type), parcel: str(r.parcel).replace(/\D/g, ""), improvedType: str(r.improvedType),
        address: str(r.address), area: str(r.area), econ: str(r.econ), subdivision: str(r.subdivision), condo: str(r.condo),
        nbhdCode: str(r.nbhdCode), nbhd: str(r.nbhd), inAccounts: true });
    }
    for (const r of pick(valRaw, "values")) {
      const a = ix.has(str(r.account)) ? A[ix.get(str(r.account))] : null; if (!a) continue;
      a.landValue = num(r.land); a.impValue = num(r.imp); a.totalValue = num(r.total);
    }

    // ---------------- land attributes (one row per attribute) → raw type → [subtypes]
    const add = (a, type, sub) => { if (!a || !type || !sub) return; (a.raw.get(type) || a.raw.set(type, []).get(type)).push(sub); };
    for (const r of pick(attrRaw, "land_attributes")) add(getAcct(r.account), str(r.type).toUpperCase(), str(r.sub).toUpperCase());
    for (const r of pick(detRaw, "land_details")) {
      const a = getAcct(r.account); if (!a) continue;
      const code = str(r.lea), desc = str(r.leaDesc);
      if (code || desc) add(a, "LEA", code && desc ? `${code}: ${desc}` : code || desc);
      a.acres += num(r.acres) || 0;
    }
    for (const a of A) if (a.nbhd || a.nbhdCode) add(a, "NEIGHBORHOOD", a.nbhdCode && a.nbhd ? `${a.nbhdCode}: ${a.nbhd}` : a.nbhd || a.nbhdCode);

    // ---------------- categories & value dictionaries
    const present = new Set(); for (const a of A) for (const t of a.raw.keys()) present.add(t);
    const known = KNOWN.filter(([k]) => present.has(k)).map(([key, label, group]) => ({ key, label, group }));
    const extra = [...present].filter((t) => !KNOWN.some(([k]) => k === t)).sort()
      .map((t) => ({ key: t, label: titleCase(t), group: "Other" }));
    const CATS = [...known, ...extra];
    const CAT_IX = Object.fromEntries(CATS.map((c, i) => [c.key, i]));
    const counts = CATS.map(() => new Map());
    for (const a of A) for (const [t, subs] of a.raw) for (const s of new Set(subs)) counts[CAT_IX[t]].set(s, (counts[CAT_IX[t]].get(s) || 0) + 1);
    const VALUES = counts.map((m) => [...m.entries()].sort((x, y) => y[1] - x[1]).map(([v]) => v));
    const VIX = VALUES.map((vs) => new Map(vs.map((v, i) => [v, i])));
    const nonLandCats = new Set([CAT_IX.NEIGHBORHOOD]);

    // ---------------- per-account attributes + data checks
    const coreCis = CORE.map((k) => CAT_IX[k]).filter((x) => x != null);
    for (const a of A) {
      a.attrs = CATS.map((c, ci) => [...new Set(a.raw.get(c.key) || [])].map((v) => VIX[ci].get(v)));
      a.hasLand = [...a.raw.keys()].some((t) => !nonLandCats.has(CAT_IX[t]));
      a.landExpected = !(a.account.startsWith("M") || a.improvedType === "Condo" || a.condo);
      const vals = (k) => (CAT_IX[k] == null ? [] : a.attrs[CAT_IX[k]].map((v) => VALUES[CAT_IX[k]][v]));
      const flag = (k, code, detail = "") => { if (CAT_IX[k] != null) a.flags.push([CAT_IX[k], code, detail]); };
      if (a.hasLand) {
        for (const ci of coreCis) if (!a.attrs[ci].length) a.flags.push([ci, "missing", ""]);
        for (const k of SINGLE) { const v = vals(k); if (v.length > 1) flag(k, "multiple", v.join(" / ")); }
        const p = vals("LAND TYPE PRIMARY"), s = vals("LAND TYPE SECONDARY");
        if (p.length === 1 && s.length === 1 && p[0] === s[0]) flag("LAND TYPE SECONDARY", "same_as_primary", p[0]);
        const es = vals("ELECTRICITY").filter((v) => ELECTRIC_STATUS.has(v));
        if (es.length > 1) flag("ELECTRICITY", "conflict", es.join(" / "));
        const sw = vals("SEWER"); if (sw.filter((v) => v !== "CENTRAL AVAILABLE NEAR SITE").length > 1) flag("SEWER", "conflict", sw.join(" / "));
        const wt = vals("WATER"), wt2 = wt.filter((v) => v !== "STORAGE TANK");
        if (wt2.length > 1 && (wt2.includes("NOT INSTALLED") || new Set(wt2.map((w) => w.split(" ")[0])).size < wt2.length)) flag("WATER", "conflict", wt.join(" / "));
        const acc = vals("SITE ACCESS"); if (acc.length && acc.every((v) => LEGACY_ACCESS.has(v))) flag("SITE ACCESS", "legacy", acc.join(", "));
        if (IMPROVED_TYPES.has(a.improvedType) && (a.impValue || 0) > 0) {
          for (const [k, none] of Object.entries(NO_UTILITY)) {
            const v = vals(k);
            if (v.length && v.every((x) => none.has(x)) && !v.some((x) => x.startsWith("OFF GRID"))) flag(k, "improved_no_utility", `${a.improvedType}: ${v.join(" / ")}`);
          }
        }
      }
      delete a.raw;
    }

    // ---------------- qualified sales, newest first
    for (const r of pick(salesRaw, "sales")) {
      const a = ix.has(str(r.account)) ? A[ix.get(str(r.account))] : null; if (!a) continue;
      if (!/QUALIFIED/i.test(str(r.txn))) continue;
      const d = parseDate(r.date); if (!d) continue;
      a.sales.push({ date: d, price: num(r.price), adj: num(r.adj), reception: str(r.reception), deed: str(r.deed),
                     vacantImproved: str(r.vacantImproved) });
    }
    for (const a of A) a.sales.sort((x, y) => y.date - x.date);

    // ---------------- link to parcel shapes (account first, parcel number fallback)
    const fpByAcct = new Map(), fpByParcel = new Map();
    GEO.forEach(([accts, parcels], i) => { for (const x of accts) if (!fpByAcct.has(x)) fpByAcct.set(x, i);
                                           for (const p of parcels) if (!fpByParcel.has(p)) fpByParcel.set(p, i); });
    const fpAccts = GEO.map(() => []);
    A.forEach((a, i) => { a.fp = fpByAcct.get(a.account) ?? fpByParcel.get(a.parcel) ?? -1; if (a.fp >= 0) fpAccts[a.fp].push(i); });
    for (const a of A) if (!a.type) a.type = "Unknown";

    return { meta, A, GEO, fpAccts, CATS, CAT_IX, VALUES, core: CORE.filter((k) => CAT_IX[k] != null),
             neighborCats: CORE.filter((k) => CAT_IX[k] != null) };
  }

  window.LADData = { load };
})();
