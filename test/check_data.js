// Sanity check for js/data.js: `node test/check_data.js` from the project root.
const fs = require("fs"), path = require("path"), assert = require("assert");
const D = require("../js/data.js");
const rd = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", f)));
const M = D.build(rd("meta.json"), rd("cube.json"), rd("demo.json"), rd("calendar.json"));
const y = (yr) => M.meta.years.indexOf(yr);

const p75 = M.pIndex.get(75);
assert.strictEqual(M.value(p75, y(2019), null), 6024);
assert.strictEqual(M.meta.years.reduce((t, _, i) => t + M.city(i, null), 0), M.meta.total - M.meta.unmatched_precinct_arrests);
assert.deepStrictEqual(D.weekdayCounts(2024, 1), [4, 4, 4, 5, 4, 4, 4]); // Feb 2024: Thu 1st, 29 days
assert.deepStrictEqual(D.largestRemainder([1, 1, 1], 100), [34, 33, 33]);
assert.deepStrictEqual(D.largestRemainder([0, 0], 100), [0, 0]);

for (const dim of ["sex", "race", "age"])
  for (const p of [null, p75, M.p116])
    for (const w of M.waffle(dim, p, [y(2025)]))
      assert.strictEqual(w.cells.reduce((a, b) => a + b, 0), w.n ? 100 : 0, dim + " " + p);

const r = M.rank(p75, y(2019), null, "count");
const c = M.calendar(M.cal.offense, 0, [y(2019)]);
assert(Math.abs(c.overall * 365 - M.city(y(2019), null)) < 1);
assert.strictEqual(M.rank(M.p22, y(2019), null, "rate"), null);
assert.strictEqual(M.hasData(M.p116, y(2020)), false);
console.log("ok · 75/2019 rank", r, "· per10k", (M.metric(p75, y(2019), null, "rate")).toFixed(0));
// 105/113 use pre-split population before 116 existed; the 105+113+116 total is unchanged
const pi = (id) => M.pIndex.get(id);
assert.strictEqual(M.pop(pi(105), y(2024)) + M.pop(pi(113), y(2024)),
  [105, 113, 116].reduce((t, id) => t + M.pop(pi(id), y(2025)), 0));
assert.strictEqual(M.pop(pi(105), y(2025)), M.meta.precincts[pi(105)].pop);

// ---- cross-filter slices (data/x) ----
const rx = (f) => rd("x/" + f);
// a cohort cube's citywide year total equals that cohort's total in demo.json
const black = M.indexCube([rx("race_0.json").rows], "race:0");
const demoBlack2019 = rd("demo.json").race.filter((r) => r[1] === y(2019) && r[2] === 0).reduce((t, r) => t + r[4], 0);
M.useCube(black);
assert.strictEqual(M.city(y(2019), null), demoBlack2019);
M.useCube(null);
assert.strictEqual(M.value(p75, y(2019), null), 6024); // back on the full cube
// waffle following an offense: sex cohort cubes partition the data, so F/M/V n match the cube
const sexCubes = [0, 1, 2].map((i) => M.indexCube([rx(`sex_${i}.json`).rows], "sex:" + i));
const o = 5, wf = M.waffle("sex", p75, [y(2019)], { cubes: sexCubes, o });
assert.deepStrictEqual(wf.map((w) => w.n), M.sevMix(p75, y(2019), o).slice(0, 3));
// precinct x offense calendar (sparse cal_p75) sums to the cube value
const cal75 = M.decodeSparse(rx("cal_p75.json").cells);
assert.strictEqual(M.calendar(cal75, o, [y(2019)]).total, M.value(p75, y(2019), o));
// citywide x any offense calendar (includes unmatched precincts, so >=)
const calAll = rx("cal_offense_all.json").cal;
assert(M.calendar(calAll, 40, [y(2019)]).total >= M.city(y(2019), 40));
console.log("ok · cross-filter slices · Black 2019 =", demoBlack2019, "· p75 Felony Assault 2019 =", M.value(p75, y(2019), o));
