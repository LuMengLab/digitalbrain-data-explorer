# Gene Atlas 图层设计（自建统计管线）

- 日期：2026-08-04
- 状态：已与用户逐项确认，待转入实施计划
- 基线：`master` @ `693c127`
- 前置说明：仓库存在未合并分支 `feat/gene-atlas-integration`（38 commits）实现过同类功能。
  用户已明确选择**忽略该分支、从零重新设计**，理由是不接受「移植出第二份渲染器」的做法，
  且不愿接手遗留代码。本设计不复用其任何 JS 代码与数据包。

## 摘要

在现有 3D Atlas 中新增**第 4 个数据图层** Gene expression，展示所选基因在各脑区的
**平均表达值**与**检出率**。前端零渲染代码复制，复用同一个 atlas 实例；数据由自建管线
从 109 个原始源 h5ad 统计得出，聚合规则完全自主。

---

## 一、形态决策

**不是新页面，而是现有 atlas 的第 4 个图层。** 访问路径仍为 `#atlas`，图层切换不进 URL
（与现有 FC/SC 一致）。

```
Atlas layer
├─ Cell profiles
├─ Functional
├─ Structural
└─ Gene expression   ← 新增
```

已评估并否决的两个替代方案：

| 方案 | 否决理由 |
| --- | --- |
| 抽取 `atlas-core.js` 共享渲染内核，双实例 | 需重构正在工作的 2774 行 `app.js`（93 处 `getElementById`、单一全局 `state`/`ctx`），而现有测试**不覆盖 atlas 渲染本身**，重构无安全网 |
| iframe 嵌入独立图谱页 + postMessage | 整套 atlas chrome（细胞类型过滤、连接组阈值）在基因语境下不适用；样式割裂、通信异步 |

## 二、前端复用机制

关键依据：`drawRegions()`（`interactive_brain_atlas/app.js:1279-1292`）已存在一条
**「每区域标量 → 标记颜色与半径」**通道，当前由 `AtlasBridge` 通过
`state.linkedRegionCells` 驱动。基因表达值形状完全相同，直接复用。

唯一的结构性改动是渲染主循环的分支（`app.js:1590`）：

```js
// 现状
if (state.dataLayer === "cells") drawRegions();
else drawConnectivity();

// 改为
if (state.dataLayer === "cells" || state.dataLayer === "genes") drawRegions();
else drawConnectivity();
```

配套改动：

- `selectDataLayer()`（`app.js:1745`）图层白名单加 `"genes"`
- `drawRegions()` / `getVisibleRegions()` / `getRange()` 内部把取值收敛成一个显式值提供者，
  由两条分支扩为三条：

```
        ┌─ "cells" + 无联动 → region.composition[selectedCellType]   （现有）
valueOf ├─ "cells" + 有联动 → linkedRegionCells[acronym]             （现有）
        └─ "genes"          → geneValues[acronym]                    （新增）
```

**零改动继承**：3D 投影、深度排序与遮挡、旋转/缩放缓动（系数 0.1 / 0.12）、
Lateral/Dorsal/Anterior 预设、外壳两种样式、点击命中、hover tooltip、区域详情面板、
精确映射 vs 广义代理的实线/虚线标记。

## 三、指标与色标

| 指标 | 含义 | 色标区间 |
| --- | --- | --- |
| Mean expression | 平均表达值（log1p(CP10K) 组内均值） | 当前基因在可见区的 min–max，**动态** |
| Detection rate | 检出率 = 该区中表达该基因的细胞比例 | **固定 0–100%** |

Detection 有天然上界，固定区间才能跨基因横向比较；Mean 无上界，需动态拉伸才能体现区域差异。
两者不可共用同一套区间策略。

### 术语约定（避免与数据契约冲突）

用户口语中的「表达覆盖率」= 本设计的 **Detection rate**。界面与代码中禁止用
`coverage` 指代细胞比例，该词保留给「数据集覆盖数」（用于缺失判定）。

## 四、界面落位

基因搜索行是**唯一新增的 chrome**，仅在 genes 图层显示；其余控件复用抽屉内既有
`control-section` 结构（换标签与数据源）。

```
┌─ Atlas header ────────────────────────────────────────────────┐
│  Interactive 3D Atlas      [Atlas settings] [About the atlas] │
├───────────────────────────────────────────────────────────────┤
│  ← 仅 genes 图层显示 →                                          │
│  [🔍 搜索基因，如 GFAP  ] [GFAP ×][SNAP25 ×]  Mean │ Detection │
├─────────────────┬─────────────────────────────────────────────┤
│ 抽屉（复用）      │            3D 画布（同一个 canvas）           │
│  Atlas layer     │      105 区按活动基因着色，无数据区中性灰       │
│  表达阈值 ▓▓▓░░   │   [Lateral][Dorsal][Anterior]      [− ⤡ +] │
│  细胞类型(31类)   ├─────────────────────────────────────────────┤
│                  │  区域详情：该区 31 类细胞的表达值/检出率明细    │
└─────────────────┴─────────────────────────────────────────────┘
```

多基因 chips，点击某个设为「活动基因」驱动 3D 着色。

**细胞类型过滤器用 Explorer 的 31 类词表**（已实测：源文件 `obs/DigitalNeuron_cell_type` 的
31 个全局取值与 `digitalneuron_data.js` 的 31 个细胞类型逐字相同）。因此**不需要任何归并映射**，
基因图层与 Overview 页面口径天然统一。

> 注意不要沿用上游二阶段 summary 的 11 类广义分类——那是它自己的归并结果，
> 与本站 31 类词表不一致，采用它会引入一层无谓的映射与口径分歧。
>
> atlas 内置 `regions.js` 的 7 类是**示意数据**（哈希扰动生成），与真实分类无关，不可作为依据。

## 五、数据源（已逐项实测）

```
/data/DigitalBrain/data/scBrain/aligned_with_predictions/filtered_dataset_BCA/          65 文件
/data/DigitalBrain/data/scBrain/aligned_with_predictions/filtered_dataset/              42 文件
/data/DigitalBrain/data/scBrain/aligned/collection_019__5_6human_brain_cell_atlas_v1_0/  2 文件
                                                              ───────────────────────────────
                                              109 文件，0.81 TiB，全部存在
```

与 Overview 页面精确对应：75 collections / 109 datasets / 2,143 donors / 16,352,123 cells。

权威清单来自
`/data/DigitalBrain/data/scBrainCellAtlas/outputs/external_three_sources_audit_2026-08-02/audit_manifest.json`
的 `files[].source_path` 与 `files[].matrix_source`。

### 矩阵来源分布与排除项

| `matrix_source` | 文件数 |
| --- | --- |
| `X` | 51 |
| `raw.X` | 26 |
| `layer:counts` | 22 |
| `None`（无 counts） | **10** |

那 10 个文件 `status = skipped`、原因 `no_count_like_matrix_source`，主要是 GBM/胶质瘤类
Smart-seq/TPM 数据集。**必须排除**：没有原始 counts 无法计算检出率。

代价：104,399 细胞（**0.64%**），最终覆盖 16,247,724 / 16,352,123。**界面须显式披露。**

### 实测规模与吞吐

| 项 | 实测值 |
| --- | --- |
| 有 counts 的文件 | 99 |
| 总非零值 | 56,302,856,730 |
| 实际需读字节 | 553 GiB（只读 counts 矩阵，非整个 0.81 TiB） |
| HDF5 压缩 | 无（`compression=None`），吞吐即纯磁盘 I/O |
| 实测吞吐 | 224 MiB/s |
| 体积分布 | 11 个 >10 GB，48 个 1–10 GB，50 个 <1 GB，中位 1.06 GB，最大 187 GB |
| 预计耗时 | ≈1.6 小时单进程；按文件粒度 4–8 并行约 15–25 分钟 |

## 六、统计管线（三阶段）

### Stage A · 逐文件伪批量（可并行，成本全在此）

分组键 `donor × region × cell_type`。配方与上游一致（取自 first_stage 的
`uns/digitalbrain_summary`）：

```
每细胞:  counts → CP10K(target_sum=10000) → log1p     ← log1p(0)=0，稀疏性不破坏
组内:    mean   = Σ log1p值 / 组内细胞数
         detect = 组内非零细胞数 / 组内细胞数
```

**实现必须走稀疏矩阵乘法**（`指示矩阵 @ 归一化矩阵`），把分组聚合交给 C 层。
禁止逐细胞 Python 循环——560 亿次迭代不可行。

检出率用同一指示矩阵乘以「data 全置 1 的结构矩阵」得到。

#### 已完成的端到端校验

在 `ec_stream_region_at_14_days_of_age_filtered.h5ad`（7,588 细胞 × 21,563 基因、
1 区 / 1 donor / 17 细胞类型）上与上游 first_stage 逐值比对：

```
基因顺序完全一致        True
匹配细胞类型            17/17
mean      最大绝对误差   4.768e-07     ← float32 机器精度量级
detection 最大绝对误差   2.979e-08
细胞数                  7,588 vs 7,588  精确一致
耗时                    1.65 s
```

配方理解、稀疏矩阵乘法路线、稀疏性保持假设三者均得到验证。

#### 硬约束：大文件必须分块流式

最大文件 `whole_taxonomy_dlpfc_seattle_alzheimer_s_disease_atlas_sea_ad_filtered.h5ad`
有 **7,971,379,735 个非零值（约 96 GB）**，无法整载入内存。必须按 `indptr` 做细胞行分块
（建议 5–10 万细胞/块）迭代累加。这是实现上唯一的硬约束。

#### 输出粒度（关键决策）

Stage A 缓存保持 `donor × region × cell_type` 粒度，并记录每组 `n_cells`，
**且每个文件只保存自身基因集**（不在此阶段统一基因空间，避免缓存膨胀到 ~23 GB；
参照上游 first_stage 同样策略，体积约 5.7 GB）。

**一次扫完全部基因并落盘。** 全量扫描代价与基因数无关，一次算全可让后续更换基因清单、
更换聚合规则都无需重扫 553 GiB。

### Stage B · 跨文件合并（规则自主）

**基因标识符解析。** 实测源文件主键并不统一：

| `var/_index` 风格 | 文件数 | 符号字段 |
| --- | --- | --- |
| Ensembl（≥95% 为 ENSG） | 44 | `feature_name` |
| 非 Ensembl（即符号本身） | 55 | 54 个无独立符号字段、1 个有 `gene_symbol` |

因此需双向解析器（符号 ↔ Ensembl），用已在仓库的 `data/vendor/hgnc_complete_set.txt`
（17 MB）桥接。注意 `raw.X` 的基因集取 `raw/var`，与 `var` 可能不同。

**脑区映射：纯查表，零歧义（已实测）。** 源文件 `obs/atlas_ontology_term_Mod-Brodmann`
存在于 **99/99** 个文件，其全局取值恰为 **163 个区，与 163 区词表 163/163 完全吻合**
（词表外 0 个、词表内未出现 0 个）。脑区协调在源文件里已完成，**不需要 RegionTokenizer、
不需要构建映射**。

**细胞类型：直接用 31 类，零映射。** 源 `obs/DigitalNeuron_cell_type` 的 31 个全局取值
与 Explorer 词表逐字相同。

**上游 `resolved_fields` 记录的权威字段名**（可直接沿用）：

| 语义 | 字段名 | 覆盖 |
| --- | --- | --- |
| 脑区（Mod-Brodmann） | `atlas_ontology_term_Mod-Brodmann` | 99/99 |
| 脑区（Gyral） | `atlas_ontology_term_Gyral` | 99/99 |
| donor | `donor_id` 46 / `publication_donor_id` 53 | 99/99（**两种取值**，实测修正） |
| 细胞类型 | `DigitalNeuron_cell_type` | 97/99 |
| 细胞类型（备用） | `supercluster_term` | 2/99（HBCA 的 all_neurons / all_non_neurons） |

实现须按 `audit_manifest.json` 的 `files[].resolved_fields` 逐文件取字段名，不可硬编码单一字段。

**聚合规则：两种都算，前端可切换。**

| 规则 | 定义 |
| --- | --- |
| donor 平衡 + 数据集等权 | donor 内平均 → 数据集内平均 → 跨数据集等权平均 |
| 细胞数加权 | `Σ(组均值 × 组细胞数) / Σ组细胞数` |

两者均可由 Stage A 的 donor 级缓存直接推导，**Stage A 无额外成本**，仅 Stage C 产物体积翻倍。
差异大的区域应在界面给出提示——差异本身即「少数超大队列是否支配结论」的信号。

### Stage C · 前端数据包（按基因分文件、懒加载）

**实测体积基准**（基于 31 类词表，非上游 11 类）：

| 项 | 实测 |
| --- | --- |
| `(region, cell_type)` 真实组合数 | **3,478**（163 × 31 = 5,053 种可能，**31% 为空**） |
| `(donor, region, cell_type)` 行数 = Stage A 规模 | 33,318 |
| 单基因全粒度 JSON | **44.6 KB**（双聚合规则约 89 KB） |
| 100 基因 × 双规则一次性加载 | 8.7 MB —— **不可接受作为首屏** |

因此**不做单一大文件**，而是按基因分文件懒加载——基因本来就是用户逐个选的：

```
gene_atlas_web/
├── index.json                 基因名→文件名的检索索引 + scope 披露（几 KB）
└── genes/
    ├── GFAP.json              单基因全粒度：region 级 + region×cellType 级 + 支持度
    └── SNAP25.json                双聚合规则同文件内并存，约 89 KB
```

- **首屏** = `index.json`（几 KB）+ 默认一个基因（~89 KB）
- 用户每加一个基因 = 一次 ~89 KB 请求，已加载的缓存在内存
- 该布局可直接扩到全量 14 万基因，只需 `index.json` 变大，**无需重构**
- 仍然**不需要分块二进制、`DecompressionStream` 或定点量化**

单基因文件同时携带 region 级与 region×cellType 级，因此细胞类型过滤器可在**前端即时重算**
3D 着色，无需额外请求。

### 细胞类型过滤器的语义（必须显式定义）

勾选细胞类型子集后，region 级值由所选类型**即时重算**，聚合方式与当前全局规则保持一致：

| 当前规则 | 子集重算方式 |
| --- | --- |
| `cell_weighted` | 在所选类型上按细胞数加权 |
| `donor_balanced` | 在所选类型上等权平均 |

只对**该区内真实有数据的类型**参与运算（参照 31% 空组合）；若所选类型在某区全无数据，
该区按**数据缺失**处理（中性灰、不进色标区间），**不得渲染为 0**。

## 七、区域覆盖（已实测）

```
基因数据 163 区
  ∩ atlas 106 区词表  = 106   ← 完全覆盖
      其中可上 3D      = 105   （1 区落在 Allen 体积外）
  atlas 侧缺基因数据   =   0   ← 一个都不缺
词表外仅有基因数据     =  57   → 只进定量列表，不上 3D
```

## 八、两条必须落实的正确性规则

**1. 范围隔离（含一个真实交互陷阱）**

基因数据是跨研究合并结果，数据集轴已在聚合中压掉，**无法按 Collection/Dataset/Donor 过滤**。
切到 genes 图层时须禁用筛选器并显式标注「全局范围」。

> **UI 落实（2026-08-04 修订）**：说明文字**不内联**在筛选器行内——作为 flex 子项它会
> 抢占宽度、把三个 select 压扁。改为：锁定时给 `.controls` 加 `is-scope-locked` 类，
> CSS 在行右上角渲染一个常驻小徽章「ⓘ Global scope」，说明文字改为**绝对定位的悬浮
> tooltip**（`opacity/visibility` 过渡，`pointer-events:none`，不占布局），鼠标悬停筛选器行
> 时浮现于行下方。守卫仍切换 `#geneScopeNote` 的 `hidden`（armed 语义），可见性交给 CSS。

> **数据集选择的调研结论与本版决策（2026-08-04）**：曾评估「All / 选具体数据集 / 选
> 具体 donor」的级联选择。结论如下：
>
> - **底层可行、无需重跑扫描**：Stage A 缓存本就按源文件分存，每个都带 `dataset_id`
>   与完整 donor×region×cell_type 分组；`basename(source_path)` + collection 目录名
>   slug 化后与 Explorer 的 (collection, dataset) 二元组 **109/109 确定性映射、0 歧义**，
>   donor 标识 **99.8%** 命中。All / collection / dataset / donor 四级都是同一份缓存的
>   不同聚合，那 53 分钟全量扫描**不必重跑**。
> - **代价在 Stage C 前端产物**：聚合有损，从 All 级 805 组无法还原 dataset 级 1,864 组
>   或 donor 级 14,714 组。单基因体积实测：All ≈ 31 KB、dataset 级 ≈ 51 KB、
>   donor 级 ≈ 257 KB。按基因清单线性放大：1,000 基因 dataset 级约 52 MB、donor 级
>   约 263 MB；5,000 基因带 donor 级达 1.3 GB，逼近 GitHub Pages 单仓库软上限。
> - **视图价值低**：每数据集覆盖脑区数中位数为 **1**（多数研究只测一个区），选中具体
>   数据集后 3D 图大概率只有 1 个区着色，donor 级更稀疏、噪声大。
>
> **本版决策：仅做 All（全局跨研究合并），不引入 Collection/Dataset/Donor 选择。**
> 筛选器在 genes 图层保持锁定。数据集级选择留作后续迭代——若启用，简易方案见下。
>
> **后续若要做的简易方案（不重跑扫描）**：Stage B/C 保留 dataset 轴，按基因导出
> `genes/<SYMBOL>.json` 内联 All＋dataset 级明细（≈51 KB，覆盖 All/collection/dataset
> 三级由前端聚合）；donor 级另拆 `genes/<SYMBOL>.donors.json` **按需 fetch**、不进首屏、
> 可选不纳入发布产物。前端 `gene-atlas-data.js` 的 `recomputeRegion()` 已具备按子集
> 同规则重算能力，加 dataset/donor 维度是同构扩展。届时需撤销筛选器锁定并同步修订本节。

陷阱：`getVisibleRegions()`（`app.js:648-652`）会用 `state.linkedActiveRegions` 裁剪可见区域。
若不旁路，Explorer 当前选中范围会**静默裁掉**基因图层本该显示的区域，
表现为「基因在这些区不表达」，实为被范围过滤器吃掉。**进入 genes 图层必须旁路该过滤。**

**2. 缺失 ≠ 零**

无数据一律按「数据缺失」处理：中性灰、不参与色标 min/max、不渲染为 0 表达。
零表达与无数据在生物学上是不同结论。适用于：被排除的 10 个数据集所涉区域、
词表外的 57 区、以及任何组内细胞数为 0 的情形。

## 九、测试策略

沿用项目现有 `node:assert` + `node:vm` + jsdom 约定，纯函数优先。

**前端**

- 值提供者三条分支各自取值正确、图层切换后随之切换
- 色标：mean 动态区间、detection 固定区间、全缺失时不崩
- 缺失语义：无数据不进 min/max、不渲染为 0
- 范围隔离：genes 图层下 `linkedActiveRegions` 被旁路
- 区域交集：105 / 106 / 57 三个数字作为回归断言，防数据换版后静默漂移

**管线（Python）**

- 归一化配方：小型构造矩阵断言 CP10K + log1p + 组内均值
- 检出率：非零计数与组细胞数的边界（全零组、单细胞组）
- 分块流式：分块结果与整载结果逐值一致（防 `indptr` 切片错位）
- 标识符解析：Ensembl / 符号 / 带版本号 三类输入，及无命中
- 聚合规则：两种规则在构造数据上的解析解
- **回归基准**：保留 `ec_stream` 那份与上游的逐值比对作为管线正确性基准

**构建**

- 扩充 `test_build_pages_release.py`：断言新增前端文件与基因数据目录进入发布产物，
  且 `index.html` 内路径重写正确

## 十、明确不在本次范围内

- 按 Collection/Dataset/Donor 过滤基因数据（数据集轴已压掉，需为每数据集单独建包）
  ——**已调研，确认可行且无需重跑扫描；因产物体积与视图价值权衡，本版仅做 All，
  见第八节的决策记录**
- 用真实 region × celltype 联合矩阵替换 `interactive_brain_atlas/data/regions.js`
  中哈希扰动生成的示意组成（技术上可行，留作后续迭代）
- 全量 14 万基因的前端数据包（先做子集验证，规模化留作第二阶段）
- 那 10 个无 counts 数据集的替代处理方案
