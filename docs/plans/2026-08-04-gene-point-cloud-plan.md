# Gene expression 点云图层 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 Gene expression 图层从"每区一个标记"改为多基因同屏的体素点云，用点亮密度编码指标值。

**Architecture:** 新增一个纯函数模块承担密度标定、固定置换、窗口分配与标签级聚合（IIFE 双导出，可脱离 jsdom 单测）；`interactive_brain_atlas/app.js` 在基因层改走点云绘制并建屏幕命中网格；`index.json` 新增按 `规则 × 指标` 分组的 `densityScale` 标定表；宿主 `gene-atlas-view.js` 改用多基因签名并提供基因配色。

**Tech Stack:** 零构建纯前端（IIFE + 全局挂载）、Canvas2D 软 3D 渲染、jsdom + `node:assert/strict` 测试、Python 3（导出脚本，环境 `/home/jialiang/miniconda3/envs/scbrain/bin/python`）。

**设计依据:** `docs/plans/2026-08-04-gene-point-cloud-design.md`（提交 `cdbf574`，另含 §4.5 修订）。计划里的每个常数都能在设计文档里找到实测出处，**不要就地重新发明参数**。

---

## 开工前必读

**测试怎么跑。** 仓库没有 `package.json`，测试是直接跑文件：

```bash
cd /data/DigitalBrain/data/scBrain/web
node test_gene_atlas_layer.js            # 单个 JS 套件
for f in test_*.js; do node "$f" || echo "FAIL $f"; done      # 全部 JS
/home/jialiang/miniconda3/envs/scbrain/bin/python -m pytest -q  # 全部 Python
```

**已知既有噪声（不是你引入的）：** `node test_smoke.js` 会打印 3 条
`requestAnimationFrame is not defined` 报错但**退出码为 0**。已用 `git stash` 对照
HEAD 确认过是既有现象，不要花时间去修，也不要把它当成你的回归。

**新增浏览器模块必须在 4 处注册**，漏一处就是"本地好、发布坏"或"测试加载不到"：

1. `digitalneuron_main.html` — 加在 `interactive_brain_atlas/app.js`（L472）**之前**
2. `interactive_brain_atlas/index.html` — 加在 `app.js`（L578）**之前**
3. `build_pages_release.py` 的 atlas 资源字典（L34 附近）
4. `test_gene_atlas_layer.js` 的加载清单（L81）

只有 `test_gene_atlas_layer.js` 引导 atlas；`test_smoke.js` 与 `test_ui_rendering.js`
加载的是**根目录**的 `app.js`（数据浏览器），与本次无关。

**代码风格。** 全仓库 `var` 出现 0 次、`const` 600+ 次。用 ES2018+：`const/let`、
箭头函数、展开、`Object.entries`。新模块用既有双导出模式：

```js
(function (global) {
  // ...
  const api = { /* ... */ };
  global.XXX = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
```

---

## Task 0: 修测试帧驱动器（前置，必须第一个做）

`test_gene_atlas_layer.js` 的 `drawOneFrame` 恒传 `callback(0)`，撞上 `render()` 的
30ms 节流（`app.js:1635`：`if (now - lastFrame < 30) { requestAnimationFrame(render); return; }`，
而 `lastFrame` 初值是 `performance.now()`）。首帧因 `0 - lastFrame < 0` 过闸，之后
`0 - 0 = 0 < 30` **全部短路重排**。结果是 boot 之后每次 `drawOneFrame` 都是空操作，
既有 21 条基因层测试里凡"改状态 → 渲染 → 断言"的都在断言 boot 那帧的陈旧像素。

不先修，本计划后面所有渲染断言都会静默空转。

**Files:**
- Modify: `test_gene_atlas_layer.js:89-93`

**Step 1: 先证明缺陷存在（临时探针，不提交）**

在 `test_gene_atlas_layer.js` 末尾临时加：

```js
function probeThrottle() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const before = window.document.getElementById('visibleCount').textContent;
  atlas.applyGeneValues({ values: {}, metric: 'mean' });
  drawOneFrame();
  console.log('切到基因层后 visibleCount =', window.document.getElementById('visibleCount').textContent,
              '（切换前是', before, '）');
}
probeThrottle();
```

Run: `node test_gene_atlas_layer.js 2>&1 | tail -3`
Expected: 两个数字相同 —— 证明 `drawOneFrame` 没有真的重绘。

**Step 2: 换成单调递增时钟**

把 L89-93 替换为：

```js
  // A single frame is not enough: render() throttles at 30 ms and lastFrame starts at
  // performance.now(), so a fixed timestamp lets only the first frame through and every
  // later drawOneFrame() short-circuits into a no-op. Advance a monotonic clock instead.
  let clock = 0;
  const drawOneFrame = () => {
    const pending = frames.splice(0, frames.length);
    clock += 100;
    pending.forEach((callback) => callback(clock));
  };
```

**Step 3: 确认探针现在看到真的重绘**

Run: `node test_gene_atlas_layer.js 2>&1 | tail -3`
Expected: 两个数字不同（基因层只有少数区有值）。

**Step 4: 删掉探针，跑完整套件**

Run: `node test_gene_atlas_layer.js`
Expected: 全部通过。**若有测试此时开始失败，那是它本来就在空转、断言从未真正生效**——
把失败原因记下来，在对应任务里修，不要为了让它绿而把时钟改回去。

**Step 5: Commit**

```bash
git add test_gene_atlas_layer.js
git commit -m "test: drive atlas frames with a monotonic clock

render() throttles at 30 ms, so a fixed callback(0) let only the boot frame
through and every later drawOneFrame() was a no-op. Every state-change render
assertion in this file was checking stale boot pixels."
```

---

## Task 1: 密度标定与点位分配的纯函数模块

一个新模块承担四件纯计算：分段密度标定、固定置换、按组窗口分配、标签级 support
加权聚合。放在独立文件是为了能脱离 jsdom 直接单测。

**Files:**
- Create: `interactive_brain_atlas/gene_point_cloud.js`
- Create: `test_gene_point_cloud.js`

**Step 1: 写失败的测试**

新建 `test_gene_point_cloud.js`：

```js
// Pure calibration/allocation maths for the gene expression point cloud.
// Runs without jsdom: every function here is a pure function of its arguments.
const assert = require('node:assert/strict');
const cloud = require('./interactive_brain_atlas/gene_point_cloud.js');

// The real cell_weighted/mean calibration, from index.json.
const SCALE = {
  breakpoint: 0.5201,
  reference: 3.5091,
  lowKnots: [0, 0.0008, 0.003, 0.0085, 0.0196, 0.0372, 0.0602,
             0.0889, 0.1253, 0.1729, 0.2382, 0.3379, 0.5201],
};

function testNormaliseInvariants() {
  assert.equal(cloud.normalise(0, SCALE), 0, 'zero must not light anything');
  assert.equal(cloud.normalise(-1, SCALE), 0, 'negative values must not light anything');
  assert.equal(cloud.normalise(SCALE.breakpoint, SCALE), cloud.D_LOW,
    'the breakpoint must land exactly on the low segment budget');
  assert.equal(cloud.normalise(SCALE.reference, SCALE), 1, 'the reference must saturate');
  assert.equal(cloud.normalise(SCALE.reference * 9, SCALE), 1, 'above the reference must clamp');
}

function testNormaliseIsContinuousAtTheBreakpoint() {
  // Compare the two branch formulas at the breakpoint itself. Do NOT use a finite
  // difference with a small tolerance: the high segment has an infinite derivative
  // there, so norm(bp + 1e-9) already differs by ~5.5e-6 and a 1e-6 tolerance
  // reports a false failure. Slope is deliberately discontinuous (design section 4.2).
  const atBreakpoint = cloud.normalise(SCALE.breakpoint, SCALE);
  const justAbove = cloud.normalise(SCALE.breakpoint + 1e-12, SCALE);
  assert.ok(justAbove >= atBreakpoint, 'the high segment must start at or above the low segment');
  assert.ok(justAbove - atBreakpoint < 1e-3, 'and must not jump');
}

function testNormaliseIsMonotonic() {
  let previous = -1;
  for (let step = 0; step <= 20000; step += 1) {
    const value = (step / 20000) * SCALE.reference * 1.3;
    const density = cloud.normalise(value, SCALE);
    assert.ok(density >= previous, `density dropped at value ${value}`);
    previous = density;
  }
}

function testLitCountHonoursTheFloorAndTheWindow() {
  assert.equal(cloud.litCount(0, SCALE, 120), 0, 'no data must stay dark');
  assert.equal(cloud.litCount(1e-9, SCALE, 120), cloud.MIN_LIT,
    'a tiny but present value must still be distinguishable from no data');
  assert.equal(cloud.litCount(SCALE.reference, SCALE, 120), 120, 'the reference lights the window');
  assert.equal(cloud.litCount(SCALE.reference, SCALE, 2), 2, 'never exceed the window');
  assert.equal(cloud.litCount(SCALE.breakpoint, SCALE, 120), Math.round(120 * cloud.D_LOW),
    'the breakpoint lights D_LOW of the window');
}

function testPermutationIsAStableShuffle() {
  const first = cloud.permutationFor(7, 120);
  const again = cloud.permutationFor(7, 120);
  assert.deepEqual(first, again, 'the permutation must be stable across calls');
  assert.notDeepEqual(first, cloud.permutationFor(8, 120), 'different labels must differ');
  assert.deepEqual([...first].sort((a, b) => a - b), Array.from({ length: 120 }, (_, i) => i),
    'it must be a permutation of every index, losing and duplicating nothing');
  const identity = Array.from({ length: 120 }, (_, i) => i);
  assert.notDeepEqual(first, identity, 'and it must actually shuffle');
}

function testRaisingAValueOnlyAddsPoints() {
  // The whole point of a fixed permutation: already-lit points must not move when the
  // value changes, otherwise switching metric makes the cloud flicker and re-scatter.
  const order = cloud.permutationFor(3, 120);
  const low = cloud.litIndices(order, 0, 1, 0.05, SCALE);
  const high = cloud.litIndices(order, 0, 1, 0.4, SCALE);
  assert.ok(high.length > low.length, 'a higher value must light more points');
  assert.deepEqual(high.slice(0, low.length), low, 'and must keep the earlier points in place');
}

function testGenesGetDisjointWindowsAndSublinearGrowth() {
  const order = cloud.permutationFor(5, 120);
  const saturated = SCALE.reference;
  const single = cloud.litIndices(order, 0, 1, saturated, SCALE).length;
  const ofFour = cloud.litIndices(order, 0, 4, saturated, SCALE).length;
  assert.equal(single, 120, 'one gene may use the whole label');
  assert.equal(ofFour, 60, 'four genes get P/sqrt(4) each');
  const windows = [0, 1, 2, 3].map((index) => cloud.litIndices(order, index, 4, saturated, SCALE));
  windows.forEach((window, index) => {
    assert.equal(window.length, 60, `gene ${index} must get the same window size`);
  });
  const starts = windows.map((window) => window[0]);
  assert.equal(new Set(starts).size, 4, 'each gene must start at its own offset');
}

function testAggregateByLabelIsSupportWeighted() {
  // Label 114 (hippocampus head) is claimed by 10 DigitalBrain regions. The coarse
  // "CA1 CA2 CA3" bucket holds 59 cells against CA1U's 176k-scale neighbours, so a
  // plain mean would let 59 cells outvote the rest. Support weighting must not.
  const labelToRegions = new Map([[0, ['CA1 CA2 CA3', 'CA1U']]]);
  const gene = {
    values: { 'CA1 CA2 CA3': 0.3745, CA1U: 0.0199 },
    support: { 'CA1 CA2 CA3': 59, CA1U: 235349 },
  };
  const aggregated = cloud.aggregateByLabel(gene, labelToRegions, 1);
  assert.equal(aggregated.hasValue[0], 1, 'the label must resolve to a value');
  const expected = (0.3745 * 59 + 0.0199 * 235349) / (59 + 235349);
  assert.ok(Math.abs(aggregated.values[0] - expected) < 1e-12, 'support-weighted mean');
  assert.ok(aggregated.values[0] < 0.021, 'the 59-cell bucket must not dominate');
}

function testAggregateByLabelSkipsLabelsWithoutData() {
  const labelToRegions = new Map([[0, ['NOPE']], [1, []]]);
  const aggregated = cloud.aggregateByLabel({ values: {}, support: {} }, labelToRegions, 2);
  assert.equal(aggregated.hasValue[0], 0, 'a claimant without a value leaves the label dark');
  assert.equal(aggregated.hasValue[1], 0, 'a label with no claimant leaves it dark');
}

const tests = [
  testNormaliseInvariants,
  testNormaliseIsContinuousAtTheBreakpoint,
  testNormaliseIsMonotonic,
  testLitCountHonoursTheFloorAndTheWindow,
  testPermutationIsAStableShuffle,
  testRaisingAValueOnlyAddsPoints,
  testGenesGetDisjointWindowsAndSublinearGrowth,
  testAggregateByLabelIsSupportWeighted,
  testAggregateByLabelSkipsLabelsWithoutData,
];
tests.forEach((test) => {
  test();
  console.log(`ok - ${test.name}`);
});
console.log(`\n${tests.length} passed`);
```

**Step 2: 跑测试，确认它因模块不存在而失败**

Run: `node test_gene_point_cloud.js`
Expected: FAIL — `Cannot find module './interactive_brain_atlas/gene_point_cloud.js'`

**Step 3: 写实现**

新建 `interactive_brain_atlas/gene_point_cloud.js`：

```js
// Density calibration and point allocation for the gene expression layer.
//
// Kept out of app.js so the maths can be unit-tested without jsdom. Every constant
// here has a measured justification in docs/plans/2026-08-04-gene-point-cloud-design.md;
// do not retune them by eye.
(function (global) {
  const K = 12;          // low-segment knot count; lowKnots carries K + 1 entries
  const D_LOW = 0.7;     // density budget handed to the bottom 90% of corpus values
  const P_HI = 0.6;      // high-segment exponent: 0.5 leaves a 2.4pt bulge, 1.0 flattens
  const MIN_LIT = 3;     // "present but very low" must stay distinguishable from "no data"

  function normalise(value, scale) {
    if (!(value > 0)) return 0;
    const { breakpoint, reference, lowKnots } = scale;
    if (value <= breakpoint) {
      for (let index = 1; index < lowKnots.length; index += 1) {
        if (value <= lowKnots[index]) {
          const span = lowKnots[index] - lowKnots[index - 1];
          const offset = span <= 0 ? 0 : (value - lowKnots[index - 1]) / span;
          return ((index - 1 + offset) / K) * D_LOW;
        }
      }
      return D_LOW;
    }
    const above = Math.min(1, (value - breakpoint) / (reference - breakpoint));
    return D_LOW + (1 - D_LOW) * above ** P_HI;
  }

  function litCount(value, scale, windowSize) {
    if (!(value > 0) || windowSize <= 0) return 0;
    const wanted = Math.round(windowSize * normalise(value, scale));
    return Math.min(windowSize, Math.max(MIN_LIT, wanted));
  }

  function permutationFor(labelIndex, size) {
    // Fisher-Yates over a mulberry32 stream seeded from the label index. Two properties
    // matter: the window's leading entries scatter through the whole label instead of
    // clustering in one corner, and raising a value only appends points rather than
    // re-shuffling the ones already lit.
    const order = Array.from({ length: size }, (unused, index) => index);
    let seed = ((labelIndex + 1) * 0x9e3779b9) >>> 0;
    const nextRandom = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let mixed = seed;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
    for (let index = size - 1; index > 0; index -= 1) {
      const swap = Math.floor(nextRandom() * (index + 1));
      const held = order[index];
      order[index] = order[swap];
      order[swap] = held;
    }
    return order;
  }

  function litIndices(order, geneIndex, geneCount, value, scale) {
    const size = order.length;
    if (!size) return [];
    const windowSize = Math.max(1, Math.round(size / Math.sqrt(geneCount)));
    const lit = litCount(value, scale, windowSize);
    if (!lit) return [];
    const start = Math.round((geneIndex * size) / geneCount);
    const picked = [];
    for (let step = 0; step < lit; step += 1) picked.push(order[(start + step) % size]);
    return picked;
  }

  function aggregateByLabel(gene, labelToRegions, labelCount) {
    // Allen has one hippocampus label against ten DigitalBrain subregions, so the
    // colouring unit is the label. Support weighting is exactly "pool the cells, then
    // recompute": the buckets are disjoint (their cell counts sum to 0.737x the dataset
    // total), so nothing is double counted. See design section 5.2.
    const values = new Float64Array(labelCount);
    const hasValue = new Uint8Array(labelCount);
    labelToRegions.forEach((acronyms, labelIndex) => {
      let weighted = 0;
      let support = 0;
      for (const acronym of acronyms) {
        const value = gene.values[acronym];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        const cells = gene.support[acronym];
        const weight = typeof cells === "number" && cells > 0 ? cells : 0;
        if (!weight) continue;
        weighted += value * weight;
        support += weight;
      }
      if (support > 0) {
        values[labelIndex] = weighted / support;
        hasValue[labelIndex] = 1;
      }
    });
    return { values, hasValue };
  }

  const api = { K, D_LOW, P_HI, MIN_LIT, normalise, litCount, permutationFor, litIndices, aggregateByLabel };
  global.GenePointCloud = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
```

**Step 4: 跑测试确认通过**

Run: `node test_gene_point_cloud.js`
Expected: `9 passed`

**Step 5: 变异测试——确认护栏真的会响**

把 `P_HI` 临时改成 `1`，跑测试。Expected: `testNormaliseInvariants` 仍过（不变量与幂次无关），
但这说明**幂次没有被护栏覆盖**。加一条断言把它钉死：

```js
function testHighSegmentExponentIsPinned() {
  // P_HI = 0.6 was chosen by measurement: 0.5 leaves a 2.4-point density bulge just
  // above the breakpoint, 1.0 flattens high-abundance genes from 13.0 to 5.9 points of
  // within-gene contrast. Pin the curve so a "simplification" cannot silently retune it.
  const midway = SCALE.breakpoint + (SCALE.reference - SCALE.breakpoint) * 0.5;
  const expected = cloud.D_LOW + (1 - cloud.D_LOW) * 0.5 ** 0.6;
  assert.ok(Math.abs(cloud.normalise(midway, SCALE) - expected) < 1e-12,
    'the high segment must stay at the measured exponent');
}
```

把它加进 `tests` 数组，确认改 `P_HI = 1` 时它失败、改回 `0.6` 时通过，再把实现改回去。

**Step 6: 注册模块到 4 处**

- `digitalneuron_main.html:472` 之前插入
  `<script src="interactive_brain_atlas/gene_point_cloud.js"></script>`
- `interactive_brain_atlas/index.html:578` 之前插入
  `<script src="gene_point_cloud.js"></script>`
- `build_pages_release.py` atlas 资源字典加
  `"interactive_brain_atlas/gene_point_cloud.js": "atlas/gene_point_cloud.js",`
- `test_gene_atlas_layer.js:81` 的数组里，在 `'app.js'` **之前**加 `'gene_point_cloud.js'`

Run: `node test_gene_atlas_layer.js && /home/jialiang/miniconda3/envs/scbrain/bin/python -m pytest test_build_pages_release.py -q`
Expected: 都通过。

**Step 7: Commit**

```bash
git add interactive_brain_atlas/gene_point_cloud.js test_gene_point_cloud.js \
        digitalneuron_main.html interactive_brain_atlas/index.html \
        build_pages_release.py test_gene_atlas_layer.js
git commit -m "feat(atlas): add pure density calibration and point allocation module

Piecewise density scale (12-knot corpus CDF low segment owning 0.70 of the
range, ^0.6 high segment), a per-label fixed permutation so raising a value
only appends points, sublinear P/sqrt(n) windows per gene, and label-level
support-weighted aggregation."
```

---

## Task 2: `densityScale` 进 `index.json`

标定表必须与数据同版，且按 `规则 × 指标` 分四组——实测两个规则的 `mean` 参照差 21%，
共用一个会在切换规则时错标量程。

**Files:**
- Create: `scripts/compute_density_scale.py`
- Create: `test_compute_density_scale.py`
- Modify: `scripts/export_gene_atlas_web.py:252-272`（`write_index_file`）
- Modify: `test_export_gene_atlas_web.py`（加一条断言）

**Step 1: 写失败的测试**

新建 `test_compute_density_scale.py`：

```python
"""密度标定表的计算：分位数取法、四组齐全、detection 用天然上界。"""
import json

from scripts import compute_density_scale as mod


def _payload(mean_values, detection_values, support_keys):
    return {
        "cell_weighted": {"regions": {"mean": mean_values, "detection": detection_values}},
        "donor_balanced": {"regions": {"mean": mean_values, "detection": detection_values}},
    }


def test_detection_reference_is_the_natural_bound():
    # detection 是比率，语义上界就是 1。用数据派生的 0.9877/0.9458 会让同一个 0.95
    # 在两个规则下渲染出不同密度，这是无意义的差别。
    values = {f"R{i}": (i + 1) / 100 for i in range(60)}
    scales = mod.density_scales([_payload(values, values, values)], set(values))
    for rule in ("cell_weighted", "donor_balanced"):
        assert scales[rule]["detection"]["reference"] == 1


def test_mean_reference_is_the_corpus_p9999_not_the_max():
    # max 会把约四分之一的量程让给极少数离群值。
    values = {f"R{i}": 0.1 for i in range(60)}
    values["R0"] = 99.0
    scales = mod.density_scales([_payload(values, values, values)], set(values))
    assert scales["cell_weighted"]["mean"]["reference"] < 99.0


def test_knots_are_well_formed():
    values = {f"R{i}": (i + 1) / 100 for i in range(60)}
    scales = mod.density_scales([_payload(values, values, values)], set(values))
    for rule in scales:
        for metric in scales[rule]:
            knots = scales[rule][metric]["lowKnots"]
            assert len(knots) == 13, "12 段需要 13 个节点"
            assert knots[0] == 0
            assert knots[-1] == scales[rule][metric]["breakpoint"]
            assert knots == sorted(knots)


def test_only_mapped_regions_count():
    # 没有几何映射的区永远不会被画出来，把它们计入分位数会歪掉标定。
    mapped = {f"R{i}": 0.1 for i in range(60)}
    unmapped = {"GHOST": 99.0}
    scales = mod.density_scales([_payload({**mapped, **unmapped}, mapped, mapped)], set(mapped))
    assert scales["cell_weighted"]["mean"]["reference"] < 99.0
```

**Step 2: 跑测试确认失败**

Run: `/home/jialiang/miniconda3/envs/scbrain/bin/python -m pytest test_compute_density_scale.py -q`
Expected: FAIL — `ModuleNotFoundError` / `AttributeError: density_scales`

**Step 3: 写实现**

新建 `scripts/compute_density_scale.py`，提供：

- `density_scales(payloads, mapped_acronyms)` → 上面测试要求的四组结构。
  实现要点：对每个 `(规则, 指标)` 收集**有几何映射的区内的非零值**，只统计至少有
  40 个非零区的基因；`breakpoint = p90`、`mean` 的 `reference = p99.99`、
  `detection` 的 `reference = 1`、`lowKnots[i] = 分位 (i/12) × 0.90`，全部 `round(…, 6)`。
- `main(argv)` CLI：扫描 `gene_atlas_web/genes/*.json`（跳过 `*.detail.json`），
  就地把 `densityScale` 补写进 `gene_atlas_web/index.json`，并打印四组数值。
  加 `--check` 只比对不改写、有偏差退出码 1（与 `sync_region_groups.mjs` 同风格）。

`mapped_acronyms` 从 `interactive_brain_atlas/data/allen_3d_geometry.js` 的
`regionMappings` 键取（该文件是 `window.ALLEN_3D_ATLAS = {...}` 的 JS 赋值，
用正则截出 `{` 到末尾的 JSON 即可，不要引 node）。

**Step 4: 跑测试确认通过**

Run: `/home/jialiang/miniconda3/envs/scbrain/bin/python -m pytest test_compute_density_scale.py -q`
Expected: 4 passed

**Step 5: 接进导出管线**

`scripts/export_gene_atlas_web.py:252` 的 `write_index_file` 签名加
`density_scale=None`，并在 `doc` 里加一项（放在 `"rules"` 之后）：

```python
        "densityScale": density_scale or {},
```

在 `test_export_gene_atlas_web.py` 加一条：传入 `density_scale` 时 `index.json` 里
带得出来、四组齐全。

**Step 6: 补写现有产物并核对**

Run:
```bash
/home/jialiang/miniconda3/envs/scbrain/bin/python scripts/compute_density_scale.py
```
Expected: 约 6–7 秒；打印的四组数值应与设计文档 §十 完全一致，特别是
`cell_weighted/mean` 的 `breakpoint 0.5201`、`reference 3.5091`。**若不一致，
停下来查原因**（很可能是分位取法或映射区集合不同），不要直接改设计文档。

再验证幂等与 `--check`：
```bash
/home/jialiang/miniconda3/envs/scbrain/bin/python scripts/compute_density_scale.py --check && echo "check 通过"
```

**Step 7: Commit**

```bash
git add scripts/compute_density_scale.py test_compute_density_scale.py \
        scripts/export_gene_atlas_web.py test_export_gene_atlas_web.py
git commit -m "feat(genes): ship the per-rule density calibration in index.json

The two aggregation rules differ by 21% on the mean anchor, so one shared
scale would mislabel the range whenever the rule is switched. detection uses
the natural bound of 1 rather than a derived percentile."
```

> `gene_atlas_web/` 是否入库取决于既有 `.gitignore`。若被忽略，则 `index.json` 的
> 改动不进提交，只在部署时由脚本生成——这一点在 Task 9 的发布检查里再确认。

> **已确认：`gene_atlas_web/` 被 `.gitignore:16` 忽略。** 所以 `index.json` 的
> `densityScale` 是**部署期产物、不进提交**。由此推出一条硬要求：atlas 侧遇到缺失
> 的标定表必须**显式报错**（Task 3 Step 3），绝不能静默兜底一个默认量程——那会让
> 旧数据配新代码时所有密度悄悄偏掉，且不报错。

---

## Task 3: 多基因接缝签名

`applyGeneValues` 现在只收单基因的 `{ values, metric }`（`app.js:3025`）。改成多基因
数组，并把标定表与聚合规则一起传进来。**旧签名不保留**——仓库里只有
`gene-atlas-view.js` 一个调用方，留兼容分支等于永久维护第二条代码路径。

**Files:**
- Modify: `interactive_brain_atlas/app.js:3023-3033`（`applyGeneValues`）
- Modify: `interactive_brain_atlas/app.js` 状态字段（`state.geneValues` → 多基因）
- Modify: `gene-atlas-data.js`（加 `densityScale()` 访问器，挨着 `rule()`/`metric()`，L71-85）
- Modify: `gene-atlas-view.js:84-96`（`repaint`）
- Modify: `test_gene_atlas_layer.js`（把既有 21 条测试迁到新签名）
- Modify: `test_gene_atlas_view.js`（宿主侧断言）

**新签名（设计 §九）：**

```js
atlas.applyGeneValues({
  metric: "mean" | "detection",
  rule: "cell_weighted" | "donor_balanced",
  scale: { breakpoint, reference, lowKnots },   // index.densityScale[rule][metric]
  genes: [
    { symbol, colour, values: { acronym: number }, support: { acronym: cells } },
  ],
});
```

四个决定的理由（**不要"简化"掉**）：数组而非映射，因为顺序决定偏移方向角 `2πi/n`；
`colour` 由宿主给，因为芯片颜色与点云颜色只能有一个来源，而宿主已有 `CHIP_COLOURS`
与 `colourFor(symbol)`；`support` 随每个基因走，因为聚合必须在 atlas 侧（`label → regions`
的逆映射只有它的 `regionMappings` 有）；`scale` 传整个对象而不拆三个参数，因为三者
必须同源同版。

**Step 1: 写失败的测试**

在 `test_gene_atlas_layer.js` 加：

```js
function testApplyGeneValuesRejectsAMissingCalibration() {
  // index.json lives outside git (gitignored), so a stale payload paired with new code
  // is a real deployment scenario. It must fail loudly, not silently pick a default
  // range: every density would be quietly wrong with nothing on screen to say so.
  const { window } = bootAtlas();
  assert.throws(
    () => window.DigitalBrainAtlas.applyGeneValues({
      metric: 'mean',
      rule: 'cell_weighted',
      genes: [{ symbol: 'AIF1', colour: '#61ddb2', values: {}, support: {} }],
    }),
    /densityScale|calibration/i,
    'a payload without a scale must be refused',
  );
}

function testApplyGeneValuesAcceptsSeveralGenes() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const picked = someMappedAcronyms(window, 2);
  const summary = atlas.applyGeneValues({
    metric: 'mean',
    rule: 'cell_weighted',
    scale: SCALE,
    genes: [
      { symbol: 'AIF1', colour: '#61ddb2', values: { [picked[0]]: 0.4 }, support: { [picked[0]]: 1000 } },
      { symbol: 'GFAP', colour: '#f0a36a', values: { [picked[1]]: 1.2 }, support: { [picked[1]]: 2000 } },
    ],
  });
  assert.equal(summary.layer, 'genes');
  assert.deepEqual(summary.genes.map((gene) => gene.symbol), ['AIF1', 'GFAP'],
    'the summary must report each gene in the order given');
  assert.doesNotThrow(drawOneFrame);
}
```

`SCALE` 用 Task 1 测试里那份真实的 `cell_weighted/mean` 标定，提到文件顶部共用。

**Step 2: 跑测试确认失败**

Run: `node test_gene_atlas_layer.js`
Expected: FAIL —— 新签名未实现；同时**既有那些用旧签名的测试仍然通过**（此时新旧并存）。

**Step 3: 写实现**

- `state.geneValues`（单基因映射）替换为 `state.genes`（数组）+ `state.geneScale`。
  保留 `state.geneMetric`，新增 `state.geneRule`。
- `applyGeneValues(payload)`：校验 `payload.scale` 的 `breakpoint`/`reference`/`lowKnots`
  齐全且 `lowKnots.length === 13`，否则
  `throw new Error("applyGeneValues needs a densityScale for " + rule + "/" + metric)`。
- 建 `labelToRegions`（`Map<labelIndex, acronym[]>`）：遍历 `anatomy.regionMappings`
  的每个 `labelIndices`，反向累积。**在模块加载时建一次**，它不随基因变化。
- 对每个基因调 `GenePointCloud.aggregateByLabel(gene, labelToRegions, anatomy.labels.length)`，
  结果存进 `state.genes[i].byLabel`。
- `geneSummary()` 增 `genes: [{ symbol, colour, min, max }]`（`min`/`max` 取该基因
  **聚合后**在标签上的实测范围，供图例每行用）。
- `geneValueFor(region)`（`app.js` 内）保留给详情面板用，但改成取**第一个**基因的
  区域级值；详情面板本来就逐区列数字，不受标签合并影响。

宿主侧：
- `gene-atlas-data.js` 在 `rule()`/`metric()` 旁加
  ```js
  function densityScale() {
      const table = state.index && state.index.densityScale;
      return (table && table[rule()] && table[rule()][metric()]) || null;
  }
  ```
  并加进导出对象。
- `gene-atlas-view.js:84-96` 的 `repaint` 改为组装多基因数组，`colour` 用已有的
  `colourFor(symbol)`，`scale` 用 `data.densityScale()`。

**Step 4: 迁移既有测试**

把 `test_gene_atlas_layer.js` 里所有 `applyGeneValues({ values, metric })` 调用改成
新签名。**逐条跑，注意哪些是 Task 0 修好时钟后才第一次真正生效的**——它们可能暴露
既有缺陷，逐个记录处置，不要为了绿而放宽断言。

Run: `node test_gene_atlas_layer.js && node test_gene_atlas_view.js`
Expected: 全部通过。

**Step 5: Commit**

```bash
git add interactive_brain_atlas/app.js gene-atlas-data.js gene-atlas-view.js \
        test_gene_atlas_layer.js test_gene_atlas_view.js
git commit -m "feat(atlas): take several genes and an explicit density calibration

applyGeneValues now receives an ordered gene array (the order fixes each
gene's offset angle), the host-owned colour so chips and cloud cannot drift
apart, per-gene support for label-level aggregation, and the calibration
itself. A payload without a calibration is refused rather than defaulted."
```

---

## Task 4: 基因层点云渲染

信号搬到点云本身。现在 `drawAtlasPointGroups`（`app.js:734`）按 `label.color` 着色、
从不读基因值，点云只是解剖底图。

**Files:**
- Modify: `interactive_brain_atlas/app.js:734-762`（`drawAtlasPointGroups`）
- Modify: `interactive_brain_atlas/app.js:872-873`（调用点）
- Modify: `test_gene_atlas_layer.js`

**关键约束（设计 §4.5，实测得来）：**

- 窗口**按组独立分配**：`atlasOuterPointGroups` 与 `atlasBoundaryPointGroups` 各自
  一份置换、各自 `k = round(P_group/√n)`。合并成一份窗口会让切轮廓改变点亮**比例**，
  看起来像密度变了。
- 基因层**无条件绘制两组**，不再由 `state.showContours` 决定边界组：90 个被声明标签里
  有 **26 个完全没有 outer 点**，轮廓关掉时它们一个点也不画，在其上高表达的基因会
  静默消失。边界组占 56% 的点（8,045 / 14,252），在基因层它是数据载体不是装饰。
- 三档点大小对应 `status`：`recoverable_exact_or_union` → 1.9px、
  `coarse_ontology_proxy` → 1.6px、`curated_gyral_proxy` → 1.4px，都乘
  `projected.perspective`。**混合置信度取最保守的一档**（只有 `label 51 HTHma` 一例）。
- 偏移方向角 `2πi/n`、半径约 2px，**乘 perspective**（让偏移是同一个物理量而不是同一个
  屏幕量）；再叠 ≤1px 的确定性抖动（点索引哈希），打散体素网格条纹。

**Step 1: 写失败的测试**

```js
function testGeneCloudLightsMorePointsForHigherValues() {
  const { window, drawOneFrame } = bootAtlas();
  const atlas = window.DigitalBrainAtlas;
  const acronym = someMappedAcronyms(window, 1)[0];
  const drawn = [];
  // Count the point-cloud writes: the atlas draws voxels with fillRect and markers
  // with arc/fill, so fillRect alone isolates the cloud.
  window.HTMLCanvasElement.prototype.getContext = () => {
    const stub = stubContext();
    stub.fillRect = () => drawn.push(1);
    return stub;
  };
  const paint = (value) => {
    drawn.length = 0;
    atlas.applyGeneValues({
      metric: 'mean', rule: 'cell_weighted', scale: SCALE,
      genes: [{ symbol: 'AIF1', colour: '#61ddb2', values: { [acronym]: value }, support: { [acronym]: 1000 } }],
    });
    drawOneFrame();
    return drawn.length;
  };
  assert.ok(paint(1.5) > paint(0.05), 'a higher value must light more voxels');
}

function testGeneCloudIgnoresTheContourToggle() {
  // 26 of the 90 claimed labels have no outer points at all, so letting a cosmetic
  // toggle govern the boundary group would make those genes vanish silently.
  const { window, drawOneFrame } = bootAtlas();
  // ... count fillRect with showContours on and off; assert both are non-zero and equal
}

function testGeneCloudPointCountGrowsSublinearly() {
  // One gene against four: total lit points must grow by about sqrt(4) = 2x, not 4x.
}
```

**Step 2: 跑测试确认失败** — Run: `node test_gene_atlas_layer.js`

**Step 3: 写实现**

`drawAtlasPointGroups(pointGroups, boundaryLayer)` 增加基因分支：当
`state.dataLayer === "genes" && state.genes?.length` 时，对每个标签、每个基因：

```js
const order = permutationCache(groupKey, labelIndex, points.length);
const lit = GenePointCloud.litIndices(order, geneIndex, geneCount, value, state.geneScale);
```

置换要**缓存**（`Map` 键 `groupKey + ":" + labelIndex`），否则每帧重算 Fisher-Yates
会把 1.4 万点的开销翻好几倍。

调用点 `app.js:872-873` 改为基因层时两组都画：

```js
    const geneMode = state.dataLayer === "genes" && Boolean(state.genes && state.genes.length);
    drawAtlasPointGroups(atlasOuterPointGroups);
    // In the genes layer the boundary group carries 56% of the voxels and is the only
    // substrate for 26 labels, so it is data rather than contour decoration.
    if (geneMode || state.showContours) drawAtlasPointGroups(atlasBoundaryPointGroups, true);
```

**Step 4: 跑测试确认通过并核性能**

Run: `node test_gene_atlas_layer.js`

再手工核一次帧预算（设计 §八：预算 30ms，实测 22.4k 点 = 1.8ms、45k = 3.7ms）：
20 个基因时总点数约 `14,252 × √20 ≈ 63.7k`，估算 ~5.2ms。若实测明显超出，
**先查是不是置换没缓存**。

**Step 5: Commit**

```bash
git add interactive_brain_atlas/app.js test_gene_atlas_layer.js
git commit -m "feat(atlas): encode gene values as point-cloud density

Windows are allocated per point group so toggling contours changes the number
of voxels drawn but not the lit fraction, and the genes layer always draws the
boundary group: it holds 56% of the voxels and is the only substrate for 26 of
the 90 claimed labels."
```

---

## Task 5: 16px 屏幕命中网格

现在命中靠每区一个 8–12px 圆盘（`app.js:1416` 的 `radius: Math.max(8, radius + 4)`，
`findRegionAt` 在 `app.js:2318`）。点云铺开后会出现"点亮一大片却只有中心一小块能点"——
大区投影可跨 100px 以上。

**Files:**
- Modify: `interactive_brain_atlas/app.js`（绘制时建网格；`findRegionAt` 增基因层分支）
- Modify: `test_gene_atlas_layer.js`

**做法：** 绘制点云时顺手写一张 16px 粒度的网格（1200×800 → 75×50 = 3,750 格），
每格存 z 最近的那个点的**标签 id + 基因序号**。`mousemove` 查一格，O(1)。额外成本是
每点一次数组写入（约 3 万次，相对已有的 3 万次 `fillRect` 可忽略）。

基因序号要一起存——这让"点击查看该基因在此处的明细"成为可能，也是 tooltip 能说清
"你指的是哪个基因"的前提。

**Step 1-4:** 测试要覆盖：给定落在某标签点上的屏幕坐标能取回该标签与基因序号；
两个基因偏移后各自的坐标取回各自的序号；基因层之外网格不参与（走原圆盘路径）。

**Step 5: Commit**

```bash
git commit -m "feat(atlas): hit-test the gene cloud through a screen grid

A per-region 8-12px disc cannot cover a parcel whose projection spans 100px,
so the whole lit cloud is clickable now and the grid also records which gene
each pixel belongs to."
```

---

## Task 6: `legendGenes` 图例块与三档映射图例

**基因层现在没有可见图例。** `drawRegions()` 确实把范围写进 `legendRange`
（`app.js:1303-1307`，jsdom 实测 `"0.40–2.68"`），但该元素在 `legendSingle` 内部，
而 `syncCellTypeControls()`（`app.js:1709`）在非 cells 层把 `legendSingle` 与
`legendAll` **都隐藏**。范围算对了、写进去了、看不见。

**Files:**
- Modify: `interactive_brain_atlas/index.html:372-418`（图例块）
- Modify: `interactive_brain_atlas/styles.css`（新块样式，参照既有 `.legend-*`）
- Modify: `interactive_brain_atlas/app.js`（`syncCellTypeControls` 增显隐、`drawRegions` 填内容）
- Modify: `test_gene_atlas_layer.js`

**新增 `legendGenes`（默认 `hidden`），基因层显示：**

- **每基因一行**：色块 + symbol + 该基因实测 `min–max` + **丰度位标**（在共用的
  `0–reference` 轴上标出该基因 max 的位置，一眼看出整体是高丰度还是低丰度）
- 一条**密度标尺**：从疏到密的点带，下方按 `GenePointCloud.normalise()` 落位标出
  若干圆整值（`mean`：0.05 / 0.1 / 0.5 / 1 / 2；`detection`：10% / 25% / 50% / 75%），
  并在断点处加一道细分隔线。**分段标定无法用一行公式讲清，所以必须给刻度**——
  这是所有非线性色标的通行做法。
- 把 `mappingKey`（`index.html:414-417`）的两档虚实线改成三档点大小示意（1.9/1.6/1.4px）。

丰度位标是决策 7 的第二半：跨基因比较**格局靠密度、量级靠位标与数字**，不争同一通道。

**Step 1: 写失败的测试**

```js
function testGeneLayerShowsALegendRowPerGene() {
  // The bug this guards: the range was computed and written into legendRange all along,
  // but that element sits inside legendSingle, which syncCellTypeControls hides outside
  // the cells layer. Assert visibility, not just content.
  const { window, drawOneFrame } = bootAtlas();
  // ... apply two genes, drawOneFrame, then:
  const legend = window.document.getElementById('legendGenes');
  assert.equal(legend.hidden, false, 'the genes legend must be visible in the genes layer');
  assert.equal(legend.querySelectorAll('.legend-gene-row').length, 2, 'one row per gene');
}

function testDensityRampTicksSitWhereTheCalibrationPutsThem() {
  // ... assert a tick's offset matches GenePointCloud.normalise(tickValue, SCALE)
}

function testLeavingTheGeneLayerHidesTheGenesLegend() { /* ... */ }
```

**Step 5: Commit**

```bash
git commit -m "fix(atlas): give the genes layer a visible legend

The range was already computed and written, but into an element that
syncCellTypeControls hides outside the cells layer. The new block carries one
row per gene with its own min-max and an abundance marker, plus a tick-marked
density ramp, because a piecewise scale cannot be explained by a formula line."
```

---

## Task 7: 发布副本、全套验证与端到端

**Files:**
- Modify: `github-pages/`（由脚本重新生成）
- 可能 Modify: `build_pages_release.py`（若 Task 1 Step 6 已加则跳过）

**Step 1: 确认发布副本与源码的既有偏差**

`github-pages/gene-atlas-view.js` 目前落后源码 **35 行**（已实测 `diff`），不是排版差异
而是**行为差异**：发布副本仍把"没有选中基因"走 `clearGeneValues()`，于是点一下 metric
或 rule 就把用户踢出基因层；源码早已把 `repaint` 与 `teardown` 拆开修掉了这一点。
**线上站点因此带着一个源码已修的缺陷。** 先记下这条偏差，再重新生成，
以免把它误认成本次改动引入的。

**Step 2: 重新生成并核对**

```bash
/home/jialiang/miniconda3/envs/scbrain/bin/python build_pages_release.py
git diff --stat github-pages/
```
Expected: 差异只落在本次改过的文件 + 新增的 `atlas/gene_point_cloud.js`。
**确认 `github-pages/atlas/gene_point_cloud.js` 真的存在**——漏注册的话它不会报错，
只是发布版的基因层在浏览器里直接抛 `GenePointCloud is not defined`。

**Step 3: 跑全套**

```bash
for f in test_*.js; do node "$f" || echo "FAIL $f"; done
/home/jialiang/miniconda3/envs/scbrain/bin/python -m pytest -q
```
Expected: 全绿（`test_smoke.js` 那 3 条 rAF 报错是既有噪声，退出码 0）。

**Step 4: 端到端浏览器验证（此前一直缺，这次补上）**

```bash
cd /data/DigitalBrain/data/scBrain/web && python3 -m http.server 8765
```
逐项人工确认，**每项都要真的看到**：

1. 选 1 个基因 → 点云按密度点亮，不是每区一个圆点
2. 加到 3–4 个基因 → 各自一色、互不遮盖，总点数明显没有翻 n 倍
3. 切 `mean` / `detection` → 密度变化，已亮的点不重新散开（固定置换的可见证据）
4. 切 `cell_weighted` / `donor_balanced` → 标尺上的参照数值随之变化
5. 关掉轮廓开关 → 点亮**比例**不变（只是点少了），且没有区整块消失
6. 图例：每基因一行带 min–max 与丰度位标；密度标尺刻度位置合理
7. 点击点云边缘（不是中心）→ 详情面板正确打开
8. 旋转/缩放 → 偏移随透视缩放，近处远处看着是同一个物理量

**Step 5: Commit**

```bash
git add github-pages/
git commit -m "chore: regenerate the GitHub Pages release with the gene point cloud"
```

---

## 明确不做（设计 §十三）

- **小倍数形式**（每基因一个小脑图）。它是比较多个空间格局的最强实践，但已定
  "单脑图叠加多基因"且现有架构是单 canvas。若日后重议形式，它第一个上桌。
- **绝对/相对量程切换**。决策 7 选了固定的语料级绝对量程。
- 死代码清理：`drawShell()`、`drawRegionContours()`、`groupAnchors`（全文只有定义处，
  且缺 `Hypothalamus` 一项）。
- `scripts/_verify_parquet_chunks.py` 与 `_verify_parquet_merge.py` 的去留（两个未跟踪
  文件，与本次无关）。
