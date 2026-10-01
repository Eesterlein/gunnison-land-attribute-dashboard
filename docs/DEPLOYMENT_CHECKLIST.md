# Deployment checklist

Decisions and records to complete before the Land Attribute Dashboard goes into production on the county network. Where the current behavior is already known, it is noted so the review can focus on the decisions.

- **Installation:** [`HOSTING.md`](HOSTING.md)
- **How the dashboard works:** [`ARCHITECTURE.md`](ARCHITECTURE.md)

---

## 1. Decide who may use it

- [ ] **Audience:** Assessor staff only, or a wider County group?
- [ ] **Turn on County sign-in** for the site (Windows Authentication in IIS).
- [ ] **Disable anonymous access.**
- [ ] **Decide who may use the Refresh button.**
  - *Current behavior:* anyone who can open the site can click Refresh.
  - A refresh can run at most once every 5 minutes.
  - A refresh only reads from RealWare.

## 2. Write down the data it uses

- [ ] **Confirm the field list.** The dashboard keeps:

| Data | Fields |
|---|---|
| Account | Account number, account type, parcel number, property type, property address, property area, economic area, subdivision, condo name, neighborhood |
| Land | Land attributes (type and sub-type), LEA, gross acres / square feet |
| Sales (last 10 years) | Reception number, deed description, sale date, sale price, adjusted sale price, vacant/improved at sale, type of transaction, invalid-sale reason |
| Values | Land, improvement and total actual value |

- [ ] **Confirm whether any field is sensitive or restricted.**
  - *Current behavior:* owner names, mailing addresses, grantor and grantee are **not** stored. The server drops every column not listed in `config/searches.json` before saving.
- [ ] **Confirm where the data lives:** on the internal server only, in `wwwroot\data\raw\`, replaced at each refresh. It is not stored anywhere else and is not entered into any AI chat.

## 3. Approve the outside services

The dashboard runs on the internal server. Staff browsers also load these outside resources. **No county data is sent to any of them.**

| Service | Used for | Decision: keep / County-hosted copy / route through approved service |
|---|---|---|
| unpkg.com | Map library (MapLibre GL JS) | |
| server.arcgisonline.com (Esri) | Basemap images: light, satellite, topo | |
| protomaps.github.io | Fonts for map labels | |
| property.spatialest.com | "Open county record" links (opens the public property page for an account number) | |
| github.com | Downloading releases, only when `install.ps1` / `update.ps1` is run | |

- [ ] **IT has reviewed** each service above, plus any other external connection, and recorded a decision.

## 4. Confirm the dashboard's purpose and limits

- [ ] **Purpose statement:** *"This tool helps appraisers find records to review. It does not change RealWare or make appraisal decisions."*
- [ ] **Decide whether that wording should appear on the dashboard and in exported CSV files.**
  - *Current state:* it appears in this documentation only.
- [ ] **Name a person** who checks whether the review flags are accurate enough to stay useful.

## 5. Complete the County governance review

- [ ] **Submit the use case to IT** for a risk-threshold decision under the AI Policy.
  - *For context:* the dashboard is rule-based. It uses no machine learning and makes no predictions or automated decisions. Every flag comes from a written rule, listed in `ARCHITECTURE.md`, section 6.
- [ ] **If IT classifies it as an AI system,** complete the Algorithmic Impact Assessment and an internal FactSheet. `ARCHITECTURE.md` already describes:
  - the rules
  - the inputs (section 3)
  - the outputs
  - the safeguards (section 9)
- [ ] **Name the owners:**
  - **Department owner:** ______________________
  - **IT owner:** ______________________
  - **Person authorized to pause the system:** ______________________

    To pause it, stop the IIS app pool. RealWare is unaffected.

## 6. Establish everyday operating rules

- [ ] **Train users** to treat flags as review prompts, not conclusions.
- [ ] **Create a simple way to report** bad flags, security concerns or incorrect data. For example, an email address or a help-desk category: ______________________
- [ ] **Decide how long data and logs are kept.** *Current behavior:*
  - Saved data is overwritten at each refresh.
  - Server logs are kept only if IIS stdout logging is turned on.
  - CSV files staff download are saved on their own computers.
- [ ] **Review the tool** at least annually and after meaningful changes. Next review date: ______________________

## 7. Secure releases and updates

- [ ] **IT approves each production update** before it is installed.
  - Changes between versions are visible on GitHub: `/compare/<old>...<new>`.
- [ ] **Verify the downloaded release before installing it.**
  - *Current behavior:* release packages are built by GitHub Actions from the tagged code in this repository. Builds are not yet published with checksums.
- [ ] **Keep a tested rollback process.**
  - *Current behavior:* `update.ps1 -Version <previous version>` reinstalls an earlier release.
  - Test it once after the first install.
- [ ] **Record which version is running.**
  - *Current behavior:* the dashboard's **About** page shows the installed version and build date.
  - `CHANGELOG.md` lists what changed in each version.

---

**Sign-off**

| Role | Name | Date |
|---|---|---|
| Department owner | | |
| IT | | |
