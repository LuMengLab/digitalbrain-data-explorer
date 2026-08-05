// 示意性细胞构成的生成规则，从 build_region_catalogue.mjs 抽出，
// 供该生成器与 sync_region_groups.mjs 共用一份实现。
//
// 这些比例是 **示意值**，不是测量值（regions.js 的 metadata.compositionProvenance
// 已如此声明）。它们由 region.group 决定，所以任何 group 的修正都必须
// 连带重算 composition，否则同一条记录里的分组与构成会互相矛盾。

export const CELL_TYPES = Object.freeze([
  "Excitatory neuron",
  "Inhibitory neuron",
  "Astrocyte",
  "Oligodendrocyte",
  "OPC",
  "Microglia",
  "Endothelial",
]);

const profileByGroup = {
  "Cerebral cortex": [0.43, 0.17, 0.13, 0.13, 0.05, 0.06, 0.03],
  "Hippocampal formation": [0.49, 0.11, 0.13, 0.12, 0.05, 0.07, 0.03],
  Thalamus: [0.31, 0.19, 0.14, 0.19, 0.06, 0.08, 0.03],
  Hypothalamus: [0.25, 0.25, 0.16, 0.16, 0.06, 0.09, 0.03],
  "Basal ganglia": [0.27, 0.27, 0.13, 0.17, 0.06, 0.07, 0.03],
  "Limbic / olfactory": [0.38, 0.21, 0.13, 0.13, 0.05, 0.07, 0.03],
  Cerebellum: [0.48, 0.16, 0.1, 0.13, 0.04, 0.06, 0.03],
  Brainstem: [0.24, 0.22, 0.15, 0.22, 0.06, 0.08, 0.03],
  "Other subcortical": [0.3, 0.21, 0.15, 0.18, 0.06, 0.07, 0.03],
};

function hashUnit(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

// 抖动只取决于 `${label}:${index}`，与分组无关，所以分组不变的区域重算后逐字节相同。
export function makeComposition(label, group) {
  const base = profileByGroup[group] || profileByGroup["Other subcortical"];
  const perturbed = base.map((value, index) => {
    const jitter = (hashUnit(`${label}:${index}`) - 0.5) * 0.06;
    return Math.max(0.012, value + jitter);
  });
  const total = perturbed.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(
    CELL_TYPES.map((cellType, index) => [
      cellType,
      Number((perturbed[index] / total).toFixed(5)),
    ]),
  );
}
