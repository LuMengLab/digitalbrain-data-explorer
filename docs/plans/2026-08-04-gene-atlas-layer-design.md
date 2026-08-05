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

> **2026-08-04 修订：早期体积估算偏低 20 倍，已改为两层拆分。** 下方表格的 44.6 KB
> 来自符号匹配的样本，只命中了部分源文件；改用 Ensembl 主键解析后覆盖变全，实测单基因
> 全粒度**中位 334 KB**。原因是 1,600 万细胞几乎填满 163×31 矩阵，cellType 明细体积
> 与基因本身无关，恒为 ~357 KB。全部 19,296 蛋白编码基因走全粒度 = **7.2 GB**，破
> GitHub Pages 限额。修订后的实测账与决策见本节末「两层拆分」。

**实测体积基准**（基于 31 类词表，非上游 11 类）：

| 项 | 实测 |
| --- | --- |
| `(region, cell_type)` 真实组合数 | **3,478**（163 × 31 = 5,053 种可能，**31% 为空**） |
| `(donor, region, cell_type)` 行数 = Stage A 规模 | 33,318 |
| 单基因全粒度 JSON | ~~44.6 KB~~ → **实测中位 334 KB**（见上方修订） |
| 100 基因 × 双规则一次性加载 | 8.7 MB —— **不可接受作为首屏** |

因此**不做单一大文件**，而是按基因分文件懒加载——基因本来就是用户逐个选的。

#### 两层拆分（当前实现）

区域级着色要覆盖全部蛋白编码基因，而 cellType 明细体积是它的 20 倍且只对少数
有解读价值的基因真正需要，所以两者分文件：

```
gene_atlas_web/
├── index.json                    基因名→文件名索引 + scope 披露 + detailGenes 清单
└── genes/
    ├── GFAP.json                 区域级：regions{mean,detection} × 双规则 + support
    │                               ~17 KB，全部 19,296 个蛋白编码基因都有
    ├── GFAP.detail.json           cellType 明细：region×cellType × 双规则
    │                               实测 ~265 KB，仅 data/gene_atlas_detail_genes.txt 的 517 个
    └── SNAP25.json               无明细的基因只有这一个文件，hasDetail: false
```

**实测体积账**：

| 方案 | 单基因 | 全 19,296 编码基因 | 可行 |
| --- | --- | --- | --- |
| 全粒度单文件 | 381 KB | **7.2 GB** | 否，破 Pages |
| 区域级（support 存双份） | 24 KB | 454 MB | 是 |
| **区域级（support 提顶层）** | **17 KB** | **~320 MB** | **是，当前实现** |
| + 517 个精选明细 | 265 KB | +134 MB | |

`support`（datasets / donors / cells）是**计数**，与聚合规则无关——双规则下完全相同，
所以提到文件顶层只存一份，省 31%。

- **首屏** = `index.json` + 默认一个基因的区域级文件（~17 KB）
- 选中有明细的基因时并行拉 `.detail.json`；无明细的基因**不发这个请求**（否则是 19,203 次必然 404）
- `index.json` 的 `detailGenes` 让前端在取数**之前**就知道该不该开放细胞类型过滤器
- 仍然**不需要分块二进制、`DecompressionStream` 或定点量化**

**代价（已接受）**：细胞类型过滤只对 517 个精选基因可用。其余基因的过滤器置灰并说明
「该基因只有区域级数据，图上显示全部细胞类型合并值」——置灰而不解释会被读成故障。

**发布与部署**：产物由 `scripts/export_gene_atlas_web.py` 生成到 `gene_atlas_web/`
（`.gitignore` 忽略），发布时由 `build_pages_release.py` 拷成 `github-pages/gene-data/`
（同样忽略）。因此**直接推 git 得到的站点不含基因数据**，基因图层会显示不可用提示；
数据需要单独的部署通道（release asset、外部 CDN 或独立数据仓库）。

#### 精选明细基因怎么定（`scripts/rank_gene_specificity.py`）

数据驱动 ∪ 生物学先验，两者各管对方管不了的部分。当前产出 **517 个**（数据驱动 403
+ 先验独有 114），明细约 134 MB。

**为何不用覆盖率（已实测否定）**：

| 指标 | 实测结果 | 结论 |
| --- | --- | --- |
| 脑区覆盖率 | 几乎所有基因都是 150-163 区（连 A1BG 都满覆盖） | **常数，无区分度** |
| 细胞类型覆盖率 | 与特异性 Spearman rho = **−0.675** | **方向相反** |

1,600 万细胞下任何基因在任何区都能找到至少一个表达细胞，所以覆盖率测不出任何东西。
按它排序会选中 APP(1.2x)/FUS(1.2x)——面板上 31 类几乎一样，等于没信息；而筛掉
 CX3CR1(300x)、FOXJ1(275x)、TTR(436x) 这些最清晰的标记。

**指标**：特异性 = 峰值类跨区中位 / 全类中位。配额**按 31 类各取 top 13**，而非全局
top-N：全局排序会让 Microglia 占满名额，Splatter、Mammillary body 一个代表都没有，
而面板要回答的正是「哪类细胞表达它」。实测全局 top 306 只覆盖 17/31 类，Cerebellar
inhibitory 一类独占 60 个名额。

**配额为何是 13**：松紧按「类名基因是否进得来」定。LAMP5 是自己那类（LAMP5-LHX6 and
Chandelier）的命名基因，14.4x 在类内排第 13，而 top 6 的门槛是 18.4x，正好卡在外面。
再往下没有可放的档：ASIC2 要放到类内第 297 名（8,221 个基因、2.1 GB）、AKT2 要第 703
名（14,075 个、3.6 GB），等于取消筛选 —— 这两个走先验特例。

各类门槛差 68 倍（Splatter 第 6 名仅 5.1x = 全库 top 26.9%，Miscellaneous 348.6x =
top 0.1%），所以「精选基因的分位」没有单一数字：数据驱动这 403 个的特异性中位在全库
top 3% 附近，下限一直放到约四分之一分位。

**先验（`data/gene_atlas_prior_genes.txt`）** 负责数据给不出的：高频查询的疾病基因
（APP/MAPT/APOE/HTT 排名近 1.0x，纯数据驱动永远选不上，但读者一定会搜）、教科书
标记、递质通路。改精选范围请编辑先验文件后重跑脚本，不要直接改生成的
`detail_genes.txt`。

**有效性已验证**：TTR→Choroid plexus、CX3CR1→Microglia、FOXJ1→Ependymal、
COL1A2→Fibroblast、BCAS1/GPR17→Committed OPC、CLIC6→Choroid plexus、
CXCL14→CGE interneuron、PVALB→Cerebellar inhibitory（小脑篮状细胞，正确）、
SLC17A7→齿状回颗粒细胞——均与教科书一致。

#### 两个已知数据局限（如实记录，不用统计手段掩盖）

**1. 极低表达噪声会刷高特异性。** 按纯特异性排序的 top 15 实测全是嗅觉受体
（OR2F2 12916x、OR10H2、OR8K3）、毛发角蛋白（KRTAP12-4）、精子蛋白（SPACA5B）——
脑内本不该表达，得分来自中位接近 0 时的除法放大。`MIN_COMBOS = 200` 把它们排除出
清单（它们的 combos 仅 11-154，正常基因 2000-3400），诊断 CSV 也把合格行排在前面。

**2. `Cerebellar inhibitory` 类存在血管基因污染。** FLT1/CLDN5/CAVIN2/CLEC1A 的峰值类
都落在它而不是 Vascular。诊断过程：

- 先怀疑是稀疏细胞数噪声 → **实测否定**：FLT1 在细胞数≥20 的组合里中位 3.17，
  反而高于 <20 的 2.98，所以不是计数噪声，**没加细胞数门槛**。
- 真因是标注质量：该类出现在 NAC、CA1、A8 等小脑外区域，那些核很可能是 doublet
  或误分类，携带内皮基因。
- 试过用 margin（峰值/第二高类）筛掉它们 → **否定**：margin 只看数值、不看谱系关系，
  会误杀正确标记。BCAS1 margin 仅 **1.08**（第二高是 Oligodendrocyte）却是新生少突
  胶质的经典标记，COP 与 Oligo 谱系连续共高是正确的；GFAP/AQP4 (1.67-1.69,第二高
  Ependymal)、ETNPPL (1.80, Bergmann glia) 同理。而污染的 CAVIN2 margin 反而有 2.31。

结论：**如实保留**。明细面板会同时展示 Cerebellar inhibitory 与 Vascular 两类的值，
读者能自行判断；先验清单已包含真正的血管标记。读面板时应当把 31 类看作
supercluster 级标注，存在 doublet / ambient RNA 污染，单一类的值不宜孤立解读。

**附带发现**：TH / CHAT / DBH / TPH2 在 31 类粒度下确实没有清晰峰（峰值仅 0.01-0.03），
因为 supercluster 里根本没有「多巴胺神经元」或「胆碱能神经元」这一类，它们被并入
Midbrain-derived inhibitory 或 Splatter。它们仍在清单里（用户会搜，且「任何类都不
富集」本身是诚实信息），但生成的清单会把真实特异性注在符号后面，不假装它们是好标记。

**3. 特异性指标对「泛神经元 / 泛胶质」型基因是盲的。** peak/median 的分母会跟着峰一
起动：实测 ASIC2 的 specificity 只有 **2.31x**（全库 top 53%，数据驱动要放到类内第
297 名才收得到），但它的跨类 max/min 是 **109.7x** —— 在多数神经元类都高、在胶质类
近零，中位被自己抬起来了。ENO2（1.55x vs 10.4x）同型。

结论：这类基因只能靠先验清单进明细集合；判断一个基因平不平、或是不是真的类型限制，
一律用 `scripts/gene_flatness_probe.py` 算 max/min 与检出率下界，不要看诊断表的
specificity 列。housekeeping 对照面板（10 个基因、入选判据、判读规则）单独记在
`docs/gene-atlas-housekeeping-panel.md`。



### 细胞类型过滤器的语义（必须显式定义）

勾选细胞类型子集后，region 级值由所选类型**即时重算**，聚合方式与当前全局规则保持一致：

| 当前规则 | 子集重算方式 |
| --- | --- |
| `cell_weighted` | 在所选类型上按细胞数加权 |
| `donor_balanced` | 在所选类型上等权平均 |

只对**该区内真实有数据的类型**参与运算（参照 31% 空组合）；若所选类型在某区全无数据，
该区按**数据缺失**处理（中性灰、不进色标区间），**不得渲染为 0**。

**可用性前提**：重算需要 cellType 明细层，因此过滤器只对 `index.json` 的 `detailGenes`
列出的 517 个精选基因开放。其余基因勾选框置灰，并显式说明图上是全部细胞类型的合并值。

两处易混的空状态必须区分开：

| 状态 | 含义 | 表现 |
| --- | --- | --- |
| **无过滤**（内部 `null`） | 用户没动过滤器 | 读预编译的区域级表（权威值） |
| **空选择**（内部 `[]`） | 用户取消了所有勾选 | 无类型贡献，图上什么都不着色 |

把两者塌成同一个值会让「取消全部勾选」错误地显示全部区域。

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
