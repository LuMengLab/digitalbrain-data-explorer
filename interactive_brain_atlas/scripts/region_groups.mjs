// 从脑区层级树推导 region.group，取代原先在 build_region_catalogue.mjs 里的正则级联。
//
// 原实现把 `"缩写 全名"` 小写化后逐条正则匹配、先命中者胜，产生过四类错误：
//   · 大小写撞车：SpC（脊髓）与 SPC（上顶叶皮层）小写化后同串，脊髓被判为皮层；
//   · 子串误伤：subthalamic 内含 thalam，STH 被丘脑分支截胡，
//     而基底节分支里写着的 \bsth\b 因此成了死代码（parahippocampal ⊃ hippoc 同理）；
//   · 只认字面词：下丘脑分支只匹配 hth|hypothalam，
//     所以 "mammillary nucleus"（树上是 Die/HTH/HTHma/MN）落到了脑干；
//   · 覆盖不全：杏仁核六个核团被拆进三个不同分组，尾状核体不在基底节里。
//
// 现在改为查 data/vendor/region_hierarchy_paths.json 的祖先路径，按
// **路径上最深的匹配节点** 判定，因此父子节点同时列表时子节点自动胜出，
// 不存在顺序依赖，也不会被名称里的子串影响。

// 树节点 → 分组。分组词表固定为 9 个：它同时是配色（app.js）、CSS
// 与 index.html 解剖示意图的契约，新增分组需要同步那三处。
const GROUP_BY_NODE = {
  // —— 端脑皮层 ——
  Cx: "Cerebral cortex", // 新皮层 NCx 与周边异皮层 PACx 都归皮层
  PalCx: "Limbic / olfactory", // 古皮层＝嗅皮层（AON、Pir）；注意与 PACx 不是同一节点
  HIP: "Hippocampal formation",

  // —— 端脑核团 ——
  CN: "Basal ganglia", // CN 的直系子代只有 Cla（屏状核）
  BN: "Basal ganglia", // 基底核：苍白球 GP、纹状体 STR、尾状核 Ca
  AMY: "Limbic / olfactory", // 杏仁核全部核团，含 BLN 与 CMN 两支
  BF: "Limbic / olfactory", // 基底前脑：隔核 SEP
  SI: "Basal ganglia", // 无名质在 BF 之下，但习惯与苍白球同列；保持原分组
  EXA: "Basal ganglia", // 延伸杏仁核 BNST：limbic 与 basal ganglia 两种读法都成立，保持原分组

  // —— 间脑 ——
  THM: "Thalamus",
  HTH: "Hypothalamus",
  SubTH: "Basal ganglia", // 底丘脑核在树上与丘脑并列而非其子代；功能上属基底节环路

  // —— 中脑与后脑 ——
  M: "Brainstem",
  Pn: "Brainstem",
  Mo: "Brainstem",
  CB: "Cerebellum",

  // —— 脑以外 ——
  // 脊髓的路径是 NP/NT/SpC，与 Br（脑）是兄弟节点，不在任何脑内分区之下。
  // 9 个固定分组里只有显式的兜底项可用；"Other" 至少不构成正面的错误断言。
  SpC: "Other subcortical",
};

export const REGION_GROUPS = Object.freeze([
  "Cerebral cortex",
  "Hippocampal formation",
  "Thalamus",
  "Hypothalamus",
  "Basal ganglia",
  "Limbic / olfactory",
  "Cerebellum",
  "Brainstem",
  "Other subcortical",
]);

// 单个树节点的分组：沿祖先路径由深到浅找第一个在表里的节点。
function groupForNode(node, paths) {
  const path = paths[node];
  if (!path) return null;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const group = GROUP_BY_NODE[path[index]];
    if (group) return group;
  }
  return null;
}

// 区域缩写可能是空格拼接的多节点集合（如 "CA1 CA2 CA3"）。要求各成员判定一致：
// 不一致说明该缩写跨越了分组边界，那是数据问题，应当暴露而不是任选其一。
export function classifyRegionGroup(acronym, paths) {
  const nodes = acronym.split(/\s+/).filter(Boolean);
  const decided = nodes.map((node) => [node, groupForNode(node, paths)]);

  const unknown = decided.filter(([, group]) => !group).map(([node]) => node);
  if (unknown.length) {
    throw new Error(
      `No hierarchy group for ${JSON.stringify(acronym)}; unresolved nodes: ${unknown.join(", ")}`,
    );
  }

  const distinct = [...new Set(decided.map(([, group]) => group))];
  if (distinct.length > 1) {
    const detail = decided.map(([node, group]) => `${node}→${group}`).join(", ");
    throw new Error(
      `Composite acronym ${JSON.stringify(acronym)} spans several groups (${detail})`,
    );
  }
  return distinct[0];
}
