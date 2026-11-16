// App: global state, controls, views B (detail), C (waffles), D (calendar)
(function () {
  "use strict";

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const DUR = reduced ? 0 : 250;
  const SEV_NAMES = ["Felony", "Misdemeanor", "Violation", "Other"];
  const SEV_TOK = ["--sev-f", "--sev-m", "--sev-v", "--sev-o"];
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const COHORT_TOK = {
    sex: ["--sex-m", "--sex-f", "--unk"],
    race: ["--race-1", "--race-2", "--race-3", "--race-4", "--race-5", "--race-other", "--unk"],
    age: ["--age-1", "--age-2", "--age-3", "--age-4", "--age-5", "--unk"],
  };

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const rootStyle = () => getComputedStyle(document.documentElement);
  const tok = (name) => rootStyle().getPropertyValue(name).trim();
  const fmt = {
    int: d3.format(","),
    dec: (v) => (v < 10 ? d3.format(",.1f")(v) : d3.format(",.0f")(v)),
    pct: d3.format(".1%"),
    compact: (v) => (v < 10000 ? d3.format(",.0f")(v) : d3.format(".3~s")(v).replace("k", "K")),
  };
  function el(tag, attrs = {}, kids = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") e.textContent = v;
      else if (k === "class") e.className = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids) e.appendChild(k);
    return e;
  }
  const tipBox = $("#tooltip");
  function showTip(evt, node) {
    tipBox.replaceChildren(node);
    tipBox.hidden = false;
    let x, y;
    if (evt.clientX != null && evt.clientX !== 0) { x = evt.clientX; y = evt.clientY; }
    else { const r = evt.target.getBoundingClientRect(); x = r.right; y = r.top; }
    const w = tipBox.offsetWidth, h = tipBox.offsetHeight;
    tipBox.style.left = Math.min(innerWidth - w - 8, x + 14) + "px";
    tipBox.style.top = Math.max(8, y - h - 10) + "px";
  }
  const hideTip = () => (tipBox.hidden = true);
  const tipLines = (head, lines, key) => el("div", {}, [
    el("div", { class: "tl" }, [
      ...(key ? [el("span", { class: "sw line", style: `background:${key}` })] : []),
      el("b", { text: head }),
    ]),
    ...lines.map((t) => el("div", { text: t })),
  ]);
  // horizontal bar path: square at baseline, 4px rounded data end
  const barPath = (x, y, w, h) => {
    const r = Math.min(4, w / 2, h / 2);
    if (w <= 0) return `M${x},${y}h0v${h}h0z`;
    return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`;
  };

  // ---------- load ----------
  const loadingEl = $("#loading");
  const getJSON = (f) => fetch(f).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); });
  Promise.all(["data/meta.json", "data/cube.json", "data/demo.json", "data/calendar.json", "data/precincts.geojson"].map(getJSON))
    .then(([meta, cube, demo, cal, geo]) => {
      init(NYCData.build(meta, cube, demo, cal), geo);
      loadingEl.remove();
    })
    .catch((err) => {
      console.error(err);
      loadingEl.classList.add("err");
      const hint = location.protocol === "file:"
        ? "This page was opened directly from disk (file://), where browsers block loading the data files. Run a local server in the project folder, e.g. `python3 -m http.server 8000`, and open http://localhost:8000/."
        : "Check your connection and that the data/ folder is deployed next to index.html.";
      loadingEl.replaceChildren(el("div", {}, [el("b", { text: "Could not load the data." }), el("p", { text: hint }), el("p", { class: "muted", text: String(err.message || err) })]));
    });

  function init(M, geo) {
    const meta = M.meta, Y = M.Y;
    const S = { year: Y - 2, offense: null, precinct: null, layer: "choro", mode: "count", dim: "sex", wper: "year", cmode: "abs", cper: "year",
      xf: null }; // cross-filter: null | {kind:"cohort", dim, key} | {kind:"dow", d}
    const offenseLabel = (o = S.offense) => (o == null ? "All offenses" : meta.offenses[o].label);

    // sources in footer
    $("#srcArrests").href = meta.source.arrests;
    $("#srcPrecincts").href = meta.source.precincts;
    $("#srcPop").textContent = "2020 census, aggregated to precincts (census-by-precincts, J. Keefe)";

    // ---------- controls ----------
    const sel = $("#offense");
    sel.appendChild(el("option", { value: "", text: "All offenses" }));
    const g1 = el("optgroup", { label: "15 largest offense categories" }), g2 = el("optgroup", { label: "All other categories (by arrests)" });
    meta.offenses.forEach((o, i) => (M.topIdx.includes(i) ? g1 : g2).appendChild(el("option", { value: i, text: `${o.label} (${fmt.compact(o.n)})` })));
    sel.append(g1, g2);
    sel.addEventListener("change", () => set({ offense: sel.value === "" ? null : +sel.value }));

    const slider = $("#year");
    slider.min = meta.years[0]; slider.max = meta.years[Y - 1];
    slider.addEventListener("input", () => set({ year: +slider.value - meta.years[0] }));
    const playBtn = $("#play");
    let timer = null;
    const stop = () => { clearInterval(timer); timer = null; playBtn.textContent = "▶"; playBtn.setAttribute("aria-label", "Play years"); };
    playBtn.addEventListener("click", () => {
      if (timer) return stop();
      if (S.year === Y - 1) set({ year: 0 });
      playBtn.textContent = "❚❚"; playBtn.setAttribute("aria-label", "Pause");
      timer = setInterval(() => { if (S.year >= Y - 1) return stop(); set({ year: S.year + 1 }); if (S.year >= Y - 1) stop(); }, 1000);
    });

    for (const [attr, key] of [["layer", "layer"], ["mode", "mode"], ["dim", "dim"], ["wper", "wper"], ["cmode", "cmode"], ["cper", "cper"]]) {
      document.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener("click", () => set({ [key]: b.dataset[attr] })));
    }
    // Esc clears the most recent layer first: the cross-filter, then the precinct
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (S.xf) set({ xf: null }); else if (S.precinct != null) set({ precinct: null });
    });

    // ---------- state ----------
    let pending = false; // coalesce several set() calls in one task into one render
    function set(patch) {
      Object.assign(S, patch);
      if (!pending) { pending = true; queueMicrotask(() => { pending = false; render(); }); }
    }
    const toggle = (p) => set({ precinct: S.precinct === p ? null : p });
    const sameXf = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind === "dow" ? a.d === b.d : a.dim === b.dim && a.key === b.key);
    const toggleXf = (xf) => set({ xf: sameXf(S.xf, xf) ? null : xf }); // one at a time: a new one replaces the old
    const DIM_NAME = { sex: "Sex", race: "Race", age: "Age" };
    const xfLabel = (xf = S.xf) => !xf ? null : xf.kind === "dow" ? `Weekday: ${DAYS[xf.d]}`
      : `${DIM_NAME[xf.dim]}: ${xf.dim === "race" && xf.key === 5 ? "Other" : M.cohorts[xf.dim].labels[xf.key]}`;

    // ---------- lazy cross-filter slices (data/x) ----------
    // Each file is fetched once, indexed once into typed arrays, cached; a resolved fetch re-renders.
    const files = new Map();
    function need(url, transform) {
      let e = files.get(url);
      if (!e) {
        e = { status: "pending" };
        files.set(url, e);
        getJSON(url).then((v) => { e.value = transform(v); e.status = "ok"; })
          .catch((err) => { console.warn(err); e.status = "error"; e.err = err; })
          .finally(() => set({}));
      }
      return e;
    }
    const all = (entries) => entries.find((e) => e.status === "error") || entries.find((e) => e.status === "pending")
      || { status: "ok", values: entries.map((e) => e.value) };
    const cohortRaw = (dim, i) => need(`data/x/${dim}_${i}.json`, (v) => ({
      cube: M.indexCube([v.rows], `${dim}:${i}`), calOff: v.cal_offense, calPre: v.cal_precinct }));
    const folded = new Map();
    function cohortSlice(dim, key) { // folded cohort (race "Other" = race_5 + race_6)
      const st = all(M.rawCohorts(dim, key).map((i) => cohortRaw(dim, i)));
      if (st.status !== "ok") return st;
      const k = dim + ":" + key;
      if (!folded.has(k)) folded.set(k, { status: "ok", value: {
        cube: M.sumCubes(st.values.map((v) => v.cube), k),
        calOff: M.sumArrays(st.values.map((v) => v.calOff)), calPre: M.sumArrays(st.values.map((v) => v.calPre)) } });
      return folded.get(k);
    }
    const dowSlice = (d) => need(`data/x/dow_${d}.json`, (v) => ({ cube: M.indexCube([v.rows], "dow:" + d), dims: M.indexDemo(v) }));
    const calPrecinct = (p) => need(`data/x/cal_p${meta.precincts[p].id}.json`, (v) => M.decodeSparse(v.cells));
    const calOffenseAll = () => need("data/x/cal_offense_all.json", (v) => Int32Array.from(v.cal));
    const xfSlice = () => (S.xf.kind === "dow" ? dowSlice(S.xf.d) : cohortSlice(S.xf.dim, S.xf.key));

    // per-view status pill + dimmed previous render; "Loading…" only after 300 ms so fast loads never flash
    const busyTimers = {};
    function status(view, st, what) {
      const panel = $("#" + view), pill = panel.querySelector(".vstatus");
      clearTimeout(busyTimers[view]);
      if (st.status === "pending") {
        busyTimers[view] = setTimeout(() => {
          panel.classList.add("busy");
          pill.classList.remove("err"); pill.textContent = `Loading ${what}…`; pill.hidden = false;
        }, 300);
        return false;
      }
      panel.classList.remove("busy");
      if (st.status === "error") {
        pill.classList.add("err"); pill.hidden = false;
        pill.textContent = `Could not load ${what} — showing the previous view. Check the connection and reload.`;
        return false;
      }
      pill.hidden = true;
      return true;
    }

    const mapView = MapView(M, geo, S, {
      tok, fmt, el, toggle, offenseLabel, reduced, xfLabel: () => xfLabel(),
      legendEl: $("#mapLegend"), noteEl: $("#mapNote"),
    });

    function syncControls() {
      slider.value = meta.years[S.year];
      $("#yearOut").textContent = meta.years[S.year];
      sel.value = S.offense == null ? "" : String(S.offense);
      for (const attr of ["layer", "mode", "dim", "wper", "cmode", "cper"])
        document.querySelectorAll(`[data-${attr}]`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === S[attr])));
      const chip = $("#selChip");
      chip.replaceChildren();
      if (S.precinct == null) { chip.className = "chip-static"; chip.textContent = "Citywide — click a precinct"; chip.title = "Citywide: click a precinct on the map to select it"; }
      else {
        const d = meta.precincts[S.precinct];
        chip.className = ""; chip.title = "";
        const b = el("button", { class: "chip-x", type: "button", title: `Precinct ${d.id} · ${d.boro} — click or Esc to clear`, "aria-label": `Clear precinct ${d.id} selection`, text: `Precinct ${d.id} · ${d.boro}  ×` });
        b.addEventListener("click", () => set({ precinct: null }));
        chip.appendChild(b);
      }
      const xc = $("#xfChip");
      xc.replaceChildren();
      if (!S.xf) { xc.className = "chip-static"; xc.textContent = "none — click a cohort or weekday"; xc.title = "None: click a waffle cohort (cell or legend) or a calendar weekday to cross-filter the other views"; }
      else {
        xc.className = ""; xc.title = "";
        const b = el("button", { class: "chip-x", type: "button", "aria-label": `Clear cross-filter ${xfLabel()}`, title: `${xfLabel()} — click or Esc to clear`, text: `${xfLabel()}  ×` });
        b.addEventListener("click", () => set({ xf: null }));
        xc.appendChild(b);
      }
    }

    function render() {
      syncControls();
      const yr = meta.years[S.year];
      // A + B run on "the active cube": the full data, or the cross-filter slice once it is loaded
      const xs = S.xf ? xfSlice() : { status: "ok" };
      const xfWhat = S.xf ? `${xfLabel()} slice` : "";
      const okA = status("viewA", xs, xfWhat), okB = status("viewB", xs, xfWhat);
      if (okA && okB) {
        M.useCube(S.xf ? xs.value.cube : null);
        const xf = xfLabel();
        $("#subA").textContent = `${xf ? xf + " · " : ""}${offenseLabel()} · ${yr} · ${S.layer === "choro" ? (S.mode === "rate" ? `arrests per 10k residents${xf ? " (all residents)" : ""}` : "arrest count") : S.layer === "heat" ? "point density (not cross-filtered)" : "severity mix"} · click a precinct to filter the other views`;
        mapView.update();
        renderB();
      }
      renderC();
      renderD();
      // headers never wrap; full text of ellipsized titles/subtitles on hover
      document.querySelectorAll(".phead h2, .phead .psub").forEach((e) => (e.title = e.textContent));
    }

    // =====================================================================
    // View B — detail
    // =====================================================================
    const pdCache = new Map();
    const getPd = (id) => {
      if (!pdCache.has(id)) pdCache.set(id, getJSON(`data/pd/${id}.json`).catch((e) => { pdCache.delete(id); throw e; }));
      return pdCache.get(id);
    };

    function renderB() {
      const p = S.precinct, y = S.year, o = S.offense, yr = meta.years[y];
      const d = p == null ? null : meta.precincts[p];
      $("#bTitle").textContent = d ? `Precinct ${d.id} · ${d.boro}` : "New York City";
      // header line
      let head;
      if (d && !M.hasData(p, y)) head = `${yr} — no data (precinct created ${M.created(p)})`;
      else {
        const n = p == null ? M.city(y, o) : M.value(p, y, o);
        const parts = [`${yr} — ${fmt.int(n)} arrests${o != null ? " (" + offenseLabel() + ")" : ""}`];
        if (d) {
          const r = M.rank(p, y, o, S.mode);
          if (r) parts.push(`rank ${r.rank} / ${r.of}${S.mode === "rate" ? " per capita" : ""}`);
          if (M.partial(p, y)) parts.push("partial year");
          parts.push(p === M.p22 ? "per 10k n/a (park)" : `${fmt.dec((n / M.pop(p, y)) * 1e4)} per 10k residents${S.xf ? " (all residents)" : ""}`);
        } else parts.push(`${fmt.dec((n / M.cityPop) * 1e4)} per 10k residents${S.xf ? " (all residents)" : ""}`);
        head = parts.join(" · ");
      }
      $("#subB").textContent = (xfLabel() ? xfLabel() + " · " : "") + head;
      renderBars(p, y, o);
      renderDrill(p, y, o);
      renderLine(p, o);
      renderSev(p, y, o);
    }

    function renderBars(p, y, o) {
      const svg = d3.select("#bars");
      const W = svg.node().clientWidth || 400;
      const rank = M.offenseRanking(p, y);
      let rows = rank.slice(0, 10).map((r) => ({ ...r, key: r.o }));
      if (o != null && !rows.some((r) => r.o === o)) {
        const hit = rank.find((r) => r.o === o);
        rows.push({ o, n: hit ? hit.n : 0, key: o, pinned: true });
      }
      const shown = new Set(rows.map((r) => r.o));
      const rest = d3.sum(rank.filter((r) => !shown.has(r.o)), (r) => r.n);
      if (rest > 0) rows.push({ o: null, n: rest, key: "other", other: true, cnt: rank.length - shown.size });
      $("#bBarsNote").textContent = `— ${meta.years[y]}, click a bar to filter by offense`;

      const RH = 19, labelW = Math.min(230, W * 0.5), valW = 46;
      const H = rows.length * RH + 30;
      svg.attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
      // "Other" is an aggregate of many categories: value only, no bar, so it does not squash the scale
      const x = d3.scaleLinear().domain([0, d3.max(rows, (r) => (r.other ? 0 : r.n)) || 1]).range([0, W - labelW - valW]).nice();
      const bw = (r) => (r.other ? 0 : x(r.n));
      const t = svg.transition().duration(DUR).ease(d3.easeCubicOut);

      const g = svg.selectAll("g.row").data(rows, (r) => r.key).join(
        (enter) => {
          const e = enter.append("g").attr("class", "row").attr("transform", (_, i) => `translate(0,${i * RH})`);
          e.append("rect").attr("class", "hit");
          e.append("path").attr("class", "bar").attr("d", barPath(labelW, 4, 0, RH - 8));
          e.append("text").attr("class", "lab").attr("text-anchor", "end").attr("dy", "0.35em");
          e.append("text").attr("class", "val").attr("dy", "0.35em");
          return e;
        });
      g.classed("sel", (r) => r.o != null && r.o === o).classed("other", (r) => !!r.other)
        .attr("tabindex", (r) => (r.other ? null : 0)).attr("role", (r) => (r.other ? null : "button"))
        .attr("aria-label", (r) => (r.other ? null : `${meta.offenses[r.o].label}: ${fmt.int(r.n)} arrests`));
      g.transition(t).attr("transform", (_, i) => `translate(0,${i * RH})`);
      g.select(".hit").attr("x", 0).attr("y", 0).attr("width", W).attr("height", RH);
      g.select(".bar").transition(t).attr("d", (r) => barPath(labelW, 4, bw(r), RH - 8));
      g.select(".lab").attr("x", labelW - 6).attr("y", RH / 2)
        .each(function (r) { // trim to fit the label column (measured, so bold/selected labels fit too)
          const full = r.other ? `Other (${r.cnt} categories)` : (r.pinned ? "▸ " : "") + meta.offenses[r.o].label;
          this.textContent = full;
          let s = full;
          while (s.length > 4 && this.getComputedTextLength() > labelW - 10) { s = s.slice(0, -1); this.textContent = s + "…"; }
          if (s !== full) this.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title")).textContent = full;
        });
      g.select(".val").attr("y", RH / 2).text((r) => fmt.compact(r.n)).transition(t).attr("x", (r) => labelW + bw(r) + 4);

      g.on("click", (e, r) => { if (!r.other) set({ offense: S.offense === r.o ? null : r.o }); })
        .on("keydown", (e, r) => { if ((e.key === "Enter" || e.key === " ") && !r.other) { e.preventDefault(); set({ offense: S.offense === r.o ? null : r.o }); } })
        .on("pointermove focus", (e, r) => {
          const tot = d3.sum(rank, (q) => q.n);
          showTip(e, tipLines(`${fmt.int(r.n)} arrests`, [
            r.other ? `Other — ${r.cnt} smaller categories` : meta.offenses[r.o].label,
            `${fmt.pct(tot ? r.n / tot : 0)} of all arrests · ${meta.years[y]}`,
            ...(r.other ? [] : [S.offense === r.o ? "Click to clear the offense filter" : "Click to filter all views by this offense"]),
          ]));
        })
        .on("pointerleave blur", hideTip);

      svg.selectAll("g.axis").data([0]).join("g").attr("class", "axis")
        .attr("transform", `translate(${labelW},${rows.length * RH + 2})`)
        .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor((W - labelW) / 90)), "~s").tickSizeOuter(0));
      svg.selectAll("text.axis-title").data([0]).join("text").attr("class", "axis-title")
        .attr("x", W - 4).attr("y", H - 2).attr("text-anchor", "end").text(`Arrests (count), ${meta.years[y]}`);
    }

    let drillToken = 0;
    function renderDrill(p, y, o) {
      const box = $("#drill");
      if (o == null) { box.hidden = true; return; }
      box.hidden = false;
      const token = ++drillToken;
      const ids = p == null ? meta.precincts.map((d) => d.id) : [meta.precincts[p].id];
      const where = p == null ? "citywide" : `precinct ${meta.precincts[p].id}`;
      if (box.dataset.k !== `${p}|${y}|${o}`) box.replaceChildren(el("div", { class: "muted", text: "Loading detailed offenses…" }));
      Promise.all(ids.map(getPd)).then((files) => {
        if (token !== drillToken) return;
        const agg = new Map();
        for (const f of files) for (const [ry, ro, pd, n] of f.rows) if (ry === y && ro === o) agg.set(pd, (agg.get(pd) || 0) + n);
        const rows = [...agg].sort((a, b) => b[1] - a[1]);
        const top = rows.slice(0, 8), rest = d3.sum(rows.slice(8), (r) => r[1]);
        const tot = d3.sum(rows, (r) => r[1]), mx = top.length ? top[0][1] : 1;
        box.dataset.k = `${p}|${y}|${o}`;
        box.replaceChildren(el("h3", { text: `Detailed offenses (PD description) — ${offenseLabel(o)}, ${where}, ${meta.years[y]}` }));
        if (S.xf) box.appendChild(el("div", { class: "muted", text: `Not cross-filtered — all arrests, not only ${xfLabel()}.` }));
        if (!rows.length) { box.appendChild(el("div", { class: "muted", text: "No arrests for this offense here in this year." })); return; }
        const line = (label, n) => {
          const r = el("div", { class: "dr", tabindex: 0 }, [
            el("span", { text: label }),
            el("span", {}, [el("div", { class: "dbar", style: `width:${(n / mx) * 100}%` })]),
            el("span", { class: "num", text: fmt.int(n) }),
          ]);
          const tip = (e) => showTip(e, tipLines(`${fmt.int(n)} arrests`, [label, `${fmt.pct(n / tot)} of ${offenseLabel(o)}`]));
          r.addEventListener("pointermove", tip); r.addEventListener("focus", tip);
          r.addEventListener("pointerleave", hideTip); r.addEventListener("blur", hideTip);
          box.appendChild(r);
        };
        top.forEach(([pd, n]) => line(meta.pds[pd].label, n));
        if (rest) line(`Other (${rows.length - 8} descriptions)`, rest);
      }).catch(() => { if (token === drillToken) box.replaceChildren(el("div", { class: "muted", text: "Could not load detailed offenses." })); });
    }

    let drag = false; // lives outside renderLine: pointerdown re-renders and rebinds the handlers
    function renderLine(p, o) {
      const svg = d3.select("#line");
      const W = svg.node().clientWidth || 400, H = 160, m = { l: 40, r: 12, t: 20, b: 30 };
      svg.attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
      const ok = (y) => p == null || (M.hasData(p, y) && !M.partial(p, y));
      const index = (arr, valid) => {
        const base = d3.mean(arr.filter((_, y) => valid(y)));
        return arr.map((v, y) => (valid(y) && base ? (v / base) * 100 : null));
      };
      const city = M.series(null, o), cityIx = index(city, () => true);
      const mine = p == null ? null : M.series(p, o), mineIx = p == null ? null : index(mine, ok);
      const all = [...cityIx, ...(mineIx || [])].filter((v) => v != null);
      const x = d3.scaleLinear().domain([0, Y - 1]).range([m.l, W - m.r]);
      const yS = d3.scaleLinear().domain([0, Math.max(150, d3.max(all) || 150)]).nice().range([H - m.b, m.t]);
      const t = svg.transition().duration(DUR).ease(d3.easeCubicOut);

      svg.selectAll("g.gridline").data([0]).join("g").attr("class", "gridline")
        .attr("transform", `translate(${m.l},0)`)
        .call(d3.axisLeft(yS).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat(""))
        .call((g) => g.select(".domain").remove());
      svg.selectAll("g.axis.y").data([0]).join("g").attr("class", "axis y").attr("transform", `translate(${m.l},0)`)
        .call(d3.axisLeft(yS).ticks(4).tickSizeOuter(0));
      svg.selectAll("g.axis.x").data([0]).join("g").attr("class", "axis x").attr("transform", `translate(0,${H - m.b})`)
        .call(d3.axisBottom(x).tickValues([0, 4, 9, 14, 19]).tickFormat((i) => meta.years[i]).tickSizeOuter(0));
      svg.selectAll("text.axis-title").data([0]).join("text").attr("class", "axis-title")
        .attr("x", m.l - 34).attr("y", 10).text("Index (own 2006–2025 mean = 100)");
      svg.selectAll("text.xt").data([0]).join("text").attr("class", "axis-title xt")
        .attr("x", W - m.r).attr("y", H - 2).attr("text-anchor", "end").text("Year");
      svg.selectAll("line.ref100").data([0]).join("line").attr("class", "ref100")
        .attr("x1", m.l).attr("x2", W - m.r).attr("y1", yS(100)).attr("y2", yS(100));

      const line = d3.line().defined((v) => v != null).x((_, i) => x(i)).y((v) => yS(v));
      const series = [{ k: "city", v: cityIx, cls: p == null ? "s-sel" : "s-city" }];
      if (p != null) series.push({ k: "mine", v: mineIx, cls: "s-sel" });
      svg.selectAll("path.ser").data(series, (s) => s.k).join("path")
        .attr("class", (s) => "ser " + s.cls).transition(t).attr("d", (s) => line(s.v));

      const curSeries = p == null ? cityIx : mineIx;
      const cv = curSeries[S.year];
      svg.selectAll("line.curline").data([0]).join("line").attr("class", "curline")
        .attr("y1", m.t).attr("y2", H - m.b).transition(t).attr("x1", x(S.year)).attr("x2", x(S.year));
      svg.selectAll("circle.cur").data(cv == null ? [] : [cv]).join("circle").attr("class", "cur").attr("r", 4.5)
        .transition(t).attr("cx", x(S.year)).attr("cy", (v) => yS(v));

      // legend
      const lg = $("#lineLegend");
      lg.replaceChildren();
      const item = (color, text) => lg.appendChild(el("span", { class: "item" }, [el("span", { class: "sw line", style: `background:${color}` }), el("span", { text })]));
      if (p != null) item(tok("--ink"), `Precinct ${meta.precincts[p].id}`);
      item(p == null ? tok("--ink") : tok("--neutral-mark"), "New York City");
      lg.appendChild(el("span", { class: "item muted", text: offenseLabel(o) + (S.xf ? " · " + xfLabel() : "") }));

      // interaction: hover readout + click/drag sets year
      const yearAt = (e) => Math.max(0, Math.min(Y - 1, Math.round(x.invert(d3.pointer(e, svg.node())[0]))));
      svg.selectAll("rect.overlay").data([0]).join("rect").attr("class", "overlay")
        .attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b)
        .on("pointerdown", (e) => { drag = true; e.target.setPointerCapture(e.pointerId); set({ year: yearAt(e) }); })
        .on("pointerup pointercancel", () => (drag = false))
        .on("pointermove", (e) => {
          const yi = yearAt(e);
          if (drag && yi !== S.year) set({ year: yi });
          const lines = [];
          if (p != null) lines.push(`Precinct ${meta.precincts[p].id}: ${ok(yi) ? fmt.int(mine[yi]) + " arrests · index " + Math.round(mineIx[yi]) : M.partial(p, yi) ? fmt.int(mine[yi]) + " (partial year)" : "no data"}`);
          lines.push(`New York City: ${fmt.int(city[yi])} arrests · index ${Math.round(cityIx[yi])}`);
          showTip(e, tipLines(String(meta.years[yi]), lines));
        })
        .on("pointerleave", hideTip);
    }

    function renderSev(p, y, o) {
      const svg = d3.select("#sevbar");
      const W = svg.node().clientWidth || 400, m = { l: 92, r: 8 }, H = 80;
      svg.attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
      const mine = M.sevMix(p, y, o), city = M.sevMix(null, y, o);
      const x = d3.scaleLinear().domain([0, 1]).range([m.l, W - m.r]);
      const stack = (mix) => { const n = d3.sum(mix); let acc = 0; return mix.map((v, i) => { const s = { i, v, n, x0: n ? acc / n : 0, x1: n ? (acc + v) / n : 0 }; acc += v; return s; }); };
      const rows = [{ k: "mine", y: 4, h: 26, label: p == null ? "New York City" : `Precinct ${meta.precincts[p].id}`, segs: stack(mine) }];
      if (p != null) rows.push({ k: "city", y: 36, h: 12, label: "NYC average", segs: stack(city), ghost: true });
      $("#sevNote").textContent = `— ${offenseLabel(o)}, ${meta.years[y]}`;

      const g = svg.selectAll("g.srow").data(rows, (r) => r.k).join((e) => {
        const n = e.append("g").attr("class", "srow");
        n.append("text").attr("class", "lab").attr("x", m.l - 6).attr("text-anchor", "end").attr("dy", "0.35em");
        return n;
      });
      g.select(".lab").attr("y", (r) => r.y + r.h / 2).text((r) => r.label);
      const t = svg.transition().duration(DUR).ease(d3.easeCubicOut);
      g.each(function (r) {
        const gg = d3.select(this);
        const segs = gg.selectAll("rect.seg-r").data(r.segs, (s) => s.i).join("rect").attr("class", "seg-r")
          .attr("y", r.y).attr("height", r.h).attr("rx", r.ghost ? 2 : 4)
          .attr("fill", (s) => tok(SEV_TOK[s.i])).attr("fill-opacity", r.ghost ? 0.35 : 1)
          .attr("tabindex", 0)
          .on("pointermove focus", (e, s) => showTip(e, tipLines(`${s.n ? fmt.pct(s.v / s.n) : "–"}`, [`${SEV_NAMES[s.i]} · ${r.label}`, `${fmt.int(s.v)} of ${fmt.int(s.n)} arrests`], tok(SEV_TOK[s.i]))))
          .on("pointerleave blur", hideTip);
        // 2px surface gap between parts
        segs.transition(t).attr("x", (s) => x(s.x0) + (s.x0 > 0 ? 1 : 0)).attr("width", (s) => Math.max(0, x(s.x1) - x(s.x0) - (s.x0 > 0 ? 1 : 0) - (s.x1 < 1 ? 1 : 0)));
        gg.selectAll("text.in").data(r.ghost ? [] : r.segs.filter((s) => x(s.x1) - x(s.x0) > 40), (s) => s.i).join("text")
          .attr("class", "in").attr("y", r.y + r.h / 2).attr("dy", "0.35em").style("fill", "#ffffff").style("pointer-events", "none")
          .text((s) => d3.format(".0%")(s.v / s.n)).transition(t).attr("x", (s) => x(s.x0) + 6);
      });
      svg.selectAll("g.axis").data([0]).join("g").attr("class", "axis").attr("transform", `translate(0,${p != null ? 52 : 34})`)
        .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor((W - m.l - m.r) / 60)), "%").tickSizeOuter(0));
      svg.selectAll("text.axis-title").data([0]).join("text").attr("class", "axis-title")
        .attr("x", W - m.r).attr("y", p != null ? 78 : 60).attr("text-anchor", "end").text("Share of arrests (%)");

      const lg = $("#sevLegend");
      lg.replaceChildren(...SEV_NAMES.map((nme, i) => el("span", { class: "item" }, [
        el("span", { class: "sw", style: `background:${tok(SEV_TOK[i])}` }), el("span", { text: i === 3 ? "Other (infraction / unknown)" : nme })])));
      if (p != null) lg.appendChild(el("span", { class: "item muted", text: "faded bar = NYC average" }));
    }

    // =====================================================================
    // View C — waffles
    // =====================================================================
    let hiCohort = null; // hover highlight (temporary); the clicked cohort (S.xf) is the persistent one
    const selCohort = () => (S.xf && S.xf.kind === "cohort" && S.xf.dim === S.dim ? S.xf.key : null);
    function renderC() {
      const p = S.precinct, dim = S.dim, yr = meta.years[S.year], o = S.offense;
      const demoIncomplete = dim !== "race";
      const years = S.wper === "year" ? [S.year] : d3.range(demoIncomplete ? Y - 1 : Y);
      const per = S.wper === "year" ? String(yr) : demoIncomplete ? "2006–2024 (2025 excluded: sex/age incomplete)" : "2006–2025";
      const where = p == null ? "New York City" : `Precinct ${meta.precincts[p].id}`;

      // source: weekday slice (ignores offense) | one cohort cube per raw cohort (follows offense) | demo.json
      let src, st = { status: "ok" }, what = "", scope;
      if (S.xf && S.xf.kind === "dow") {
        st = dowSlice(S.xf.d); what = `${xfLabel()} slice`;
        if (st.status === "ok") src = { dims: st.value.dims };
        scope = `only ${xfLabel()} · all offenses${o != null ? " (offense filter not applied under a weekday filter)" : ""}`;
      } else if (o != null) {
        st = all(M.cohorts[dim].map.map((_, i) => cohortRaw(dim, i))); what = `${DIM_NAME[dim].toLowerCase()} × offense data`;
        if (st.status === "ok") src = { cubes: st.values.map((v) => v.cube), o };
        scope = offenseLabel(o);
      } else scope = "all offenses";
      if (selCohort() != null) scope += ` · cross-filter ${xfLabel()} (highlighted; full distribution kept)`;
      if (S.xf && S.xf.kind === "cohort" && S.xf.dim !== dim) scope += ` · ${xfLabel()} filter not applied here (no ${dim} × ${S.xf.dim} data)`;
      if (!status("viewC", st, what)) return;
      $("#subC").textContent = `${where} · ${per} · ${scope}`;
      const banner = $("#dqBanner");
      const xfDemo = S.xf && S.xf.kind === "cohort" && S.xf.dim !== "race";
      banner.hidden = !((demoIncomplete && S.wper === "year" && yr === 2025) || (xfDemo && (yr === 2025 || S.cper === "all")));
      banner.textContent = "⚠ 2025 demographics incomplete — sex/age missing for 52.8% of records; the Unknown share is shown as recorded"
        + (xfDemo ? `, and the ${xfLabel()} filter only covers records where ${S.xf.dim} was recorded.` : ".");

      const ws = M.waffle(dim, p, years, src);
      const labels = M.cohorts[dim].labels;
      const cols = COHORT_TOK[dim].map(tok);
      const box = $("#waffles");
      const wEach = (box.clientWidth - 32) / 3, hAvail = box.clientHeight - 22;
      const u = Math.max(8, Math.floor(Math.min(wEach, hAvail) / 10));

      d3.select(box).selectAll("div.waffle").data(ws).join((e) => {
        const d = e.append("div").attr("class", "waffle");
        d.append("h4");
        d.append("svg");
        return d;
      }).each(function (w) {
        const d = d3.select(this);
        d.select("h4").text(SEV_NAMES[w.sev]).append("span").attr("class", "muted").text(` · n = ${fmt.int(w.n)}`);
        const svg = d.select("svg").attr("width", u * 10).attr("height", u * 10).attr("viewBox", `0 0 ${u * 10} ${u * 10}`)
          .attr("role", "img").attr("aria-label", `${SEV_NAMES[w.sev]}: ` + labels.map((l, i) => `${l} ${w.cells[i]}%`).join(", "));
        const cells = [];
        w.cells.forEach((c, i) => { for (let k = 0; k < c; k++) cells.push(i); });
        svg.selectAll("text.empty").data(w.n ? [] : [0]).join("text").attr("class", "empty")
          .attr("x", u * 5).attr("y", u * 5).attr("text-anchor", "middle").text("No arrests");
        svg.selectAll("use").data(cells).join("use").attr("href", "#person")
          .attr("x", (_, j) => (j % 10) * u + 1).attr("y", (_, j) => Math.floor(j / 10) * u + 1)
          .attr("width", u - 2).attr("height", u - 2)
          .style("fill", (c) => cols[c])
          .classed("dim", (c) => effHi() != null && c !== effHi())
          .on("click", (e, c) => toggleXf({ kind: "cohort", dim, key: c }))
          .on("pointermove", (e, c) => {
            highlight(c);
            showTip(e, tipLines(`${fmt.pct(w.counts[c] / w.n)}`, [`${labels[c]} · ${SEV_NAMES[w.sev]}`, `${fmt.int(w.counts[c])} of ${fmt.int(w.n)} arrests · ${w.cells[c]} figures`, selCohort() === c ? "Click to clear the cross-filter" : "Click to cross-filter the map, detail and calendar"], cols[c]));
          })
          .on("pointerleave", () => { highlight(null); hideTip(); });
      });

      const lg = $("#waffleLegend");
      lg.replaceChildren(el("span", { class: "item muted", text: "Felony · Misdemeanor · Violation (%)" }));
      labels.forEach((l, i) => {
        const it = el("span", { class: "item", tabindex: 0, role: "button", "aria-pressed": String(selCohort() === i) }, [
          el("span", { class: "sw", style: `background:${cols[i]}` }),
          el("span", { text: l }),
          el("span", { class: "pctv", text: ws.map((w) => (w.n ? w.cells[i] : "–")).join(" · ") }),
        ]);
        it.dataset.c = i;
        if (selCohort() === i) it.classList.add("sel");
        if (effHi() != null && effHi() !== i) it.classList.add("dim");
        const pick = () => toggleXf({ kind: "cohort", dim, key: i });
        it.addEventListener("click", pick);
        it.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
        const on = () => highlight(i), off = () => highlight(null);
        it.addEventListener("pointerenter", on); it.addEventListener("focus", on);
        it.addEventListener("pointerleave", off); it.addEventListener("blur", off);
        lg.appendChild(it);
      });
    }
    const effHi = () => (hiCohort != null ? hiCohort : selCohort());
    function highlight(c) {
      hiCohort = c;
      const h = effHi();
      d3.selectAll("#waffles use").classed("dim", (k) => h != null && k !== h);
      document.querySelectorAll("#waffleLegend .item[data-c]").forEach((it) => it.classList.toggle("dim", h != null && +it.dataset.c !== h));
    }

    // =====================================================================
    // View D — calendar heatmap
    // =====================================================================
    // -> {st, arr, base, scope}: which calendar array (and its base index) the current state needs
    function calSlice() {
      const p = S.precinct, o = S.offense, ok = (arr, base, scope, st = { status: "ok" }) => ({ st, arr, base, scope });
      const P = p == null ? "Citywide" : `Precinct ${meta.precincts[p].id}`;
      if (S.xf && S.xf.kind === "cohort") {
        const st = cohortSlice(S.xf.dim, S.xf.key), v = st.value, xf = `only ${xfLabel()}`;
        if (p != null) return ok(v && v.calPre, p, `${P} · ${xf} · all offenses${o != null ? " (offense not applied: no precinct × offense × cohort calendar)" : ""}`, st);
        const k = o == null ? -1 : M.topIdx.indexOf(o);
        if (o != null && k < 0) return ok(v && v.calOff, 0, `${P} · ${xf} · all offenses (cohort calendars exist for the 15 largest offenses only)`, st);
        return ok(v && v.calOff, k + 1, `${P} · ${xf} · ${offenseLabel()}`, st);
      }
      if (p != null && o != null) { const st = calPrecinct(p); return ok(st.value, o, `${P} · ${offenseLabel()}`, st); }
      if (p != null) return ok(M.cal.precinct, p, `${P} · all offenses`);
      if (o != null) { const st = calOffenseAll(); return ok(st.value, o, `${P} · ${offenseLabel()}`, st); }
      return ok(M.cal.offense, 0, `${P} · all offenses`);
    }

    function renderD() {
      const { st, arr, base, scope } = calSlice();
      if (!status("viewD", st, "calendar data")) return;
      const p = S.precinct;
      // a precinct created mid-period: "all years" = its full years only, so days before it existed don't dilute the mean
      const allYears = d3.range(Y).filter((y) => p == null || (M.hasData(p, y) && !M.partial(p, y)));
      const years = S.cper === "year" ? [S.year] : allYears;
      const span = allYears.length ? `${meta.years[allYears[0]]}–${meta.years[allYears[allYears.length - 1]]}` : "–";
      const c = M.calendar(arr, base, years);
      const selD = S.xf && S.xf.kind === "dow" ? S.xf.d : null;
      const pct = S.cmode === "pct";
      const part = S.precinct != null && S.cper === "year" && M.partial(S.precinct, S.year) ? ` (partial year — precinct created ${M.created(S.precinct)})` : "";
      $("#subD").textContent = `${selD != null ? `cross-filter ${xfLabel()} (selected row) · ` : ""}${scope} · ${S.cper === "year" ? meta.years[S.year] + part : span} · ${pct ? "% deviation from the period's mean arrests per day" : "mean arrests per day"}`;

      // fixed domain across years for this slice (comparable while animating)
      let lo = Infinity, hi = 0, dev = 0;
      const grids = S.cper === "year" ? allYears.map((y) => M.calendar(arr, base, [y])) : [c];
      for (const g of grids) {
        if (!g.total) continue;
        for (const r of g.mean) for (const v of r) { lo = Math.min(lo, v); hi = Math.max(hi, v); dev = Math.max(dev, Math.abs(v / g.overall - 1)); }
      }
      const seq2 = tok("--seq2").split(",").map((s) => s.trim()), div = tok("--div").split(",").map((s) => s.trim());
      const color = pct
        ? d3.scaleDiverging(d3.interpolateRgbBasis(div)).domain([-dev, 0, dev])
        : d3.scaleSequential(d3.interpolateRgbBasis(seq2)).domain([lo, hi]);
      const val = (d, m) => (pct ? c.mean[d][m] / c.overall - 1 : c.mean[d][m]);

      const svg = d3.select("#cal");
      const W = svg.node().clientWidth || 600, H = Math.max(200, svg.node().clientHeight || 260);
      svg.attr("viewBox", `0 0 ${W} ${H}`);
      const m = { l: 56, r: 56, t: 18, b: 40 };
      const x = d3.scaleBand().domain(d3.range(12)).range([m.l, W - m.r]).paddingInner(0.08);
      const yS = d3.scaleBand().domain(d3.range(7)).range([m.t, H - m.b]).paddingInner(0.1);
      const cells = [];
      for (let d = 0; d < 7; d++) for (let mo = 0; mo < 12; mo++) cells.push({ d, m: mo });

      svg.selectAll("text.empty").data(c.total ? [] : [0]).join("text").attr("class", "empty axis-title")
        .attr("x", W / 2).attr("y", H / 2).attr("text-anchor", "middle").text("No data for this precinct in this period");
      svg.selectAll("rect.cell").data(c.total ? cells : []).join("rect").attr("class", "cell")
        .attr("x", (q) => x(q.m)).attr("y", (q) => yS(q.d)).attr("width", x.bandwidth()).attr("height", yS.bandwidth())
        .attr("rx", 3).attr("tabindex", 0).attr("role", "button")
        .attr("aria-label", (q) => `${DAYS[q.d]} in ${MONTHS[q.m]}: ${fmt.dec(c.mean[q.d][q.m])} arrests per day`)
        .style("fill", (q) => color(val(q.d, q.m)))
        .classed("off", (q) => selD != null && q.d !== selD)
        .on("click", (e, q) => toggleXf({ kind: "dow", d: q.d }))
        .on("keydown", (e, q) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleXf({ kind: "dow", d: q.d }); } })
        .on("pointermove focus", (e, q) => {
          const mean = c.mean[q.d][q.m], dv = mean / c.overall - 1;
          showTip(e, tipLines(pct ? `${dv >= 0 ? "+" : ""}${d3.format(".1%")(dv)} vs mean` : `${fmt.dec(mean)} arrests / day`, [
            `${DAYS[q.d]} in ${MONTHS[q.m]} · ${S.cper === "year" ? meta.years[S.year] : span}`,
            pct ? `${fmt.dec(mean)} arrests / day (period mean ${fmt.dec(c.overall)})` : `${d3.format("+.1%")(dv)} vs period mean ${fmt.dec(c.overall)}`,
            `${fmt.int(c.cnt[q.d][q.m])} arrests over ${c.days[q.d][q.m]} ${DAYS[q.d]}s`,
            selD === q.d ? "Click to clear the weekday cross-filter" : `Click to cross-filter by ${DAYS[q.d]}`,
          ]));
        })
        .on("pointerleave blur", hideTip);

      svg.selectAll("g.axis.x").data([0]).join("g").attr("class", "axis x").attr("transform", `translate(0,${m.t - 4})`)
        .call(d3.axisTop(x).tickFormat((i) => MONTHS[i]).tickSize(0)).call((g) => g.select(".domain").remove());
      svg.selectAll("g.axis.y").data([0]).join("g").attr("class", "axis y").attr("transform", `translate(${m.l - 4},0)`)
        .call(d3.axisLeft(yS).tickFormat((i) => DAYS[i]).tickSize(0)).call((g) => g.select(".domain").remove())
        .call((g) => g.selectAll(".tick").classed("sel", (d) => d === selD)
          .on("click", (e, d) => toggleXf({ kind: "dow", d })));
      // marginal means
      const mf = (v) => (pct ? d3.format("+.0%")(v / c.overall - 1) : fmt.dec(v));
      svg.selectAll("text.marg.r").data(c.total ? c.rowMean : []).join("text").attr("class", "marg r")
        .attr("x", W - m.r + 6).attr("y", (_, d) => yS(d) + yS.bandwidth() / 2).attr("dy", "0.35em").text(mf);
      svg.selectAll("text.marg.c").data(c.total ? c.colMean : []).join("text").attr("class", "marg c")
        .attr("x", (_, i) => x(i) + x.bandwidth() / 2).attr("y", H - m.b + 13).attr("text-anchor", "middle").text(mf);
      svg.selectAll("text.mt").data(c.total ? [0, 1] : []).join("text").attr("class", "axis-title mt")
        .attr("x", (k) => (k ? W - m.r + 6 : m.l - 6)).attr("y", (k) => (k ? m.t - 4 : H - m.b + 13))
        .attr("text-anchor", (k) => (k ? "start" : "end")).text((k) => (k ? "row mean" : "col. mean"));
      svg.selectAll("text.xt").data([0]).join("text").attr("class", "axis-title xt")
        .attr("x", W - m.r).attr("y", H - 4).attr("text-anchor", "end").text("Columns: month · rows: weekday");

      // legend
      const lg = $("#calLegend");
      lg.replaceChildren();
      if (!c.total) return;
      const stops = d3.range(0, 1.0001, 0.1).map((t) => `${color(color.domain()[0] + t * (color.domain()[color.domain().length - 1] - color.domain()[0]))} ${t * 100}%`).join(",");
      const ticks = pct ? [-dev, 0, dev].map((v) => d3.format("+.0%")(v)) : [lo, (lo + hi) / 2, hi].map(fmt.dec);
      lg.appendChild(el("span", { class: "item" }, [
        el("span", { text: pct ? "% vs mean arrests/day:" : "Mean arrests per day:" }),
        el("span", {}, [
          el("div", { class: "gradbar", style: `background:linear-gradient(90deg,${stops});width:200px` }),
          el("div", { class: "gradticks", style: "width:200px" }, ticks.map((t) => el("span", { text: t }))),
        ]),
      ]));
      lg.appendChild(el("span", { class: "item muted", text: S.cper === "year" ? "colour scale fixed across years for this scope" : pct ? "grey = period mean" : "" }));
    }

    // ---------- global listeners ----------
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { mapView.setTiles(); render(); });
    let rz = 0;
    addEventListener("resize", () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { mapView.invalidate(); render(); }); });

    render();
    window.__app = { S, M, set, map: mapView.map }; // for debugging / verification
  }
})();
