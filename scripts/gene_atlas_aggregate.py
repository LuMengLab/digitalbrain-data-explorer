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
