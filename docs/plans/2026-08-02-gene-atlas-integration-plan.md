# Gene Atlas 融合实施计划（方案 B3）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有 DigitalBrain Data Explorer 静态站中新增第 3 个视图标签 Gene Atlas，以原生 JS 实现 16,247,724 细胞图谱的基因表达检索、轻量 3D 点云可视化与 Excel 导出。

**Architecture:** 开发树根目录为唯一真源，`github-pages/` 由 `build_pages_release.py` 生成。新增 4 个原生 JS/CSS 文件 + 1 个数据目录；改动 4 个既有文件。基因数据以「gene-major 定点块」形式按需拉取，浏览器用 `DecompressionStream` 解压、`Uint16Array` 视图零拷贝解码。3D 自绘点云复用现有 Allen 几何，不复用硬单例的 `interactive_brain_atlas/app.js`。

**Tech Stack:** 原生 ES5+ JS（无框架、无构建）、Canvas 2D、`DecompressionStream`、Chart.js 3.9.1（站点已引入）、Python 3 + h5py/numpy（仅离线构建数据）、jsdom + `node:vm` + `node:assert`（测试）

**设计依据:** [2026-08-02-gene-atlas-integration-design.md](./2026-08-02-gene-atlas-integration-design.md)

---

## ⚠️ 实施前必读

### 1. 本目录当前不是 git 仓库

`git rev-parse --is-inside-work-tree` 返回 `fatal: not a git repository`。
按记忆本项目对应 `github.com/LuMengLab/digitalbrain-data-explorer`，但 `.git` 不在树中。

**下方所有「提交」步骤都以已启用 git 为前提。** 实施前请先二选一：

- **选项 A**：`git init && git add -A && git commit -m "chore: baseline before gene atlas integration"`
  建立基线后，按计划正常提交。
- **选项 B**：不启用 git。此时把每个「提交」步骤替换为
  「运行该任务的全部测试并确认通过」，作为检查点。

**不要在未确认基线的情况下开始改动既有文件。**

### 2. 测试依赖未安装

本机无 `node_modules`，`jsdom` 未安装（`node -e "require.resolve('jsdom')"` 报错）。
根目录也没有 `package.json`。Task 0 处理。

### 3. 已核实的关键事实（不要重新猜测）

| 项 | 值 |
| --- | --- |
| Python 解释器 | `/home/jialiang/miniconda3/envs/scbrain/bin/python`（h5py 3.15.1 / numpy 2.2.6） |
| Node 版本 | v24.12.0 |
| 源 h5ad | `/data/DigitalBrain/data/scBrainCellAtlas/outputs/external_three_sources_summary_2026-08-02/atlas/overall.equal_study.summary.h5ad` |
| 源 sha256 | `12eed9e4575af724b8900b56cb7f43ba9ba338845958da409fd4419a260e165a` |
| 源规模 | 1,570 行 × 315,331 基因，163 区，11 细胞类型，67 数据集，16,247,724 细胞 |
| 预期块数 | 1,232（`ceil(315331/256)`） |
| 预期体积 | chunks 150–180 MB，gene index ≈ 8.4 MB |
| 几何文件 | `interactive_brain_atlas/data/allen_3d_geometry.js`（9,828 outerPoints，141 labels，106 regionMappings） |

**路径简写**（下文统一使用）：

```bash
WEB=/data/DigitalBrain/data/scBrain/web
PKG=$WEB/digitalbrain_gene_atlas_student_integration_package_2026-08-02_v2/digitalbrain_gene_atlas
SRC=/data/DigitalBrain/data/scBrainCellAtlas/outputs/external_three_sources_summary_2026-08-02
PY=/home/jialiang/miniconda3/envs/scbrain/bin/python
```

---

## Task 0: 前置准备

**Files:**
- Create: `package.json`

**Step 1: 确认版本控制策略**

先与用户确认上文「实施前必读 §1」的选项 A 或 B。若选 A：

```bash
cd $WEB && git init && git add -A && git commit -m "chore: baseline before gene atlas integration"
```

预期输出：显示大量文件被加入的提交摘要。

**Step 2: 创建最小 package.json**

站点本身零依赖，`package.json` 仅用于固定测试依赖。

```json
{
  "name": "digitalbrain-data-explorer",
  "private": true,
  "scripts": {
    "test": "node --test test_*.js"
  },
  "devDependencies": {
    "jsdom": "^24.0.0"
  }
}
```

**Step 3: 安装依赖**

```bash
cd $WEB && npm install
```

预期：生成 `node_modules/` 与 `package-lock.json`，无报错。

**Step 4: 确认既有测试全部通过（建立基线）**

```bash
cd $WEB && node --test test_smoke.js test_data_model.js test_atlas_bridge.js test_ui_rendering.js
```

预期：全部 pass。**若此处已有失败，先记录failing 项并向用户报告，不要继续。**

```bash
cd $WEB && $PY -m pytest test_build_pages_release.py -q
```

预期：pass。若无 pytest，改用 `$PY test_build_pages_release.py`。

**Step 5: 把生成物加入忽略清单**

创建/追加 `.gitignore`：

```
node_modules/
__pycache__/
*.pyc
```

注意：`gene_atlas_data/` **不要**忽略 —— 按设计决策它要提交进仓库。

**Step 6: 提交**

```bash
cd $WEB && git add package.json package-lock.json .gitignore
git commit -m "chore: add jsdom test dependency and package manifest"
```

---

## Task 1: 合并区域显示名词典

新图谱 163 区中有 45 个在 `$PKG/data/region_names.equal_study.json`（174 条）里没有显示名。
其中 27 个可从 `interactive_brain_atlas/data/regions.js`（106 条）补齐，
余 18 个由转换器回退为 `"{region_id} · {gyral}"`（见 `build_equal_study_gene_chunks.py:220-223`）。

**不要为这 18 个区编造名称** —— 回退标签是诚实的，且符合项目既有的「不推测」原则。

### 缺口的根因（已验证，勿凭直觉改动）

1. `region_names.equal_study.json` **不是通用区域字典**，而是 44M 图谱的伴生产物：
   它的 174 个键与 44M `manifest.regions` 的 174 个区 ID **双向差集均为 0**。
2. 该文件 174 条中只有 **154 条真名 + 20 条回退占位符**，
   且 20 条占位符**全部**是复合区（如 `"A29+A30" → "A29+A30 · CgGrs"`）。
   即：连 44M 图谱自己都没有复合区的真名。
3. 两套图谱的复合区分隔符不同 —— 44M 用 `+`（20 个复合区，0 个空格），
   17M 用空格（29 个空格 + 1 个斜杠，0 个 `+`）。`A35+A36` 与 `A35 A36` 是同一个区。
4. **17M 才是与项目原生约定一致的一方**：17M 的 163 区 100% 落在 explorer 的 165 区
   `brain_regions_brod` 词表内，而 44M 独有的 56 区只有 2/56 落在其中。

### ⚠️ 陷阱：不要做 `+` → 空格 归一化

看似把 44M 的键归一化就能多救回 12 个名字，**但救回的是占位符**：

```
17M "CA1 CA2 CA3"  ←→  44M "CA1+CA2+CA3"  →  值为 "CA1+CA2+CA3 · HiF"
```

这会把 44M 的外来 `+` 记号与假名注入 17M 的显示标签，
比让转换器按 17M 原生空格约定回退**更糟**。

`regions.js` 之所以是有效来源，是因为 Table 2 层级同样使用空格约定，
其 `expandRegionName()` 按空格拆词、逐词查真名再以 `+` 连接，因此给出的是真名：
`"CA1C CA2C CA3C" → "caudal CA1 + caudal CA2 + caudal CA3"`。

余下 18 个本可用同样的逐词展开补齐，但前提词典 `region_acronym2name.json`
**已不在代码树中**（`hierarchical clustering/` 目录整体缺失，`regions.js` 是其历史产物）。
因此 18 个缺名是诚实的上限，不是待修的缺陷。

**Files:**
- Create: `scripts/build_gene_atlas_region_names.mjs`
- Create: `data/region_names.external_three_sources.json`（脚本产出）
- Test: `test_gene_atlas_region_names.js`

**Step 1: 写失败的测试**

创建 `test_gene_atlas_region_names.js`：

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'data', 'region_names.external_three_sources.json');

test('merged region names cover the equal_study base entries', () => {
  const merged = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  // 来自 equal_study 基线的条目必须原样保留
  assert.equal(merged['A10'], 'frontal polar cortex (area 10)');
  assert.equal(merged['10N'], 'dorsal motor nucleus of the vagus (vagal nucleus)');
});

test('merged region names fill composite hippocampal labels from regions.js', () => {
  const merged = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  assert.equal(merged['CA1C CA2C CA3C'], 'caudal CA1 + caudal CA2 + caudal CA3');
  assert.equal(merged['CA1U'], 'uncal CA1');
});

test('merged region names never invent labels for unknown acronyms', () => {
  const merged = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  // 这 18 个在两个来源里都没有，必须缺席，交给转换器回退
  for (const missing of ['A11m', 'A9/46', 'ASFV', 'PMC', 'Pit', 'SWM', 'MV', 'DLG']) {
    assert.equal(Object.hasOwn(merged, missing), false, `${missing} 不应被编造`);
  }
});
```

**Step 2: 运行测试确认失败**

```bash
cd $WEB && node --test test_gene_atlas_region_names.js
```

预期：FAIL —— `ENOENT: no such file or directory ... region_names.external_three_sources.json`

**Step 3: 写生成脚本**

创建 `scripts/build_gene_atlas_region_names.mjs`：

```js
// 合并两个既有名称来源，产出新图谱专用的区域显示名词典。
// 来源优先级：region_names.equal_study.json > interactive_brain_atlas/data/regions.js
// 两处都没有的缩写一律不写入，由转换器回退为 "{region_id} · {gyral}"。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgNames = path.join(
  webDir,
  'digitalbrain_gene_atlas_student_integration_package_2026-08-02_v2',
  'digitalbrain_gene_atlas', 'data', 'region_names.equal_study.json',
);
const regionsJs = path.join(webDir, 'interactive_brain_atlas', 'data', 'regions.js');
const outPath = path.join(webDir, 'data', 'region_names.external_three_sources.json');

const base = JSON.parse(await fs.readFile(pkgNames, 'utf8'));

// regions.js 是 `window.X = {...};` 形式，取第一个 { 到最后一个 } 解析。
const text = await fs.readFile(regionsJs, 'utf8');
const regionData = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
const fromAtlas = Object.fromEntries(
  regionData.regions.map((region) => [region.acronym, region.name]),
);

const merged = { ...fromAtlas, ...base };  // base 优先
const ordered = Object.fromEntries(
  Object.keys(merged).sort().map((key) => [key, merged[key]]),
);

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(ordered, null, 2)}\n`);
console.log(`Wrote ${Object.keys(ordered).length} region labels to ${outPath}`);
```

**Step 4: 运行脚本**

```bash
cd $WEB && node scripts/build_gene_atlas_region_names.mjs
```

预期输出：`Wrote 201 region labels to .../data/region_names.external_three_sources.json`
（174 base + 106 atlas 去重后约 201；数字以实际为准，不是断言目标）

**Step 5: 运行测试确认通过**

```bash
cd $WEB && node --test test_gene_atlas_region_names.js
```

预期：3 个测试全部 pass。

**Step 6: 核对覆盖率**

```bash
cd $WEB && $PY - <<'EOF'
import json, csv
names = json.load(open('data/region_names.external_three_sources.json'))
src = '/data/DigitalBrain/data/scBrainCellAtlas/outputs/external_three_sources_summary_2026-08-02/registries/regions.tsv'
regions = {r['region_id'] for r in csv.DictReader(open(src), delimiter='\t')}
missing = sorted(regions - set(names))
print(f'163 区中已命名 {len(regions) - len(missing)}，回退 {len(missing)}')
print('回退清单:', missing)
EOF
```

预期：`163 区中已命名 145，回退 18`，清单与设计文档一致。

**Step 7: 提交**

```bash
cd $WEB && git add scripts/build_gene_atlas_region_names.mjs \
  data/region_names.external_three_sources.json test_gene_atlas_region_names.js
git commit -m "feat: merge region display names for the 16.25M gene atlas"
```

---

## Task 2: 构建 17M 紧凑 bundle

**Files:**
- Create: `gene_atlas_data/external_three_sources_v1/`（约 1,234 个文件）

**Step 1: 确认输出目录不存在**

转换器拒绝覆盖既有发布（输出目录必须不存在或为空）。

```bash
cd $WEB && ls gene_atlas_data/external_three_sources_v1 2>/dev/null && echo "已存在，需人工确认" || echo "OK 可构建"
```

**Step 2: 确认源文件校验和**

```bash
sha256sum $SRC/atlas/overall.equal_study.summary.h5ad
```

预期：`12eed9e4575af724b8900b56cb7f43ba9ba338845958da409fd4419a260e165a`
**不匹配则停止**，说明源数据已变更，需重新确认。

**Step 3: 运行转换器**

耗时预计 8–15 分钟（44M 版为 524 秒），建议后台运行并留意日志。

```bash
cd $WEB && $PY $PKG/scripts/build_equal_study_gene_chunks.py \
  --input  $SRC/atlas/overall.equal_study.summary.h5ad \
  --output gene_atlas_data/external_three_sources_v1 \
  --geometry interactive_brain_atlas/data/allen_3d_geometry.js \
  --region-names data/region_names.external_three_sources.json \
  --chunk-genes 256
```

预期：正常结束，输出 `manifest.json`、`gene_index.json.gz`、`chunks/chunk_0000.bin.gz … chunk_1231.bin.gz`。

**Step 4: 核对产物规模与 manifest 关键字段**

```bash
cd $WEB/gene_atlas_data/external_three_sources_v1 && \
  echo "chunk 数: $(ls chunks | wc -l)" && du -sh . && \
  $PY -c "
import json; m=json.load(open('manifest.json'))
print('schemaVersion', m['schemaVersion'])
print('source', m['source']['file'], m['source']['sha256'][:16])
print('matrix', m['matrix']['rowCount'], 'x', m['matrix']['geneCount'], 'chunkGenes', m['matrix']['chunkGeneCount'])
print('summary', json.dumps(m['summary']))
print('regions', len(m['regions']), 'cellTypes', len(m['cellTypes']), 'chunks', len(m['chunks']))
"
```

预期：chunk 数 1232；`rowCount` 1570，`geneCount` 315331；
`regions` 163，`cellTypes` 11；`source.sha256` 前缀 `12eed9e4575af724`。

**Step 5: 记录实际体积**

把 `du -sh` 的实际值填入设计文档的规模推算处（把「预计」改为实测），保持文档与事实一致。

**Step 6: 提交**

体积较大，单独一次提交。

```bash
cd $WEB && git add gene_atlas_data/external_three_sources_v1
git commit -m "data: add compact browser bundle for the 16.25M external_three_sources atlas"
```

---

## Task 3: 校验 bundle 与源数据一致性

**Step 1: 运行全哈希校验**

```bash
cd $WEB && $PY $PKG/scripts/validate_equal_study_gene_chunks.py \
  --input  $SRC/atlas/overall.equal_study.summary.h5ad \
  --bundle gene_atlas_data/external_three_sources_v1 \
  --verify-all-hashes
```

预期：源校验和匹配、1,232 个块哈希全部匹配、量化误差在界内、coverage 精确一致，退出码 0。

**Step 2: 失败时的处置**

- 块哈希不符 → 删除整个输出目录重建（不要就地修补，混合新旧块会让浏览器读到错乱数值）
- 量化误差超界 → 停止并报告，可能是源数据数值范围异常
- coverage 不一致 → 停止并报告，属于严重数据问题

**Step 3: 记录校验结论**

把校验通过的结论与运行日期追加到设计文档，作为数据可信性的凭据。

---

## Task 4: 解码核心 —— gene-atlas-data.js（TDD）

移植自 `$PKG/app/GeneAtlasExplorer.tsx` 的 `fetchGzipBuffer`（第 773-783 行）
与 chunk 解码（第 916-947 行），去掉 React 相关部分。

**块二进制布局**（来自 `docs/DATA_CONTRACT.md`，已核实）：

```
valueCount = manifest.matrix.rowCount * chunk.count
uint16 LE mean       起始 0
uint16 LE detection  起始 valueCount * 2
uint8     coverage   起始 valueCount * 4
每个 metric 均为行主序：offset(row, localGene) = row * chunk.count + localGene
mean = encoded * chunk.meanScale;  detection = encoded * chunk.detectionScale
```

**Files:**
- Create: `gene-atlas-data.js`
- Test: `test_gene_atlas_data.js`

**Step 1: 写失败的测试**

创建 `test_gene_atlas_data.js`：

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule() {
  const context = { window: {}, console };
  context.globalThis = context;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, 'gene-atlas-data.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'gene-atlas-data.js' });
  return context.window.GeneAtlasData;
}

// 构造一个已知的块：2 行 × 3 基因
function makeChunkBuffer() {
  const rowCount = 2;
  const count = 3;
  const valueCount = rowCount * count;          // 6
  const buffer = new ArrayBuffer(valueCount * 5); // 30
  const mean = new Uint16Array(buffer, 0, valueCount);
  const detection = new Uint16Array(buffer, valueCount * 2, valueCount);
  const coverage = new Uint8Array(buffer, valueCount * 4, valueCount);
  // row0: [10,20,30]  row1: [40,50,60]
  mean.set([10, 20, 30, 40, 50, 60]);
  detection.set([1, 2, 3, 4, 5, 6]);
  coverage.set([7, 0, 9, 1, 2, 3]);             // 第 2 个刻意为 0 = 数据缺失
  return buffer;
}

const DESCRIPTOR = {
  index: 0, start: 0, count: 3, encoding: 'quantized-u16', bytesPerValue: 5,
  meanScale: 0.5, detectionScale: 1 / 65535,
};

test('decodeChunk maps the three metric segments at the right offsets', () => {
  const api = loadModule();
  const chunk = api.decodeChunk(makeChunkBuffer(), DESCRIPTOR, 2);
  assert.equal(chunk.mean[0], 5);    // 10 * 0.5
  assert.equal(chunk.mean[5], 30);   // 60 * 0.5
  assert.ok(Math.abs(chunk.detection[0] - 1 / 65535) < 1e-12);
  assert.equal(chunk.coverage[0], 7);
  assert.equal(chunk.coverage[1], 0);
});

test('valueOffset is row-major within the chunk', () => {
  const api = loadModule();
  assert.equal(api.valueOffset(0, 0, 3), 0);
  assert.equal(api.valueOffset(0, 2, 3), 2);
  assert.equal(api.valueOffset(1, 0, 3), 3);
  assert.equal(api.valueOffset(1, 2, 3), 5);
});

test('decodeChunk rejects a block whose byte length disagrees with the manifest', () => {
  const api = loadModule();
  const truncated = new ArrayBuffer(29);
  assert.throws(() => api.decodeChunk(truncated, DESCRIPTOR, 2), /unexpected shape/i);
});

test('decodeChunk rejects an unsupported encoding', () => {
  const api = loadModule();
  const bad = { ...DESCRIPTOR, encoding: 'float32' };
  assert.throws(() => api.decodeChunk(makeChunkBuffer(), bad, 2), /unsupported encoding/i);
});

test('locateGene resolves chunk index and local offset, including block edges', () => {
  const api = loadModule();
  const manifest = {
    matrix: { chunkGeneCount: 256, geneCount: 600 },
    chunks: [
      { index: 0, start: 0, count: 256 },
      { index: 1, start: 256, count: 256 },
      { index: 2, start: 512, count: 88 },
    ],
  };
  assert.deepEqual(api.locateGene(manifest, 0), { chunkIndex: 0, localGene: 0 });
  assert.deepEqual(api.locateGene(manifest, 255), { chunkIndex: 0, localGene: 255 });
  assert.deepEqual(api.locateGene(manifest, 256), { chunkIndex: 1, localGene: 0 });
  assert.deepEqual(api.locateGene(manifest, 599), { chunkIndex: 2, localGene: 87 });
  assert.equal(api.locateGene(manifest, 600), null);
  assert.equal(api.locateGene(manifest, -1), null);
});
```

**Step 2: 运行测试确认失败**

```bash
cd $WEB && node --test test_gene_atlas_data.js
```

预期：FAIL —— `ENOENT ... gene-atlas-data.js`

**Step 3: 写最小实现**

创建 `gene-atlas-data.js`。本步只实现 `valueOffset` / `decodeChunk` / `locateGene`，
网络与检索留给下一个 Task。

```js
// Gene Atlas 数据层：加载并解码 gene-major 定点块。
//
// 块布局见 docs/plans/2026-08-02-gene-atlas-integration-design.md。
// coverage == 0 表示该值不可用（数据缺失），调用方必须把它与「零表达」区分开。
(function (global) {
    'use strict';

    function valueOffset(row, localGene, chunkGeneCount) {
        return row * chunkGeneCount + localGene;
    }

    function decodeChunk(buffer, descriptor, rowCount) {
        if (descriptor.encoding !== 'quantized-u16') {
            throw new Error('Gene block ' + descriptor.index + ' uses an unsupported encoding.');
        }
        var valueCount = rowCount * descriptor.count;
        var expectedBytes = valueCount * descriptor.bytesPerValue;
        if (buffer.byteLength !== expectedBytes) {
            throw new Error('Gene block ' + descriptor.index + ' has an unexpected shape.');
        }
        var encodedMean = new Uint16Array(buffer, 0, valueCount);
        var encodedDetection = new Uint16Array(buffer, valueCount * 2, valueCount);
        var mean = new Float32Array(valueCount);
        var detection = new Float32Array(valueCount);
        for (var index = 0; index < valueCount; index += 1) {
            mean[index] = encodedMean[index] * descriptor.meanScale;
            detection[index] = encodedDetection[index] * descriptor.detectionScale;
        }
        return {
            descriptor: descriptor,
            mean: mean,
            detection: detection,
            coverage: new Uint8Array(buffer, valueCount * 4, valueCount)
        };
    }

    function locateGene(manifest, geneIndex) {
        if (!(geneIndex >= 0) || geneIndex >= manifest.matrix.geneCount) return null;
        var chunkIndex = Math.floor(geneIndex / manifest.matrix.chunkGeneCount);
        var descriptor = manifest.chunks[chunkIndex];
        if (!descriptor) return null;
        return { chunkIndex: chunkIndex, localGene: geneIndex - descriptor.start };
    }

    global.GeneAtlasData = {
        valueOffset: valueOffset,
        decodeChunk: decodeChunk,
        locateGene: locateGene
    };
})(typeof window !== 'undefined' ? window : globalThis);
```

**Step 4: 运行测试确认通过**

```bash
cd $WEB && node --test test_gene_atlas_data.js
```

预期：5 个测试全部 pass。

**Step 5: 用真实块做一次端到端解码抽查**

确认实现能吃下真实数据，而不只是构造的字节流。

```bash
cd $WEB && node -e "
const fs=require('fs'), zlib=require('zlib'), vm=require('vm');
const ctx={window:{},console}; ctx.globalThis=ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync('gene-atlas-data.js','utf8'),ctx);
const api=ctx.window.GeneAtlasData;
const dir='gene_atlas_data/external_three_sources_v1';
const m=JSON.parse(fs.readFileSync(dir+'/manifest.json','utf8'));
const d=m.chunks[0];
const raw=zlib.gunzipSync(fs.readFileSync(dir+'/'+d.file));
const buf=raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength);
const chunk=api.decodeChunk(buf,d,m.matrix.rowCount);
console.log('解码成功 valueCount=',chunk.mean.length,'预期=',m.matrix.rowCount*d.count);
console.log('mean 最大值=',Math.max.apply(null,Array.from(chunk.mean.slice(0,5000))));
console.log('coverage 为 0 的比例=', Array.from(chunk.coverage.slice(0,5000)).filter(v=>v===0).length/5000);
"
```

预期：解码成功，`valueCount` 与预期相等，无异常抛出。

**Step 6: 提交**

```bash
cd $WEB && git add gene-atlas-data.js test_gene_atlas_data.js
git commit -m "feat: add gene atlas chunk decoder with bounded-precision fixed-point support"
```

---

## Task 5: 检索与聚合 —— gene-atlas-data.js（TDD）

**聚合规则**（来自 `docs/DATA_CONTRACT.md`「Aggregation shown by the UI」，已核实）：
同一区域内多行共享同一 broad cell type 时，先在细胞类型内平均；
再对**已represented 的细胞类型**取等权均值，**不做细胞数加权**。
`coverage == 0` 的行不参与任何均值。

**Files:**
- Modify: `gene-atlas-data.js`
- Modify: `test_gene_atlas_data.js`

**Step 1: 追加失败的测试**

在 `test_gene_atlas_data.js` 末尾追加：

```js
test('lowerBound finds the insertion point in a sorted token array', () => {
  const api = loadModule();
  const tokens = ['aqp4', 'gapdh', 'gfap', 'mbp'];
  assert.equal(api.lowerBound(tokens, 'aqp4'), 0);
  assert.equal(api.lowerBound(tokens, 'gfap'), 2);
  assert.equal(api.lowerBound(tokens, 'zzz'), 4);
});

test('searchGene matches symbols and stable ids case-insensitively', () => {
  const api = loadModule();
  const geneIndex = {
    symbols: ['GFAP', 'AQP4'],
    ids: ['ENSG00000131095', 'ENSG00000171885'],
    searchTokens: ['aqp4', 'ensg00000131095', 'ensg00000171885', 'gfap'],
    searchIndices: [1, 0, 1, 0],
  };
  assert.equal(api.searchGene(geneIndex, 'GFAP'), 0);
  assert.equal(api.searchGene(geneIndex, 'gfap'), 0);
  assert.equal(api.searchGene(geneIndex, '  AQP4 '), 1);
  assert.equal(api.searchGene(geneIndex, 'ENSG00000131095'), 0);
  assert.equal(api.searchGene(geneIndex, 'NOTAGENE'), -1);
});

test('aggregateRegion averages within cell type, then equally across cell types', () => {
  const api = loadModule();
  // 区域含 3 行：Astrocyte 两行(1.0, 3.0) + Microglia 一行(10.0)
  // 细胞类型内平均 -> Astrocyte 2.0, Microglia 10.0；等权跨类型 -> 6.0
  const rows = [
    { cellType: 'Astrocyte' }, { cellType: 'Astrocyte' }, { cellType: 'Microglia' },
  ];
  const result = api.aggregateRegion({
    rowIndices: [0, 1, 2],
    rows: rows,
    values: [1.0, 3.0, 10.0],
    coverage: [5, 5, 5],
  });
  assert.equal(result.value, 6.0);
  assert.equal(result.cellTypeCount, 2);
  assert.equal(result.available, true);
});

test('aggregateRegion excludes zero-coverage rows instead of treating them as zero', () => {
  const api = loadModule();
  const rows = [{ cellType: 'Astrocyte' }, { cellType: 'Microglia' }];
  const result = api.aggregateRegion({
    rowIndices: [0, 1],
    rows: rows,
    values: [4.0, 0.0],
    coverage: [5, 0],        // Microglia 无覆盖
  });
  // 只剩 Astrocyte，均值必须是 4.0 而不是 (4+0)/2 = 2.0
  assert.equal(result.value, 4.0);
  assert.equal(result.cellTypeCount, 1);
});

test('aggregateRegion reports unavailable when every row lacks coverage', () => {
  const api = loadModule();
  const rows = [{ cellType: 'Astrocyte' }];
  const result = api.aggregateRegion({
    rowIndices: [0], rows: rows, values: [0.0], coverage: [0],
  });
  assert.equal(result.available, false);
  assert.equal(result.value, null);   // 不得是 0
});
```

**Step 2: 运行测试确认失败**

```bash
cd $WEB && node --test test_gene_atlas_data.js
```

预期：新增 5 个 FAIL（`api.lowerBound is not a function` 等），原 5 个仍 pass。

**Step 3: 实现检索与聚合**

在 `gene-atlas-data.js` 的 `global.GeneAtlasData = {...}` 之前插入：

```js
    function lowerBound(values, needle) {
        var low = 0;
        var high = values.length;
        while (low < high) {
            var mid = (low + high) >>> 1;
            if (values[mid] < needle) low = mid + 1;
            else high = mid;
        }
        return low;
    }

    function searchGene(geneIndex, query) {
        var needle = String(query == null ? '' : query).trim().toLowerCase();
        if (!needle) return -1;
        var position = lowerBound(geneIndex.searchTokens, needle);
        if (position >= geneIndex.searchTokens.length) return -1;
        if (geneIndex.searchTokens[position] !== needle) return -1;
        return geneIndex.searchIndices[position];
    }

    // 先在 broad cell type 内平均，再对已represented 的类型取等权均值。
    // coverage == 0 的行代表数据缺失，必须排除而不是当作 0 参与平均。
    function aggregateRegion(input) {
        var sums = Object.create(null);
        var counts = Object.create(null);
        var order = [];
        for (var i = 0; i < input.rowIndices.length; i += 1) {
            var rowIndex = input.rowIndices[i];
            if (!input.coverage[i]) continue;
            var cellType = input.rows[rowIndex].cellType;
            if (!(cellType in sums)) {
                sums[cellType] = 0;
                counts[cellType] = 0;
                order.push(cellType);
            }
            sums[cellType] += input.values[i];
            counts[cellType] += 1;
        }
        if (!order.length) {
            return { value: null, available: false, cellTypeCount: 0 };
        }
        var total = 0;
        for (var j = 0; j < order.length; j += 1) {
            total += sums[order[j]] / counts[order[j]];
        }
        return {
            value: total / order.length,
            available: true,
            cellTypeCount: order.length
        };
    }
```

并把三个新函数加入导出对象。

**Step 4: 运行测试确认通过**

```bash
cd $WEB && node --test test_gene_atlas_data.js
```

预期：10 个测试全部 pass。

**Step 5: 用真实 gene index 抽查检索**

```bash
cd $WEB && node -e "
const fs=require('fs'), zlib=require('zlib'), vm=require('vm');
const ctx={window:{},console}; ctx.globalThis=ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync('gene-atlas-data.js','utf8'),ctx);
const api=ctx.window.GeneAtlasData;
const dir='gene_atlas_data/external_three_sources_v1';
const gi=JSON.parse(zlib.gunzipSync(fs.readFileSync(dir+'/gene_index.json.gz')).toString());
console.log('特征数=',gi.symbols.length,'token 数=',gi.searchTokens.length);
['GFAP','gapdh','AQP4','MBP','SNAP25','NOTAREALGENE'].forEach(q=>{
  const i=api.searchGene(gi,q);
  console.log(q,'->',i,i>=0?gi.symbols[i]:'(无命中)');
});
"
```

预期：`GFAP` / `gapdh` / `AQP4` / `MBP` / `SNAP25` 均命中，`NOTAREALGENE` 返回 -1。
**若常见基因未命中，停止并检查 gene index 是否完整**。

**Step 6: 提交**

```bash
cd $WEB && git add gene-atlas-data.js test_gene_atlas_data.js
git commit -m "feat: add gene search and coverage-aware regional aggregation"
```

---

## Task 6: 网络加载层 —— gene-atlas-data.js

浏览器侧的 fetch + gzip 解压 + chunk 缓存。这部分依赖 `DecompressionStream`
与 `fetch`，在 jsdom 下不可靠，因此**不写 jsdom 单元测试**，改为
Task 12 的浏览器端到端验证覆盖。纯逻辑部分（Task 4/5）已有测试保障。

**Files:**
- Modify: `gene-atlas-data.js`

**Step 1: 实现 bundle 加载与块缓存**

在 `gene-atlas-data.js` 中追加：

```js
    // 若响应已是明文（服务器做了 Content-Encoding 协商），直接返回；
    // 否则用 gzip 魔数判定并解压。
    function fetchMaybeGzip(url) {
        return fetch(url).then(function (response) {
            if (!response.ok) {
                throw new Error('Data block ' + url + ' is unavailable.');
            }
            return response.arrayBuffer();
        }).then(function (compressed) {
            var bytes = new Uint8Array(compressed);
            if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return compressed;
            if (typeof DecompressionStream !== 'function') {
                throw new Error(
                    'This browser cannot decompress gene blocks (DecompressionStream unavailable).'
                );
            }
            var stream = new Blob([compressed]).stream()
                .pipeThrough(new DecompressionStream('gzip'));
            return new Response(stream).arrayBuffer();
        });
    }

    function createLoader(bundlePath) {
        var base = String(bundlePath).replace(/\/$/, '');
        var manifest = null;
        var geneIndex = null;
        var chunks = new Map();
        var pending = new Map();

        function load() {
            return fetch(base + '/manifest.json').then(function (response) {
                if (!response.ok) throw new Error('The gene atlas manifest is unavailable.');
                return response.json();
            }).then(function (loaded) {
                manifest = loaded;
                return fetchMaybeGzip(base + '/' + manifest.genes.indexFile);
            }).then(function (buffer) {
                geneIndex = JSON.parse(new TextDecoder().decode(buffer));
                if (geneIndex.symbols.length !== manifest.matrix.geneCount) {
                    throw new Error('The gene index has an unexpected shape.');
                }
                return { manifest: manifest, geneIndex: geneIndex };
            });
        }

        function ensureChunk(chunkIndex) {
            if (chunks.has(chunkIndex)) return Promise.resolve(chunks.get(chunkIndex));
            if (pending.has(chunkIndex)) return pending.get(chunkIndex);
            var descriptor = manifest.chunks[chunkIndex];
            if (!descriptor) return Promise.reject(new Error('Unknown gene block.'));
            var task = fetchMaybeGzip(base + '/' + descriptor.file)
                .then(function (buffer) {
                    var chunk = decodeChunk(buffer, descriptor, manifest.matrix.rowCount);
                    chunks.set(chunkIndex, chunk);
                    pending.delete(chunkIndex);
                    return chunk;
                })
                .catch(function (error) {
                    pending.delete(chunkIndex);
                    throw error;
                });
            pending.set(chunkIndex, task);
            return task;
        }

        return {
            load: load,
            ensureChunk: ensureChunk,
            getManifest: function () { return manifest; },
            getGeneIndex: function () { return geneIndex; },
            cachedChunkCount: function () { return chunks.size; }
        };
    }
```

把 `fetchMaybeGzip` 与 `createLoader` 加入导出对象。

**Step 2: 确认既有测试未被破坏**

```bash
cd $WEB && node --test test_gene_atlas_data.js
```

预期：10 个测试仍全部 pass（新增代码不应影响纯函数）。

**Step 3: 提交**

```bash
cd $WEB && git add gene-atlas-data.js
git commit -m "feat: add gene bundle loader with gzip decode and block cache"
```

---

## Task 7: 视图切换改为三态（TDD）

现状是二态布尔：`app.js` 的 `applyView()` 内 `const isOverview = view === 'overview'`。
需改为以视图 id 为键的 N 态映射，**不改变现有两个视图的任何行为**。

必须保留的既有逻辑：URL hash 同步、`viewHint` 首次提示 + `localStorage` 记忆、
`resizeAllCharts` 在 overview 可见后的双 `requestAnimationFrame` 重排。

**Files:**
- Modify: `app.js`（`initializeViewSwitch()`，约 363-405 行起）
- Modify: `digitalneuron_main.html`（新增第 3 个按钮与视图容器）
- Test: `test_gene_atlas_view_switch.js`

**Step 1: 先读现状再动手**

```bash
cd $WEB && sed -n '355,430p' app.js
```

完整读懂 `applyView()` 与其后的 hash 监听、按钮绑定，再改。

**Step 2: 写失败的测试**

创建 `test_gene_atlas_view_switch.js`。参照 `test_ui_rendering.js` 的
jsdom + `node:vm` 装载方式（去掉 `<script>` 后注入真实脚本）：

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const WEB_DIR = __dirname;

function bootDom(hash) {
  const html = fs.readFileSync(path.join(WEB_DIR, 'digitalneuron_main.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: `https://example.test/${hash || ''}`,
  });
  return dom;
}

function runScript(dom, fileName) {
  const code = fs.readFileSync(path.join(WEB_DIR, fileName), 'utf8');
  vm.runInContext(code, dom.getInternalVMContext(), { filename: fileName });
}

test('the html exposes a third gene atlas view and tab', () => {
  const dom = bootDom();
  const { document } = dom.window;
  assert.ok(document.getElementById('viewGenesBtn'), '缺少 viewGenesBtn');
  assert.ok(document.getElementById('geneAtlasView'), '缺少 geneAtlasView');
  assert.equal(
    document.getElementById('viewGenesBtn').dataset.view, 'genes',
    'viewGenesBtn 的 data-view 必须是 genes',
  );
});

test('applyView shows exactly one view at a time', () => {
  const dom = bootDom();
  runScript(dom, 'app.js');
  const { document } = dom.window;
  dom.window.__applyViewForTest('genes');

  assert.equal(document.getElementById('geneAtlasView').classList.contains('is-hidden'), false);
  assert.equal(document.getElementById('atlasSection').classList.contains('is-hidden'), true);
  assert.equal(document.getElementById('overviewView').classList.contains('is-hidden'), true);
  assert.equal(document.getElementById('viewGenesBtn').getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('viewAtlasBtn').getAttribute('aria-selected'), 'false');
});

test('the scope filters are disabled on the gene view and restored when leaving', () => {
  const dom = bootDom();
  runScript(dom, 'app.js');
  const { document } = dom.window;
  const ids = ['collectionSelect', 'datasetSelect', 'donorSelect'];

  dom.window.__applyViewForTest('genes');
  for (const id of ids) {
    assert.equal(document.getElementById(id).disabled, true, `${id} 应在基因视图下置灰`);
  }

  dom.window.__applyViewForTest('atlas');
  // collection 恢复可用；dataset/donor 恢复到各自原有的级联状态
  assert.equal(document.getElementById('collectionSelect').disabled, false);
});

test('an unknown hash falls back to the atlas view', () => {
  const dom = bootDom('#nonsense');
  runScript(dom, 'app.js');
  const { document } = dom.window;
  assert.equal(document.getElementById('atlasSection').classList.contains('is-hidden'), false);
});
```

**Step 3: 运行测试确认失败**

```bash
cd $WEB && node --test test_gene_atlas_view_switch.js
```

预期：全部 FAIL（缺少 `viewGenesBtn` / `geneAtlasView` / `__applyViewForTest`）。

**Step 4: 改 HTML —— 加第 3 个 tab**

在 `digitalneuron_main.html` 的 `.view-switch` 内，`viewOverviewBtn` 之后插入：

```html
                        <button type="button" class="view-switch-btn" id="viewGenesBtn" role="tab" aria-selected="false" data-view="genes">
                            <svg class="view-switch-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4c6 0 6 16 12 16"/><path d="M20 4c-6 0-6 16-12 16"/><path d="M7 8h6"/><path d="M11 16h6"/></svg>
                            <span>Gene Atlas</span>
                        </button>
```

**Step 5: 改 HTML —— 加视图容器**

在 `atlasSection` 之后插入骨架（内部结构在 Task 9 填充）：

```html
        <section id="geneAtlasView" class="app-view gene-atlas is-hidden" aria-label="Gene expression atlas">
            <div class="gene-scope-note" role="note">
                <strong>全局范围。</strong>基因数据为 67 项研究的等权合并结果，上游已折叠数据集轴，
                因此<strong>不随上方 Collection / Dataset / Donor 筛选变化</strong>。
            </div>
            <div class="gene-toolbar">
                <div class="gene-search-wrap">
                    <input type="search" id="geneSearchInput" placeholder="搜索基因符号或 Ensembl ID，例如 GFAP" autocomplete="off">
                    <div id="geneSearchResults" class="gene-search-results" hidden></div>
                </div>
                <div id="geneChips" class="gene-chips" aria-live="polite"></div>
                <div class="gene-metric-switch" role="group" aria-label="Metric">
                    <button type="button" class="is-active" id="geneMetricMean" data-metric="mean">表达均值</button>
                    <button type="button" id="geneMetricDetection" data-metric="detection">检出率</button>
                </div>
            </div>
            <div id="geneStatus" class="gene-status" role="status"></div>
            <div class="gene-body">
                <div class="gene-canvas-wrap">
                    <canvas id="geneBrainCanvas" width="720" height="520"></canvas>
                    <p class="gene-canvas-caption" id="geneCanvasCaption"></p>
                </div>
                <aside class="gene-side">
                    <div class="gene-chart-wrap"><canvas id="geneRegionChart"></canvas></div>
                    <div id="geneCellTypeTable" class="gene-cell-table"></div>
                </aside>
            </div>
            <div class="gene-actions">
                <button type="button" id="geneExportBtn" disabled>下载 Excel</button>
                <p class="gene-caveat" id="geneCaveat"></p>
            </div>
        </section>
```

**Step 6: 改 app.js —— applyView 改为 N 态**

把 `applyView()` 重写为映射驱动，并暴露测试钩子。保持既有行为：

```js
    // 三个视图共用一套映射；新增视图时只需扩展这张表。
    const VIEWS = {
        atlas: { section: atlasView, button: atlasBtn },
        overview: { section: overviewView, button: overviewBtn },
        genes: { section: geneView, button: genesBtn }
    };
    const SCOPE_FILTER_IDS = ['collectionSelect', 'datasetSelect', 'donorSelect'];
    // 进入基因视图前记下各筛选器的原始 disabled 状态，离开时精确还原，
    // 避免把级联逻辑本就置灰的 dataset/donor 错误地解锁。
    let savedFilterState = null;

    function setScopeFiltersDisabled(disabled) {
        if (disabled) {
            if (savedFilterState) return;
            savedFilterState = {};
            SCOPE_FILTER_IDS.forEach(function (id) {
                const element = document.getElementById(id);
                if (!element) return;
                savedFilterState[id] = element.disabled;
                element.disabled = true;
            });
            return;
        }
        if (!savedFilterState) return;
        SCOPE_FILTER_IDS.forEach(function (id) {
            const element = document.getElementById(id);
            if (!element) return;
            element.disabled = savedFilterState[id];
        });
        savedFilterState = null;
    }

    function applyView(view) {
        const active = VIEWS[view] ? view : 'atlas';
        Object.keys(VIEWS).forEach(function (name) {
            const entry = VIEWS[name];
            if (!entry.section || !entry.button) return;
            const isActive = name === active;
            entry.section.classList.toggle('is-hidden', !isActive);
            entry.button.classList.toggle('is-active', isActive);
            entry.button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        setScopeFiltersDisabled(active === 'genes');
        // Charts may have been drawn while hidden (0-sized); refit once visible.
        if (active === 'overview' && typeof resizeAllCharts === 'function') {
            window.requestAnimationFrame(function () {
                window.requestAnimationFrame(resizeAllCharts);
            });
        }
        if (active === 'genes' && window.GeneAtlasView
            && typeof window.GeneAtlasView.activate === 'function') {
            window.GeneAtlasView.activate();
        }
    }

    // 测试钩子：让 jsdom 能在不派发点击事件的前提下驱动视图切换。
    window.__applyViewForTest = applyView;
```

同时：
- 在函数顶部补 `const geneView = document.getElementById('geneAtlasView');`
  与 `const genesBtn = document.getElementById('viewGenesBtn');`
- 放宽早退守卫：缺少基因视图时不应让原有两个视图失效，
  把 `if (!atlasView || !overviewView || !atlasBtn || !overviewBtn) return;` 保留原样即可
  （基因视图缺失时 `VIEWS.genes` 的条目会被跳过）
- `viewFromHash()` 改为：`const raw = window.location.hash.replace('#', ''); return VIEWS[raw] ? raw : 'atlas';`
- 按钮事件绑定改为遍历 `VIEWS`，或给新按钮补一条与既有按钮同构的绑定

**Step 7: 运行测试确认通过**

```bash
cd $WEB && node --test test_gene_atlas_view_switch.js
```

预期：4 个测试全部 pass。

**Step 8: 确认既有测试无回归**

```bash
cd $WEB && node --test test_smoke.js test_data_model.js test_atlas_bridge.js test_ui_rendering.js
```

预期：全部 pass。**若 `test_ui_rendering.js` 出现失败，说明改动破坏了既有视图行为，必须修好再继续。**

**Step 9: 提交**

```bash
cd $WEB && git add app.js digitalneuron_main.html test_gene_atlas_view_switch.js
git commit -m "feat: add third gene atlas view with scope-filter isolation"
```

---

## Task 8: 轻量 3D 点云渲染 —— gene-atlas-3d.js

**不复用** `interactive_brain_atlas/app.js`：它有 92 处 `getElementById()` 绑死固定
DOM id 并在加载时读取全局 `window.DIGITALBRAIN_REGION_DATA`，同页无法起第二个实例。

**几何数据结构**（已核实）：

```
window.ALLEN_3D_ATLAS = {
  metadata: { sourceShape:[394,466,378], sampleStep:2,
              voxelSizeMm:[0.5,0.5,0.5], qoffsetMm:[-98,-134,-72],
              orientation:{ sourceAxes:[LR,PA,IS], viewerAxes:[LR,IS,PA] } },
  labels: [ { value, acronym, name, color, centroidVoxel } × 141 ],
  outerPoints:    [x,y,z,labelIndex] × 9828   （扁平数组，长度 39312）
  boundaryPoints: [x,y,z,labelIndex] × 12578  （扁平数组，长度 50312）
  regionMappings: { "<DigitalBrain 区域>": { status, labelIndices, atlasAcronyms, basis } } × 106
}
```

**Files:**
- Create: `gene-atlas-3d.js`
- Test: `test_gene_atlas_3d.js`

**Step 1: 写失败的测试（只测纯几何/映射逻辑，不测 Canvas 绘制）**

创建 `test_gene_atlas_3d.js`：

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule() {
  const context = { window: {}, console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'gene-atlas-3d.js'), 'utf8'),
    context, { filename: 'gene-atlas-3d.js' },
  );
  return context.window.GeneAtlas3D;
}

test('buildLabelToRegion inverts regionMappings into a labelIndex lookup', () => {
  const api = loadModule();
  const geometry = {
    labels: [{ acronym: 'FI' }, { acronym: 'POrG' }, { acronym: 'SIG' }],
    regionMappings: {
      A13: { labelIndices: [1, 2] },
      FI: { labelIndices: [0] },
    },
  };
  const lookup = api.buildLabelToRegion(geometry);
  assert.equal(lookup.get(1), 'A13');
  assert.equal(lookup.get(2), 'A13');
  assert.equal(lookup.get(0), 'FI');
  assert.equal(lookup.has(3), false);
});

test('unpackPoints splits the flat quadruple array', () => {
  const api = loadModule();
  const points = api.unpackPoints([10, 20, 30, 1, 40, 50, 60, 2]);
  assert.equal(points.length, 2);
  assert.deepEqual(points[0], { x: 10, y: 20, z: 30, label: 1 });
  assert.deepEqual(points[1], { x: 40, y: 50, z: 60, label: 2 });
});

test('unpackPoints rejects an array whose length is not a multiple of four', () => {
  const api = loadModule();
  assert.throws(() => api.unpackPoints([1, 2, 3]), /multiple of four/i);
});

test('project rotates about the vertical axis and preserves depth ordering', () => {
  const api = loadModule();
  const center = { x: 0, y: 0, z: 0 };
  const at0 = api.project({ x: 10, y: 0, z: 0, label: 0 }, 0, 1, center);
  assert.ok(Math.abs(at0.screenX - 10) < 1e-9);
  // 旋转 90° 后，原本沿 x 的位移应转到深度轴上
  const at90 = api.project({ x: 10, y: 0, z: 0, label: 0 }, Math.PI / 2, 1, center);
  assert.ok(Math.abs(at90.screenX) < 1e-9);
  assert.ok(Math.abs(at90.depth - 10) < 1e-9 || Math.abs(at90.depth + 10) < 1e-9);
});

test('colorFor returns the neutral tone for regions without a value', () => {
  const api = loadModule();
  const scale = { min: 0, max: 4 };
  assert.equal(api.colorFor(null, scale), api.NO_DATA_COLOR);
  assert.notEqual(api.colorFor(2, scale), api.NO_DATA_COLOR);
});
```

**Step 2: 运行测试确认失败**

```bash
cd $WEB && node --test test_gene_atlas_3d.js
```

预期：FAIL —— 文件不存在。

**Step 3: 实现渲染模块**

创建 `gene-atlas-3d.js`，导出：

- `NO_DATA_COLOR`：中性灰常量
- `unpackPoints(flat)`：长度必须是 4 的倍数，否则抛 `... must be a multiple of four`
- `buildLabelToRegion(geometry)`：遍历 `regionMappings`，把每个 `labelIndices`
  元素映射到 DigitalBrain 区域 id，返回 `Map<labelIndex, regionId>`
- `project(point, angle, zoom, center)`：绕垂直轴旋转，返回
  `{ screenX, screenY, depth }`；轴向按 metadata 的 `sourceAxes → viewerAxes`
  映射（source `[LR, PA, IS]` → viewer `[LR, IS, PA]`，即 viewer 的纵轴取 source 的 z、深度取 source 的 y）
- `colorFor(value, scale)`：`value == null` 返回 `NO_DATA_COLOR`；
  否则在连续色标上插值
- `createRenderer(canvas, geometry)`：返回 `{ setValues, setAngle, setZoom, draw, destroy }`。
  `draw()` 内按 `depth` 升序排序后绘制以保证遮挡关系；
  绑定指针拖拽改 angle、滚轮改 zoom

绘制实现要点：
- 用 `outerPoints`（9,828 点）作主体；点半径随 zoom 调整
- 只有 `labelToRegion` 命中且该区域有值的点才着色，其余用 `NO_DATA_COLOR`
- 在 `geneCanvasCaption` 输出「163 区中 106 区可在 3D 呈现，57 区仅定量」

**Step 4: 运行测试确认通过**

```bash
cd $WEB && node --test test_gene_atlas_3d.js
```

预期：5 个测试全部 pass。

**Step 5: 用真实几何抽查映射覆盖**

```bash
cd $WEB && node -e "
const fs=require('fs'), vm=require('vm');
const ctx={window:{},console}; ctx.globalThis=ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync('gene-atlas-3d.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('interactive_brain_atlas/data/allen_3d_geometry.js','utf8'),ctx);
const api=ctx.window.GeneAtlas3D, g=ctx.window.ALLEN_3D_ATLAS;
const pts=api.unpackPoints(g.outerPoints);
const lookup=api.buildLabelToRegion(g);
console.log('点数=',pts.length,'（预期 9828）');
console.log('regionMappings 区域数=',Object.keys(g.regionMappings).length,'（预期 106）');
console.log('labelIndex→区域 映射条目=',lookup.size);
const hit=pts.filter(p=>lookup.has(p.label)).length;
console.log('可着色点比例=',(hit/pts.length*100).toFixed(1)+'%');
"
```

预期：点数 9828，regionMappings 106，可着色点比例为一个合理的非零百分比。

**Step 6: 提交**

```bash
cd $WEB && git add gene-atlas-3d.js test_gene_atlas_3d.js
git commit -m "feat: add standalone Allen point-cloud renderer for the gene view"
```

---

## Task 9: 视图编排与图表 —— gene-atlas-view.js + gene-atlas.css

**Files:**
- Create: `gene-atlas-view.js`
- Create: `gene-atlas.css`
- Modify: `digitalneuron_main.html`（引入两个新资源）
- Test: `test_gene_atlas_view.js`

**Step 1: 写失败的测试（聚焦可测的编排逻辑）**

创建 `test_gene_atlas_view.js`，用 jsdom 装载视图模块并注入伪造的 loader，
断言以下行为（避免测 Canvas 像素）：

```js
test('selecting a gene renders one row per region in the histogram data', ...);
test('regions without coverage are labelled unavailable, never zero', ...);
test('Pn and THM are reported as absent from the gene atlas', ...);
test('the export button stays disabled until at least one gene is loaded', ...);
test('switching metric re-renders without refetching the cached block', ...);
```

伪造 loader 形如：

```js
const fakeLoader = {
  getManifest: () => manifestFixture,
  getGeneIndex: () => geneIndexFixture,
  ensureChunk: async () => decodedChunkFixture,
  load: async () => ({ manifest: manifestFixture, geneIndex: geneIndexFixture }),
};
```

fixture 用小规模构造数据（如 2 区 × 2 细胞类型 × 3 基因），
不要在单元测试里读真实 150 MB bundle。

**Step 2: 运行测试确认失败**

```bash
cd $WEB && node --test test_gene_atlas_view.js
```

**Step 3: 实现 gene-atlas-view.js**

导出 `window.GeneAtlasView`，至少包含：

- `activate()`：首次进入时懒加载 bundle（避免其他两个视图为它付出 9 MB 首屏代价），
  已加载则直接重绘
- `addGene(query)` / `removeGene(index)`：维护已选基因列表，每个基因独立配色，
  **不把多基因混成一条曲线**
- `setMetric('mean'|'detection')`
- 区域柱状图：用站点已引入的 Chart.js 3.9.1，按当前指标降序
- 细胞类型明细表：展示所选区域下 11 类细胞的值、覆盖度、细胞/donor/样本数
- 状态渲染：加载中、加载失败可重试、无命中空态

**Step 4: 实现 gene-atlas.css**

复用 `styles.css` 的 CSS 变量（`--panel` / `--line` / `--accent` / `--muted` 等），
不要引入新的调色板。

**Step 5: 在 HTML 中引入资源**

`<head>` 内 `styles.css` 之后加 `<link rel="stylesheet" href="gene-atlas.css">`；
页面底部按依赖顺序加脚本：

```html
    <script src="gene-atlas-data.js"></script>
    <script src="gene-atlas-3d.js"></script>
    <script src="gene-atlas-view.js"></script>
```

注意：`gene-atlas-3d.js` 需要 `window.ALLEN_3D_ATLAS`，
它由既有的 `interactive_brain_atlas/data/allen_3d_geometry.js` 提供，
必须排在其后。

**Step 6: 运行全部测试**

```bash
cd $WEB && node --test test_*.js
```

预期：全部 pass。

**Step 7: 提交**

```bash
cd $WEB && git add gene-atlas-view.js gene-atlas.css digitalneuron_main.html test_gene_atlas_view.js
git commit -m "feat: wire gene atlas view with region histogram and cell-type detail"
```

---

## Task 10: Excel 导出

移植 `$PKG/app/GeneAtlasExplorer.tsx` 中零依赖的 `.xlsx` 生成器
（`crc32` / `sheetXml` / `makeXlsxZip` / `makeXlsxWorkbook`，约第 254-440 行），
它已是纯 TypeScript 无 React 依赖，去掉类型标注即可。

**Files:**
- Create: `gene-atlas-export.js`
- Modify: `gene-atlas-view.js`（接线导出按钮）
- Modify: `digitalneuron_main.html`（引入脚本）
- Test: `test_gene_atlas_export.js`

**Step 1: 写失败的测试**

```js
test('makeXlsxWorkbook produces a zip whose local file header magic is PK\\x03\\x04', ...);
test('the workbook contains the three required sheets', ...);
test('regional_abundance exports both mean and detection regardless of the active metric', ...);
test('selection_metadata records the source file, sha256 and scope caveat', ...);
test('unavailable values are exported as empty, not as 0', ...);
```

**Step 2: 运行确认失败 → Step 3: 移植实现 → Step 4: 运行确认通过**

三个工作表沿用既有契约：`regional_abundance`、`cell_type_abundance`、
`selection_metadata`。`selection_metadata` 必须写入
源文件名、源 SHA-256（`12eed9e4…`）、归一化标签、当前选择与科学范围警示。

**Step 5: 提交**

```bash
cd $WEB && git add gene-atlas-export.js gene-atlas-view.js digitalneuron_main.html test_gene_atlas_export.js
git commit -m "feat: add dependency-free xlsx export for gene selections"
```

---

## Task 11: 科学标注落实与核对

设计文档列了 6 项标注要求，本任务逐项在界面上核实，防止实现过程中漏掉。

**Files:**
- Modify: `gene-atlas-view.js` / `digitalneuron_main.html` / `gene-atlas.css`（按需）
- Test: `test_gene_atlas_labelling.js`

**Step 1: 写断言测试**

逐项对应设计文档：

```js
test('the gene view states that data is global and not scope-filtered', ...);
test('zero coverage renders as a missing-data marker, never 0', ...);
test('Pn and THM are explicitly marked as absent from the gene atlas', ...);
test('the caption discloses 106 mapped and 57 quantitative-only regions', ...);
test('the caveat mentions bounded fixed-point approximation', ...);
test('the caveat states the values are descriptive, not differential expression', ...);
```

**Step 2-4: 运行 → 补齐文案 → 再运行**

**Step 5: 提交**

```bash
cd $WEB && git add -A
git commit -m "docs: enforce scientific scope labelling in the gene atlas view"
```

---

## Task 12: 发布脚本注册与端到端验证

**Files:**
- Modify: `build_pages_release.py`
- Modify: `test_build_pages_release.py`

**Step 1: 读现状**

```bash
cd $WEB && sed -n '1,80p' build_pages_release.py && echo '---' && cat test_build_pages_release.py
```

**Step 2: 写失败的测试**

在 `test_build_pages_release.py` 追加：新文件全部出现在发布产物中，
且基因数据目录被复制。

```python
def test_release_includes_gene_atlas_files(tmp_path):
    # 断言 gene-atlas-data.js / gene-atlas-3d.js / gene-atlas-view.js /
    # gene-atlas-export.js / gene-atlas.css 出现在输出目录
    ...

def test_release_includes_gene_data_bundle(tmp_path):
    # 断言 gene-data/external_three_sources_v1/manifest.json 存在
    ...
```

**Step 3: 运行确认失败**

```bash
cd $WEB && $PY -m pytest test_build_pages_release.py -q
```

**Step 4: 改 build_pages_release.py**

- `release_file_map()` 新增 5 个条目（4 个 JS + 1 个 CSS）
- 新增一个数据目录复制逻辑：`gene_atlas_data/external_three_sources_v1`
  → `gene-data/external_three_sources_v1`（整目录递归复制，约 1,234 个文件）
- 前端读取路径使用站点根相对 `/gene-data/...`，与开发树路径解耦

**Step 5: 运行确认通过**

```bash
cd $WEB && $PY -m pytest test_build_pages_release.py -q
```

**Step 6: 生成发布产物并核对**

```bash
cd $WEB && $PY build_pages_release.py --output github-pages
ls github-pages/gene-atlas-*.js github-pages/gene-atlas.css
echo "chunk 数: $(ls github-pages/gene-data/external_three_sources_v1/chunks | wc -l)"
du -sh github-pages
```

预期：5 个新资源就位，chunk 数 1232。

**Step 7: 浏览器端到端验证（必做，覆盖 Task 6 未做单测的网络路径）**

```bash
cd $WEB/github-pages && python3 -m http.server 8900 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8900/`，逐项确认：

1. 默认进入 3D Atlas，Overview 可正常切换（无回归）
2. 切到 **Gene Atlas**：三个筛选器置灰，范围说明可见
3. 搜索 `GFAP`：命中、3D 着色出现、柱状图与细胞类型表填充
4. 追加 `AQP4`：两个基因各自独立配色与数值，未被混合
5. 切「检出率」：不重新拉块即刻重绘（Network 面板应无新请求）
6. 搜索一个**低表达**基因与一个不存在的基因：分别正确显示与空态
7. 检查 Network：首屏约 9 MB（manifest + 索引），每个新基因约 10 KB 级别
8. 点「下载 Excel」：三个工作表齐备，缺失值为空而非 0
9. 刷新 `#genes` hash：直接回到基因视图；输入 `#nonsense` 回落到 atlas
10. 切回 Atlas 视图：筛选器恢复原有级联状态

**Step 8: 记录实测数字**

把首屏体积、单基因请求体积、bundle 实际总体积回填到设计文档，
替换其中的「预计」表述。

**Step 9: 提交**

```bash
cd $WEB && git add build_pages_release.py test_build_pages_release.py github-pages docs/plans
git commit -m "build: publish gene atlas assets and data bundle in the pages release"
```

---

## 完成标准

- [ ] `node --test test_*.js` 全部通过，且既有 4 个测试文件无回归
- [ ] `$PY -m pytest test_build_pages_release.py` 通过
- [ ] `validate_equal_study_gene_chunks.py --verify-all-hashes` 通过
- [ ] Task 12 Step 7 的 10 项浏览器核对全部通过
- [ ] 设计文档中的「预计」数字已被实测值替换
- [ ] 6 项科学标注在界面上均可见

## 明确不做（YAGNI）

- 按 Collection/Dataset/Donor 过滤基因数据（需为 67 个 per-dataset 摘要各建 bundle）
- 替换 `regions.js` 中哈希扰动生成的示意组成（留作后续迭代）
- 包内 React 应用与 Cloudflare 数据站部署
- 包内 44M 版本 bundle 的去留处理
- 为 18 个无名区域编造显示名
