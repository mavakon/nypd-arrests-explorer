# NYC Arrests Explorer

PV251 final project. An interactive dashboard of NYPD arrests 2006–2025: who is arrested, for what, where and when.
Four linked views share three filters: year, offense and precinct. The views are a precinct map, a precinct detail panel, demographic waffle charts and a weekday × month calendar heatmap.

Authors: Lada Spektorovska (595755), Maksym Konshyn (595740), Nikita Dakhno (599440)

## Run

The page is static (no build step), but it has to be served over HTTP because browsers block `fetch` from `file://`:

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

All local paths are relative, so the folder also works as-is on GitHub Pages, including from a subfolder.
Libraries load from CDNs at pinned versions: d3 7.9.0, Leaflet 1.9.4 and leaflet.heat 0.2.0. The basemap is Esri's World Light/Dark Gray Canvas.

## Files

- `index.html`, `style.css`: layout and theme tokens (light and dark, following `prefers-color-scheme`)
- `js/data.js`: pure data layer. It indexes the cube into typed arrays and computes aggregations, ranks, outliers, largest-remainder waffles and per-weekday calendar means.
- `js/map.js`: view A, the Leaflet map with three layers (choropleth, density heat, donut clusters)
- `js/app.js`: global state, the controls and views B, C and D
- `test/check_data.js`: sanity checks for the data layer. Run them with `node test/check_data.js`.

## Data sources

- Arrests: [NYPD Arrests Data (Historic)](https://data.cityofnewyork.us/resource/8h9b-rp9u.json), NYC Open Data
- Precinct boundaries: [NYC Open Data, Police Precincts](https://data.cityofnewyork.us/resource/y76i-bdw7.geojson)
- Population: 2020 census aggregated to precincts ([jkeefe/census-by-precincts](https://github.com/jkeefe/census-by-precincts)). Precinct 116 was rebuilt from census blocks.

Caveats: these are arrests, not crimes. Locations are mid-block. 4 arrests in precincts without polygons are excluded, and the heat layer excludes 7,116 rows without valid coordinates. Sex and age are missing for 52.8% of 2025 records. Precincts 121 (2013) and 116 (Dec 2024) were created during the period.

## Rebuild the data

```sh
python3 prep/build_data.py
```

The script writes everything in `data/`. Remote responses are cached under `prep/cache/`, so a rerun only re-aggregates locally; delete a cache file to refetch it. `data/meta.json` documents every index layout.
