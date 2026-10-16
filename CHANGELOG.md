# Changelog

Each version is tagged on GitHub and has an install package under **Releases**. To install one on the county server: `update.ps1 -Version <version>`.

## v1.2 (2026-10-15)

Security fixes from the County IT code review (2026-10-13), a reorganized map sidebar, and new sales filters.

> **Before updating a server that reaches RealWare over `http://`:** this version refuses an `http://` RealWare address by default, so the RealWare password isn't sent unencrypted. Until RealWare has HTTPS, add `"AllowInsecureHttp": true` under `"Realware"` in `appsettings.Production.json`, or refreshes will fail. `update.ps1` prints a warning if this applies.

- **Refresh limits (H3):** every refresh *attempt* now counts toward the 5-minute gap, not just successful ones. After a failed RealWare sign-in, the Refresh button pauses for 15 minutes, then 30, 60 and so on up to 4 hours, so repeated clicks can't lock the account. A successful sign-in resets it. The button shows how long to wait.
- **Tooltips (M2):** hover tips are built as plain text, so a value stored in RealWare can never run as code in the browser.
- **HTTPS (M3):** an `http://` RealWare address is refused unless `Realware:AllowInsecureHttp` is set to `true`. `IgnoreCertificateErrors` stays off by default.
- **Map library (M4):** MapLibre GL JS 4.7.1 now ships with the dashboard (`assets/vendor/`) instead of loading from unpkg.com.
- **Error messages (L1):** `/api/status` shows plain-language messages only. Full error details, which can include the RealWare host and port, go to the server log.
- **CSV export (L2):** cells that start with `=`, `+`, `-` or `@` get a leading `'` so Excel can't run them as formulas.
- **Host names (L4):** `install.ps1 -HostName <name>` also sets `AllowedHosts` to that name.
- **Installer (L5, L10):** checks the correct ASP.NET Core Module path, and never copies `wwwroot\data\raw` from a package.
- **Updates keep server customizations:** `update.ps1` and `install.ps1` no longer overwrite an existing `web.config` or `appsettings.json`, so IIS rules, security headers, logging and `AllowedHosts` survive updates. If a new version's copy differs, it's saved as `web.config.new` / `appsettings.json.new`. `update.ps1` is also attached to each release. **For this update from v1.1:** run the `update.ps1` downloaded from the v1.2 release page, because the copy already in the site folder is the old one that overwrites both files.
- **Search settings (L7):** `searches.json` moved from `wwwroot\config\` to `config\` next to the program, so it's never web-accessible. `update.ps1` removes the old copy.
- **Releases (H1):** GitHub Actions are pinned to exact commits, and each release includes `SHA256SUMS.txt`.

**Map sidebar**

- **New order, as numbered steps:** 1 Area → 2 Account type → 3 Land attribute → 4 Sales → 5 Map display. Every existing feature is still there.
- **Collapsible:** each step folds up and shows a one-line summary in its header; the « button hides the whole sidebar for a full-width map. The browser remembers the layout.
- **Live count** at the top: accounts and parcels in the selected area and account types.
- **Property area filter** (Gunnison, Mt Crested Butte, Marble, Pitkin, …) next to LEA and neighborhood, on the map and on Review & Stats. Picking an area zooms the map there; **Back to area** returns to it after you've moved around, and **Whole county** clears the area filters and zooms out. Searching for an area in the top search box now adds it to the filter.
- **Legend** moved onto the map.

**Sales**

- **Qualified level:** each qualified sale shows **Q1**, **Q2** or **Q1 + Q2** in callouts and the parcel card; Q2 sales also show their reason (e.g. remodel after sale). Filter: Q1 + Q2 / Q1 only / Q2 only.
- **Analysis type** filter (e.g. MH Affixed, MH Titled).
- Sale dots, sale callouts, the parcel card and the "Download list" CSV all follow these filters. The CSV adds property area, qualified level, analysis type and Q2 reason.
- **Data:** LAD - Sales (43636) now also returns `VALID 1 FLAG`, `VALID 2 FLAG` and `ANALYSIS TYPE`. Same query ID.

## v1.1 (2026-10-12)

- **Data:** points the app at the new saved ListBuilder searches: LAD - Accounts 43632, Land Attributes 43633, Land Details 43634, Sales 43636, Values 43637. No other changes. Updating keeps the existing RealWare connection settings.

## v1.0 (2026-10-01)

First release of the RealWare edition.

- **Data:** reads five saved ListBuilder searches (LAD - Accounts, Land Attributes, Land Details, Sales, Values) from RealWare. Refreshes weekly (Sunday 2 AM), on first start, and from the **Refresh** button. Read-only, with safety checks that keep the previous data if a refresh looks wrong.
- **Map:** every parcel in the county, with:
  - any land attribute and sub-attribute lit up;
  - **Color all values**, or up to 6 chosen values, each in its own color;
  - LEA and neighborhood multi-select filters that zoom to the selection;
  - a red outline for parcels that don't match their neighbors or have conflicting entries;
  - light, satellite and topo basemaps.
- **Sales:** appraisal-period selector (2027 reappraisal: 7/1/2024 – 6/30/2026, extendable in 6-month steps), dots on parcels with a qualified sale in the period, and callouts with sale date, sale price and adjusted sale price.
- **Callouts:** account numbers.
- **Review & Stats:** attribute coverage by account type, neighborhood consistency, value distributions, and a review list with CSV export.
- **Server:** ASP.NET Core (.NET 10) for IIS, with `install.ps1` (one-command install; asks for the RealWare address, username and password) and `update.ps1` (one-command updates and rollbacks).
