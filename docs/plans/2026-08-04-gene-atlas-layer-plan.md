# Gene Atlas 图层 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有 3D Atlas 中新增第 4 个数据图层 Gene expression，展示所选基因在各脑区的平均表达值与检出率，数据由自建管线从 109 个原始源 h5ad 统计得出。

**Architecture:** 前端零渲染代码复制——复用 `interactive_brain_atlas/app.js` 中既有的「每区域标量 → 标记着色」通道（`drawRegions()` 已由 `state.linkedRegionCells` 驱动），只新增一个图层分支与值提供者。数据侧三阶段：Stage A 逐文件伪批量（稀疏矩阵乘法，落盘缓存），Stage B 跨文件合并（两种聚合规则），Stage C 导出前端 JSON。

**Tech Stack:** Python 3.10（h5py 3.15 / scipy 1.15 / numpy 2.2，位于 `/home/jialiang/miniconda3/envs/scbrain/bin/python`）、pytest 9.0；前端为零构建 ES5 IIFE + Canvas 2D，测试用 `node:assert/strict` + `node:vm` + jsdom。

**设计依据:** [docs/plans/2026-08-04-gene-atlas-layer-design.md](2026-08-04-gene-atlas-layer-design.md)

---

## 约定（每个任务都适用）

**Python 测试命令前缀**（系统 `python` 无 pytest，必须用 conda 环境）：

```bash
PY=/home/jialiang/miniconda3/envs/scbrain/bin/python
$PY -m pytest <file>::<test> -v
```

**JS 测试约定**：模仿 `test_atlas_bridge.js`——`node:assert/strict`、用 `vm.runInNewContext` 把被测模块载入沙箱、文件末尾 `main()` 依次调用各测试并 `console.log('PASS <name>')`。运行：`node test_x.js`，期望输出以 `PASS` 结尾且退出码 0。

**新增前端模块必须是 ES5 IIFE**（与 `data-model.js` / `atlas-bridge.js` 一致）：

```js
(function (global) {
    'use strict';
    // 只用 var / function，禁用 const/let/箭头函数/class
    global.XXX = api;
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis);
```

**权威元数据**：源文件清单、`matrix_source`、`resolved_fields` 全部来自
`/data/DigitalBrain/data/scBrainCellAtlas/outputs/external_three_sources_audit_2026-08-02/audit_manifest.json`。
不要自己扫目录推断，也不要硬编码字段名。

---

## Task 1: 源文件清单与词表回归基准

建立管线入口：从 audit manifest 读出 99 个可用源文件及其字段名，并把已实测的关键数字固化成回归断言，防止数据换版后静默漂移。

**Files:**
- Create: `scripts/gene_atlas_inventory.py`
- Test: `test_gene_atlas_inventory.py`

**Step 1: 写失败测试**

```python
from __future__ import annotations

import importlib.util
from pathlib import Path


def load_module():
    module_path = Path(__file__).with_name("scripts") / "gene_atlas_inventory.py"
    spec = importlib.util.spec_from_file_location("gene_atlas_inventory", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_inventory_selects_only_files_with_counts():
    module = load_module()
    inv = module.load_inventory()

    # 109 个数据集中 99 个有 counts 矩阵，10 个 no_count_like_matrix_source。
    assert len(inv.usable) == 99
    assert len(inv.skipped) == 10
    assert all(e.matrix_source in ("X", "raw.X") or e.matrix_source.startswith("layer:")
               for e in inv.usable)


def test_inventory_records_resolved_field_names_per_file():
    module = load_module()
    inv = module.load_inventory()

    # 字段名逐文件解析，不可硬编码：细胞类型有两种取值。
    region_fields = {e.region_field for e in inv.usable}
    assert region_fields == {"atlas_ontology_term_Mod-Brodmann"}

    cell_type_fields = {e.cell_type_field for e in inv.usable}
    assert cell_type_fields == {"DigitalNeuron_cell_type", "supercluster_term"}

    counts = {}
    for entry in inv.usable:
        counts[entry.cell_type_field] = counts.get(entry.cell_type_field, 0) + 1
    assert counts["DigitalNeuron_cell_type"] == 97
    assert counts["supercluster_term"] == 2

    assert {e.donor_field for e in inv.usable} == {"donor_id"}


def test_inventory_reports_excluded_cell_budget():
    module = load_module()
    inv = module.load_inventory()

    # Overview 页面 16,352,123 细胞；可用 16,247,724；差额 104,399（0.64%）须可披露。
    assert inv.explorer_cells == 16_352_123
    assert inv.usable_cells == 16_247_724
    assert inv.excluded_cells == 104_399


def test_every_usable_source_file_exists():
    module = load_module()
    inv = module.load_inventory()
    missing = [e.source_path for e in inv.usable if not Path(e.source_path).exists()]
    assert missing == []
```

**Step 2: 运行测试确认失败**

```bash
PY=/home/jialiang/miniconda3/envs/scbrain/bin/python
$PY -m pytest test_gene_atlas_inventory.py -v
```

期望：4 个测试全部 FAIL，报 `FileNotFoundError` 或 `ModuleNotFoundError`（模块尚不存在）。

**Step 3: 实现**

创建 `scripts/gene_atlas_inventory.py`：

```python
"""从上游 audit manifest 读出基因图谱统计所需的源文件清单与字段名。

字段名逐文件解析（manifest 的 resolved_fields），因为细胞类型字段在 99 个文件里
有两种取值；硬编码单一字段会静默漏掉 HBCA 的两个文件。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import json

AUDIT_MANIFEST = Path(
    "/data/DigitalBrain/data/scBrainCellAtlas/outputs"
    "/external_three_sources_audit_2026-08-02/audit_manifest.json"
)

# Overview 页面（digitalneuron_data.js）的口径，用作披露基准。
EXPLORER_CELLS = 16_352_123


@dataclass(frozen=True)
class SourceEntry:
    dataset_id: str
    file_id: str
    source_path: str
    matrix_source: str
    region_field: str
    region_gyral_field: str
    cell_type_field: str
    donor_field: str
    n_cells: int


@dataclass(frozen=True)
class Inventory:
    usable: list[SourceEntry]
    skipped: list[str]
    explorer_cells: int
    usable_cells: int

    @property
    def excluded_cells(self) -> int:
        return self.explorer_cells - self.usable_cells


def load_inventory(manifest_path: Path = AUDIT_MANIFEST) -> Inventory:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))

    usable: list[SourceEntry] = []
    skipped: list[str] = []
    usable_cells = 0

    for record in payload["files"]:
        matrix_source = record.get("matrix_source")
        if not matrix_source:
            # status=skipped, reason=no_count_like_matrix_source：无原始 counts，
            # 无法计算检出率，必须排除。
            skipped.append(record["dataset_id"])
            continue

        fields = record.get("resolved_fields") or {}
        n_cells = int(record.get("n_cells_selected") or 0)
        usable_cells += n_cells
        usable.append(
            SourceEntry(
                dataset_id=record["dataset_id"],
                file_id=record["file_id"],
                source_path=record["source_path"],
                matrix_source=matrix_source,
                region_field=fields["region"],
                region_gyral_field=fields["region_gyral"],
                cell_type_field=fields["cell_type"],
                donor_field=fields["donor"],
                n_cells=n_cells,
            )
        )

    return Inventory(
        usable=usable,
        skipped=skipped,
        explorer_cells=EXPLORER_CELLS,
        usable_cells=usable_cells,
    )
```

**Step 4: 运行测试确认通过**

```bash
$PY -m pytest test_gene_atlas_inventory.py -v
```

期望：4 passed。

若 `test_inventory_reports_excluded_cell_budget` 的 `usable_cells` 不等于 16,247,724，
说明 `n_cells_selected` 字段取错，改用 `n_cells_source` 复核，**不要**直接改断言数字。

**Step 5: 提交**

```bash
git add scripts/gene_atlas_inventory.py test_gene_atlas_inventory.py
git commit -m "feat: source inventory for the gene atlas pipeline"
```

---

## Task 2: 词表一致性断言（脑区 163 / 细胞类型 31）

把设计里最关键的两条「零映射」前提固化成测试。这两条一旦被上游数据改动破坏，
Stage B 会静默产出错区域/错类型，必须有守卫。

**Files:**
- Modify: `scripts/gene_atlas_inventory.py`（新增 `collect_vocabularies`）
- Test: `test_gene_atlas_inventory.py`（追加）

**Step 1: 写失败测试**

追加到 `test_gene_atlas_inventory.py`：

```python
import json


def test_region_vocabulary_is_exactly_163_and_matches_atlas_axis():
    module = load_module()
    inv = module.load_inventory()
    vocab = module.collect_vocabularies(inv)

    # obs/atlas_ontology_term_Mod-Brodmann 在 99/99 文件中存在，
    # 全局取值恰为 163 区——脑区协调已在源文件内完成，无需自建映射。
    assert len(vocab.regions) == 163


def test_cell_type_vocabulary_matches_the_explorer_taxonomy():
    module = load_module()
    inv = module.load_inventory()
    vocab = module.collect_vocabularies(inv)

    # 源 obs 的细胞类型与 digitalneuron_data.js 的 31 类逐字相同，
    # 因此基因图层不需要任何归并映射。
    assert len(vocab.cell_types) == 31
    assert "Amygdala excitatory" in vocab.cell_types
    assert "Oligodendrocyte precursor" in vocab.cell_types
    # 上游二阶段 summary 的 11 类广义标签不属于本站口径，不应出现。
    assert "Glia, other" not in vocab.cell_types
    assert "Microglia/macrophage" not in vocab.cell_types
```

**Step 2: 运行测试确认失败**

```bash
$PY -m pytest test_gene_atlas_inventory.py -k vocabulary -v
```

期望：2 个 FAIL，报 `AttributeError: module has no attribute 'collect_vocabularies'`。

**Step 3: 实现**

在 `scripts/gene_atlas_inventory.py` 追加：

```python
from dataclasses import dataclass as _dataclass

import h5py
import numpy as np


@_dataclass(frozen=True)
class Vocabularies:
    regions: frozenset[str]
    cell_types: frozenset[str]


def read_obs_categories(obs_group: h5py.Group, field: str) -> set[str]:
    """读一个 obs 分类字段的全部取值，兼容 categorical 与纯数组两种编码。"""
    node = obs_group[field]
    if isinstance(node, h5py.Group):
        return set(np.asarray(node["categories"]).astype(str).tolist())
    return set(np.asarray(node).astype(str).tolist())


def collect_vocabularies(inventory: Inventory) -> Vocabularies:
    regions: set[str] = set()
    cell_types: set[str] = set()
    for entry in inventory.usable:
        with h5py.File(entry.source_path, "r") as handle:
            obs = handle["obs"]
            regions |= read_obs_categories(obs, entry.region_field)
            cell_types |= read_obs_categories(obs, entry.cell_type_field)
    return Vocabularies(regions=frozenset(regions), cell_types=frozenset(cell_types))
```

**Step 4: 运行测试确认通过**

```bash
$PY -m pytest test_gene_atlas_inventory.py -v
```

期望：6 passed。该测试会打开全部 99 个文件读 obs 元数据，约 10–30 秒，属正常。

**Step 5: 提交**

```bash
git add scripts/gene_atlas_inventory.py test_gene_atlas_inventory.py
git commit -m "test: pin the 163-region and 31-cell-type vocabularies"
```

---

## Task 3: 归一化与分组聚合核心（纯函数）

这是整条管线的数学核心。用小型构造矩阵做 TDD，把配方钉死后再碰真实数据。

配方（取自上游 `uns/digitalbrain_summary`）：
`counts → CP10K(target_sum=10000) → log1p → 组内按细胞取均值`；
检出率 = 组内非零细胞数 / 组内细胞数。

**Files:**
- Create: `scripts/gene_atlas_aggregate.py`
- Test: `test_gene_atlas_aggregate.py`

**Step 1: 写失败测试**

```python
from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import scipy.sparse as sp


def load_module():
    module_path = Path(__file__).with_name("scripts") / "gene_atlas_aggregate.py"
    spec = importlib.util.spec_from_file_location("gene_atlas_aggregate", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_normalise_applies_cp10k_then_log1p_and_keeps_sparsity():
    module = load_module()
    # 单细胞、两基因：counts=[1, 3]，总数 4 -> CP10K = [2500, 7500]
    counts = sp.csr_matrix(np.array([[1.0, 3.0]]))
    out = module.normalise_cp10k_log1p(counts)

    expected = np.log1p(np.array([2500.0, 7500.0]))
    np.testing.assert_allclose(out.toarray()[0], expected, rtol=1e-6)
    # log1p(0)=0，稀疏结构不得被破坏（否则大文件会爆内存）。
    assert out.nnz == counts.nnz


def test_normalise_handles_all_zero_cell_without_dividing_by_zero():
    module = load_module()
    counts = sp.csr_matrix(np.array([[0.0, 0.0], [2.0, 2.0]]))
    out = module.normalise_cp10k_log1p(counts)
    np.testing.assert_allclose(out.toarray()[0], [0.0, 0.0])


def test_aggregate_groups_returns_mean_and_detection_per_group():
    module = load_module()
    # 3 个细胞、2 个基因；细胞 0 与 1 同组，细胞 2 独立成组。
    counts = sp.csr_matrix(np.array([
        [1.0, 0.0],
        [3.0, 0.0],
        [0.0, 5.0],
    ]))
    group_index = np.array([0, 0, 1])

    result = module.aggregate_groups(counts, group_index, n_groups=2)

    assert result.n_cells.tolist() == [2, 1]

    normalised = module.normalise_cp10k_log1p(counts).toarray()
    np.testing.assert_allclose(result.mean[0], normalised[:2].mean(axis=0), rtol=1e-6)
    np.testing.assert_allclose(result.mean[1], normalised[2], rtol=1e-6)

    # 基因 0：组 0 两个细胞都检出 -> 1.0；组 1 未检出 -> 0.0
    # 基因 1：组 0 无检出 -> 0.0；组 1 检出 -> 1.0
    np.testing.assert_allclose(result.detection[0], [1.0, 0.0])
    np.testing.assert_allclose(result.detection[1], [0.0, 1.0])


def test_aggregate_detection_uses_raw_counts_not_normalised_values():
    module = load_module()
    # 检出率必须由原始 counts 的非零结构决定；归一化不改变非零位置，
    # 但若实现误用阈值比较就会在此暴露。
    counts = sp.csr_matrix(np.array([[1.0, 0.0], [0.0, 0.0]]))
    result = module.aggregate_groups(counts, np.array([0, 0]), n_groups=1)
    np.testing.assert_allclose(result.detection[0], [0.5, 0.0])
```

**Step 2: 运行测试确认失败**

```bash
$PY -m pytest test_gene_atlas_aggregate.py -v
```

期望：4 个 FAIL，模块不存在。

**Step 3: 实现**

创建 `scripts/gene_atlas_aggregate.py`：

```python
"""基因表达的归一化与分组聚合核心。

分组聚合走稀疏矩阵乘法（指示矩阵 @ 数据矩阵），把 O(nnz) 的散射累加交给 C 层。
禁止逐细胞 Python 循环——全量 563 亿个非零值下不可行。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp

TARGET_SUM = 10_000.0


@dataclass(frozen=True)
class GroupAggregate:
    mean: np.ndarray       # (n_groups, n_genes) 组内 log1p(CP10K) 均值
    detection: np.ndarray  # (n_groups, n_genes) 组内非零细胞比例
    n_cells: np.ndarray    # (n_groups,) 组内细胞数


def normalise_cp10k_log1p(counts: sp.csr_matrix) -> sp.csr_matrix:
    """按细胞归一化到 TARGET_SUM 后取 log1p。

    log1p(0) == 0，所以只需变换非零值，稀疏结构原样保留。
    """
    matrix = counts.tocsr(copy=True).astype(np.float64)
    totals = np.asarray(matrix.sum(axis=1)).ravel()
    totals[totals == 0] = 1.0  # 全零细胞：避免除零，结果仍为全零行
    scale = TARGET_SUM / totals
    matrix = matrix.multiply(scale[:, None]).tocsr()
    matrix.data = np.log1p(matrix.data)
    return matrix


def _indicator(group_index: np.ndarray, n_groups: int) -> sp.csr_matrix:
    n_cells = group_index.shape[0]
    return sp.csr_matrix(
        (np.ones(n_cells, dtype=np.float64), (group_index, np.arange(n_cells))),
        shape=(n_groups, n_cells),
    )


def aggregate_groups(
    counts: sp.csr_matrix, group_index: np.ndarray, n_groups: int
) -> GroupAggregate:
    indicator = _indicator(group_index, n_groups)
    n_cells = np.asarray(indicator.sum(axis=1)).ravel()
    safe_counts = np.where(n_cells == 0, 1.0, n_cells)

    normalised = normalise_cp10k_log1p(counts)
    mean = np.asarray((indicator @ normalised).todense()) / safe_counts[:, None]

    structure = counts.tocsr(copy=True)
    structure.data = np.ones_like(structure.data, dtype=np.float64)
    detection = np.asarray((indicator @ structure).todense()) / safe_counts[:, None]

    return GroupAggregate(
        mean=mean, detection=detection, n_cells=n_cells.astype(np.int64)
    )
```

**Step 4: 运行测试确认通过**

```bash
$PY -m pytest test_gene_atlas_aggregate.py -v
```

期望：4 passed。

**Step 5: 提交**

```bash
git add scripts/gene_atlas_aggregate.py test_gene_atlas_aggregate.py
git commit -m "feat: cp10k+log1p normalisation and sparse group aggregation"
```

---

## Task 4: 分块流式聚合（等价性守卫）

最大源文件有 79.7 亿个非零值（约 96 GB），无法整载入内存，必须按 `indptr` 分块。
**切片错位不会报错，只会给出错误数字**——所以必须有「分块结果 == 整载结果」的测试。

**Files:**
- Modify: `scripts/gene_atlas_aggregate.py`（新增 `aggregate_groups_blocked`）
- Test: `test_gene_atlas_aggregate.py`（追加）

**Step 1: 写失败测试**

```python
def test_blocked_aggregation_equals_whole_matrix_aggregation():
    module = load_module()
    rng = np.random.default_rng(20260804)
    dense = rng.poisson(0.4, size=(97, 23)).astype(np.float64)
    counts = sp.csr_matrix(dense)
    group_index = rng.integers(0, 5, size=97)

    whole = module.aggregate_groups(counts, group_index, n_groups=5)
    # 故意选不能整除 97 的块大小，暴露 indptr 边界错误。
    blocked = module.aggregate_groups_blocked(
        counts, group_index, n_groups=5, block_size=10
    )

    np.testing.assert_allclose(blocked.mean, whole.mean, rtol=1e-9, atol=1e-12)
    np.testing.assert_allclose(blocked.detection, whole.detection, rtol=1e-9, atol=1e-12)
    assert blocked.n_cells.tolist() == whole.n_cells.tolist()


def test_blocked_aggregation_handles_block_larger_than_matrix():
    module = load_module()
    counts = sp.csr_matrix(np.array([[1.0, 2.0], [0.0, 4.0]]))
    group_index = np.array([0, 0])
    whole = module.aggregate_groups(counts, group_index, n_groups=1)
    blocked = module.aggregate_groups_blocked(
        counts, group_index, n_groups=1, block_size=10_000
    )
    np.testing.assert_allclose(blocked.mean, whole.mean, rtol=1e-9)
```

**Step 2: 运行测试确认失败**

```bash
$PY -m pytest test_gene_atlas_aggregate.py -k blocked -v
```

期望：2 个 FAIL，`AttributeError: aggregate_groups_blocked`。

**Step 3: 实现**

在 `scripts/gene_atlas_aggregate.py` 追加：

```python
def aggregate_groups_blocked(
    counts: sp.csr_matrix,
    group_index: np.ndarray,
    n_groups: int,
    block_size: int = 50_000,
) -> GroupAggregate:
    """按细胞行分块累加，供无法整载入内存的大文件使用。

    归一化是按行独立的，检出与求和都是可加的，因此分块与整载严格等价。
    """
    n_cells_total, n_genes = counts.shape
    mean_sum = np.zeros((n_groups, n_genes), dtype=np.float64)
    detect_sum = np.zeros((n_groups, n_genes), dtype=np.float64)
    n_cells = np.zeros(n_groups, dtype=np.int64)

    for start in range(0, n_cells_total, block_size):
        stop = min(start + block_size, n_cells_total)
        block = counts[start:stop]
        block_groups = group_index[start:stop]
        indicator = _indicator(block_groups, n_groups)

        normalised = normalise_cp10k_log1p(block)
        mean_sum += np.asarray((indicator @ normalised).todense())

        structure = block.tocsr(copy=True)
        structure.data = np.ones_like(structure.data, dtype=np.float64)
        detect_sum += np.asarray((indicator @ structure).todense())

        n_cells += np.asarray(indicator.sum(axis=1)).ravel().astype(np.int64)

    safe = np.where(n_cells == 0, 1, n_cells).astype(np.float64)
    return GroupAggregate(
        mean=mean_sum / safe[:, None],
        detection=detect_sum / safe[:, None],
        n_cells=n_cells,
    )
```

**Step 4: 运行测试确认通过**

```bash
$PY -m pytest test_gene_atlas_aggregate.py -v
```

期望：6 passed。

**Step 5: 提交**

```bash
git add scripts/gene_atlas_aggregate.py test_gene_atlas_aggregate.py
git commit -m "feat: blocked streaming aggregation for oversized source files"
```

---

## Task 5: 单文件 Stage A（含与上游的逐值回归基准）

把前面的核心接到真实源文件上，并用一个小文件与上游 first_stage 逐值比对。
**这是整条管线唯一的外部正确性证据，必须保留为回归测试。**

**Files:**
- Create: `scripts/gene_atlas_stage_a.py`
- Test: `test_gene_atlas_stage_a.py`

**Step 1: 写失败测试**

```python
from __future__ import annotations

import importlib.util
from pathlib import Path

import h5py
import numpy as np

FIRST_STAGE = Path(
    "/data/DigitalBrain/data/scBrainCellAtlas/outputs"
    "/external_three_sources_first_stage_2026-08-02"
)
SMOKE_FILE_ID = "ec_stream_region_at_14_days_of_age_filtered_e4fde89832"
SMOKE_COLLECTION = (
    "collection_001__1_3protracted_neuronal_recruitment_in_the_temporal_lobe_of_young_children"
)


def load_module():
    module_path = Path(__file__).with_name("scripts") / "gene_atlas_stage_a.py"
    spec = importlib.util.spec_from_file_location("gene_atlas_stage_a", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_categories(node) -> np.ndarray:
    if isinstance(node, h5py.Group):
        return np.asarray(node["categories"]).astype(str)[np.asarray(node["codes"])]
    return np.asarray(node).astype(str)


def test_stage_a_matches_upstream_first_stage_value_by_value():
    """回归基准：自建管线与上游 first_stage 在 float32 精度内一致。

    该文件为 7,588 细胞 x 21,563 基因，1 区 / 1 donor / 17 细胞类型。
    """
    module = load_module()
    import gene_atlas_inventory_shim as _  # noqa: F401  (占位，见 Step 3 说明)

    result = module.summarise_source_file_by_id(SMOKE_FILE_ID)

    upstream_path = FIRST_STAGE / SMOKE_COLLECTION / f"{SMOKE_FILE_ID}.summary.h5ad"
    with h5py.File(upstream_path, "r") as handle:
        up_cell_type = read_categories(handle["obs"]["cell_type"])
        up_gene_id = read_categories(handle["var"]["gene_id"])
        up_mean = np.asarray(handle["X"])
        up_detection = np.asarray(handle["layers"]["detection_fraction"])
        up_n_cells = np.asarray(handle["obs"]["n_cells"])

    assert result.gene_ids.tolist() == up_gene_id.tolist()

    upstream_row = {name: i for i, name in enumerate(up_cell_type)}
    worst_mean = 0.0
    worst_detection = 0.0
    matched = 0
    for i, key in enumerate(result.group_keys):
        row = upstream_row.get(key.cell_type)
        assert row is not None, f"upstream lacks cell type {key.cell_type}"
        matched += 1
        worst_mean = max(worst_mean, float(np.abs(result.mean[i] - up_mean[row]).max()))
        worst_detection = max(
            worst_detection, float(np.abs(result.detection[i] - up_detection[row]).max())
        )

    assert matched == 17
    assert worst_mean < 1e-5, f"mean drift {worst_mean:.3e}"
    assert worst_detection < 1e-6, f"detection drift {worst_detection:.3e}"
    assert int(result.n_cells.sum()) == int(up_n_cells.sum()) == 7_588
```

**Step 2: 运行测试确认失败**

```bash
$PY -m pytest test_gene_atlas_stage_a.py -v
```

期望：FAIL（模块不存在）。

> 注意：上面测试里 `import gene_atlas_inventory_shim` 一行是**故意留下的占位错误**，
> 实现时删掉它。它的作用是提醒你：Stage A 必须通过 Task 1 的 inventory 取字段名，
> 而不是自己硬编码 `DigitalNeuron_cell_type`。

**Step 3: 实现**

创建 `scripts/gene_atlas_stage_a.py`。要点：

- 用 `gene_atlas_inventory.load_inventory()` 按 `file_id` 找到条目，取 `matrix_source` 与四个字段名
- `matrix_source` 三种取值分别对应 `h["X"]` / `h["raw"]["X"]` / `h["layers"][name]`
- **基因标识取矩阵所属的 var**：`raw.X` 用 `h["raw"]["var"]`，其余用 `h["var"]`；
  标识符列为该 group 的 `_index`（`attrs["_index"]`）
- 分组键为 `(donor, region, region_gyral, cell_type)` 四元组，排序后固定顺序
- nnz 超过阈值（建议 5e8）时走 `aggregate_groups_blocked`，否则整载
- 返回 dataclass：`gene_ids`、`group_keys`、`mean`、`detection`、`n_cells`
- 提供 `write_cache(result, out_dir)` 落盘为 `.npz`（`mean`/`detection`/`n_cells`/`gene_ids`
  与分组键的四个字符串数组），**每个文件只存自身基因集**，不在此阶段统一基因空间

**Step 4: 运行测试确认通过**

```bash
$PY -m pytest test_gene_atlas_stage_a.py -v
```

期望：1 passed。若 `worst_mean` 在 1e-3 量级，先查 `matrix_source` 是否取错
（`X` 常已被归一化，必须用 counts 那一份）。

**Step 5: 提交**

```bash
git add scripts/gene_atlas_stage_a.py test_gene_atlas_stage_a.py
git commit -m "feat: per-file stage A summariser with upstream parity regression"
```

---

## Task 6: Stage A 批量执行（CLI，可续跑）

**Files:**
- Create: `scripts/run_gene_atlas_stage_a.py`
- Test: `test_run_gene_atlas_stage_a.py`

**预算（已实测，用于判断跑飞了没有）**：99 个文件、563 亿非零值、需读 553 GiB，
实测吞吐 224 MiB/s，单进程约 **1.6 小时**；`--workers 4` 约 25 分钟。
若单文件耗时远超 `nnz / 1e7` 秒，停下来查是否误走了整载路径。

**Step 1: 写失败测试**

```python
def test_cli_skips_files_whose_cache_already_exists(tmp_path):
    module = load_module()
    entry = module.load_inventory().usable[0]
    cache = tmp_path / f"{entry.file_id}.npz"
    cache.write_bytes(b"placeholder")
    todo = module.pending_entries(module.load_inventory(), tmp_path)
    assert entry.file_id not in {e.file_id for e in todo}


def test_cli_reports_every_usable_file_as_pending_on_empty_cache(tmp_path):
    module = load_module()
    inv = module.load_inventory()
    assert len(module.pending_entries(inv, tmp_path)) == 99
```

**Step 2: 确认失败** → `$PY -m pytest test_run_gene_atlas_stage_a.py -v`

**Step 3: 实现** `scripts/run_gene_atlas_stage_a.py`：

- `pending_entries(inventory, cache_dir)`：过滤掉已有 `.npz` 的条目（支持中断续跑）
- `main()`：`argparse` 提供 `--cache-dir`（默认 `gene_atlas_cache/stage_a`）、
  `--workers`（默认 1）、`--limit`（冒烟用）
- 用 `concurrent.futures.ProcessPoolExecutor` 按**文件**并行；不要在文件内部并行
- 每个文件打印 `[a/b] file_id nnz=... groups=... genes=... elapsed=...s`
- 单文件失败只记录并继续，末尾汇总失败清单并以非零码退出——**不允许一个坏文件
  拖垮整批 1.6 小时的运行**

**Step 4: 冒烟验证**

```bash
$PY scripts/run_gene_atlas_stage_a.py --limit 3 --cache-dir /tmp/stage_a_smoke
```

期望：3 个 `.npz` 落盘，日志显示 3 行进度。

**Step 5: 提交**

```bash
git add scripts/run_gene_atlas_stage_a.py test_run_gene_atlas_stage_a.py
git commit -m "feat: resumable stage A batch runner"
```

**Step 6: 全量执行（长任务，后台跑）**

```bash
mkdir -p logs
nohup $PY scripts/run_gene_atlas_stage_a.py --workers 4 \
  --cache-dir gene_atlas_cache/stage_a > logs/stage_a.log 2>&1 &
```

完成后核对：`ls gene_atlas_cache/stage_a/*.npz | wc -l` 应为 **99**。
把 `gene_atlas_cache/` 加入 `.gitignore`（是可重建的本地缓存，不入库）。

---

## Task 7: 基因标识符解析器

实测：99 个源文件中 **44 个**主键为 Ensembl（另有 `feature_name` 提供符号），
**55 个**主键即符号（其中 54 个无独立符号字段）。所以必须双向解析。
HGNC 桥接表已在仓库：`data/vendor/hgnc_complete_set.txt`（17 MB）。

**Files:**
- Create: `scripts/gene_identifier_index.py`
- Test: `test_gene_identifier_index.py`

**Step 1: 写失败测试**

```python
def test_parses_plain_symbol_versioned_ensembl_and_compound_forms():
    module = load_module()
    assert module.parse_identifier("GFAP") == ("GFAP", None)
    assert module.parse_identifier("ENSG00000131095") == (None, "ENSG00000131095")
    assert module.parse_identifier("ENSG00000131095.12") == (None, "ENSG00000131095")
    # SEA-AD 用的复合形式
    assert module.parse_identifier("TSPAN6_ENSG00000000003") == ("TSPAN6", "ENSG00000000003")


def test_hgnc_index_bridges_symbol_and_ensembl_both_ways():
    module = load_module()
    index = module.load_hgnc_index()
    assert index.ensembl_for_symbol("GFAP") == "ENSG00000131095"
    assert index.symbol_for_ensembl("ENSG00000131095") == "GFAP"


def test_hgnc_index_resolves_a_retired_alias_to_the_current_symbol():
    module = load_module()
    index = module.load_hgnc_index()
    # HGNC 的 alias/prev symbol 列必须被纳入，否则老数据集的旧符号会丢失。
    assert index.canonical_symbol("HGNC:4235") == "GFAP"
```

**Step 2: 确认失败** → `$PY -m pytest test_gene_identifier_index.py -v`

**Step 3: 实现**

- `parse_identifier(value)`：按 `SYMBOL_ENSG…` → `ENSG…[.ver]` → 裸符号 三级正则匹配
- `load_hgnc_index()`：解析 `data/vendor/hgnc_complete_set.txt`（TSV），
  取 `hgnc_id` / `symbol` / `ensembl_gene_id` / `alias_symbol` / `prev_symbol`，
  建立 symbol→ensembl、ensembl→symbol、alias→canonical 三张表
- **主键统一为 Ensembl ID**；无法解析出 Ensembl 的特征以 `SYMBOL:<name>` 作为兜底主键，
  并计入审计（不静默丢弃）

**Step 4: 确认通过**，若 `canonical_symbol` 断言失败，先 `head -1 data/vendor/hgnc_complete_set.txt`
核对列名再调整解析，**不要**放宽断言。

**Step 5: 提交**

```bash
git add scripts/gene_identifier_index.py test_gene_identifier_index.py
git commit -m "feat: bidirectional gene identifier index backed by HGNC"
```

---

## Task 8: Stage B 跨文件合并（两种聚合规则）

**Files:**
- Create: `scripts/gene_atlas_stage_b.py`
- Test: `test_gene_atlas_stage_b.py`

两种规则都要算（用户已确认），且**两者均可由 Stage A 的 donor 级缓存直接推导，无需重扫**：

| 规则 | 定义 |
| --- | --- |
| `cell_weighted` | `Σ(组均值 × 组细胞数) / Σ组细胞数` |
| `donor_balanced` | donor 内平均 → 数据集内平均 → 跨数据集等权平均 |

**Step 1: 写失败测试**（用构造缓存，有解析解）

```python
def test_cell_weighted_rule_matches_the_closed_form():
    module = load_module()
    # 两个 donor 同区同类型：均值 1.0（10 细胞）与 4.0（30 细胞）
    # 细胞加权 = (1*10 + 4*30) / 40 = 3.25
    caches = [
        module.FakeCache(dataset="d1", donor="A", region="EC", cell_type="Astrocyte",
                         gene="ENSG1", mean=1.0, detection=0.2, n_cells=10),
        module.FakeCache(dataset="d1", donor="B", region="EC", cell_type="Astrocyte",
                         gene="ENSG1", mean=4.0, detection=0.6, n_cells=30),
    ]
    out = module.merge(caches, rule="cell_weighted")
    assert out.mean[("EC", "Astrocyte", "ENSG1")] == 3.25
    assert out.detection[("EC", "Astrocyte", "ENSG1")] == 0.5  # (0.2*10+0.6*30)/40


def test_donor_balanced_rule_ignores_donor_size():
    module = load_module()
    caches = [ ... same as above ... ]
    out = module.merge(caches, rule="donor_balanced")
    # donor 等权：(1.0 + 4.0) / 2 = 2.5，与 10 vs 30 的细胞数无关
    assert out.mean[("EC", "Astrocyte", "ENSG1")] == 2.5


def test_donor_balanced_gives_equal_weight_to_each_dataset():
    module = load_module()
    # d1 有 3 个 donor、d2 只有 1 个：数据集等权，d2 不应被 d1 淹没
    ...


def test_missing_group_is_absent_not_zero():
    module = load_module()
    out = module.merge([...], rule="cell_weighted")
    # 某区某类型无任何 donor 覆盖时，键不得存在（缺失 != 零表达）
    assert ("Pn", "Astrocyte", "ENSG1") not in out.mean
```

**Step 2: 确认失败** → **Step 3: 实现**：

- 读 `gene_atlas_cache/stage_a/*.npz`，用 Task 7 的索引把各文件基因集映射到统一 Ensembl 主键
- 分组键统一为 `(region, cell_type, gene)`，同时保留 `region` 级汇总
- 两种规则各输出一份
- 记录每个 `(region, cell_type, gene)` 的支撑度：`n_datasets` / `n_donors` / `n_cells`，
  供界面标注可信度；`n_datasets == 0` 的键**不写入**

**Step 4: 确认通过** → **Step 5: 提交**

```bash
git add scripts/gene_atlas_stage_b.py test_gene_atlas_stage_b.py
git commit -m "feat: stage B cross-dataset merge with two aggregation rules"
```

---

## Task 9: Stage C 导出前端 JSON（按基因分文件）

**Files:**
- Create: `scripts/export_gene_atlas_web.py`, `data/gene_atlas_gene_list.txt`
- Test: `test_export_gene_atlas_web.py`

**体积基准（实测，基于 31 类词表）**：

| 项 | 实测 |
| --- | --- |
| `(region, cell_type)` 真实组合数 | **3,478**（163 × 31 = 5,053 种可能，**31% 为空**） |
| 单基因全粒度 JSON | **44.6 KB**（双聚合规则约 89 KB） |
| 100 基因 × 双规则一次性加载 | 8.7 MB —— **不可作为首屏** |

因此**按基因分文件懒加载**，不做单一大文件：

```
gene_atlas_web/
├── index.json          基因名→文件名索引 + scope 披露（几 KB，首屏加载）
└── genes/GFAP.json     单基因全粒度，双聚合规则并存，约 89 KB
```

单基因文件**必须同时携带 region 级与 region×cellType 级**，否则细胞类型过滤器
无法在前端即时重算 3D 着色。

**Step 1: 写失败测试**

```python
def test_export_writes_one_file_per_gene_plus_an_index(tmp_path):
    module = load_module()
    module.export(genes=["GFAP", "SNAP25"], out_dir=tmp_path)
    assert (tmp_path / "index.json").exists()
    assert (tmp_path / "genes" / "GFAP.json").exists()
    assert (tmp_path / "genes" / "SNAP25.json").exists()


def test_index_declares_scope_and_exclusions(tmp_path):
    module = load_module()
    module.export(genes=["GFAP"], out_dir=tmp_path)
    index = json.loads((tmp_path / "index.json").read_text())
    # 界面必须能如实披露口径与排除项。
    assert index["scope"]["datasets"] == 99
    assert index["scope"]["cells"] == 16_247_724
    assert index["scope"]["excludedDatasets"] == 10
    assert index["scope"]["excludedCells"] == 104_399
    assert index["metrics"] == ["mean", "detection"]
    assert index["rules"] == ["cell_weighted", "donor_balanced"]
    assert len(index["cellTypes"]) == 31


def test_gene_file_carries_both_region_and_cell_type_granularity(tmp_path):
    module = load_module()
    module.export(genes=["GFAP"], out_dir=tmp_path)
    payload = json.loads((tmp_path / "genes" / "GFAP.json").read_text())

    for rule in ("cell_weighted", "donor_balanced"):
        # region 级：驱动 3D 着色
        assert "EC" in payload[rule]["regions"]["mean"]
        assert "EC" in payload[rule]["regions"]["detection"]
        # region x cellType 级：驱动区域详情面板与细胞类型过滤器重算
        ec = payload[rule]["cellTypes"]["EC"]
        assert "mean" in ec["Astrocyte"] and "detection" in ec["Astrocyte"]
        # 细胞数必须随行下发，否则前端无法做 cell_weighted 子集重算
        assert ec["Astrocyte"]["cells"] > 0


def test_absent_region_cell_type_combos_are_omitted_not_zero(tmp_path):
    module = load_module()
    module.export(genes=["GFAP"], out_dir=tmp_path)
    payload = json.loads((tmp_path / "genes" / "GFAP.json").read_text())
    ec = payload["cell_weighted"]["cellTypes"]["EC"]
    # 163 x 31 中约 31% 组合无数据；缺失必须缺键，不得写 0。
    assert len(ec) <= 31
    assert all(v["cells"] > 0 for v in ec.values())
```

**Step 2–4:** 实现 `export()`：读 Stage B 产物，按 `data/gene_atlas_gene_list.txt`
（首批 50–200 个标记基因，一行一个符号）筛选。

`index.json`：

```json
{
  "scope": { "datasets": 99, "cells": 16247724,
             "excludedDatasets": 10, "excludedCells": 104399 },
  "metrics": ["mean", "detection"],
  "rules": ["cell_weighted", "donor_balanced"],
  "cellTypes": ["Amygdala excitatory", "..."],
  "genes": { "GFAP": "genes/GFAP.json" }
}
```

单基因文件 `genes/GFAP.json`：

```json
{
  "symbol": "GFAP",
  "ensembl": "ENSG00000131095",
  "cell_weighted": {
    "regions":   { "mean": { "EC": 0.637 }, "detection": { "EC": 0.297 } },
    "cellTypes": { "EC": { "Astrocyte": { "mean": 1.9, "detection": 0.81, "cells": 41203 } } },
    "support":   { "EC": { "datasets": 12, "donors": 43, "cells": 295306 } }
  },
  "donor_balanced": { "...": "同结构" }
}
```

`cellTypes` 下每项必须带 `cells`，因为前端做 `cell_weighted` 的细胞类型子集重算时需要权重。
无数据的 `(region, cellType)` 组合**缺键**，不得写 0。

**Step 5: 提交**

```bash
git add scripts/export_gene_atlas_web.py data/gene_atlas_gene_list.txt test_export_gene_atlas_web.py
git commit -m "feat: export the browser-facing gene atlas payload"
```

---

## Task 10: 前端基因数据模块

**Files:**
- Create: `gene-atlas-data.js`（ES5 IIFE）
- Test: `test_gene_atlas_data.js`

职责：按需拉取单基因文件、按符号检索（大小写不敏感）、切换聚合规则与指标、
根据细胞类型子集重算 region 级值、产出 `{脑区缩写: 数值}` 表供 atlas 着色。**不碰 DOM**。

**Step 1: 写失败测试**（模仿 `test_atlas_bridge.js` 的 vm 沙箱写法；用内联小 fixture，勿读真实 JSON）

```js
// fixture：EC 区有 Astrocyte(细胞 30) 与 Microglia(细胞 10)；SWM 区只有 Astrocyte
// Pn 区完全无数据（验证缺失 != 零）

function testRegionValuesForActiveGene() {
  const { api } = loadModule('gene-atlas-data.js');
  api.ingestGene(FIXTURE_GFAP);
  api.setRule('cell_weighted');
  api.setMetric('mean');
  assert.deepEqual(api.regionValues('GFAP'), { EC: 0.637, SWM: 1.266 });
}

function testDetectionMetricSwitch() { /* setMetric('detection') 后取值改变 */ }

function testRuleSwitchChangesRegionValues() { /* setRule('donor_balanced') 后取值改变 */ }

function testSearchIsCaseInsensitiveAndReportsMisses() {
  assert.deepEqual(api.search('gfap'), ['GFAP']);
  assert.deepEqual(api.search('NOT_A_GENE'), []);
}

function testMissingRegionIsAbsentNotZero() {
  const values = api.regionValues('GFAP');
  assert.equal('Pn' in values, false, 'missing region must be absent, not 0');
}

// ── 细胞类型粒度：本任务新增的核心契约 ──

function testCellTypeDetailForARegion() {
  // 区域详情面板的数据源：该区每个细胞类型的两个指标与细胞数
  const rows = api.cellTypeDetail('GFAP', 'EC');
  assert.deepEqual(rows.map((r) => r.cellType), ['Astrocyte', 'Microglia']);
  assert.equal(rows[0].mean, 1.9);
  assert.equal(rows[0].detection, 0.81);
  assert.equal(rows[0].cells, 30);
}

function testCellTypeDetailOmitsTypesWithoutDataInThatRegion() {
  // 163 x 31 中约 31% 组合无数据；SWM 只有 Astrocyte。
  const rows = api.cellTypeDetail('GFAP', 'SWM');
  assert.deepEqual(rows.map((r) => r.cellType), ['Astrocyte']);
}

function testCellWeightedSubsetRecomputesByCellCount() {
  api.setRule('cell_weighted');
  api.setMetric('mean');
  // 只选 Astrocyte + Microglia：(1.9*30 + 0.4*10) / 40 = 1.525
  const values = api.regionValues('GFAP', { cellTypes: ['Astrocyte', 'Microglia'] });
  assert.equal(Number(values.EC.toFixed(6)), 1.525);
}

function testDonorBalancedSubsetRecomputesByEqualWeight() {
  api.setRule('donor_balanced');
  // 等权：(1.9 + 0.4) / 2 = 1.15，与 30 vs 10 的细胞数无关
  const values = api.regionValues('GFAP', { cellTypes: ['Astrocyte', 'Microglia'] });
  assert.equal(Number(values.EC.toFixed(6)), 1.15);
}

function testSubsetWithNoDataInARegionDropsThatRegion() {
  // SWM 无 Microglia；只选 Microglia 时 SWM 必须缺失，不得为 0
  const values = api.regionValues('GFAP', { cellTypes: ['Microglia'] });
  assert.equal('SWM' in values, false);
}

function testGeneFilesAreFetchedOnceAndCached() {
  // 第二次请求同一基因不得再次 fetch
}
```

**Step 2:** `node test_gene_atlas_data.js` → 失败
**Step 3:** 实现（`var`/`function`，挂 `global.GeneAtlasData`，同时 `module.exports`）。
关键契约：`regionValues(gene, options)` 的 `options.cellTypes` 缺省为全部类型，
传入子集时按当前规则重算（`cell_weighted` 用 `cells` 加权、`donor_balanced` 等权），
且**只对该区真实有数据的类型参与运算**。
**Step 4:** 再跑 → 全部 `PASS`
**Step 5:** 提交 `feat: gene atlas data module with cell-type granularity`

---

## Task 11: atlas 新增 genes 图层（渲染接线）

**Files:**
- Modify: `interactive_brain_atlas/app.js`
  - `:97` `state.dataLayer` 初值附近加 `geneValues` 状态
  - `:1590` 渲染分支
  - `:1745` `selectDataLayer` 白名单
  - `:646-657` `getVisibleRegions`
  - `:659-667` `getRange`
  - `:1284-1292` `drawRegions` 取值分支
- Modify: `digitalneuron_main.html:257-261`（`#dataLayerTabs` 加第 4 个按钮）
- Test: `test_gene_atlas_layer.js`

**Step 1: 写失败测试**

```js
function testGeneLayerIsAcceptedByTheLayerWhitelist() {
  // 载入 atlas 后切到 genes，断言 state 生效且 render 不抛
}
function testGeneValuesDriveRegionColouring() {
  // 注入 geneValues 后，可见区域集合等于有值且过阈值的区域
}
function testRangeUsesGeneValuesInGeneLayer() {
  // getRange 在 genes 图层返回基因值的 min/max，而非 composition
}
function testAllMissingGeneValuesDoesNotThrow() {
  // 全缺失时不得除零或崩溃
}
```

**Step 2:** `node test_gene_atlas_layer.js` → 失败

**Step 3: 实现**

渲染主循环（`app.js:1590`）：

```js
if (state.dataLayer === "cells" || state.dataLayer === "genes") drawRegions();
else drawConnectivity();
```

白名单（`app.js:1745`）：

```js
if (!["cells", "functional", "structural", "genes"].includes(layer)) return;
```

`drawRegions()` 取值：把现有两条分支收敲成一个 `regionValue(region)`，
新增 `state.dataLayer === "genes"` → `state.geneValues[region.acronym]`。
**无值时返回 `null`**，调用方据此走中性灰、且不参与 `getRange()`。

**Step 4:** 再跑；同时回归既有测试，确认 cells/FC/SC 三个图层未被破坏：

```bash
node test_atlas_bridge.js && node test_ui_rendering.js && node test_smoke.js
```

**Step 5:** 提交 `feat: add the gene expression layer to the 3d atlas`

---

## Task 12: 范围隔离（旁路 linkedActiveRegions）

设计里点明的真实陷阱：`getVisibleRegions()`（`app.js:648-652`）会用
`state.linkedActiveRegions` 裁剪可见区域。基因数据是跨研究合并、数据集轴已压掉，
**若不旁路，Explorer 当前选中范围会静默裁掉本该显示的区域**，表现为「基因在这些区不表达」。

**Files:**
- Modify: `interactive_brain_atlas/app.js:646-657`
- Modify: `app.js`（切到 genes 图层时禁用三个筛选器并显示范围说明）
- Test: `test_gene_atlas_layer.js`（追加）

**Step 1: 写失败测试**

```js
function testGeneLayerBypassesTheExplorerScopeFilter() {
  // 先用 AtlasBridge 施加一个只含 EC 的范围，再切到 genes 图层，
  // 断言 SWM 等其他有基因数据的区域仍然可见。
}
function testScopeFiltersAreDisabledInGeneLayer() {
  // collectionSelect / datasetSelect / donorSelect 三者 disabled === true
  // 且范围说明可见
}
function testLeavingGeneLayerRestoresTheScopeFilters() {
  // 切回 cells 后筛选器恢复可用，联动范围重新生效
}
```

**Step 2–4:** 实现并确认通过。`getVisibleRegions()` 改为：

```js
var anatomicallyMapped = state.regions.filter(function (r) { return r.hasAnatomy; });
// 基因图层是全局范围，Explorer 的选中范围在此不适用。
if (state.linkedActiveRegions && state.dataLayer !== "genes") { ... }
```

**Step 5:** 提交 `fix: isolate the gene layer from the explorer scope filter`

---

## Task 13: 基因搜索行与指标切换 UI

**Files:**
- Modify: `digitalneuron_main.html`（`#atlasSection` 内、画布上方插入一行，仅 genes 图层显示）
- Modify: `styles.css`
- Create: `gene-atlas-view.js`（接线层，ES5 IIFE）
- Test: `test_gene_atlas_view.js`

要点：

- 搜索框 + 已选基因 chips（多基因，各自配色）；点 chip 设为「活动基因」
- 右侧全局指标切换 `Mean expression | Detection rate`
- 聚合规则切换（`Cell-weighted | Donor-balanced`），差异显著时给提示
- 细胞类型过滤器用 **Explorer 的 31 类**（不是 11 类广义分类，也不是 atlas 的 7 类示意数据）；
  勾选变化后**必须触发 3D 重着色**（调 `regionValues(gene, { cellTypes })`），
  而不是仅影响详情面板
- 阈值滑块复用抽屉里现有的 `#abundanceFilter`，仅换标签文案

**测试**：搜索命中/未命中空态、chip 增删与活动基因切换、指标切换后 3D 取值随之变化、
移除活动基因后活动索引的边界处理。

**Step 5:** 提交 `feat: gene search row and metric switch`

---

## Task 14: 色标、图例与区域详情

**Files:**
- Modify: `gene-atlas-view.js`、`interactive_brain_atlas/app.js`（图例文案）、`styles.css`
- Test: `test_gene_atlas_view.js`（追加）

**色标规则（不可共用同一策略）**：

| 指标 | 区间 |
| --- | --- |
| Mean expression | 当前基因在可见区的 min–max，**动态** |
| Detection rate | **固定 0–100%** |

Detection 有天然上界，固定区间才能跨基因比较；Mean 无上界，需动态拉伸。

**区域详情面板**：点击脑区展示该区在活动基因下的 31 类细胞明细（值 / 检出率 /
支撑度 datasets·donors·cells）。无数据的类型显示「数据缺失」而非 0。

**测试**：mean 动态区间、detection 固定区间、全缺失不崩、缺失类型不渲染为 0。

**Step 5:** 提交 `feat: gene expression colour scale and region detail`

---

## Task 15: 发布产物接线

**Files:**
- Modify: `build_pages_release.py`（`release_file_map` 加 `gene-atlas-data.js`、
  `gene-atlas-view.js`、`gene-atlas.css`；新增目录拷贝把 `gene_atlas_web/index.json`
  与 `gene_atlas_web/genes/*.json` 整树复制到 `gene-data/`）
- Modify: `test_build_pages_release.py`
- Test: `test_build_pages_release.py`

> 注意现有 `build_pages_release.py` 是**白名单逐文件拷贝**（`release_file_map` /
> `atlas_asset_map` 都是平铺的 dict）。`genes/` 下是不定个数的文件，
> 需新增一个**目录级**拷贝函数，不要把数百个基因文件手写进白名单。

**Step 1: 写失败测试**

```python
def test_release_bundle_contains_gene_atlas_assets():
    # 断言 gene-atlas-data.js / gene-atlas-view.js 与 gene-data/*.json 进入产物
    ...

def test_index_html_gene_data_paths_are_rewritten_for_the_release_layout():
    # 开发树用 gene_atlas_web/，发布用 gene-data/，路径重写须正确
    ...
```

**Step 2–4:** 实现并确认通过：

```bash
$PY -m pytest test_build_pages_release.py -v
$PY build_pages_release.py && ls -R github-pages | head -30
```

**Step 5:** 提交 `feat: ship the gene atlas assets in the pages bundle`

---

## 全量回归清单（每个任务收尾都跑）

```bash
PY=/home/jialiang/miniconda3/envs/scbrain/bin/python
node test_data_model.js
node test_atlas_bridge.js
node test_smoke.js
node test_ui_rendering.js
node test_gene_atlas_data.js
node test_gene_atlas_layer.js
node test_gene_atlas_view.js
$PY -m pytest -q
```

**基线状态（已实跑确认）**：4 个既有 JS 测试全部 PASS；
`test_build_pages_release.py` 需用 conda 环境的 pytest（系统 `python` 无 pytest）。

## 风险与守卫对照

| 风险 | 守卫 |
| --- | --- |
| 大文件整载爆内存（最大 96 GB） | Task 4 分块等价性测试 + Task 5 按 nnz 自动选路 |
| `matrix_source` 取错（`X` 常已归一化） | Task 5 与上游逐值比对，误差会跳到 1e-3 量级 |
| 基因标识符漏解析 | Task 7 四种形态测试 + 兜底主键计入审计 |
| 上游数据换版导致词表漂移 | Task 2 把 163 / 31 固化为断言 |
| Explorer 范围过滤静默裁剪基因图层 | Task 12 专项测试 |
| 缺失被渲染成 0 表达 | Task 8 / 9 / 10 / 14 各层均有「缺失 != 零」断言 |
| 改动破坏既有三个图层 | 每个前端任务收尾跑全量回归清单 |
| 首屏体积失控（100 基因双规则达 8.7 MB） | Task 9 按基因分文件；首屏仅 index.json + 1 个基因（~89 KB） |
| 细胞类型过滤只改详情、不改 3D 着色 | Task 10 的 `regionValues(gene, {cellTypes})` 子集重算测试 + Task 13 触发重着色 |
| 子集重算用错权重（加权 vs 等权） | Task 10 两条规则各自的解析解断言（1.525 / 1.15） |
| 31% 空组合被当成零表达 | Task 9 缺键断言 + Task 10 子集无数据时丢区断言 + Task 14 详情面板文案 |
