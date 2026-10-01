# Updating the dashboard: from suggestion to running at work

## The short version

```
Suggestion ──▶ change + test in development ──▶ push to GitHub ──▶ run update.ps1 on the county server
                (full-county test data)            (IT can review)     (~2 minutes; API connection untouched)
```

**You never need to remove or redo the RealWare connection to update the app.** The connection (API address, login, password) lives only in `appsettings.Production.json` on the county server, and the data in `wwwroot\data\raw\`. The update script replaces the program and website files but **never touches those two**. After an update the dashboard comes back already connected, with its data intact.

---

## Step 1: Collect suggestions
Keep a running list. For each one, note what to change and an example account or area, e.g. *"In CB South, show the LEA in the parcel tooltip."*

## Step 2: Make and test the change in development
The change is made in a development copy of the project and tested with the full-county test data, including a test run of the server program if it changed. Then:

1. a line describing it is added to [`CHANGELOG.md`](../CHANGELOG.md);
2. it is pushed to GitHub and tagged as a version (e.g. `v1.1`). GitHub builds the install package automatically (about 2 minutes); it appears under **Releases**.

**If a change needs new data from RealWare** (for example, a new column), the LAD search is updated in ListBuilder first, then the new version is deployed.

## Step 3: IT reviews (if they want to)
Every change is visible on GitHub:

- **One version:** the **Commits** list shows what changed.
- **Between versions:** `https://github.com/Eesterlein/gunnison-land-attribute-dashboard/compare/v1.0...v1.1` shows the differences.

## Step 4: Deploy to the county server
On the server, in PowerShell **as Administrator**:

```powershell
C:\inetpub\LandAttributeDashboard\update.ps1
```

The script:
1. downloads the latest version from GitHub;
2. stops the dashboard's app pool;
3. copies the new program and website files into the site folder, keeping the settings file and data;
4. starts the app pool again and prints the installed version. Add `-StatusUrl http://<site>/api/status` to also print the refresh status.

To install a **specific version**, or **roll back** to one, name it:

```powershell
C:\inetpub\LandAttributeDashboard\update.ps1 -Version v1.0
```

`update.ps1` comes inside every release package, so it's already in the site folder. If IT used a different folder or app-pool name, they can pass `-SiteDir` and `-AppPool`. The server only needs HTTPS access to github.com; it doesn't need git or the .NET SDK.

## Step 5: Check it
- Reload the dashboard with **Ctrl + F5** so the browser fetches the new files.
- The **About** page shows the version that's running and when it was built.

---

## Common situations

| Situation | What to do |
|---|---|
| Visual or behavior change (map, colors, labels, checks, stats) | Steps 2 → 4. No RealWare changes needed. |
| Need a new column or data from RealWare | Add it to the LAD search in ListBuilder, then Steps 2 → 4 (`config/searches.json` gets updated). |
| New parcel shapefile from GIS | Rebuild `data/parcels.geojson` + `data/geo_index.json` with `scripts/build_geometry.py`, then Steps 2 → 4. |
| An update caused a problem | Roll back: `update.ps1 -Version <previous version>`. Then fix it here. |
| RealWare password changed | Not an update. IT edits `appsettings.Production.json` and restarts the app pool. Until then, refreshes fail with "RealWare sign-in failed" and the last good data stays on screen. |
| Weekly refresh failed | Open `/api/status`; `lastError` says why. The old data is still being shown. |
