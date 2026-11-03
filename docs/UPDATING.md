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
- **Between versions:** `https://github.com/Gunnison-County/GC-Assessor-RealWareDashboard/compare/v1.4...v1.5` shows the differences.

## Step 4: Deploy to the county server
On the server, in PowerShell **as Administrator**:

```powershell
C:\inetpub\LandAttributeDashboard\update.ps1
```

The script:
1. downloads the latest version from the county GitHub repository (using the saved token, below) and checks it against the release's `SHA256SUMS.txt`;
2. stops the dashboard's app pool;
3. copies the new program and website files into the site folder, keeping the settings file and data. It also keeps the server's own `web.config` and `appsettings.json` (so IIS rules, headers, logging and `AllowedHosts` survive). If this version's copy of either differs, it's saved alongside as `web.config.new` / `appsettings.json.new` for comparison;
4. starts the app pool again and prints the installed version. Add `-StatusUrl http://<site>/api/status` to also print the refresh status.

To install a **specific version**, or **roll back** to one, name it:

```powershell
C:\inetpub\LandAttributeDashboard\update.ps1 -Version v1.0
```

`update.ps1` comes inside every release package, so it's already in the site folder. If IT used a different folder or app-pool name, they can pass `-SiteDir` and `-AppPool`. The server doesn't need git or the .NET SDK.

### The GitHub token (one time, renewed yearly)
Releases come from `Gunnison-County/GC-Assessor-RealWareDashboard`, which is private, so the server needs a read-only GitHub token to download them.

1. **Create it:** GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token. Use a shared or service account if there is one, so it doesn't stop working when someone leaves.
   - **Resource owner:** Gunnison-County
   - **Repository access:** only `GC-Assessor-RealWareDashboard`
   - **Permissions:** Contents: *Read-only*. Nothing else.
   - **Expiration:** up to a year. Put a renewal reminder on the calendar.

   If the organization requires approval for fine-grained tokens, an org owner approves it under org Settings → Personal access tokens.
2. **Save it on the server:** in PowerShell as Administrator, run `update.ps1 -SetToken` and paste the token when asked. It's saved in `C:\ProgramData\LandAttributeDashboard\github-token.txt`, a folder only Administrators and SYSTEM can read, outside the website folder. The script then tests the token and prints the latest release it can see.
3. **When it expires,** `update.ps1` says so. Create a new token and run `update.ps1 -SetToken` again.

The server needs HTTPS access to `api.github.com` and to GitHub's download host, `release-assets.githubusercontent.com` (older downloads may use `objects.githubusercontent.com`).

**No token?** Download `LandAttributeDashboard.zip` and `SHA256SUMS.txt` from the release page in a browser signed in to GitHub, put them in the same folder, and run `update.ps1 -ZipPath <path to the zip>`. The checksum is still checked.

**Rolling back to v1.4 or earlier** puts that version's older `update.ps1` in the site folder, which downloads from the old personal repository and can't use the token. To update again afterwards, use `update.ps1` from the current county release page.

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
| `update.ps1` says the token wasn't accepted (401) | The token expired or was revoked. Create a new one and run `update.ps1 -SetToken`. |
| `update.ps1` says HTTP 403 or 404 with a token | The token isn't approved by the organization yet, or its repository access doesn't include `GC-Assessor-RealWareDashboard`. |
| Weekly refresh failed | Open `/api/status`; `lastError` says why, and the server log has the full details. The old data is still being shown. |
