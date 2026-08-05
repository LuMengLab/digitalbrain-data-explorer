// 脑区分组的回归护栏。
//
// 分组曾由 build_region_catalogue.mjs 里的正则级联判定，出过四类错误：
// 大小写撞车（SpC 脊髓被判为皮层，因为小写化后与 SPC 上顶叶皮层同串）、
// 子串误伤（subthalamic ⊃ thalam，parahippocampal ⊃ hippoc）、
// 只认字面词（"mammillary nucleus" 不含 hypothalam 于是落到脑干）、
// 以及覆盖不全（杏仁核核团散落三个分组、尾状核体不在基底节）。
//
// 现在分组由 scripts/region_groups.mjs 从层级树推导。这里的测试覆盖：
//   · 落盘数据与树的推导结果一致（等价于 sync_region_groups.mjs --check）；
//   · 分组词表不越界，因为它是 app.js 配色、styles.css 与 index.html 示意图的契约；
//   · composition 跟着 group 走，两者不会脱钩；
//   · 上述四类错误各自的具体回归点。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const atlasDir = path.join(__dirname, 'interactive_brain_atlas');

// regions.js / connectivity.js 都是 `window.X = {...}` 数据模块，用空 window 求值取出。
function loadDataModule(file, globalName) {
  const filePath = path.join(atlasDir, 'data', file);
  assert.ok(fs.existsSync(filePath), `Missing data module: ${filePath}`);
  const window = {};
  new Function('window', fs.readFileSync(filePath, 'utf8'))(window);
  const value = window[globalName];
  assert.ok(value, `${file} did not define window.${globalName}`);
  return value;
}

const regionData = loadDataModule('regions.js', 'DIGITALBRAIN_REGION_DATA');
const connectivityData = loadDataModule('connectivity.js', 'DIGITALBRAIN_CONNECTIVITY_DATA');
const knowledge = loadDataModule('atlas_knowledge.js', 'DIGITALBRAIN_ATLAS_KNOWLEDGE');
const hierarchy = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'vendor', 'region_hierarchy_paths.json'), 'utf8'),
);

const byAcronym = new Map(regionData.regions.map((region) => [region.acronym, region]));
const groupOf = (acronym) => {
  const region = byAcronym.get(acronym);
  assert.ok(region, `regions.js has no entry for ${acronym}`);
  return region.group;
};

function testTheVendoredHierarchyCoversEveryRegionAcronym() {
  const missing = [];
  for (const region of regionData.regions) {
    for (const node of region.acronym.split(/\s+/)) {
      if (!hierarchy.paths[node]) missing.push(`${region.acronym} → ${node}`);
    }
  }
  // 新增区域时若忘了扩充 vendor 子集，分类会直接抛错而不是静默降级，这里先给出可读的原因。
  assert.deepStrictEqual(missing, [], `Hierarchy subset is stale for: ${missing.join(', ')}`);
}

function testEveryRegionGroupAgreesWithTheHierarchy(classifyRegionGroup) {
  const drift = regionData.regions
    .filter((region) => classifyRegionGroup(region.acronym, hierarchy.paths) !== region.group)
    .map(
      (region) =>
        `${region.acronym}: ${region.group} != ${classifyRegionGroup(region.acronym, hierarchy.paths)}`,
    );
  assert.deepStrictEqual(drift, [], `Run scripts/sync_region_groups.mjs. Drift: ${drift.join('; ')}`);
}

function testGroupsStayInsideTheUiVocabulary(REGION_GROUPS) {
  // 词表是三处硬编码的契约：app.js 的 groupColors、styles.css 的
  // .anatomy-region[data-group=...]、index.html 的示意图 <g data-group=...>。
  const used = [...new Set(regionData.regions.map((region) => region.group))];
  const stray = used.filter((group) => !REGION_GROUPS.includes(group));
  assert.deepStrictEqual(stray, [], `Groups outside the UI vocabulary: ${stray.join(', ')}`);
}

function testCompositionIsDerivedFromTheGroup(makeComposition) {
  // composition 是 group 的函数；脱钩会让同一条记录里的分组与构成互相矛盾。
  const mismatched = regionData.regions
    .filter((region) => {
      const expected = makeComposition(region.acronym, region.group);
      return Object.keys(expected).some(
        (cellType) => expected[cellType] !== region.composition[cellType],
      );
    })
    .map((region) => region.acronym);
  assert.deepStrictEqual(mismatched, [], `Composition does not match group for: ${mismatched.join(', ')}`);
}

function testTheSpinalCordIsNotFiledUnderCerebralCortex() {
  // 树上 SpC 的路径是 NP/NT/SpC，与 Br（脑）是兄弟节点，根本不在脑内。
  assert.notStrictEqual(groupOf('SpC'), 'Cerebral cortex');
  assert.strictEqual(hierarchy.paths.SpC.includes('Br'), false);
}

function testAcronymsThatDifferOnlyInCaseAreNotConflated() {
  // 根因：原实现对 `"缩写 全名"` 做 toLowerCase() 后匹配，
  // SpC（脊髓）与 SPC（上顶叶皮层）由此变成同一个串。
  assert.strictEqual('SpC'.toLowerCase(), 'SPC'.toLowerCase());
  assert.notStrictEqual(groupOf('SpC'), groupOf('SPC'));
  assert.strictEqual(groupOf('SPC'), 'Cerebral cortex');
}

function testSubstringsOfLongerNamesDoNotDecideTheGroup() {
  // "subthalamic" 内含 "thalam"，"parahippocampal" 内含 "hippoc"。
  assert.strictEqual(groupOf('STH'), 'Basal ganglia');
  assert.strictEqual(groupOf('PPHC'), 'Cerebral cortex');
}

function testGroupComesFromTheTreeAndNotFromWordsInTheName() {
  // "mammillary nucleus" 不含 hypothalam/hth，但树上是 Die/HTH/HTHma/MN。
  assert.strictEqual(groupOf('MN'), 'Hypothalamus');
  assert.ok(hierarchy.paths.MN.includes('HTH'));
  // "basolateral nucleus (basal nucleus)" 含 "basal"，曾因此被判进基底节。
  assert.strictEqual(groupOf('BL'), 'Limbic / olfactory');
}

function testAmygdalaNucleiShareOneGroup() {
  const nuclei = ['CEN', 'CMN', 'CoA', 'La', 'BL', 'BM'];
  const groups = [...new Set(nuclei.map(groupOf))];
  assert.deepStrictEqual(groups, ['Limbic / olfactory'], `Amygdala split across: ${groups.join(', ')}`);
}

function testStriatalSubdivisionsShareOneGroup() {
  for (const acronym of ['Pu', 'NAC', 'CaB', 'GPe', 'GPi']) {
    assert.strictEqual(groupOf(acronym), 'Basal ganglia', `${acronym} is not in Basal ganglia`);
  }
}

function testConnectivityNodesCarryTheRegionCatalogueGroup() {
  // connectivity.js 的节点带的是 regions.js 分组的副本，两边必须同步。
  const drift = connectivityData.nodes
    .filter((node) => node.group !== groupOf(node.acronym))
    .map((node) => `${node.acronym}: ${node.group} != ${groupOf(node.acronym)}`);
  assert.deepStrictEqual(drift, [], `connectivity.js is stale: ${drift.join('; ')}`);
}

function testAnnotatedRegionsExistInTheCatalogue() {
  const orphans = Object.keys(knowledge.regions).filter((acronym) => !byAcronym.has(acronym));
  assert.deepStrictEqual(orphans, [], `atlas_knowledge.js annotates unknown regions: ${orphans.join(', ')}`);
}

function testTheAnnotationDoesNotPromoteASubdivisionToTheWholeStructure() {
  // A23 的权威全名是 "ventral division of PCC (area 23)"；
  // 解说曾写作 "Posterior cingulate cortex"，把一个亚区说成了整个 PCC。
  const overview = knowledge.regions.A23.overview.toLowerCase();
  assert.ok(overview.includes('ventral'), `A23 overview drops the ventral qualifier: ${overview}`);
  assert.ok(groupOf('A23') === 'Cerebral cortex');
}

async function main() {
  const groups = await import(
    require('node:url').pathToFileURL(path.join(atlasDir, 'scripts', 'region_groups.mjs')).href
  );
  const composition = await import(
    require('node:url').pathToFileURL(path.join(atlasDir, 'scripts', 'region_composition.mjs')).href
  );

  const cases = [
    ['testTheVendoredHierarchyCoversEveryRegionAcronym', () => testTheVendoredHierarchyCoversEveryRegionAcronym()],
    ['testEveryRegionGroupAgreesWithTheHierarchy', () => testEveryRegionGroupAgreesWithTheHierarchy(groups.classifyRegionGroup)],
    ['testGroupsStayInsideTheUiVocabulary', () => testGroupsStayInsideTheUiVocabulary(groups.REGION_GROUPS)],
    ['testCompositionIsDerivedFromTheGroup', () => testCompositionIsDerivedFromTheGroup(composition.makeComposition)],
    ['testTheSpinalCordIsNotFiledUnderCerebralCortex', testTheSpinalCordIsNotFiledUnderCerebralCortex],
    ['testAcronymsThatDifferOnlyInCaseAreNotConflated', testAcronymsThatDifferOnlyInCaseAreNotConflated],
    ['testSubstringsOfLongerNamesDoNotDecideTheGroup', testSubstringsOfLongerNamesDoNotDecideTheGroup],
    ['testGroupComesFromTheTreeAndNotFromWordsInTheName', testGroupComesFromTheTreeAndNotFromWordsInTheName],
    ['testAmygdalaNucleiShareOneGroup', testAmygdalaNucleiShareOneGroup],
    ['testStriatalSubdivisionsShareOneGroup', testStriatalSubdivisionsShareOneGroup],
    ['testConnectivityNodesCarryTheRegionCatalogueGroup', testConnectivityNodesCarryTheRegionCatalogueGroup],
    ['testAnnotatedRegionsExistInTheCatalogue', testAnnotatedRegionsExistInTheCatalogue],
    ['testTheAnnotationDoesNotPromoteASubdivisionToTheWholeStructure', testTheAnnotationDoesNotPromoteASubdivisionToTheWholeStructure],
  ];

  cases.forEach(([name, fn]) => {
    fn();
    console.log(`PASS ${name}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
