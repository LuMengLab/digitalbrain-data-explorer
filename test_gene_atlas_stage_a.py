from __future__ import annotations

import importlib.util
import sys
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

# 普查结果：99 个源文件共 92 CSR + 6 CSC + 1 密集数组。
# CSR 已由 SMOKE 文件覆盖，另两种各取一个最小的做同样的逐值比对。
CSC_FILE_ID = "fetalhuman_annot_filtered_a9e32878e0"
CSC_COLLECTION = "collection_050__human_brain_frontoparietal_li_2018"
DENSE_FILE_ID = "human_annot_filtered_23b5e7b73a"
DENSE_COLLECTION = "collection_075__human_mouse_macque_brain_bakken_2021_smarter"


def load_module():
    module_path = Path(__file__).with_name("scripts") / "gene_atlas_stage_a.py"
    spec = importlib.util.spec_from_file_location("gene_atlas_stage_a", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses 解析注解时会回查 sys.modules[cls.__module__]，未注册会在类定义阶段崩。
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def read_categories(node) -> np.ndarray:
    if isinstance(node, h5py.Group):
        return np.asarray(node["categories"]).astype(str)[np.asarray(node["codes"])]
    return np.asarray(node).astype(str)


def compare_with_upstream(module, file_id: str, collection: str):
    """拿上游 first_stage 做逐值比对，返回（最大 mean 误差，最大 detection 误差，行数）。

    必须按完整四元组 (donor, region, region_gyral, cell_type) 对齐：
    上游的原子单元含 donor 与 region 轴，单用 cell_type 作键在多 donor
    文件上会静静撞键冲突，把不同组的值拿去比。
    """
    result = module.summarise_source_file_by_id(file_id)

    upstream_path = FIRST_STAGE / collection / f"{file_id}.summary.h5ad"
    with h5py.File(upstream_path, "r") as handle:
        obs = handle["obs"]
        up_keys = list(
            zip(
                read_categories(obs["donor_id"]),
                read_categories(obs["region_id"]),
                read_categories(obs["region_gyral"]),
                read_categories(obs["cell_type"]),
            )
        )
        up_gene_id = read_categories(handle["var"]["gene_id"])
        up_mean = np.asarray(handle["X"])
        up_detection = np.asarray(handle["layers"]["detection_fraction"])
        up_n_cells = np.asarray(obs["n_cells"])

    assert result.gene_ids.tolist() == up_gene_id.tolist(), "gene order diverged"
    assert len(set(up_keys)) == len(up_keys), "upstream keys are not unique"

    upstream_row = {key: i for i, key in enumerate(up_keys)}
    worst_mean = 0.0
    worst_detection = 0.0
    consumed = set()
    for i, key in enumerate(result.group_keys):
        tup = (key.donor, key.region, key.region_gyral, key.cell_type)
        row = upstream_row.get(tup)
        assert row is not None, f"upstream lacks group {tup}"
        consumed.add(row)
        assert int(result.n_cells[i]) == int(up_n_cells[row]), f"cell count differs at {tup}"
        worst_mean = max(worst_mean, float(np.abs(result.mean[i] - up_mean[row]).max()))
        worst_detection = max(
            worst_detection, float(np.abs(result.detection[i] - up_detection[row]).max())
        )

    # 分组必须与上游一一对应，不得有多余或遗漏的行。
    assert len(consumed) == len(up_keys) == len(result.group_keys)
    assert int(result.n_cells.sum()) == int(up_n_cells.sum())
    return worst_mean, worst_detection, len(up_keys)


def test_stage_a_reads_csc_encoded_matrices_correctly():
    """6 个源文件的矩阵是 CSC（indptr 按基因而非细胞）。

    当成 CSR 读会直接报 indptr 长度不匹配；但若尺寸恰好相近就会静静算错，
    所以必须有与上游的逐值比对卡住。
    """
    module = load_module()
    worst_mean, worst_detection, _ = compare_with_upstream(
        module, CSC_FILE_ID, CSC_COLLECTION
    )
    assert worst_mean < 1e-5, f"mean drift {worst_mean:.3e}"
    assert worst_detection < 1e-6, f"detection drift {worst_detection:.3e}"


def test_stage_a_reads_dense_matrices_correctly():
    """1 个源文件的矩阵是密集 Dataset，没有 data/indices/indptr 子集。"""
    module = load_module()
    worst_mean, worst_detection, _ = compare_with_upstream(
        module, DENSE_FILE_ID, DENSE_COLLECTION
    )
    assert worst_mean < 1e-5, f"mean drift {worst_mean:.3e}"
    assert worst_detection < 1e-6, f"detection drift {worst_detection:.3e}"


def test_stage_a_matches_upstream_first_stage_value_by_value():
    """回归基准：自建管线与上游 first_stage 在 float32 精度内一致。

    该文件为 7,588 细胞 x 21,563 基因，1 区 / 1 donor / 17 细胞类型。
    """
    module = load_module()

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


def test_disk_blocked_path_equals_whole_load_path():
    """磁盘分块读取器是独立于 in-memory 分块的另一份代码，必须单独守卫。

    它只在最大的几个文件上生效（nnz > 5e8），平时跑不到；
    indptr 偏移减基算错不会报错，只会静静给出错数字。
    """
    module = load_module()
    entry = next(
        e for e in module._inventory.load_inventory().usable if e.file_id == SMOKE_FILE_ID
    )

    whole = module.summarise_source_file(entry)

    # 把阈值降到 0 强制走分块，并用不能整除 7588 的块大小暴露边界错误。
    original_threshold = module.BLOCKED_NNZ_THRESHOLD
    original_block = module.BLOCK_SIZE
    module.BLOCKED_NNZ_THRESHOLD = 0
    module.BLOCK_SIZE = 999
    try:
        blocked = module.summarise_source_file(entry)
    finally:
        module.BLOCKED_NNZ_THRESHOLD = original_threshold
        module.BLOCK_SIZE = original_block

    assert [k.cell_type for k in blocked.group_keys] == [
        k.cell_type for k in whole.group_keys
    ]
    assert blocked.n_cells.tolist() == whole.n_cells.tolist()
    np.testing.assert_allclose(blocked.mean, whole.mean, rtol=1e-9, atol=1e-12)
    np.testing.assert_allclose(blocked.detection, whole.detection, rtol=1e-9, atol=1e-12)


def test_cache_round_trip_preserves_values_and_group_keys(tmp_path):
    """Task 6 的续跑与 Stage B 都依赖缓存，落盘与回读必须同构。"""
    module = load_module()
    result = module.summarise_source_file_by_id(SMOKE_FILE_ID)

    target = module.write_cache(result, tmp_path)
    assert target.exists()

    restored = module.read_cache(target)
    assert restored.file_id == result.file_id
    assert restored.dataset_id == result.dataset_id
    assert restored.gene_ids.tolist() == result.gene_ids.tolist()
    assert restored.group_keys == result.group_keys
    assert restored.n_cells.tolist() == result.n_cells.tolist()
    # 落盘为 float32：与上游的差异本就在 float32 精度量级，不必存 float64。
    np.testing.assert_allclose(restored.mean, result.mean, rtol=1e-6, atol=1e-7)
    np.testing.assert_allclose(restored.detection, result.detection, rtol=1e-6, atol=1e-7)
