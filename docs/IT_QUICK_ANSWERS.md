# Quick answers for IT

Short answers to the questions most likely to come up when reviewing the Land Attribute Dashboard.

- **Installing it:** [`HOSTING.md`](HOSTING.md)
- **Full technical detail:** [`ARCHITECTURE.md`](ARCHITECTURE.md)

---

### What does it do?
It is a map and review tool for appraisers. It shows every parcel in the county and highlights parcels by land attribute, LEA or neighborhood. It labels recent qualified sales, and it lists accounts whose land attributes are missing, conflicting, or different from neighboring properties. It only displays information; appraisers decide what, if anything, to change in RealWare.

### What data does it use?

| Data | Fields |
|---|---|
| Account | Account number, account type, parcel number, property type, property address, property area, economic area, subdivision, condo name, neighborhood |
| Land | Land attribute type and sub-type, LEA, gross acres / square feet |
| Sales (last 10 years) | Reception number, deed description, sale date, sale price, adjusted sale price, vacant/improved at sale, type of transaction, invalid-sale reason |
| Values | Land, improvement and total actual value |
| Map | Parcel shapes from the County tax-parcel GIS layer, with account and parcel numbers |

**Not stored:** owner names, mailing addresses, grantor/grantee, or any other column not listed in `config/searches.json`. The server drops them before saving.

### Where does the data come from?
- **Property data:** five saved RealWare ListBuilder searches, run through the RealWare API by the program on the county server. They run once a week (Sunday 2 AM by default) and when someone clicks Refresh.
- **Parcel shapes:** the County tax-parcel shapefile, converted into map files that ship with each release.

### Does it change anything in RealWare?
No. It signs in and runs saved searches, which only read data. It has no code that creates, updates or deletes RealWare records.

### Where is the data stored?
Only on the county server, in `C:\inetpub\LandAttributeDashboard\wwwroot\data\raw\`. These are plain JSON files, overwritten at each refresh. There is no database, and no data is kept anywhere else.

### Does any county data leave the network?
No. RealWare data is fetched by the server and served only to browsers on the county network.

Staff browsers do load a few public resources from the internet. **No county data is sent to any of them:**

| Resource | Purpose |
|---|---|
| unpkg.com | Map library (MapLibre GL JS) |
| server.arcgisonline.com (Esri) | Basemap images: light, satellite, topo |
| protomaps.github.io | Fonts for map labels |
| property.spatialest.com | Links that open the County's public property page for an account |
| github.com | Downloading releases, only when the install or update script is run |

The map library and fonts can be hosted on the county server instead, if preferred.

### Who can access it?
Anyone who can reach the site on the county network. To limit it to signed-in County employees, turn on **Windows Authentication** and turn off **Anonymous Authentication** for the site in IIS. No code change is needed.

### How is the RealWare login protected?
- It is stored only in `appsettings.Production.json` on the server.
- The installer locks that file so only Administrators, SYSTEM and the dashboard's app pool can read it.
- It is never sent to browsers and never stored in this repository.
- Only the `wwwroot` folder is served to browsers. Requests for the settings file return 404.

### What are the security risks, and how are they handled?

| Risk | How it's handled |
|---|---|
| The RealWare login sits on the server | Locked-down settings file; never served or committed. The account only needs read access to the saved searches. A dedicated service account can replace a personal one at any time by editing the file. |
| Anyone with site access can trigger a refresh | A refresh only runs read-only saved searches. It is limited to once every 5 minutes, and only one can run at a time. |
| A bad or partial refresh replaces good data | Refused automatically. Data is only replaced if every search succeeds. A search that returns nothing, hits the row limit, or shrinks to under half its previous size keeps the old data, and the error appears at `/api/status`. |
| Outside resources (map library, fonts, basemaps) | Public, read-only content; no county data sent. The map library and fonts can be hosted locally if IT prefers. |
| Software updates | Release packages are built by GitHub from the public code in this repository, so IT can review any change before installing it. `update.ps1` never touches the settings file or saved data, and `update.ps1 -Version <old>` rolls back. |
| User input | No logins, forms, file uploads or stored user input. The only actions are viewing and the read-only Refresh. |

### Is it an AI system under the County AI Policy?
No. It uses no machine learning, predictions or automated decisions. Every highlight and flag comes from a written rule, for example "most neighbors have X, this account has Y". All the rules are listed in `ARCHITECTURE.md`, section 6.

### What if RealWare or the API is down?
The refresh fails and the dashboard keeps showing the last good data. The error appears at `http://<site>/api/status` and in the server logs.

### How do we turn it off?
Stop the dashboard's IIS app pool. Nothing in RealWare is affected.

### What is the code, and how big is it?
- **Server:** ASP.NET Core (.NET 10), two C# files, about 300 lines in `server/`.
- **Dashboard:** plain HTML, CSS and JavaScript in `index.html` and `assets/`, with no build step.
- **Scripts:** `deploy/install.ps1` and `deploy/update.ps1`.

Everything is in this repository.
