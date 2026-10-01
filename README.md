# Gunnison County Land Attribute Dashboard (RealWare edition)

> **Status: in development.** This is the next version of the [Gunnison County Land Attributes demo](https://github.com/Eesterlein/gunnison-land-attributes). The demo is built from public data downloads. This version is designed to run on the Gunnison County Assessor's internal network and read data directly from RealWare. It is not yet deployed.

An interactive parcel map and review tool for land attributes. Appraisers can:
- see every parcel in the county
- light up the parcels carrying any land attribute and sub-attribute, within chosen LEAs or neighborhoods
- color parcels by an attribute's values
- label parcels with account numbers and the most recent qualified sale in the appraisal period
- find accounts that are missing land attributes or don't match the properties around them

## How it will work

```
RealWare (internal)
        │  read-only: 5 saved ListBuilder searches
        ▼
Small server program on the county's internal server
        • runs the searches weekly, and when someone clicks Refresh
        • saves the results as data files
        • serves the dashboard to staff
        ▼
Dashboard in the browser (map + Review & Stats)
```

- **Read-only:** the app only reads from RealWare and never writes to it.
- **Credentials stay on the server:** the RealWare login is stored only in a settings file on the server. It never appears in the browser, the code or this repository.
- **Parcel shapes:** they come from the county tax-parcel shapefile and are rebuilt with `scripts/build_geometry.py` whenever a new shapefile is provided.

- **Safety rails:** a refresh only replaces the data if every search succeeds and none comes back empty, cut off or much smaller than before.

| Document | What's in it |
|---|---|
| [`docs/HOSTING.md`](docs/HOSTING.md) | Step-by-step install on the county's IIS server (written for IT, or an AI assistant helping IT) |
| [`docs/UPDATING.md`](docs/UPDATING.md) | How suggestions become updates on the county server (`update.ps1`), and how to roll back |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it's built: data flow, cleaning, review checks, map performance, server design |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each version |
| [`docs/DATA_REQUIREMENTS.md`](docs/DATA_REQUIREMENTS.md) | The ListBuilder searches, their columns, and the appraisal periods |
| [`server/`](server) | The server program (C#, .NET 10): `Program.cs` (web host), `Refresher.cs` (RealWare refresh) |

## Local development (no API needed)

`scripts/make_dev_data.py` turns the public assessor downloads into the same files the server program saves from the API, so the dashboard can be run with full-county data:

```bash
python scripts/make_dev_data.py "folder with the public .xlsx downloads"
python -m http.server 8000      # then open http://localhost:8000
```

The Refresh button only appears when the dashboard is served by the server program.

## Repository layout

```
index.html, assets/        dashboard (MapLibre GL JS, no build step)
config/searches.json       the ListBuilder searches + which columns are kept
data/                      parcel shapes; data/raw/ holds saved search output (git-ignored)
scripts/                   shapefile → map geometry; public downloads → dev data
server/                    server program (C#/.NET 10): serves the site, runs the weekly refresh
docs/                      hosting, updating, architecture, data requirements
deploy/                    install.ps1 (one-time install) and update.ps1 (updates) for the county server
.github/workflows/         builds the install package for each version tag
```
