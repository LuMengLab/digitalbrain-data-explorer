# Housekeeping 对照面板

3D atlas 基因表达层里条形统计图的对照基线（`gene-compare-view.js` 的 `CONTROL_GENES`）。
2026-08-05 立，数据源同站点（Siletti 2023 31 个 supercluster，1,600 万细胞）。

## 为什么需要

明细面板的每个格子是一个 (region × cell class) 的均值/检出率。读者看到 2-3 倍的类间
差异时无法判断那是生物学还是技术差异 —— 本数据集里 **Astrocyte / Microglia / OPC 的
核捕获深度系统性偏低**，实测候选基因里有 8 个的最低类都落在这几类上。

这组基因的作用是量出那条技术地板：**≤3x 的类间差异不足以称类型特异性**。

## 判据

| 判据 | 阈值 | 理由 |
| --- | --- | --- |
| 31 类全有数据 | `n_cell_types = 31`，`n_regions ≥ 155` | 缺类的行渲染成 No data，对比断裂 |
| 组合数 | `combos ≥ 200` | 低于此值明细面板几乎全空 |
| 跨类倍数 | **max/min ≤ 3x** | 见下方「不要用 specificity 判平坦」 |
| 检出率 | 类中位 `≥ 0.7`，最低类 `≥ 0.3` | 否则「平」是 dropout 造出来的 |
| 表达量 | 跨类中位 `≥ 0.5`（本库最大 ≈ 4.9） | 太低则面板全是接近 0 的格子 |
| **有 cellType 明细层** | 在 `index.json` 的 `detailGenes` 里 | 类面板要按每个类画基线，没有明细层就只能退回一条全脑参照线 |

## 入选面板（6 个，已接进 `CONTROL_GENES`）

`scripts/gene_flatness_probe.py` 实测（cell_weighted 规则，排除覆盖 < 20 区的薄类）：

| 基因 | 家族 | 跨类 max/min | 跨类中位表达 | 检出率(最低/中位) | 最高类 | 最低类 | specificity 列 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BPTF | Stable | 1.40 | 0.978 | 0.475 / 0.831 | OPC | Lower rhombic lip | 1.16 |
| ARID4B | Stable | 1.52 | 1.004 | 0.456 / 0.871 | Oligodendrocyte | Astrocyte | 1.10 |
| TBL1XR1 | Stable | 1.61 | 1.107 | 0.537 / 0.878 | Midbrain-derived inhib. | Astrocyte | 1.14 |
| RAB7A | Stable | 1.66 | 0.603 | 0.357 / 0.679 | Choroid plexus | Upper rhombic lip | 1.35 |
| GAPDH | Classic | 2.47 | 0.960 | 0.332 / 0.776 | Mammillary body | Microglia | 1.50 |
| ACTB | Classic | 2.75 | 1.014 | 0.492 / 0.832 | Vascular | Astrocyte | 1.91 |

分两族是因为这个区别对脑组织成立而 picker 是唯一能说明它的地方：**Classic** 是读者
认得的 ACTB / GAPDH，但它们在类间就是会动 2.5-2.8x；**Stable** 是本数据集实测最平的
一档（1.4-1.7x），要比「谁的水平更高」时该信这一族。

## 实测过、留在明细集合但没接进对照的

| 基因 | 跨类 max/min | 不接的理由 |
| --- | --- | --- |
| RPL32 | 2.42 | 检出率中位 0.65 偏低；核糖体基因本身跟着细胞大小/测序深度走 |
| VCP | 2.33 | 检出率中位 0.49、最低类 0.13，低深度类里那根柱量的是 dropout |
| **B2M** | 34.77 | 传统 HK 清单常收，但在脑组织里是血管/免疫 MHC-I 标记，当基线会把比较方向弄反 |
| **ENO2** | 10.43 | NSE，货真价实的泛神经元标记 |

B2M / ENO2 在先验清单里已从 housekeeping 段移到各自的生物学分段（免疫、泛神经元），
它们仍有明细文件、仍可被当作普通基因选中，但**不出现在 controls 里**。

## 被换掉的旧对照（2026-08-05 之前的 `CONTROL_GENES`）

旧清单是 ACTB / GAPDH / B2M / PPIA + PSMB4 / VCP / RAB7A / CHMP2A / GPI / VPS29，按上面
判据实测后剩下 4 个。移除原因：

| 基因 | 跨类 max/min | 检出率中位 | 移除原因 |
| --- | --- | --- | --- |
| B2M | 34.77 | 0.355 | 血管/免疫标记 |
| PPIA | 6.33 | 0.519 | 波动超标 |
| GPI | 5.41 | 0.738 | 波动超标 |
| PSMB4 | 4.34 | 0.248 | 波动超标 + 检出率过低 |
| CHMP2A | 3.64 | 0.184 | 同上，面板近乎空白 |
| VPS29 | 2.76 | 0.440 | 检出率偏低，且无明细层 |

## 明确排除的其它经典 housekeeping

| 基因 | 排除原因 |
| --- | --- |
| SNRPD3 (检出率中位 0.08)、SUPT4H1 (0.11)、TBP (0.21)、POLR2A (0.31) | 表达太低，面板一片空白，「平」是 dropout |
| EEF1A1 7.2x、HPRT1 7.4x、TUBB 7.6x、UBC 5.7x | 跨类倍数超标，qPCR 惯用不等于单细胞可用 |
| TUBB4B 13.9x（室管膜纤毛）、LDHA 11.7x（糖酵解偏胶质/血管） | 在脑内是类型偏好基因 |

## 判读规则

1. **≤3x 不解读为类型特异性**。对照面板本身就有 1.4-2.8x 的残余梯度，且方向一致地
   指向低 UMI 的胶质类。
2. **类面板里对照按「该类自己的基线」画**（`Baseline in this type`），不是一条全脑
   平均线：Astrocyte / Microglia 块里的对照柱本来就更矮，那是捕获深度，不是基因。
   区域面板加了类过滤时对照同样跟着过滤 —— 拿过滤后的基因去比未过滤的对照，量到的
   是过滤本身。这一条靠对照基因自己的 `.detail.json`（每个约 440 KB，只在读者真的
   打开某个对照时才拉）。
3. **忽略这些基因的 `peak_cell_type`**。平坦基因的峰值类是噪声，实测多数落在只覆盖
   20-32 个区的 Mammillary body 一类薄类上。
4. **不要用 `specificity` 列判平坦**。它是峰值类 / 全类中位，分母跟着峰一起动：ENO2
   的 specificity 仅 1.55x（看着像 housekeeping），实际 max/min 是 10.43x。判平坦一律
   用 `scripts/gene_flatness_probe.py`。

## 复算方式

```bash
python scripts/gene_flatness_probe.py                      # 默认跑对照面板这一组
python scripts/gene_flatness_probe.py --genes AKT2 ASIC2   # 任意符号
```

单次全缓存扫描约 1 分钟。契约测试见 `test_gene_flatness_probe.py`，其中
`test_specificity_understates_a_broadly_high_gene` 就是为了防止有人日后拿
specificity 去筛 housekeeping。前端一侧的契约在 `test_gene_compare_view.js`：
`testAControlWithAClassTierIsReadPerClass`、`testAControlDoesNotAddAClassBlock`、
`testAClassFilterAlsoMovesAControlThatShipsATier`。

## 附：同批测出的两个特例（`AKT2` / `ASIC2`）

| 基因 | 跨类 max/min | specificity 列 | 说明 |
| --- | --- | --- | --- |
| AKT2 | 5.31 | 2.34 | 既不平也不特异，中位表达仅 0.27；收录理由是查询频率 |
| ASIC2 | **109.73** | 2.31 | 峰值类 Deep-layer near-projecting，最低类 Oligodendrocyte 检出率 0.010 |

ASIC2 是 specificity 指标的**系统性盲点**证据：它在多数神经元类都高、在胶质类近零，
中位被自己抬起来，peak/median 只剩 2.31x（全库 top 53%），数据驱动要放宽到类内第
297 名才收得到；而按 max/min 它是 109.7x 的清晰类型限制基因。这类「泛神经元 / 泛胶质
型」基因只能靠先验清单进入明细集合。
