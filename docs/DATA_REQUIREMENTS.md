# Data sources: RealWare ListBuilder searches

The app reads five saved ListBuilder searches from RealWare. It runs them once a week and whenever someone clicks **Refresh**. All of them are read-only.

| Query ID | Search | One row per | Used for |
|---|---|---|---|
| 43623 | **LAD - Accounts** | account | Account type, parcel #, address, area, economic area, subdivision, condo, neighborhood |
| 43625 | **LAD - Land Attributes** | land attribute | Every attribute type and sub-type (views, utilities, site access, land type, unique characteristics, …) |
| 43626 | **LAD - Land Details** | land line | LEA code and description, gross acres and square feet |
| 43627 | **LAD - Sales** | sale / account | Most recent qualified sale in the appraisal period (sale price and adjusted sale price) |
| 43628 | **LAD - Values** | account | Land, improvement and total actual value; "improved" test |

## Notes

- **Ownership:** the searches are owned by the app's RealWare login and are not shared. The API must log in as that same user to run them.
- **Row limit:** the server requests up to 500,000 rows per search (setting `Realware:MaxResults`) and stops without saving if a search reaches that limit.
- **No owner data:** none of the searches the app uses need owner names or mailing addresses.
- **Valid sales:** a sale counts as valid when `TYPE OF TRANSACTION` = `QUALIFIED SALE`. The logic is in LAD - Sales.
- **Appraisal period:** Gunnison County reappraises in odd years, with values set as of June 30 of the prior year. It uses a minimum of 24 months of sales ([source](https://www.gunnisoncounty.org/665/Assessment-Process)).

| Reappraisal | Sales used | Values as of | Notices of Value by |
|---|---|---|---|
| 2027 | 7/1/2024 – 6/30/2026 | 6/30/2026 | 5/1/2027 |
| 2025 | 7/1/2022 – 6/30/2024 | 6/30/2024 | 5/1/2025 |
| 2023 | 7/1/2020 – 6/30/2022 | 6/30/2022 | 5/1/2023 |

## Testing

The app reads the column names listed in `config/searches.json`, which match the LAD searches. Until it is connected to the live API, it has been tested only with test data in the same shape: built from the public assessor download files . No RealWare data is stored in this repository.
