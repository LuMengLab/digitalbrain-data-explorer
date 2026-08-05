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
