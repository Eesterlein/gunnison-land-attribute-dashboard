# Hosting guide: Land Attribute Dashboard on the county's internal server

This guide installs the dashboard on a Windows server running IIS. It is written so an IT administrator, or an AI assistant helping one, can follow it top to bottom.

> **Note for an AI assistant helping with this install:** the quickest path is Step 0 → Step 1 → Step 2 (the installer) → Step 5. Otherwise, work through the steps in order. Ask the administrator for the values in **Step 0** rather than guessing them. Never put the RealWare password into a file that is committed to Git; Step 4 shows where it goes. Each step ends with a check: confirm it passes before moving on.

---

## What this is

One small ASP.NET Core (.NET 10) program, `LadServer`. It:

1. **Serves the dashboard** (static HTML/JS/CSS plus data files) to staff browsers.
2. **Refreshes the data** once a week (default Sunday 2:00 AM server time), when someone clicks **Refresh**, and on first start. To refresh it:
   - signs in to RealWare with the configured account
   - runs five saved ListBuilder searches
   - saves the results as JSON files in `wwwroot\data\raw\`

**It is read-only.** It never creates, changes or deletes anything in RealWare. The searches it runs are listed in `wwwroot\config\searches.json` (query IDs 43623, 43625, 43626, 43627, 43628).

**Safety rails:** a refresh only replaces the saved data if every search succeeds. If any search fails, returns nothing, hits the row limit, or returns less than half its previous row count, the old data stays in place and the error appears at `/api/status`.

```
Staff browser ──HTTP(S)──▶ IIS ─▶ LadServer ──HTTP(S)──▶ RealWare API (internal)
     │                                        └── writes wwwroot\data\raw\*.json
     └──HTTPS──▶ unpkg.com (map library), server.arcgisonline.com (basemaps),
                 protomaps.github.io (label fonts), property.spatialest.com (record links)
```

---

## Step 0: Information to gather first

| Item | Example | Who knows it |
|---|---|---|
| RealWare API address | provided by the Assessor's Office | Assessor's Office |
| RealWare username and password the app signs in with | the assessor staff member who owns the LAD searches | Assessor's office |
| Sign-in grant type | `password` (the default; change only if told otherwise) | Assessor's Office |
| Server and folder to install to | `C:\inetpub\LandAttributeDashboard` | IT |
| Site address staff will use | `http://landattributes.county.local` or a port on an existing site | IT |

The LAD searches are saved under one RealWare user and are **not shared**, so the app must sign in as that same user.

**Check:** open the RealWare API address in a browser on this server. If it doesn't respond, the server can't reach the API, so fix networking first.

---

## Step 1: Install prerequisites on the server

1. **IIS**, with the **Application Initialization** feature: Server Manager → Add Roles and Features → Web Server (IIS) → Web Server → Application Development → *Application Initialization*. This is needed so the weekly refresh keeps running when nobody is using the site.
2. **ASP.NET Core Hosting Bundle for .NET 10** (this is the runtime; the SDK is only needed to build from source), from https://dotnet.microsoft.com/download/dotnet/10.0, under "Hosting Bundle". Run `iisreset` after installing it.

**Check:** `dotnet --list-runtimes` lists `Microsoft.AspNetCore.App 10.x`.

---

## Step 2: Run the installer (recommended)

The installer does Steps 3–5 below for you.

1. Download **`install.ps1`** from the latest release: https://github.com/Eesterlein/gunnison-land-attribute-dashboard/releases/latest
2. Open PowerShell **as Administrator** in the folder where you saved it, and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

   It uses port 8080 by default. Add `-Port 80 -HostName <name>` to use a host name instead.

3. Answer the three questions it asks: **RealWare API address**, **username** and **password** (from Step 0). The password isn't shown as you type.

The installer:
- downloads the program into `C:\inetpub\LandAttributeDashboard`
- creates the app pool and site with the right settings
- saves and locks down the connection settings
- sets folder permissions
- starts the site and waits for the first data refresh

It finishes with **"Installed. Data refreshed at …"** and the dashboard address. If the refresh fails, it shows why. Run `.\install.ps1 -ResetSettings` to re-enter the connection settings.

Running it again is safe, and it keeps the existing settings.

**After that, go straight to Step 5 to verify.** Steps 3 and 4, and the manual option below, are a reference for what the installer does, or for installing by hand.

### Manual option: put the program on the server yourself

**Option A: download the ready-built package.** Each version is built automatically by GitHub from the code in this repository (see `.github/workflows/release.yml`).

1. Download **`LandAttributeDashboard.zip`** from the latest release: https://github.com/Eesterlein/gunnison-land-attribute-dashboard/releases/latest
2. Unzip it into **`C:\inetpub\LandAttributeDashboard`**.

**Option B: build it yourself from source.** Install the .NET 10 SDK, then:

```powershell
git clone https://github.com/Eesterlein/gunnison-land-attribute-dashboard.git
cd gunnison-land-attribute-dashboard
dotnet publish server -c Release -o C:\inetpub\LandAttributeDashboard
copy deploy\*.ps1 C:\inetpub\LandAttributeDashboard\
```

Either way, the folder contains `LadServer.dll`, `web.config`, `appsettings.json`, `install.ps1`, `update.ps1` and `wwwroot\` (the dashboard and parcel shapes). Only `wwwroot\` is ever served to browsers.

**Check:** `C:\inetpub\LandAttributeDashboard\wwwroot\index.html` exists.

---

## Step 3: Create the IIS site and application pool

1. **Application pool:** create one named `LandAttributeDashboard`.
   - .NET CLR version: **No Managed Code**
   - Advanced Settings → **Start Mode: AlwaysRunning**
   - Advanced Settings → **Idle Time-out (minutes): 0**

   Without these two, IIS stops the program when the site is idle and the weekly refresh won't run.
2. **Site or application:** physical path `C:\inetpub\LandAttributeDashboard`, using that app pool.
   - Advanced Settings → **Preload Enabled: True**
3. **Folder permissions:** give the app pool identity (`IIS AppPool\LandAttributeDashboard`) **Modify** rights on `C:\inetpub\LandAttributeDashboard\wwwroot\data`. The program writes the refreshed data there.
4. **Optional:** to limit the site to county staff, enable **Windows Authentication** on the site and disable Anonymous Authentication.

---

## Step 4: Enter the RealWare connection settings

Create `C:\inetpub\LandAttributeDashboard\appsettings.Production.json`. This file is specific to the server; never commit it to Git (the repository's `.gitignore` excludes it).

```json
{
  "Realware": {
    "BaseUrl": "<RealWare API address>",
    "Username": "<RealWare username>",
    "Password": "<RealWare password>",
    "GrantType": "password"
  }
}
```

Then restrict this file so only Administrators and `IIS AppPool\LandAttributeDashboard` can read it.

*Alternative:* the same values can be set as environment variables on the app pool instead of in a file: `Realware__BaseUrl`, `Realware__Username`, `Realware__Password` (two underscores).

All other settings have working defaults in `appsettings.json`:

| Setting | Default | Meaning |
|---|---|---|
| `Realware:MaxResults` | 500000 | Rows requested per search. If a search returns exactly this many, the refresh stops (results may be cut off). |
| `Realware:IgnoreCertificateErrors` | false | Set true only if the API uses a self-signed HTTPS certificate the server doesn't trust. |
| `Realware:TimeoutMinutes` | 10 | Per-request timeout. |
| `Refresh:DayOfWeek` / `Refresh:Hour` | Sunday / 2 | Weekly refresh time (server local time). |
| `Refresh:MinMinutesBetweenRefreshes` | 5 | How soon the Refresh button can be used again. |
| `Refresh:MinRowRatio` | 0.5 | Refuse a refresh if a search shrinks below this share of its previous rows. |

Restart the app pool after changing settings.

---

## Step 5: First start and verification

1. Start (or recycle) the app pool. On first start, with no data saved yet, the program runs a refresh straight away.
2. Open `http://<site>/api/status`. Within a minute or two it should show `"running": false`, a recent `"lastRefresh"` and `"lastError": null`.
   - If `lastError` mentions **sign-in failed**, check the username, password and grant type.
   - If it mentions **HTTP 404 on a query**, the saved search ID doesn't exist or isn't visible to that user.
   - If it mentions **maxResults**, raise `Realware:MaxResults`.
3. Open `http://<site>/`. The map should load with parcels. The header should show **"Data as of <date>"** and a **↻ Refresh** button.
4. Check that `wwwroot\data\raw\` contains `accounts.json`, `land_attributes.json`, `land_details.json`, `sales.json`, `values.json` and `meta.json`.

Expected row counts, roughly: accounts ~21,000; land attributes ~100,000–150,000; land details ~18,000+; sales (last 10 years) ~20,000; values ~21,000.

---

## Updating

- **New version of the dashboard:** in PowerShell as Administrator, run `C:\inetpub\LandAttributeDashboard\update.ps1`. It downloads the latest release, stops the app pool, copies the new files, and starts it again. `appsettings.Production.json` and `wwwroot\data\raw\` are never touched. To install a specific version, or roll back, run `update.ps1 -Version v1.0`. Details are in [`UPDATING.md`](UPDATING.md).
- **New parcel shapes:** these come from the county `Taxparcelassessor` shapefile. Someone with Python and `geopandas` runs `python scripts/build_geometry.py <path>\Taxparcelassessor.shp` and commits the two updated files (`data/parcels.geojson`, `data/geo_index.json`). Then publish as above.
- **A ListBuilder search changes ID or columns:** edit `config/searches.json` (query IDs and the `keep` column list) and publish.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| HTTP 500.19 / 500.30 when opening the site | ASP.NET Core Hosting Bundle missing, or IIS not restarted after installing it. |
| Map area is blank | Browsers can't reach `unpkg.com` or `server.arcgisonline.com`; check the web filter or proxy. |
| No Refresh button | The page isn't being served by LadServer (for example, opened as a file), or `/api/status` is blocked. |
| Data never updates on Sundays | App pool isn't AlwaysRunning, its idle time-out isn't 0, or Preload isn't enabled (Step 3). |
| `Access to the path ... denied` in logs | App pool identity lacks Modify rights on `wwwroot\data` (Step 3). |

**Logs:** set `stdoutLogEnabled="true"` in `web.config` (with `stdoutLogFile=".\logs\stdout"`) and create the `logs` folder. The program logs each refresh: start, row counts per search, and success or the error.
