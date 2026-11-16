// View A — Leaflet precinct map: choropleth | density heat | donut clusters
(function () {
  "use strict";

  const SPLIT_ZOOM = 12;   // donuts: borough aggregates below, precinct markers at/above
  const LABEL_ZOOM = 12.5; // precinct number labels
  const SEV_NAMES = ["Felony", "Misdemeanor", "Violation", "Other"];

  window.MapView = function (M, geo, S, ctx) {
    const { tok, fmt, el } = ctx;
    const map = L.map("map", { zoomSnap: 0.5, minZoom: 9, maxZoom: 16, attributionControl: true });
    const NYC = [[40.50, -74.26], [40.91, -73.70]];
    map.fitBounds(NYC);
    map.createPane("polys").style.zIndex = 450;
    map.createPane("labels").style.zIndex = 620;
    map.getPane("labels").style.pointerEvents = "none";

    let tiles = null;
    function setTiles() {
      if (tiles) map.removeLayer(tiles);
      const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
      // CARTO basemaps now require an API key (tiles come back watermarked), so use Esri's keyless gray canvas.
      tiles = L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${dark ? "World_Dark_Gray_Base" : "World_Light_Gray_Base"}/MapServer/tile/{z}/{y}/{x}`, {
        attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 16,
      }).addTo(map);
    }
    setTiles();

    // ---- precinct polygons ----
    const layers = [];
    const poly = L.geoJSON(geo, {
      pane: "polys",
      style: () => ({ weight: 0.6, fillOpacity: 0.85, className: "pct" }),
      onEachFeature(f, layer) {
        layer.pIdx = M.pIndex.get(f.properties.id);
        layers.push(layer);
        layer.bindTooltip(() => tipEl(layer.pIdx), { sticky: true, direction: "top", offset: [0, -8] });
        layer.on("click", () => ctx.toggle(layer.pIdx));
      },
    }).addTo(map);

    // ---- labels ----
    const labels = L.layerGroup(M.meta.precincts.map((d) =>
      L.marker([d.lat, d.lon], {
        pane: "labels", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "pct-label", html: String(d.id), iconSize: [24, 12] }),
      })));

    // ---- heat ----
    const heatCache = new Map();
    const getHeat = (yr) => {
      if (!heatCache.has(yr)) heatCache.set(yr, fetch(`data/heat/${yr}.json`).then((r) => {
        if (!r.ok) throw new Error(r.status); return r.json();
      }).catch((e) => { heatCache.delete(yr); throw e; }));
      return heatCache.get(yr);
    };
    let heat = null;

    // ---- donuts ----
    const donuts = L.layerGroup();
    const boroCentre = new Map();
    for (const b of M.boroughs) {
      const ps = M.meta.precincts.filter((d) => d.boro === b);
      boroCentre.set(b, [d3.mean(ps, (d) => d.lat), d3.mean(ps, (d) => d.lon)]);
    }
    const boroMaxCache = new Map();
    function boroMax(o) {
      if (!boroMaxCache.has(o)) {
        let mx = 1;
        for (let y = 0; y < M.Y; y++) for (const b of M.boroughs) mx = Math.max(mx, d3.sum(M.boroSevMix(b, y, o)));
        boroMaxCache.set(o, mx);
      }
      return boroMaxCache.get(o);
    }

    function donutIcon(mix, r, label) {
      const total = d3.sum(mix);
      const cols = [tok("--sev-f"), tok("--sev-m"), tok("--sev-v"), tok("--sev-o")];
      const arcs = d3.pie().sort(null).padAngle(total ? 0.03 : 0)(mix);
      const arc = d3.arc().innerRadius(r * 0.62).outerRadius(r);
      const paths = total ? arcs.map((a, i) => a.value ? `<path d="${arc(a)}" fill="${cols[i]}"/>` : "").join("") : "";
      const s = r * 2 + 4;
      const fs = Math.max(9, Math.min(13, r * 0.5));
      const html = `<svg width="${s}" height="${s}" viewBox="${-s / 2} ${-s / 2} ${s} ${s}">` +
        `<circle class="hole" r="${r}" />${paths}` +
        `<text text-anchor="middle" dy="0.35em" style="font-size:${fs}px">${label}</text></svg>`;
      return L.divIcon({ className: "donut", html, iconSize: [s, s] });
    }

    function drawDonuts() {
      donuts.clearLayers();
      const y = S.year, o = S.offense;
      if (map.getZoom() < SPLIT_ZOOM) {
        const rs = d3.scaleSqrt().domain([0, boroMax(o)]).range([0, 46]);
        for (const b of M.boroughs) {
          const mix = M.boroSevMix(b, y, o), n = d3.sum(mix);
          const m = L.marker(boroCentre.get(b), { icon: donutIcon(mix, Math.max(14, rs(n)), fmt.compact(n)), keyboard: true, title: b });
          m.bindTooltip(() => mixTip(b, `${b} · ${M.meta.years[y]}`, mix), { direction: "top" });
          m.on("click", () => map.flyTo(boroCentre.get(b), SPLIT_ZOOM + 0.5, { duration: ctx.reduced ? 0 : 0.6 }));
          donuts.addLayer(m);
        }
      } else {
        const rs = d3.scaleSqrt().domain([0, M.domainMax(o, "count")]).range([0, 26]);
        M.meta.precincts.forEach((d, p) => {
          if (!M.hasData(p, y)) return;
          const mix = M.sevMix(p, y, o), n = d3.sum(mix);
          const m = L.marker([d.lat, d.lon], { icon: donutIcon(mix, Math.max(9, rs(n)), fmt.compact(n)), keyboard: true, title: `Precinct ${d.id}` });
          m.bindTooltip(() => mixTip(p, `Precinct ${d.id} · ${d.boro} · ${M.meta.years[y]}`, mix), { direction: "top" });
          m.on("click", () => ctx.toggle(p));
          donuts.addLayer(m);
        });
      }
    }

    function mixTip(_, title, mix) {
      const n = d3.sum(mix);
      const cols = ["--sev-f", "--sev-m", "--sev-v", "--sev-o"];
      return el("div", {}, [
        el("div", {}, [el("b", { text: fmt.int(n) + " arrests" })]),
        el("div", { text: title }),
        ...mix.map((v, i) => el("div", { class: "tl" }, [
          el("span", { class: "sw line", style: `background:${tok(cols[i])}` }),
          el("span", { text: `${SEV_NAMES[i]}: ${fmt.int(v)} (${n ? fmt.pct(v / n) : "–"})` }),
        ])),
      ]);
    }

    // ---- tooltip for polygons ----
    let cur = { vals: null, thr: Infinity };
    function tipEl(p) {
      const d = M.meta.precincts[p], y = S.year, yr = M.meta.years[y];
      const lines = [];
      let head;
      if (!M.hasData(p, y)) head = `no data (precinct created ${M.created(p)})`;
      else if (S.mode === "rate" && p === M.p22) head = `${fmt.int(M.value(p, y, S.offense))} arrests · per 10k n/a (park)`;
      else {
        const v = M.metric(p, y, S.offense, S.mode);
        head = S.mode === "rate" ? `${fmt.dec(v)} per 10k residents` : `${fmt.int(v)} arrests`;
        const r = M.rank(p, y, S.offense, S.mode);
        if (r) lines.push(`rank ${r.rank} / ${r.of}`);
        if (!isNaN(cur.vals[p]) && cur.vals[p] > cur.thr) lines.push("statistical outlier (> Q3 + 1.5·IQR)");
        if (M.partial(p, y)) lines.push(`partial year — precinct created ${M.created(p)}`);
        if (S.mode === "rate" && [105, 113].includes(d.id) && yr < 2025) lines.push("rate uses pre-split population (before 116 was carved out)");
        if (S.mode === "rate" && [120, 122].includes(d.id) && yr < 2014) lines.push("rate inflated: population is after the 2013 split (121)");
      }
      return el("div", {}, [
        el("div", {}, [el("b", { text: head })]),
        el("div", { text: `Precinct ${d.id} · ${d.boro} · ${yr}` }),
        el("div", { text: ctx.offenseLabel() }),
        ...lines.map((t) => el("div", { text: t })),
      ]);
    }

    // ---- update ----
    let lastLayer = null;
    function update() {
      const y = S.year, o = S.offense, mode = S.mode, lyr = S.layer;
      const vals = M.values(y, o, mode), thr = M.outlierThreshold(y, o, mode);
      cur = { vals, thr };
      const seq = tok("--seq").split(",").map((s) => s.trim());
      const color = d3.scaleSequentialSqrt(d3.interpolateRgbBasis(seq)).domain([0, M.domainMax(o, mode)]);
      const ink = tok("--ink"), edge = tok("--surface"), muted = tok("--muted");

      for (const l of layers) {
        const p = l.pIdx, v = vals[p], nod = !M.hasData(p, y);
        const out = !isNaN(v) && v > thr, sel = S.precinct === p;
        const fillColor = nod ? tok("--nodata") : isNaN(v) && !M.partial(p, y) ? tok("--nodata")
          : color(M.metric(p, y, o, mode));
        const st = lyr === "choro"
          ? { fillColor, fillOpacity: 0.85, color: sel || out ? ink : edge, weight: sel ? 3 : out ? 2 : 0.7, dashArray: out && !sel ? "5 3" : null }
          : { fillColor: ink, fillOpacity: sel ? 0.08 : 0, color: sel ? ink : muted, weight: sel ? 3 : 0.8, dashArray: null };
        l.setStyle(st);
        const e = l.getElement();
        if (e) e.classList.toggle("nodata", lyr === "choro" && nod);
        if (sel) l.bringToFront();
      }

      // layers
      if (lyr !== lastLayer) {
        // leaflet.heat throws if removed while a redraw frame is pending, so empty it instead of removing
        if (heat && lyr !== "heat") heat.setLatLngs([]);
        if (map.hasLayer(donuts)) map.removeLayer(donuts);
        if (lyr === "donut") donuts.addTo(map);
        lastLayer = lyr;
      }
      ctx.noteEl.hidden = true;
      if (lyr === "heat") updateHeat();
      if (lyr === "donut") drawDonuts();
      syncLabels();
      legend(color, thr);
    }

    function updateHeat() {
      const yr = M.meta.years[S.year], o = S.offense;
      const key = o != null && M.topIdx.includes(o) ? String(o) : "all";
      if (o != null && key === "all") {
        ctx.noteEl.textContent = "Heat available for the 15 largest offenses — showing all offenses.";
        ctx.noteEl.hidden = false;
      }
      getHeat(yr).then((h) => {
        if (M.meta.years[S.year] !== yr || S.layer !== "heat") return; // stale
        const c = h.cells[key] || [], pts = [], ns = [];
        for (let i = 0; i < c.length; i += 3) { pts.push([c[i] * h.grid, c[i + 1] * h.grid, c[i + 2]]); ns.push(c[i + 2]); }
        ns.sort(d3.ascending);
        const max = d3.quantileSorted(ns, 0.98) || 1;
        const seq = tok("--seq").split(",").map((s) => s.trim());
        const gradient = { 0.15: seq[1], 0.35: seq[2], 0.55: seq[3], 0.75: seq[4], 0.9: seq[5], 1: seq[6] };
        if (!heat) heat = L.heatLayer(pts, { radius: 12, blur: 14, maxZoom: 10, minOpacity: 0.25, max, gradient });
        else { heat.setOptions({ max, gradient }); heat.setLatLngs(pts); }
        if (!map.hasLayer(heat)) heat.addTo(map);
      }).catch(() => {
        ctx.noteEl.textContent = "Could not load heat data for " + yr + ".";
        ctx.noteEl.hidden = false;
      });
    }

    function syncLabels() {
      const want = S.layer !== "donut" && map.getZoom() >= LABEL_ZOOM;
      if (want && !map.hasLayer(labels)) labels.addTo(map);
      if (!want && map.hasLayer(labels)) map.removeLayer(labels);
    }
    map.on("zoomend", () => (S.layer === "donut" ? update() : syncLabels()));

    function legend(color, thr) {
      const box = ctx.legendEl;
      box.replaceChildren();
      const row = (kids) => box.appendChild(el("div", { class: "row" }, kids));
      if (S.layer === "choro") {
        const max = color.domain()[1];
        const unit = S.mode === "rate" ? "Arrests per 10k residents" : "Arrests (count)";
        box.appendChild(el("div", { text: `${unit} · scale fixed across 2006–2025` }));
        const stops = d3.range(0, 1.0001, 0.1).map((t) => `${color(t * t * max)} ${t * 100}%`).join(",");
        box.appendChild(el("div", { class: "gradbar", style: `background:linear-gradient(90deg,${stops})` }));
        const tk = [0, 0.25, 0.5, 0.75, 1].map((t) => el("span", { text: fmt.compact(t * t * max) }));
        box.appendChild(el("div", { class: "gradticks" }, tk));
        row([el("span", { class: "sw outl" }), el("span", { text: `Outlier: > Q3 + 1.5·IQR (${isFinite(thr) ? fmt.compact(thr) : "–"})` })]);
        row([el("span", { class: "sw hatch" }), el("span", { text: "No data — precinct not yet created (121 before Jul 2013, 116 before Dec 2024)" })]);
        if (S.mode === "rate") row([el("span", { class: "sw", style: `background:${tok("--nodata")}` }), el("span", { text: "n/a — Central Park (pop. 129)" })]);
      } else if (S.layer === "heat") {
        const seq = tok("--seq").split(",").map((s) => s.trim()).slice(1);
        box.appendChild(el("div", { text: "Arrest density (relative within year; 400 m grid)" }));
        box.appendChild(el("div", { class: "gradbar", style: `background:linear-gradient(90deg,${seq.join(",")})` }));
        box.appendChild(el("div", { class: "gradticks" }, [el("span", { text: "lower" }), el("span", { text: "higher" })]));
      } else {
        box.appendChild(el("div", { text: "Ring: severity mix · centre: arrests · size ∝ √arrests" }));
        ["--sev-f", "--sev-m", "--sev-v", "--sev-o"].forEach((t, i) =>
          row([el("span", { class: "sw", style: `background:${tok(t)}` }), el("span", { text: SEV_NAMES[i] + (i === 3 ? " (infraction / unknown)" : "") })]));
        box.appendChild(el("div", { text: map.getZoom() < SPLIT_ZOOM ? "Boroughs — click or zoom in to split into precincts" : "Precincts — click to select" }));
      }
    }

    // keep Leaflet in sync if the map box ever changes size (layout, banners, window)
    new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById("map"));
    // container may still be settling at init; refit once laid out
    requestAnimationFrame(() => { map.invalidateSize(); map.fitBounds(NYC); });
    return { update, setTiles, map, invalidate: () => map.invalidateSize() };
  };
})();
