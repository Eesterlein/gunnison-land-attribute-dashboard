# Changelog

Each version is tagged on GitHub and has an install package under **Releases**. To install one on the county server: `update.ps1 -Version <version>`.

## v1.2 (unreleased)

Security fixes from the County IT code review (2026-10-13). No changes to what the dashboard shows.

> **Before updating a server that reaches RealWare over `http://`:** this version refuses an `http://` RealWare address by default, so the RealWare password isn't sent unencrypted. Until RealWare has HTTPS, add `"AllowInsecureHttp": true` under `"Realware"` in `appsettings.Production.json`, or refreshes will fail. `update.ps1` prints a warning if this applies.

- **Refresh limits (H3):** every refresh *attempt* now counts toward the 5-minute gap, not just successful ones. After a failed RealWare sign-in, the Refresh button pauses for 15 minutes, then 30, 60 and so on up to 4 hours, so repeated clicks can't lock the account. A successful sign-in resets it. The button shows how long to wait.
- **Tooltips (M2):** hover tips are built as plain text, so a value stored in RealWare can never run as code in the browser.
- **HTTPS (M3):** an `http://` RealWare address is refused unless `Realware:AllowInsecureHttp` is set to `true`. `IgnoreCertificateErrors` stays off by default.
- **Map library (M4):** MapLibre GL JS 4.7.1 now ships with the dashboard (`assets/vendor/`) instead of loading from unpkg.com.
- **Error messages (L1):** `/api/status` shows plain-language messages only. Full error details, which can include the RealWare host and port, go to the server log.
- **CSV export (L2):** cells that start with `=`, `+`, `-` or `@` get a leading `'` so Excel can't run them as formulas.
- **Host names (L4):** `install.ps1 -HostName <name>` also sets `AllowedHosts` to that name.
- **Installer (L5, L10):** checks the correct ASP.NET Core Module path, and never copies `wwwroot\data\raw` from a package.
- **Search settings (L7):** `searches.json` moved from `wwwroot\config\` to `config\` next to the program, so it's never web-accessible. `update.ps1` removes the old copy.
- **Releases (H1):** GitHub Actions are pinned to exact commits, and each release includes `SHA256SUMS.txt`.

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
