#!/usr/bin/env python3
"""Build static data files for the NYC Arrests Explorer dashboard.

Re-runnable: every remote response is cached under prep/cache/ (keyed by name + URL hash),
so a rerun only re-aggregates locally. Delete a cache file to refetch it.
All aggregation happens server-side in SoQL; the raw 6M rows are never downloaded.
Run: python3 prep/build_data.py
"""
import csv, hashlib, io, json, math, os, re, subprocess, time, urllib.parse
from collections import Counter, defaultdict
from datetime import date, datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "prep", "cache")
DATA = os.path.join(ROOT, "data")
ARRESTS = "https://data.cityofnewyork.us/resource/8h9b-rp9u.json"
PRECINCTS = "https://data.cityofnewyork.us/resource/y76i-bdw7.geojson?$limit=200"
POP_CSV = "https://raw.githubusercontent.com/jkeefe/census-by-precincts/master/data/nyc/nyc_precinct_2020pop.csv"
POP_BLOCKS = "https://raw.githubusercontent.com/jkeefe/census-by-precincts/master/data/nyc/nyc_block_precinct_2020pop.csv"
TIGER_BLOCKS = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/10/query"
YEARS = list(range(2006, 2026))
Y = len(YEARS)
SEV = ["F", "M", "V", "I", "U"]
SEXES = ["M", "F", "U"]
AGES = ["<18", "18-24", "25-44", "45-64", "65+", "Unknown"]
BORO = {"B": "Bronx", "K": "Brooklyn", "M": "Manhattan", "Q": "Queens", "S": "Staten Island"}
BBOX = "latitude between 40.4 and 41.0 and longitude between -74.3 and -73.6"
HEAT_MAX = 600_000
NTOP = 15


# ---------------------------------------------------------------- fetching
def fetch(url, name, raw=False):
    """GET url with retry/backoff; cache body under prep/cache/<name>-<hash>.
    Uses the curl binary: python.org's Python lacks the macOS keychain CA roots (which a TLS-inspecting
    network here needs), while system curl trusts them."""
    path = os.path.join(CACHE, f"{name}-{hashlib.sha1(url.encode()).hexdigest()[:10]}" + ("" if raw else ".json"))
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read() if raw else json.load(f)
    for attempt in range(6):
        r = subprocess.run(["curl", "-sS", "-m", "600", "-A", "nyc-arrests-explorer-prep/1.0", "-w", "\n%{http_code}", url],
                           capture_output=True, text=True)
        body, _, code = r.stdout.rpartition("\n")
        code = int(code or 0)
        try:
            if r.returncode or code >= 400:
                raise RuntimeError(f"curl rc={r.returncode} http={code} {r.stderr.strip()} {body[:300]}")
            parsed = None if raw else json.loads(body)
            if isinstance(parsed, dict) and ("error" in parsed or "message" in parsed) and "features" not in parsed:
                raise RuntimeError(str(parsed)[:300])
            break
        except Exception as e:  # network error, 5xx, timeout, API error body
            if attempt == 5 or 400 <= code < 500 and code != 429:
                raise
            print(f"  retry {attempt + 1} {name}: {str(e)[:150]}")
            time.sleep(5 * 2 ** attempt)
    os.makedirs(CACHE, exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write(body)
    os.replace(path + ".tmp", path)
    return body if raw else parsed


def soql(name, select, group=None, where=None, order=None, page=50000):
    """Run a SoQL group-by, paging with $offset until a short page comes back."""
    rows, off = [], 0
    while True:
        p = {"$select": select, "$limit": page, "$offset": off}
        if group: p["$group"] = group
        if where: p["$where"] = where
        if order or group: p["$order"] = order or group
        res = fetch(ARRESTS + "?" + urllib.parse.urlencode(p), f"{name}-o{off}")
        assert isinstance(res, list), res
        rows += res
        if len(res) < page:
            return rows
        off += page


def year_where(y):
    return f"arrest_date between '{y}-01-01T00:00:00' and '{y}-12-31T23:59:59'"


# ---------------------------------------------------------------- normalisers
def sev(v):
    return v if v in ("F", "M", "V", "I") else "U"


def num(v):
    return None if v is None else int(float(v))


ACRONYMS = {"Nys": "NYS", "Nyc": "NYC", "Dwi": "DWI", "Ii": "II", "Iii": "III", "Mta": "MTA", "Pl": "PL",
            "Ny": "NY", "Uncl": "Unclassified", "Atm": "ATM", "Gt": "GT", "Bldg": "Bldg", "Cpcs": "CPCS",
            "Cpw": "CPW", "Ofc": "Ofc", "Dna": "DNA", "Id": "ID", "Ab": "AB", "Abc": "ABC", "Lic": "Lic"}
SMALL = {"Of", "And", "To", "In", "On", "For", "The", "A", "Or", "By", "W/O", "With", "From"}


def title(s):
    s = " ".join(s.replace(",", ", ").split())
    words = s.title().split(" ")
    out = []
    for i, w in enumerate(words):
        core = w.rstrip(",")
        tail = w[len(core):]
        core = ACRONYMS.get(core, core)
        if i and core in SMALL:
            core = core.lower()
        out.append(core + tail)
    s = " ".join(out).replace("'S ", "'s ")
    return re.sub(r"(\d)(St|Nd|Rd|Th)\b", lambda m: m[1] + m[2].lower(), s)


SEV_NAME = {"F": "Felony", "M": "Misdemeanor", "V": "Violation", "I": "Infraction", "U": "Unknown"}


def dedupe(items, key, sev_of, code):
    """Make labels unique: append dominant severity, then the code, only where a label repeats."""
    for tag in (lambda it: SEV_NAME[sev_of[it[key]]], lambda it: f"{code} {it[key]}"):
        c = Counter(it["label"] for it in items)
        for it in items:
            if c[it["label"]] > 1:
                it["label"] = f"{it['label']} ({tag(it)})"


def race_label(v):
    return "Unknown" if v in (None, "", "(null)", "UNKNOWN") else title(v)


def age_label(v):
    return v if v in AGES[:-1] else "Unknown"


def sex_label(v):
    return v if v in ("M", "F") else "U"


# ---------------------------------------------------------------- geometry
def ring_area_centroid(r):
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(r, r[1:]):
        c = x0 * y1 - x1 * y0
        a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c
    if a == 0:
        return 0.0, r[0]
    return a / 2, (cx / (3 * a), cy / (3 * a))


def in_ring(x, y, r):
    inside = False
    for (x0, y0), (x1, y1) in zip(r, r[1:]):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


def in_multipolygon(x, y, mp):
    return any(in_ring(x, y, poly[0]) and not any(in_ring(x, y, h) for h in poly[1:]) for poly in mp)


def rep_point(mp):
    """Centroid of the largest polygon; if it falls outside (concave shape), midpoint of the
    widest inside span on the horizontal line through it."""
    poly = max(mp, key=lambda p: abs(ring_area_centroid(p[0])[0]))
    _, (cx, cy) = ring_area_centroid(poly[0])
    if in_multipolygon(cx, cy, [poly]):
        return cx, cy
    xs = sorted(x0 + (cy - y0) * (x1 - x0) / (y1 - y0)
                for ring in poly for (x0, y0), (x1, y1) in zip(ring, ring[1:]) if (y0 > cy) != (y1 > cy))
    a, b = max(zip(xs[::2], xs[1::2]), key=lambda s: s[1] - s[0])
    return (a + b) / 2, cy


def dp(pts, eps):
    """Douglas-Peucker on an open polyline (endpoints kept)."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x0, y0), (x1, y1) = pts[i], pts[j]
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy) or 1e-12
        best, bi = -1, None
        for k in range(i + 1, j):
            d = abs(dy * (pts[k][0] - x0) - dx * (pts[k][1] - y0)) / L
            if d > best:
                best, bi = d, k
        if bi is not None and best > eps:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    return [p for p, k in zip(pts, keep) if k]


def simplify_topo(features, eps):
    """Topology-preserving simplification: split every ring into arcs at vertices whose set of
    owning features changes, simplify each arc once in a canonical direction, and reuse that
    result for every ring sharing the arc, so neighbours keep identical borders (no slivers).
    ponytail: assumes neighbours share exact vertices after 1e-5 rounding (true for this DCP
    layer); a mapshaper/topojson pass would be needed for unrelated sources."""
    owners = defaultdict(set)
    for fi, f in enumerate(features):
        for poly in f:
            for ring in poly:
                for p in ring:
                    owners[p].add(fi)
    cache = {}

    def simp_arc(arc):
        key = min(tuple(arc), tuple(reversed(arc)))
        if key not in cache:
            cache[key] = dp(list(key), eps)
        res = cache[key]
        return res if tuple(arc) == key else res[::-1]

    out = []
    for f in features:
        polys = []
        for poly in f:
            rings = []
            for ring in poly:
                r = ring[:-1]
                n = len(r)
                if n < 3:  # degenerate after rounding
                    if not rings:  # it was the outer ring
                        break
                    continue
                junc = [i for i in range(n) if owners[r[i]] != owners[r[i - 1]] or owners[r[i]] != owners[r[(i + 1) % n]]]
                if not junc:
                    # free ring (island / no neighbours): anchor at vertex 0 and its farthest vertex
                    far = max(range(n), key=lambda i: (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2)
                    junc = [0, far] if far else [0]
                rr = r[junc[0]:] + r[:junc[0]]
                js = [j - junc[0] for j in junc] + [n]
                rr.append(rr[0])
                new = []
                for a, b in zip(js, js[1:]):
                    new += simp_arc(rr[a:b + 1])[:-1]
                new.append(new[0])
                if len(new) >= 4:
                    rings.append(new)
                elif not rings:  # outer ring collapsed: drop the whole polygon, never keep orphan holes
                    break
            if rings:
                polys.append(rings)
        out.append(polys)
    return out


# ---------------------------------------------------------------- helpers
def dump(obj, rel):
    path = os.path.join(DATA, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    return os.path.getsize(path)


def main():
    t0 = time.time()
    os.makedirs(DATA, exist_ok=True)
    report = []

    # ---- totals
    total = int(soql("total", "count(*) as n")[0]["n"])
    ytot = {int(r["y"]): int(r["n"]) for r in soql("ytot", "date_extract_y(arrest_date) as y, count(*) as n", "y")}
    assert sorted(ytot) == YEARS and sum(ytot.values()) == total, (ytot, total)
    print(f"API total {total:,}")

    # ---- offenses: key on ky_cd, label = most frequent non-null ofns_desc
    kyrows = soql("ky_desc", "ky_cd, ofns_desc, count(*) as n", "ky_cd, ofns_desc")
    kyn, kydesc = Counter(), defaultdict(Counter)
    for r in kyrows:
        k = num(r.get("ky_cd"))
        kyn[k] += int(r["n"])
        d = r.get("ofns_desc")
        if d and d != "(null)":
            kydesc[k][d.strip()] += int(r["n"])
    offenses = []
    for k, n in kyn.most_common():
        label = "Unknown/unclassified" if k is None or not kydesc[k] else title(kydesc[k].most_common(1)[0][0])
        offenses.append({"ky": k, "label": label, "n": n})
    kysev = defaultdict(Counter)
    for r in soql("ky_sev", "ky_cd, law_cat_cd, count(*) as n", "ky_cd, law_cat_cd"):
        kysev[num(r.get("ky_cd"))][sev(r.get("law_cat_cd"))] += int(r["n"])
    dedupe(offenses, "ky", {k: c.most_common(1)[0][0] for k, c in kysev.items()}, "KY")
    oidx = {o["ky"]: i for i, o in enumerate(offenses)}
    top = list(range(NTOP))  # offenses already sorted by n desc
    top_ky = [offenses[i]["ky"] for i in top]
    assert None not in top_ky, "unclassified offense in top 15 - handle ky_cd is null in heat filter"
    spell = {o["label"]: len(kydesc[o["ky"]]) for o in offenses if len(kydesc[o["ky"]]) > 1}
    report.append(f"ky_cd with >1 ofns_desc spelling: {len(spell)}")

    # ---- pds: key on pd_cd, label = most frequent pd_desc, o = most frequent offense
    pdrows = soql("pd_desc", "pd_cd, pd_desc, ky_cd, count(*) as n", "pd_cd, pd_desc, ky_cd")
    pdn, pddesc, pdky = Counter(), defaultdict(Counter), defaultdict(Counter)
    for r in pdrows:
        p, n = num(r.get("pd_cd")), int(r["n"])
        pdn[p] += n
        pdky[p][num(r.get("ky_cd"))] += n
        d = r.get("pd_desc")
        if d and d != "(null)":
            pddesc[p][d.strip()] += n
    pds = []
    for p, n in pdn.most_common():
        label = "Unknown/unclassified" if p is None or not pddesc[p] else title(pddesc[p].most_common(1)[0][0])
        pds.append({"pd": p, "label": label, "o": oidx[pdky[p].most_common(1)[0][0]]})
    pdsev = defaultdict(Counter)
    for r in soql("pd_sev", "pd_cd, law_cat_cd, count(*) as n", "pd_cd, law_cat_cd"):
        pdsev[num(r.get("pd_cd"))][sev(r.get("law_cat_cd"))] += int(r["n"])
    dedupe(pds, "pd", {k: c.most_common(1)[0][0] for k, c in pdsev.items()}, "PD")
    assert len({o["label"] for o in offenses}) == len(offenses) and len({d["label"] for d in pds}) == len(pds)
    pidx_pd = {d["pd"]: i for i, d in enumerate(pds)}

    # ---- precinct polygons
    gj = fetch(PRECINCTS, "precincts")
    feats = sorted(gj["features"], key=lambda f: int(float(f["properties"]["precinct"])))
    ids = [int(float(f["properties"]["precinct"])) for f in feats]
    assert len(ids) == len(set(ids))
    P = {pid: i for i, pid in enumerate(ids)}

    # boro = majority arrest_boro per precinct
    boro = defaultdict(Counter)
    for r in soql("boro", "arrest_precinct, arrest_boro, count(*) as n", "arrest_precinct, arrest_boro"):
        boro[num(r.get("arrest_precinct"))][r.get("arrest_boro")] += int(r["n"])
    apct = {p: sum(c.values()) for p, c in boro.items()}
    no_poly = {p: n for p, n in apct.items() if p not in P}
    no_arrests = [p for p in ids if p not in apct]
    unmatched = sum(no_poly.values())
    report.append(f"precinct polygons: {len(ids)}; distinct arrest_precinct: {len(apct)}")
    report.append(f"arrest precincts without polygon (excluded from precinct cubes): {no_poly} -> {unmatched} arrests")
    report.append(f"polygons without arrests: {no_arrests}")

    # ---- population (2020 census, Keefe aggregation of blocks to precincts)
    pop = {int(float(r["precinct"])): int(float(r["P1_001N"])) for r in csv.DictReader(io.StringIO(fetch(POP_CSV, "pop", raw=True)))}
    pop_note = POP_CSV
    if 116 in P and 116 not in pop and 105 in pop:
        # Precinct 116 (Dec 2024) was carved out of 105 plus a slice of 113; Keefe's table predates it.
        # Every census block whose TIGER 2020 interior point lies in the current 116 polygon moves to 116;
        # all other blocks keep Keefe's precinct.
        allblocks = {r["GEOID20"]: (r["precinct"], int(r["P1_001N"]))
                     for r in csv.DictReader(io.StringIO(fetch(POP_BLOCKS, "pop_blocks", raw=True)))}
        mp116 = feats[P[116]]["geometry"]["coordinates"]
        pts = [p for poly in feats[P[105]]["geometry"]["coordinates"] + mp116 for ring in poly for p in ring]
        env = f"{min(p[0] for p in pts)},{min(p[1] for p in pts)},{max(p[0] for p in pts)},{max(p[1] for p in pts)}"
        centre, off = {}, 0
        while True:
            q = urllib.parse.urlencode({"where": "STATE='36' AND COUNTY='081'", "geometry": env, "geometryType": "esriGeometryEnvelope",
                                        "inSR": 4326, "spatialRel": "esriSpatialRelIntersects", "outFields": "GEOID,INTPTLAT,INTPTLON",
                                        "returnGeometry": "false", "resultOffset": off, "resultRecordCount": 1000,
                                        "orderByFields": "GEOID", "f": "json"})
            res = fetch(TIGER_BLOCKS + "?" + q, f"tiger-{off}")
            for f in res["features"]:
                a = f["attributes"]
                centre[a["GEOID"]] = (float(a["INTPTLON"]), float(a["INTPTLAT"]))
            if not res.get("exceededTransferLimit") and len(res["features"]) < 1000:
                break
            off += len(res["features"])
        assert all(g in centre for g, (pc, _) in allblocks.items() if pc == "105"), "precinct-105 block without TIGER centroid"
        before = {k: pop[k] for k in (105, 113)}
        movedpop = Counter()
        for g, (pc, n) in allblocks.items():
            if g in centre and in_multipolygon(*centre[g], mp116):
                movedpop[int(pc)] += n
        for k in (105, 113):
            assert sum(n for pc, n in allblocks.values() if pc == str(k)) == pop[k], k
        assert set(movedpop) <= {105, 113}, movedpop
        mp105 = feats[P[105]]["geometry"]["coordinates"]
        stray = sum(n for g, (pc, n) in allblocks.items() if g in centre and n and pc not in ("105",)
                    and in_multipolygon(*centre[g], mp105))
        leak_out = sum(n for g, (pc, n) in allblocks.items() if pc == "105" and not (
            in_multipolygon(*centre[g], mp105) or in_multipolygon(*centre[g], mp116)))
        for k, n in movedpop.items():
            pop[k] -= n
        pop[116] = sum(movedpop.values())
        report.append(f"pop split: Keefe 105={before[105]:,}, 113={before[113]:,} -> 105={pop[105]:,}, 113={pop[113]:,}, "
                      f"116={pop[116]:,} (from 105: {movedpop[105]:,}, from 113: {movedpop[113]:,}); sanity: non-105 pop inside "
                      f"current 105 polygon={stray:,}, old-105 pop outside 105+116={leak_out:,}")
        pop_note = (f"{POP_CSV} (2020 census P1_001N aggregated to precincts by John Keefe); 116 rebuilt from "
                    f"block interior points from {TIGER_BLOCKS} against the current 116 polygon, block pops from {POP_BLOCKS}")
    missing_pop = [p for p in ids if p not in pop]
    assert not missing_pop, missing_pop
    pop_total = sum(pop[p] for p in ids)
    report.append(f"population total over polygons: {pop_total:,}")
    assert 8.6e6 < pop_total < 9.0e6

    precincts = []
    geo = []
    for pid, f in zip(ids, feats):
        mp = f["geometry"]["coordinates"] if f["geometry"]["type"] == "MultiPolygon" else [f["geometry"]["coordinates"]]
        lon, lat = rep_point(mp)
        assert in_multipolygon(lon, lat, mp), pid
        b = boro[pid].most_common(1)[0][0] if pid in boro else None
        precincts.append({"id": pid, "boro": BORO.get(b), "pop": pop[pid], "lat": round(lat, 5), "lon": round(lon, 5)})
        geo.append([[[(round(x, 5), round(y, 5)) for x, y in ring] for ring in poly] for poly in mp])

    # geojson: rounded + topology-preserving simplification, tighten eps until <= 600 KB
    for eps in (0.00005, 0.0001, 0.00015, 0.0002, 0.0003):
        simp = simplify_topo([[[[p for i, p in enumerate(r) if i == 0 or p != r[i - 1]] for r in poly] for poly in g] for g in geo], eps)
        fc = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"id": pr["id"], "boro": pr["boro"], "pop": pr["pop"]},
             "geometry": {"type": "MultiPolygon", "coordinates": [[[list(p) for p in r] for r in poly] for poly in s]}}
            for pr, s in zip(precincts, simp)]}
        size = dump(fc, "precincts.geojson")
        if size <= HEAT_MAX:
            break
    report.append(f"precincts.geojson: DP eps={eps} deg, {size:,} B")
    npoly0, nring0 = sum(len(g) for g in geo), sum(len(p) for g in geo for p in g)
    npoly1, nring1 = sum(len(g) for g in simp), sum(len(p) for g in simp for p in g)
    area = lambda g: sum(abs(ring_area_centroid(p[0])[0]) - sum(abs(ring_area_centroid(h)[0]) for h in p[1:]) for p in g)
    worst = max(abs(area(b) / area(a) - 1) for a, b in zip(geo, simp))
    signs = Counter(ring_area_centroid(p[0])[0] > 0 for g in simp for p in g)
    report.append(f"geojson polygons {npoly0}->{npoly1}, rings {nring0}->{nring1}, worst per-feature area change {worst:.3%}, "
                  f"outer rings CCW(lon/lat)={signs[True]} CW={signs[False]} (as in source; not rewound)")
    assert all(len(g) for g in simp) and worst < 0.01

    races_n = Counter()
    # ---- per-year fine cube: precinct x ky x pd x severity  -> cube.json + pd/*.json
    cube, pdcube = Counter(), Counter()
    demo = {"sex": Counter(), "race": Counter(), "age": Counter()}
    cal_off = [0] * ((NTOP + 1) * Y * 84)
    cal_pct = [0] * (len(ids) * Y * 84)
    topk = {ky: k + 1 for k, ky in enumerate(top_ky)}
    heat_sizes, heat_gap = {}, {}
    for yi, yr in enumerate(YEARS):
        w = year_where(yr)
        s_cube = 0
        for r in soql(f"fine-{yr}", "arrest_precinct, ky_cd, pd_cd, law_cat_cd, count(*) as n",
                      "arrest_precinct, ky_cd, pd_cd, law_cat_cd", w):
            p, n = num(r.get("arrest_precinct")), int(r["n"])
            if p not in P:
                continue
            o = oidx[num(r.get("ky_cd"))]
            cube[(P[p], yi, o, SEV.index(sev(r.get("law_cat_cd"))))] += n
            pdcube[(P[p], yi, o, pidx_pd[num(r.get("pd_cd"))])] += n
            s_cube += n
        demo_rows = soql(f"demo-{yr}", "arrest_precinct, perp_sex, perp_race, age_group, law_cat_cd, count(*) as n",
                         "arrest_precinct, perp_sex, perp_race, age_group, law_cat_cd", w)
        for r in demo_rows:
            races_n[race_label(r.get("perp_race"))] += int(r["n"])
        for r in demo_rows:
            p, n = num(r.get("arrest_precinct")), int(r["n"])
            if p not in P:
                continue
            s = SEV.index(sev(r.get("law_cat_cd")))
            demo["sex"][(P[p], yi, sex_label(r.get("perp_sex")), s)] += n
            demo["race"][(P[p], yi, race_label(r.get("perp_race")), s)] += n
            demo["age"][(P[p], yi, AGES.index(age_label(r.get("age_group"))), s)] += n
        # calendar: SoQL dow 0=Sunday -> 0=Monday; month 1..12 -> 0..11
        for r in soql(f"cal-off-{yr}", "date_extract_m(arrest_date) as m, date_extract_dow(arrest_date) as d, ky_cd, count(*) as n",
                      "m, d, ky_cd", w):
            m, d, n = int(r["m"]) - 1, (int(r["d"]) + 6) % 7, int(r["n"])
            cal_off[((0 * Y + yi) * 12 + m) * 7 + d] += n
            k = topk.get(num(r.get("ky_cd")))
            if k:
                cal_off[((k * Y + yi) * 12 + m) * 7 + d] += n
        for r in soql(f"cal-pct-{yr}", "arrest_precinct, date_extract_m(arrest_date) as m, date_extract_dow(arrest_date) as d, count(*) as n",
                      "arrest_precinct, m, d", w):
            p = num(r.get("arrest_precinct"))
            if p in P:
                cal_pct[((P[p] * Y + yi) * 12 + int(r["m"]) - 1) * 7 + (int(r["d"]) + 6) % 7] += int(r["n"])
        # heat: server-side binning, idx = floor(v/grid + 0.5) i.e. round-half-up, cell centre = idx*grid
        for grid in (0.004, 0.006):
            gs = f"{grid}"
            sel = f"floor(latitude/{gs}+0.5) as a, floor(longitude/{gs}+0.5) as b"
            cells = {"all": []}
            for r in soql(f"heat-all-{yr}-{gs}", sel + ", count(*) as n", "a, b", f"{w} and {BBOX}"):
                cells["all"] += [int(r["a"]), int(r["b"]), int(r["n"])]
            kys = ",".join(str(k) for k in top_ky)
            tmp = defaultdict(list)
            for r in soql(f"heat-off-{yr}-{gs}", sel + ", ky_cd, count(*) as n", "a, b, ky_cd", f"{w} and {BBOX} and ky_cd in ({kys})"):
                tmp[str(oidx[num(r["ky_cd"])])] += [int(r["a"]), int(r["b"]), int(r["n"])]
            for i in top:
                cells[str(i)] = tmp.get(str(i), [])
            size = dump({"grid": grid, "cells": cells}, f"heat/{yr}.json")
            if size <= HEAT_MAX:
                break
        heat_sum = sum(cells["all"][2::3])
        heat_sizes[yr] = (grid, size)
        heat_gap[yr] = ytot[yr] - heat_sum
        print(f"  {yr}: cube {s_cube:,}  heat grid {grid} {size // 1024} KB  no/out-of-bbox coords {heat_gap[yr]:,}  ({time.time() - t0:.0f}s)")

    races = sorted((r for r in races_n if r != "Unknown"), key=lambda r: -races_n[r]) + ["Unknown"]
    rix = {r: i for i, r in enumerate(races)}
    sx = {s: i for i, s in enumerate(SEXES)}
    demo_out = {
        "sex": [[p, y, sx[s], v, n] for (p, y, s, v), n in sorted(demo["sex"].items(), key=lambda kv: (kv[0][0], kv[0][1], sx[kv[0][2]], kv[0][3]))],
        "race": [[p, y, rix[s], v, n] for (p, y, s, v), n in sorted(demo["race"].items(), key=lambda kv: (kv[0][0], kv[0][1], rix[kv[0][2]], kv[0][3]))],
        "age": [[*k, n] for k, n in sorted(demo["age"].items())],
    }
    cube_rows = [[*k, n] for k, n in sorted(cube.items())]

    # ---- checks
    cube_sum = sum(cube.values())
    checks = []

    def check(name, ok, detail):
        checks.append(f"[{'OK' if ok else 'FAIL'}] {name}: {detail}")
        return ok

    ok = check("cube + unmatched == total", cube_sum + unmatched == total, f"{cube_sum:,} + {unmatched} = {cube_sum + unmatched:,} vs {total:,}")
    for k, rows in demo_out.items():
        ok &= check(f"demo.{k} sum == cube", sum(r[4] for r in rows) == cube_sum, f"{sum(r[4] for r in rows):,}")
    k0 = sum(cal_off[:Y * 84])
    ok &= check("calendar.offense k=0 == total", k0 == total, f"{k0:,}")
    for k in range(1, NTOP + 1):
        exp = offenses[top[k - 1]]["n"]
        got = sum(cal_off[k * Y * 84:(k + 1) * Y * 84])
        ok &= check(f"calendar.offense k={k} == offense n", got == exp, f"{got:,} vs {exp:,}")
    ok &= check("calendar.precinct == cube", sum(cal_pct) == cube_sum, f"{sum(cal_pct):,}")
    ok &= check("pd rows == cube", sum(pdcube.values()) == cube_sum, f"{sum(pdcube.values()):,}")
    # spot check precinct 75 / 2019
    direct = int(soql("spot-75-2019", "count(*) as n", where=f"arrest_precinct=75 and {year_where(2019)}")[0]["n"])
    mine = sum(n for (p, y, o, s), n in cube.items() if p == P[75] and y == YEARS.index(2019))
    ok &= check("precinct 75 / 2019 cube == API", mine == direct, f"{mine:,} vs {direct:,}")
    # calendar orientation: per-day counts for March 2019, weekday computed in Python
    day = soql("days-2019-03", "arrest_date, count(*) as n", "arrest_date",
               "arrest_date between '2019-03-01T00:00:00' and '2019-03-31T23:59:59'")
    by_dow = [0] * 7
    for r in day:
        by_dow[datetime.fromisoformat(r["arrest_date"][:10]).weekday()] += int(r["n"])
    yi = YEARS.index(2019)
    mine = cal_off[(yi * 12 + 2) * 7:(yi * 12 + 2) * 7 + 7]
    ok &= check("calendar Mar-2019 Monday-first == Python weekday()", mine == by_dow, f"{mine}")
    # heat orientation: a known point must land in the expected cell
    lat, lon = 40.75723226, -73.98979219
    g0, s0 = heat_sizes[2025]
    a, b = math.floor(lat / g0 + 0.5), math.floor(lon / g0 + 0.5)
    h = json.load(open(os.path.join(DATA, "heat", "2025.json")))["cells"]["all"]
    hit = any(h[i] == a and h[i + 1] == b for i in range(0, len(h), 3))
    ok &= check("heat 2025 known point cell present", hit and abs(a * g0 - lat) <= g0 / 2 and abs(b * g0 - lon) <= g0 / 2, f"({a},{b})")
    gap_api = {int(r["y"]): int(r["n"]) for r in soql("heat-gap", "date_extract_y(arrest_date) as y, count(*) as n", "y",
                                                         f"latitude is null or longitude is null or not ({BBOX})")}
    ok &= check("heat gap == API rows with null/out-of-bbox coords (per year)",
                all(gap_api.get(y, 0) == heat_gap[y] for y in YEARS), f"{sum(gap_api.values()):,} rows total")
    kys = ",".join(str(k) for k in top_ky)
    layer_api = Counter({(int(r["y"]), num(r["ky_cd"])): int(r["n"]) for r in soql(
        "heat-layer-sums", "date_extract_y(arrest_date) as y, ky_cd, count(*) as n", "y, ky_cd", f"{BBOX} and ky_cd in ({kys})")})
    bad = []
    for yr in YEARS:
        cells = json.load(open(os.path.join(DATA, "heat", f"{yr}.json")))["cells"]
        for i in top:
            if sum(cells[str(i)][2::3]) != layer_api[(yr, offenses[i]["ky"])]:
                bad.append((yr, i))
    ok &= check("heat offense layers == API in-bbox counts per year x offense", not bad, f"mismatches {bad[:5]}")
    for yr in YEARS:
        checks.append(f"       heat {yr}: all-cells = year total - {heat_gap[yr]:,} rows with missing/out-of-bbox coords "
                      f"({heat_gap[yr] / ytot[yr]:.3%}), grid {heat_sizes[yr][0]}, {heat_sizes[yr][1]:,} B")

    # ---- write
    sizes = {}
    sizes["cube.json"] = dump({"rows": cube_rows}, "cube.json")
    sizes["demo.json"] = dump(demo_out, "demo.json")
    sizes["calendar.json"] = dump({"offense": cal_off, "precinct": cal_pct}, "calendar.json")
    by_p = defaultdict(list)
    for (p, y, o, d), n in sorted(pdcube.items()):
        by_p[p].append([y, o, d, n])
    pd_total = sum(dump({"rows": by_p.get(i, [])}, f"pd/{pid}.json") for i, pid in enumerate(ids))
    meta = {
        "total": total, "years": YEARS, "severities": SEV,
        "offenses": offenses, "top_offenses": top, "pds": pds, "precincts": precincts,
        "sexes": SEXES, "races": races, "ages": AGES,
        "unmatched_precinct_arrests": unmatched,
        "unmatched_precincts": {str(k): v for k, v in no_poly.items()},
        "calendar_index": {"offense": "[(k*Y + y)*12 + m]*7 + d; k=0 all offenses, k=1..15 = top_offenses[k-1]",
                           "precinct": "[(p*Y + y)*12 + m]*7 + d; all offenses",
                           "Y": Y, "m": "0..11, Jan=0", "d": "0..6, 0=Monday"},
        "heat": {"index": "idx = floor(value/grid + 0.5) (round half up); cell centre lat = latIdx*grid, lon = lonIdx*grid; cell spans +-grid/2",
                 "grid_by_year": {str(y): heat_sizes[y][0] for y in YEARS},
                 "bbox": {"lat": [40.4, 41.0], "lon": [-74.3, -73.6]},
                 "excluded_no_or_out_of_bbox_coords": {str(y): heat_gap[y] for y in YEARS}},
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {"arrests": ARRESTS, "precincts": PRECINCTS, "population": pop_note},
    }
    sizes["meta.json"] = dump(meta, "meta.json")
    sizes["precincts.geojson"] = os.path.getsize(os.path.join(DATA, "precincts.geojson"))

    print("\n".join(report))
    print("\n".join(checks))
    print(f"cube rows {len(cube_rows):,}; demo rows sex {len(demo_out['sex']):,} race {len(demo_out['race']):,} age {len(demo_out['age']):,}")
    for k, v in sizes.items():
        print(f"  data/{k:18s} {v / 1024:8.1f} KB")
    print(f"  core total {sum(sizes.values()) / 1e6:.2f} MB; heat/ {sum(s for _, s in heat_sizes.values()) / 1e6:.2f} MB; pd/ {pd_total / 1e6:.2f} MB")
    print(f"top-15: {[offenses[i]['label'] for i in top]}")
    print(f"races: {races}")
    print(f"done in {time.time() - t0:.0f}s")
    assert ok, "checks failed"


if __name__ == "__main__":
    main()
