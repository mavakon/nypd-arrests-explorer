// Pure data layer: indexing + aggregations. No DOM, no d3 — loadable in node for checks.
(function (root) {
  "use strict";

  const S = 5; // severities F M V I U
  const SEV_GROUPS = [[0], [1], [2], [3, 4]]; // Felony, Misdemeanor, Violation, Other

  function build(meta, cube, demo, cal) {
    const P = meta.precincts.length, Y = meta.years.length, O = meta.offenses.length;
    const sev = new Int32Array(P * Y * O * S);
    const tot = new Int32Array(P * Y * O);
    const pyAll = new Int32Array(P * Y);
    const pySev = new Int32Array(P * Y * S);
    for (const [p, y, o, s, n] of cube.rows) {
      sev[((p * Y + y) * O + o) * S + s] += n;
      tot[(p * Y + y) * O + o] += n;
      pyAll[p * Y + y] += n;
      pySev[(p * Y + y) * S + s] += n;
    }
    const pIndex = new Map(meta.precincts.map((d, i) => [d.id, i]));
    const p22 = pIndex.get(22), p116 = pIndex.get(116);
    
    // demographics: dims sex / race / age -> Int32Array ((p*Y+y)*C+c)*S+s
    const dims = {};
    for (const k of ["sex", "race", "age"]) {
      const C = (k === "sex" ? meta.sexes : k === "race" ? meta.races : meta.ages).length;
      const a = new Int32Array(P * Y * C * S);
      for (const [p, y, c, s, n] of demo[k]) a[((p * Y + y) * C + c) * S + s] += n;
      dims[k] = { C, a };
    }

    const M = {
      meta, P, Y, O, sev, tot, pyAll, pySev, dims, pIndex, p22, p116,
      cal, topIdx: meta.top_offenses, _dom: new Map(),
    };

    // ---- basic lookups ----
    M.value = (p, y, o) => (o == null ? pyAll[p * Y + y] : tot[(p * Y + y) * O + o]);
    M.city = (y, o) => { let t = 0; for (let p = 0; p < P; p++) t += M.value(p, y, o); return t; };
    M.hasData = (p, y) => pyAll[p * Y + y] > 0;
    // Precincts created during the period: no data before, partial first year
    // (121 split from 120/122 in Jul 2013; 116 split from 105/113 on 2024-12-19)
    const created = new Map([[pIndex.get(121), "Jul 2013"], [p116, "Dec 2024"]]);
    const firstYear = (p) => { for (let y = 0; y < Y; y++) if (pyAll[p * Y + y] > 0) return y; return Y; };
    M.created = (p) => created.get(p) || null;
    M.partial = (p, y) => created.has(p) && y === firstYear(p);
    // Year-dependent population for the 105/113 -> 116 split (2024-12-19). meta pops are post-split;
    // until 2024 the 116 area belonged to 105/113, so use their pre-split 2020 census totals
    // (P1_001N aggregated by jkeefe/census-by-precincts, nyc_precinct_2020pop.csv). 199,218 + 135,221
    // = 123,446 + 122,199 + 88,794 (105 + 113 + 116 today). No pre-split figures exist for the 2013
    // 120/122 -> 121 split, so those stay on current boundaries (footnoted).
    const PRE_SPLIT_POP = new Map([[105, 199218], [113, 135221]]);
    const y2025 = meta.years.indexOf(2025);
    M.pop = (p, y) => {
      const d = meta.precincts[p];
      return y != null && y < y2025 && PRE_SPLIT_POP.has(d.id) ? PRE_SPLIT_POP.get(d.id) : d.pop;
    };
    M.cityPop = meta.precincts.reduce((t, d) => t + d.pop, 0);
    // Eligible for colour scale / ranking / outliers in this mode
    M.eligible = (p, y, mode) => M.hasData(p, y) && !M.partial(p, y) && !(mode === "rate" && p === p22);
    M.metric = (p, y, o, mode) => {
      const v = M.value(p, y, o);
      return mode === "rate" ? (v / M.pop(p, y)) * 1e4 : v;
    };

    // Values for all precincts in a year; NaN where not eligible
    M.values = (y, o, mode) => {
      const out = new Float64Array(P);
      for (let p = 0; p < P; p++) out[p] = M.eligible(p, y, mode) ? M.metric(p, y, o, mode) : NaN;
      return out;
    };

    M.rank = (p, y, o, mode) => {
      if (!M.eligible(p, y, mode)) return null;
      const v = M.values(y, o, mode), me = v[p];
      let r = 1, of = 0;
      for (let i = 0; i < P; i++) if (!isNaN(v[i])) { of++; if (v[i] > me) r++; }
      return { rank: r, of };
    };

    M.outlierThreshold = (y, o, mode) => {
      const v = Array.from(M.values(y, o, mode)).filter((x) => !isNaN(x)).sort((a, b) => a - b);
      if (!v.length) return Infinity;
      const q1 = quantile(v, 0.25), q3 = quantile(v, 0.75);
      return q3 + 1.5 * (q3 - q1);
    };

    // Fixed colour domain for an offense+mode: max over all years
    M.domainMax = (o, mode) => {
      const key = o + "|" + mode;
      if (!M._dom.has(key)) {
        let mx = 0;
        for (let y = 0; y < Y; y++) for (let p = 0; p < P; p++)
          if (M.eligible(p, y, mode)) mx = Math.max(mx, M.metric(p, y, o, mode));
        M._dom.set(key, mx || 1);
      }
      return M._dom.get(key);
    };

    // severity mix [F, M, V, Other] for p (null = city), year, offense (null = all)
    M.sevMix = (p, y, o) => {
      const out = [0, 0, 0, 0];
      const ps = p == null ? range(P) : [p];
      for (const q of ps) for (let g = 0; g < 4; g++) for (const s of SEV_GROUPS[g])
        out[g] += o == null ? pySev[(q * Y + y) * S + s] : sev[((q * Y + y) * O + o) * S + s];
      return out;
    };
    M.boroughs = Array.from(new Set(meta.precincts.map((d) => d.boro)));
    M.boroSevMix = (b, y, o) => {
      const out = [0, 0, 0, 0];
      meta.precincts.forEach((d, p) => {
        if (d.boro !== b) return;
        M.sevMix(p, y, o).forEach((v, g) => (out[g] += v));
      });
      return out;
    };

    // Offenses ranked by count for p (null = city) in year y
    M.offenseRanking = (p, y) => {
      const counts = new Float64Array(O);
      const ps = p == null ? range(P) : [p];
      for (const q of ps) for (let o = 0; o < O; o++) counts[o] += tot[(q * Y + y) * O + o];
      return range(O).map((o) => ({ o, n: counts[o] })).filter((d) => d.n > 0).sort((a, b) => b.n - a.n);
    };

    M.series = (p, o) => range(Y).map((y) => (p == null ? M.city(y, o) : M.value(p, y, o)));

    // ---- waffles ----
    // cohort folding: race folds American Indian + Other into one "Other" group
    M.cohorts = {
      sex: { labels: ["Male", "Female", "Unknown"], map: [0, 1, 2] },
      race: {
        labels: ["Black", "White Hispanic", "White", "Black Hispanic", "Asian / Pacific Islander",
          "Other (incl. American Indian / Alaskan Native)", "Unknown"],
        map: [0, 1, 2, 3, 4, 5, 5, 6],
      },
      age: { labels: meta.ages.slice(), map: meta.ages.map((_, i) => i) },
    };
    // returns [{sev, n, counts[], cells[]}] for severities F, M, V
    M.waffle = (dim, p, years) => {
      const { C, a } = dims[dim], { labels, map } = M.cohorts[dim];
      const ps = p == null ? range(P) : [p];
      return [0, 1, 2].map((s) => {
        const counts = new Array(labels.length).fill(0);
        for (const q of ps) for (const y of years) for (let c = 0; c < C; c++)
          counts[map[c]] += a[((q * Y + y) * C + c) * S + s];
        const n = counts.reduce((t, v) => t + v, 0);
        return { sev: s, n, counts, cells: largestRemainder(counts, 100) };
      });
    };

    // ---- calendar ----
    // slice: {kind:"offense", k} or {kind:"precinct", p}; years: array of year indices
    M.calendar = (slice, years) => {
      const arr = slice.kind === "offense" ? cal.offense : cal.precinct;
      const base = slice.kind === "offense" ? slice.k : slice.p;
      const cnt = Array.from({ length: 7 }, () => new Array(12).fill(0));
      const days = Array.from({ length: 7 }, () => new Array(12).fill(0));
      for (const y of years) {
        const yr = meta.years[y];
        for (let m = 0; m < 12; m++) {
          const wd = weekdayCounts(yr, m);
          for (let d = 0; d < 7; d++) {
            cnt[d][m] += arr[((base * Y + y) * 12 + m) * 7 + d];
            days[d][m] += wd[d];
          }
        }
      }
      const mean = cnt.map((r, d) => r.map((v, m) => v / days[d][m]));
      const sum2 = (g) => g.reduce((t, r) => t + r.reduce((a, b) => a + b, 0), 0);
      const total = sum2(cnt), totalDays = sum2(days);
      const rowMean = cnt.map((r, d) => r.reduce((a, b) => a + b, 0) / days[d].reduce((a, b) => a + b, 0));
      const colMean = range(12).map((m) => {
        let c = 0, n = 0;
        for (let d = 0; d < 7; d++) { c += cnt[d][m]; n += days[d][m]; }
        return c / n;
      });
      return { mean, cnt, days, rowMean, colMean, overall: total / totalDays, total };
    };

    return M;
  }

  // ---- pure helpers ----
  function range(n) { return Array.from({ length: n }, (_, i) => i); }

  // R-7 quantile (same as d3.quantile) on sorted array
  function quantile(sorted, q) {
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  // Hamilton / largest-remainder apportionment; sums exactly to `total` (0s if no data)
  function largestRemainder(counts, total) {
    const n = counts.reduce((t, v) => t + v, 0);
    if (!n) return counts.map(() => 0);
    const raw = counts.map((v) => (v / n) * total);
    const out = raw.map(Math.floor);
    let left = total - out.reduce((t, v) => t + v, 0);
    const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let j = 0; left > 0; j++, left--) out[order[j][1]]++;
    return out;
  }

  // number of Mondays..Sundays (0=Mon) in month m (0=Jan) of year yr
  function weekdayCounts(yr, m) {
    const out = [0, 0, 0, 0, 0, 0, 0];
    const dim = new Date(Date.UTC(yr, m + 1, 0)).getUTCDate();
    for (let day = 1; day <= dim; day++) out[(new Date(Date.UTC(yr, m, day)).getUTCDay() + 6) % 7]++;
    return out;
  }

  const api = { build, largestRemainder, weekdayCounts, quantile, SEV_GROUPS };
  if (typeof module !== "undefined") module.exports = api;
  else root.NYCData = api;
})(this);
