"""Build a full-county development dataset in the same shape as the LAD ListBuilder searches.

    python scripts/make_dev_data.py "path/to/folder with the public downloads"

Reads the public assessor downloads (Land Attributes, GENERAL ACCT INFO, VALUES,
SALES) and writes data/raw/<search>.json exactly as the server program saves
API output: a JSON array of row objects keyed by the ListBuilder column aliases.
This lets the dashboard be developed and tested without API access.

Differences from live data: there is no neighborhood (the downloads don't carry
it), and land attributes come from the older packed export, so newer attribute
types (TREE TYPE, SITE IMPROVEMENTS) don't appear.
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw"

MAINTENANCE = {"YEAR AROUND GOVT MAINTAINED", "YEAR AROUND PRIVATELY MAINTAINED",
               "SEASONAL GOVT MAINTAINED", "SEASONAL PRIVATELY MAINTAINED"}


def read(folder, pattern):
    path = next(p for p in Path(folder).glob("*.xlsx") if re.search(pattern, p.name, re.I))
    df = pd.read_excel(path, dtype=str)
    df.columns = [re.sub(r"\s+", " ", str(c)).strip().upper() for c in df.columns]
    return df.fillna(""), path.name


def clean(v):
    return re.sub(r"\s+", " ", str(v)).strip()


CONFIG = json.loads((ROOT / "config" / "searches.json").read_text())
SEARCHES = {s["name"]: s for s in CONFIG["searches"]}


def parse_date(v):
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(str(v).strip()[:19], fmt)
        except ValueError:
            pass
    return None


def write(name, rows):
    """Save rows the way the server does: only the configured columns, recent sales only."""
    spec = SEARCHES[name]
    if spec.get("dateColumn"):
        cutoff = datetime.now().replace(year=datetime.now().year - CONFIG["salesYearsToKeep"])
        rows = [r for r in rows if (d := parse_date(r.get(spec["dateColumn"]))) and d >= cutoff]
    rows = [{k: r.get(k, "") for k in spec["keep"]} for r in rows]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.json").write_text(json.dumps(rows, separators=(",", ":")))
    print(f"{name}.json: {len(rows):,} rows")


def main(folder):
    gen, gen_name = read(folder, r"GENERAL")
    land, land_name = read(folder, r"^Land Attributes")
    val, _ = read(folder, r"VALUES")
    sales, _ = read(folder, r"SALES")

    gen = gen.drop_duplicates("ACCOUNT NO")
    write("accounts", [{
        "Account #": r["ACCOUNT NO"], "Account Type": r["ACCOUNT TYPE"],
        "Parcel #": re.sub(r"\D", "", r["PARCEL NO"]), "Property Type": r["IMPROVED PROPERTY TYPE"],
        "Property Address": r["PROPERTY ADDRESS"], "Property Area": r["PROPERTY LOCATION AREA"],
        "Economic Area": r["ECONOMIC AREA CODE"], "Subdivision": r["SUBDIVISION NAME"],
        "Condo": r["CONDO NAME"], "Neighborhood Code": "", "Neighborhood": "",
    } for _, r in gen.iterrows()])

    attrs, details, seq = [], [], 100000
    for _, r in land.iterrows():
        acct = clean(r["ACCOUNT #"])
        if not acct:
            continue

        def add(atype, sub):
            nonlocal seq
            seq += 1
            attrs.append({"Account #": acct, "Land Record ID": seq, "Land Attribute ID": seq,
                          "Filter Type": "General", "Land Value By": "Info Only",
                          "Attribute Type": atype, "Attribute Sub Type": sub, "Attribute Adjustment": 0})

        for p in clean(r["SITE ACCESS"]).split(","):
            p = clean(p).upper()
            if p:
                add("SITE ACCESS MAINTENANCE" if p in MAINTENANCE else "SITE ACCESS", p)
        for col in ("ELECTRICITY", "SEWER", "WATER"):
            for p in clean(r[col]).split(","):
                if clean(p):
                    add(col, clean(p).upper())
        for part in re.split(r"\.\s+|\.$", clean(r["OTHER ATTRIBUTES"])):
            if ":" in part:
                label, v = (clean(x) for x in part.split(":", 1))
                if v:
                    add(label.upper(), v.upper())

        size = clean(r["LAND SIZE"]).upper()
        m = re.match(r"^([\d,.]+)\s*(ACRES?|SQ\s*FT)", size)
        acres = None
        if m:
            n = float(m.group(1).replace(",", ""))
            acres = n if m.group(2).startswith("ACRE") else n / 43560
        leas = [p for p in re.split(r",\s*(?=\d+\s*:)", clean(r["LEA"])) if p.strip()] or [""]
        for k, lea in enumerate(leas):
            seq += 1
            code, _, desc = lea.partition(":")
            details.append({"Account #": acct, "Land Record ID": seq, "Default LEA": clean(code),
                            "LEA Description": clean(desc), "Gross Units": 1,
                            "Gross Acres": round(acres, 6) if (acres is not None and k == 0) else 0,
                            "Gross Square Feet": round(acres * 43560, 2) if (acres is not None and k == 0) else 0})
    write("land_attributes", attrs)
    write("land_details", details)

    vcols = {c: c.replace(" ", "") for c in val.columns}
    land_col = next(c for c in val.columns if c.endswith("LAND ACTUAL"))
    imp_col = next(c for c in val.columns if c.endswith("IMPROVEMENTS ACTUAL"))
    tot_col = next(c for c in val.columns if c.endswith("TOTAL ACTUAL") and "GOVT" not in c)
    write("values", [{"ACCOUNTNO": r["ACCOUNT NO"], "PARCELNO": r["PARCEL NO"], "LANDACTUAL": r[land_col],
                      "IMPSACTUAL": r[imp_col], "TOTALACTUAL": r[tot_col]} for _, r in val.iterrows()])

    sales = sales.rename(columns={"AT TIME OF SALE": "VACANT OR IMPROVED AT TIME OF SALE", "ACCOUNT TYPE": "ACCT TYPE"})
    write("sales", sales.to_dict("records"))

    (OUT / "meta.json").write_text(json.dumps({
        "refreshedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": f"Development data built from public downloads ({land_name}, {gen_name})",
    }, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
