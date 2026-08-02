# DigitalBrain Gene Atlas 融合设计（方案 B3）

- 日期：2026-08-02
- 状态：已确认，待实施
- 决策人：用户
- 相关原型：[docs/mockups/gene-integration-options.html](../mockups/gene-integration-options.html)

## 摘要

在现有 DigitalBrain Data Explorer 静态站中新增第 3 个视图标签 **Gene Atlas**，
以原生 JS 实现基因表达检索与可视化，数据源为 16,247,724 细胞的
`external_three_sources` 等权合并图谱。该标签自包含、与 Explorer 的
Collection/Dataset/Donor 筛选状态隔离，并自绘轻量 3D 点云复用同一份 Allen 几何。

## 数据来源与验证结论

源目录：`/data/DigitalBrain/data/scBrainCellAtlas/outputs/external_three_sources_summary_2026-08-02/`

| 项 | 值 |
| --- | --- |
| 源文件 | `atlas/overall.equal_study.summary.h5ad`（1,242,327,162 字节） |
| SHA-256 | `12eed9e4575af724b8900b56cb7f43ba9ba338845958da409fd4419a260e165a` |
| 细胞数 | 16,247,724 |
| region × celltype 行 | 1,570 |
| 区域 | 163 |
| 广义细胞类型 | 11 |
| 基因特征 | 315,331 |
| 输入数据集 | 67（源自 109 个文件） |

`atlas/` 下 `external_three_sources_16247724_counted_cells.summary.h5ad` 与
`overall.equal_study.summary.h5ad` 是同一 inode 的硬链接，不是两份数据。

### 与现有 explorer 的对齐关系（已验证）

```
source_files:                       109  = explorer 的 109 datasets
source_rows:                 16,352,123  = explorer 的 16,352,123 cells
normalized_only_rows_excluded:  104,399  （10 个仅有归一化值、无原始 counts）
input_cells:                 16,247,724  = 16,352,123 − 104,399
```

区域词表兼容性显著优于包内的 44M 版本：

| 指标 | 44M 版 | 17M 版（本次采用） |
| --- | --- | --- |
| 区域落在 explorer 165 区词表内 | 118 / 174 | **163 / 163** |
| 可上 Allen 3D 的区域 | 89 | **106** |
| explorer 侧无基因数据的区 | 56 | 仅 `Pn`、`THM` |

## 架构

### 真源与发布关系

开发树根目录是唯一真源，`github-pages/` 由 `build_pages_release.py` 生成。
**所有改动必须落在根目录并注册进发布映射表**，否则下次发布构建会被覆盖。

映射关系：`digitalneuron_main.html` → `index.html`，
`interactive_brain_atlas/*` → `atlas/*`。

### 新增文件（开发树根目录）

| 文件 | 职责 |
| --- | --- |
| `gene-atlas-data.js` | bundle 加载与解码：manifest、gene index、gzip 解压、chunk LRU 缓存、基因二分检索、region × celltype 聚合 |
| `gene-atlas-3d.js` | 轻量 3D 点云投影渲染：旋转/缩放、按表达值着色 |
| `gene-atlas-view.js` | 视图编排：检索框、指标切换、区域柱状图、细胞类型明细表、区域多选筛选、Excel 导出 |
| `gene-atlas.css` | 样式，复用 `styles.css` 既有 CSS 变量 |

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `digitalneuron_main.html` | 视图切换增加第 3 个按钮；新增 `<section id="geneAtlasView" class="app-view is-hidden">`；引入 4 个新资源 |
| `app.js` | `initializeViewSwitch()` 由二态布尔改为 N 态；新增 `#genes` hash；切入基因标签时置灰三个筛选器 |
| `styles.css` | 引入 `gene-atlas.css` 所需的少量共享调整 |
| `build_pages_release.py` | `release_file_map()` 注册 4 个新文件；新增基因数据资产目录映射 |

### 视图切换重构

现状为二态布尔（`app.js` 的 `applyView()` 内 `const isOverview = view === 'overview'`），
需改为以视图 id 为键的 N 态映射，保持既有行为不变：

- hash 同步扩展为 `#atlas` / `#overview` / `#genes`，未知 hash 回落到 `atlas`
- 保留 `resizeAllCharts` 在视图可见后重排的现有逻辑
- 保留 `viewHint` 首次提示与 `localStorage` 记忆逻辑
- 新增：进入 `genes` 时对 Collection/Dataset/Donor 三个 `<select>` 设 `disabled`
  并显示范围说明；离开时恢复

## 数据构建与托管

### 构建命令

环境：`/home/jialiang/miniconda3/envs/scbrain/bin/python`（h5py 3.15.1 / numpy 2.2.6，
满足 `requirements-summarizer.txt` 的 `h5py>=3.10,<4`、`numpy>=1.26,<3`）。

```bash
PKG=digitalbrain_gene_atlas_student_integration_package_2026-08-02_v2/digitalbrain_gene_atlas
SRC=/data/DigitalBrain/data/scBrainCellAtlas/outputs/external_three_sources_summary_2026-08-02

/home/jialiang/miniconda3/envs/scbrain/bin/python \
  $PKG/scripts/build_equal_study_gene_chunks.py \
  --input  $SRC/atlas/overall.equal_study.summary.h5ad \
  --output gene_atlas_data/external_three_sources_v1 \
  --geometry interactive_brain_atlas/data/allen_3d_geometry.js \
  --region-names $PKG/data/region_names.equal_study.json \
  --chunk-genes 256
```

输出目录必须不存在或为空（转换器拒绝覆盖既有发布）。

### 校验

```bash
/home/jialiang/miniconda3/envs/scbrain/bin/python \
  $PKG/scripts/validate_equal_study_gene_chunks.py \
  --input  $SRC/atlas/overall.equal_study.summary.h5ad \
  --bundle gene_atlas_data/external_three_sources_v1 \
  --verify-all-hashes
```

### 规模推算与托管

按 44M 版实测比例外推（值总量为其 75.6%）：

- chunks 约 **150–180 MB**，约 **1,232 个块**（`ceil(315331/256)`）
- `gene_index.json.gz` 约 **8.4 MB**
- 首屏加载约 **9 MB**（manifest + 基因索引），单基因查询约 10 KB

**托管决策：提交进仓库**，路径 `gene_atlas_data/external_three_sources_v1/`。
单个 chunk 最大约 1.3 MB，远低于 GitHub 单文件 100 MB 限制；
总量在 GitHub Pages 1 GB 站点软限内。

发布时该目录复制为 `gene-data/external_three_sources_v1/`，
前端以站点根相对路径 `/gene-data/...` 读取，避免子路径部署时的路径歧义。

> 注：Git LFS 不可用于此场景 —— GitHub Pages 不解析 LFS 指针，会返回文本指针文件而非数据。

## 3D 点云渲染设计

复用 `interactive_brain_atlas/data/allen_3d_geometry.js`（md5 `9f6a815f…`，
与现有 atlas 同源，无需重新配准）。

**不复用 `interactive_brain_atlas/app.js`** —— 它是硬单例，92 处 `getElementById()`
绑定固定 DOM id 并在加载时读取全局 `window.DIGITALBRAIN_REGION_DATA`，
同页面无法起第二个独立实例。

已确认的几何数据结构：

```
outerPoints:    39,312 个数字 = 9,828 点 × [x, y, z, labelIndex]
boundaryPoints: 50,312 个数字 = 12,578 点 × [x, y, z, labelIndex]
labels:         141 条，含 acronym / color / centroidVoxel
sourceShape:    [394, 466, 378]，sampleStep 2
voxelSizeMm:    [0.5, 0.5, 0.5]，qoffsetMm [-98, -134, -72]
orientation:    sourceAxes [LR, PA, IS] → viewerAxes [LR, IS, PA]
```

渲染要点：

- 以 `outerPoints` 的 9,828 点做画布 2D 投影，绕垂直轴旋转 + 缩放
- 按 `labelIndex` → `labels[i].acronym` → `regionMappings` 反查所属 DigitalBrain 区域
- 该区域有当前基因值时按连续色标着色；无值时用中性灰并计入「无数据」计数
- 深度排序后绘制，保证遮挡关系正确
- 仅 106 个有 `geometryKey` 映射的区域可着色；其余 57 区**不推测位置**，
  仅出现在柱状图与表格中

## 数据流

```
用户输入基因符号/ID
  → gene-atlas-data.js 在 searchTokens 上二分检索 → geneIndex
  → chunkIndex = floor(geneIndex / 256)，localGene = geneIndex − chunk.start
  → 命中缓存则直接用；否则 fetch chunks/chunk_NNNN.bin.gz
  → 校验 0x1f 0x8b 魔数 → DecompressionStream('gzip')
  → 断言 byteLength === rowCount × chunk.count × 5
  → Uint16Array(buf, 0, n) 均值 × meanScale
     Uint16Array(buf, n×2, n) 检出率 × detectionScale
     Uint8Array(buf, n×4, n) 覆盖度（无损）
  → 按 region 聚合：同区域同细胞类型先内部平均，
     再对「已represented的细胞类型」取等权均值（不做细胞数加权）
  → 分发到 3D 着色 / 柱状图 / 细胞类型表
```

## 科学标注要求（方案 B 的核心价值，必须落实）

1. **范围隔离**：基因数据为 67 研究等权合并，数据集轴已在上游压掉，
   无法按队列过滤。进入该标签时筛选器置灰，并显式标注
   「全局范围，不随 Collection/Dataset/Donor 变化」。
2. **缺失 ≠ 零**：`coverage == 0` 一律显示为「数据缺失」，
   禁止渲染为 0 表达或参与均值。
3. **两区无数据**：`Pn`、`THM` 在基因图谱中不存在，需显式标为不可用。
4. **区域覆盖披露**：明示 163 区中 106 区可上 3D、57 区仅定量。
5. **量化误差**：块采用有界 16 位定点编码，需在界面说明处标注
   数值为有界近似（上游审计最大误差 0.0000382 表达单位 / 0.00000766 检出率）。
6. **描述性定位**：沿用现有站点口径 —— 非差异表达、未做多重检验校正、
   非因果证据；3D 位置是策展展示映射，非精确细胞构筑分割。

## 错误处理

| 场景 | 行为 |
| --- | --- |
| manifest / gene index 拉取失败 | 视图内显示可重试的错误态，不影响其他两个标签 |
| chunk 拉取失败或字节数不符 | 该基因标记为加载失败并保留其他基因结果，不整体崩溃 |
| `DecompressionStream` 不可用（老浏览器） | 检测能力缺失时给出明确降级提示 |
| 基因检索无命中 | 空态提示，区分「拼写无匹配」与「该图谱不含此特征」 |
| 未知 URL hash | 回落到 `atlas` 视图 |

## 测试策略

沿用现有 jsdom + `node:vm` 约定，新增 `test_gene_atlas.js`：

- **解码正确性**：用构造的已知字节流断言 mean/detection/coverage 三段偏移与缩放
- **块寻址**：`chunkIndex` / `localGene` 边界（首块、末块、跨块）
- **检索**：大小写不敏感、符号与 Ensembl ID 双路径、无命中
- **聚合规则**：同区多行先内部平均再等权跨细胞类型；coverage=0 不参与
- **缺失语义**：`Pn` / `THM` 与 coverage=0 均不得渲染为 0

扩充 `test_build_pages_release.py`：断言 4 个新文件与基因数据目录进入发布产物，
且 `index.html` 内的路径重写正确。

前置条件：本机当前无 `node_modules`，jsdom 未安装，需先 `npm install jsdom`。

## 明确不在本次范围内

- 按 Collection/Dataset/Donor 过滤基因数据（需为 67 个 per-dataset 摘要各建 bundle）
- 替换 `interactive_brain_atlas/data/regions.js` 中哈希扰动生成的示意组成
  （新数据具备真实 region × celltype 联合矩阵，技术上可行，留作后续迭代）
- 包内 React 应用与 Cloudflare 数据站的部署
- 包内 44M 版本 bundle 的去留处理
