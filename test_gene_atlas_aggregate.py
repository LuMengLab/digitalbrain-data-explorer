from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import numpy as np
import scipy.sparse as sp


def load_module():
    module_path = Path(__file__).with_name("scripts") / "gene_atlas_aggregate.py"
    spec = importlib.util.spec_from_file_location("gene_atlas_aggregate", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses 解析注解时会回查 sys.modules[cls.__module__]，未注册会在类定义阶段崩。
    sys.modules[spec.name] = module
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
