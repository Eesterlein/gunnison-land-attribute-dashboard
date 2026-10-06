# How the Land Attribute Dashboard is built

This document explains how the dashboard works: where the data comes from, how it's cleaned, how the map stays fast, and how the server keeps the data current. It's meant for anyone maintaining or reviewing the code, including county IT.

- **Installing it:** [`HOSTING.md`](HOSTING.md)
- **Data sources:** [`DATA_REQUIREMENTS.md`](DATA_REQUIREMENTS.md)

---

## 1. Purpose

Appraisers use the dashboard to:

- see every parcel in Gunnison County on one map;
- light up the parcels carrying any land attribute and sub-attribute, optionally limited to chosen LEAs or neighborhoods;
- color parcels by several values at once (e.g. all five Views values);
- label parcels with account numbers and the most recent qualified sale in an appraisal period, and mark the parcels that sold;
- find accounts that are **missing** land attributes, have **conflicting** entries, or **don't match the properties around them**.

## 2. Big picture

```
┌──────────────────────┐   read-only    ┌──────────────────────────────┐   JSON files    ┌──────────────────────────┐
│ RealWare API         │◀──────────────│ LadServer (C#, .NET 10, IIS) │───────────────▶│ Browser dashboard        │
│ API (county network) │  5 saved       │ • weekly + on-demand refresh │  wwwroot/data/  │ • assets/data.js: model  │
│                      │  ListBuilder   │ • keeps needed columns only  │  raw/*.json     │ • assets/app.js: map, UI │
└──────────────────────┘  searches      │ • serves the website         │                 │ • MapLibre GL JS         │
                                        └──────────────────────────────┘                 └──────────────────────────┘
                     County GIS tax-parcel shapefile ──▶ scripts/build_geometry.py ──▶ data/parcels.geojson + data/geo_index.json
```

Two design choices keep it simple:

1. **The server is thin.** It fetches the saved searches, drops unused columns and old sales, and saves files. It doesn't interpret the data.
2. **All cleaning and analysis happen in the browser** (`assets/data.js`). The same front end works on the county server, on a laptop with test data, or as a static preview. A change to how the data is cleaned or shown is a front-end change only.

## 3. Data sources

| Source | How it arrives | Refresh |
|---|---|---|
| Five RealWare ListBuilder searches (`LAD - Accounts`, `Land Attributes`, `Land Details`, `Sales`, `Values`) | RealWare → server → `wwwroot/data/raw/*.json` | Weekly, plus the Refresh button |
| Tax-parcel shapes | County `Taxparcelassessor` shapefile → `scripts/build_geometry.py` | When GIS provides a new shapefile |

`config/searches.json` lists each search's query ID and the columns kept. It's the single place to change if a search is renamed, gets a new ID, or adds a column.

Saved files are JSON arrays of row objects keyed by the ListBuilder column names.

## 4. Parcel geometry (`scripts/build_geometry.py`)

The shapefile is in Colorado State Plane Central (US feet, EPSG:2232). The script:

1. **Repairs invalid polygons** and **simplifies** them by 1 ft, which is invisible on screen but makes the files much smaller.
2. **Collapses stacked condo units.** Condo units share one identical polygon, so 21,352 rows become about 17,500 unique shapes, and each shape lists all of its accounts.
3. **Finds neighbors** for each shape: every shape within **60 ft**, far enough to reach across a typical road. The consistency check uses these.
4. **Picks a label point** guaranteed to fall inside each shape, for the callouts and sale dots.
5. **Reprojects** to latitude/longitude (WGS84) with ~0.1 m precision.

It writes `data/parcels.geojson` (shapes only, ~1.5 MB compressed) and `data/geo_index.json`, which holds each shape's accounts, parcel numbers, bounding box, neighbors and label point.

Accounts link to shapes by **account number**, falling back to **parcel number**.

## 5. Building the data model (`assets/data.js`)

On page load the browser reads the five search outputs plus `geo_index.json` and builds one record per account:

- **Columns are matched loosely.** `Account #`, `ACCOUNT NO` and `ACCOUNTNO` are all recognized, so small renames in ListBuilder don't break the app. Unmatched columns are logged to the browser console.
- **Land attributes:** each `Attribute Type` becomes a category and each `Attribute Sub Type` a value. **New attribute types appear automatically.** Known types get friendly labels and a fixed order and grouping; unknown ones are listed under "Other".
- **LEA** (from Land Details, as `code: description`) and **Neighborhood** (from Accounts) are treated as categories too, so they can be filters, colored on the map, or checked for consistency like any other attribute.
- **"No land line expected":** mobile home accounts (account number starts with `M`) and condo units normally have no land line. They aren't flagged as missing land data, and they have their own map category.
- **Qualified sales:** a sale counts when `TYPE OF TRANSACTION` contains `QUALIFIED`. Sales are kept newest first, with sale price and adjusted sale price.

The full county loads and builds in about half a second.

## 6. Review checks

| Check | Rule |
|---|---|
| **Missing** | A core attribute is blank: LEA, Land Type Primary, Views, Site Access road type, Site Access maintenance, Electricity, Sewer, Water. |
| **More than one value** | Land Type Primary or Secondary, or Views, holds two or more different values. |
| **Conflicting utilities** | Electricity has more than one status (e.g. INSTALLED + NOT AVAILABLE). Sewer has two systems, ignoring "central available near site". Water mixes NOT INSTALLED with installed, or repeats a system, ignoring "storage tank". |
| **Secondary = primary** | Secondary land type is the same as primary. |
| **Legacy access code only** | Site Access holds only the old `YEAR ROUND` / `SEASONAL` codes. |
| **Improved, utility shows none** | Residential, condo, commercial or mobile-home improvement worth more than $0, but a utility says none / not installed / not available. Off-grid counts as having it. |
| **No land data** | No land attributes or LEA at all (mobile homes and condos excluded). |
| **Not on parcel map** | No shape matches the account or parcel number. |
| **Differs from neighbors** | See below. |

### Neighborhood consistency

For each account and each core attribute, the app collects the values held by **comparables**:

- **"Adjacent parcels" mode:** accounts on shapes within 60 ft, plus other units in the same condo stack.
- **"Same subdivision" mode:** other accounts in the subdivision.

**For utilities, vacant lots are compared only with vacant lots and improved with improved.** A vacant lot legitimately reads "sewer to site, not yet installed" while its built neighbors read "installed".

If at least **N comparables** (default 4) have a value and **X%** of them agree (default 75%), then:

- an account with a *different* value is flagged **Differs from neighbors**;
- an account with *no* value gets the consensus added to its **Missing** flag, e.g. "6 of 6 neighbors have PAVED ACCESS".

N, X and the comparison mode can be changed on the Review & Stats page. The red map outline shows these flags, plus conflicting entries, for the selected attribute.

## 7. Appraisal periods

Gunnison County reappraises every odd year, with values as of **June 30 of the prior year**, using a minimum of **24 months** of sales ([county source](https://www.gunnisoncounty.org/665/Assessment-Process)). For reappraisal year *Y*, the period runs from **July 1 of Y−3 through June 30 of Y−1**. For 2027 that's 7/1/2024 – 6/30/2026.

The selector lists recent and in-progress cycles. It can extend the start back in 6-month steps, as the county may do when sales are thin. The sale callouts, sold-parcel dots and parcel card all use the selected period.

## 8. Why the map is fast

- **One GeoJSON source, never rebuilt.** Choosing an attribute, value, filter or color doesn't reload or retile any geometry. The app computes a small state number per shape and pushes it with MapLibre's `setFeatureState`, which the GPU applies to styling:
  - 0 = no data / filtered out
  - 1 = other value
  - 2–7 = color slots
  - 8 = multiple selected values

  Only shapes whose state changed are updated.
- **Callouts and sale dots** are lightweight point layers, rebuilt only when their options change. Callouts appear from zoom 14 up, and MapLibre drops overlapping labels automatically.
- **Small transfers:** after trimming, all data is about 1.6 MB compressed, and the server compresses responses.
- **Colors:** six slots from a palette checked for colorblind distinguishability. Red is reserved for the review outline, and a neutral color marks "multiple". A legend always lists what each color means.

## 9. The server (`server/`)

An ASP.NET Core minimal app with two source files.

**`Program.cs`** serves `wwwroot/` (the dashboard) with compression, and tells browsers to check for newer data on each load. It exposes:

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | `{ running, step, lastRefresh, lastDurationSeconds, lastError }` |
| `POST /api/refresh` | Starts a refresh. Returns 202, or 409 if one is running or ran in the last 5 minutes. |

**`Refresher.cs`** runs the refresh in these steps:

1. Sign in to RealWare with the configured account.
2. Run each saved search listed in `config/searches.json` and collect its rows.
3. Keep only the configured columns. For sales, drop rows older than `salesYearsToKeep` (10 years).
4. **Safety checks before saving anything:**
   - every search must succeed;
   - none may return zero rows;
   - none may reach the configured row limit (which would mean the results were cut off);
   - none may shrink below 50% of its previous size.
5. Write each file to a temporary name and swap it in, then write `meta.json` (time and row counts).

A failed refresh never touches the existing data. The error appears in `/api/status` and the server logs.

The weekly schedule (`WeeklySchedule`) runs Sunday at 2:00 AM by default, and once at startup if no data exists yet.

**Security:**

- The RealWare login is only in `appsettings.Production.json` or app-pool environment variables on the server.
- Only `wwwroot/` is web-accessible.
- The program never changes RealWare data.
- The API address is never in this repository.

## 10. Technology choices

| Choice | Why |
|---|---|
| Plain HTML/JS/CSS, no build step | Nothing to compile on the front end; easy for IT to read and review. |
| MapLibre GL JS 4.x | Open source, GPU-rendered vector map; handles ~17,500 parcels smoothly. |
| Esri basemaps (light/dark gray, satellite, topo) | No API key needed. |
| ASP.NET Core on IIS | Fits a county Windows server; one small program, one settings file. |
| Python + geopandas (geometry only) | Run occasionally on a workstation when parcel shapes change, not on the server. |

## 11. Working on it without county access

| Tool | What it does |
|---|---|

See the README for commands, and [`UPDATING.md`](UPDATING.md) for how changes get from development to the county server.

## 12. History

This project grew out of the [public-data demo](https://github.com/Eesterlein/gunnison-land-attributes-demo), which used the county's public download files and GitHub Pages. That demo is unchanged. This edition replaces the downloads with live RealWare data, and adds:

- LEA and neighborhood filters
- multi-value coloring
- account and sale callouts
- appraisal periods and sold-parcel markers
- the server program
