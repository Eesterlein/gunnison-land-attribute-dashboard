#!/usr/bin/env python3
"""Download the City of Gunnison utility service areas into assets/layers/.

The City publishes these publicly on ArcGIS Online ("City of Gunnison Utility Service
Areas", owner GunnisonCity). No account or key is needed. The dashboard ships a copy
with each release instead of calling the City's server from the browser.

Run before tagging a release (or whenever the City updates the layer):
    python3 scripts/fetch_city_layers.py
"""
import datetime
import json
import pathlib
import urllib.parse
import urllib.request

SERVICE = ("https://services9.arcgis.com/Xe2ZFaXOK1tSw7Ka/arcgis/rest/services/"
           "City_of_Gunnison_Utility_Service_Areas_VIEW/FeatureServer")
LAYERS = [  # (layer id, key used by the dashboard, display name)
    (0, "electric", "City of Gunnison electric service area"),
    (1, "water_sewer", "City of Gunnison water and sewer service area"),
    (2, "refuse", "City of Gunnison refuse and recycling pickup areas"),
]
OUT = pathlib.Path(__file__).resolve().parent.parent / "assets" / "layers" / "city-utility-service-areas.geojson"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "land-attribute-dashboard/layer-fetch"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def rounded(c):
    return [round(c[0], 6), round(c[1], 6)] if isinstance(c[0], (int, float)) else [rounded(x) for x in c]


def main():
    features, edited = [], []
    for lid, key, name in LAYERS:
        info = get(f"{SERVICE}/{lid}?f=json")
        if "error" in info:
            raise SystemExit(f"Layer {lid}: {info['error']}")
        ms = (info.get("editingInfo") or {}).get("lastEditDate")
        if ms:
            edited.append(ms)
        q = urllib.parse.urlencode({"where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson"})
        data = get(f"{SERVICE}/{lid}/query?{q}")
        if not data.get("features"):
            raise SystemExit(f"Layer {lid} ({key}) returned no features; not overwriting {OUT.name}")
        for f in data["features"]:
            props = {"layer": key, "name": name}
            day = (f.get("properties") or {}).get("PickupDay")
            if day:
                props["day"] = day
            features.append({"type": "Feature", "properties": props,
                             "geometry": {"type": f["geometry"]["type"], "coordinates": rounded(f["geometry"]["coordinates"])}})
        print(f"{key}: {len(data['features'])} feature(s)")
    src_date = datetime.datetime.fromtimestamp(max(edited) / 1000, datetime.timezone.utc).date().isoformat() if edited else None
    out = {"type": "FeatureCollection",
           "source": "City of Gunnison, Colorado (ArcGIS Online: City of Gunnison Utility Service Areas)",
           "sourceUrl": SERVICE, "sourceEdited": src_date,
           "downloaded": datetime.date.today().isoformat(), "features": features}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"Wrote {OUT} ({OUT.stat().st_size:,} bytes; City last edited {src_date})")


if __name__ == "__main__":
    main()
