# Changelog

Each version is tagged on GitHub and has an install package under **Releases**. To install one on the county server: `update.ps1 -Version <version>`.

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
