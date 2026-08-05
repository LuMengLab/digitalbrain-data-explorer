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

function testHighSegmentExponentIsPinned() {
  // P_HI = 0.6 was chosen by measurement: 0.5 leaves a 2.4-point density bulge just
  // above the breakpoint, 1.0 flattens high-abundance genes from 13.0 to 5.9 points of
  // within-gene contrast. Pin the curve so a "simplification" cannot silently retune it.
  const midway = SCALE.breakpoint + (SCALE.reference - SCALE.breakpoint) * 0.5;
  const expected = cloud.D_LOW + (1 - cloud.D_LOW) * 0.5 ** 0.6;
  assert.ok(Math.abs(cloud.normalise(midway, SCALE) - expected) < 1e-12,
    'the high segment must stay at the measured exponent');
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
  testHighSegmentExponentIsPinned,
];
tests.forEach((test) => {
  test();
  console.log(`ok - ${test.name}`);
});
console.log(`\n${tests.length} passed`);
