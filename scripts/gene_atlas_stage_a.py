"""Stage A：把单个源 h5ad 汇总成 donor x region x cell_type 粒度的表达统计。

字段名与矩阵位置全部来自 Task 1 的 inventory（manifest 的 resolved_fields），
不在本模块硬编码——细胞类型与 donor 字段在 99 个文件里各有两种取值。

每个文件只保存自身基因集，不在此阶段统一基因空间：统一会把缓存从 ~5.7 GB
膨胀到 ~23 GB，而统一基因空间是 Stage B 的职责。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import importlib.util
import sys

import h5py
import numpy as np
import scipy.sparse as sp

_HERE = Path(__file__).resolve().parent


def _load_sibling(name: str):
    """按文件路径载入同目录模块，避免依赖调用方的 sys.path 布局。"""
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, _HERE / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_inventory = _load_sibling("gene_atlas_inventory")
_aggregate = _load_sibling("gene_atlas_aggregate")

# 超过该非零值数量就走分块流式，避免整载爆内存。
# 最大源文件有 79.7 亿个非零值（约 96 GB），必须分块。
BLOCKED_NNZ_THRESHOLD = 500_000_000
BLOCK_SIZE = 50_000


@dataclass(frozen=True)
class GroupKey:
    donor: str
    region: str
    region_gyral: str
    cell_type: str


@dataclass(frozen=True)
class StageAResult:
    file_id: str
    dataset_id: str
    gene_ids: np.ndarray      # (n_genes,) 源 var 主键，原样保留不做解析
    group_keys: list[GroupKey]
    mean: np.ndarray          # (n_groups, n_genes)
    detection: np.ndarray     # (n_groups, n_genes)
    n_cells: np.ndarray       # (n_groups,)


def read_obs_values(obs_group: h5py.Group, field: str) -> np.ndarray:
    """展开 obs 字段为逐细胞的字符串数组，兼容 categorical 与纯数组编码。"""
    node = obs_group[field]
    if isinstance(node, h5py.Group):
        categories = np.asarray(node["categories"]).astype(str)
        return categories[np.asarray(node["codes"])]
    return np.asarray(node).astype(str)


def _matrix_group(handle: h5py.File, matrix_source: str) -> h5py.Group:
    if matrix_source == "X":
        return handle["X"]
    if matrix_source == "raw.X":
        return handle["raw"]["X"]
    if matrix_source.startswith("layer:"):
        return handle["layers"][matrix_source.split(":", 1)[1]]
    raise ValueError(f"unsupported matrix_source {matrix_source!r}")


def matrix_encoding(node) -> str:
    """区分三种存储形态：实测 99 个源文件为 92 CSR + 6 CSC + 1 密集。

    CSC 的 indptr 按基因而非细胞，当成 CSR 读会算出错数字；
    密集形态根本没有 data/indices/indptr 子集。
    """
    if isinstance(node, h5py.Dataset):
        return "dense"
    encoding = node.attrs.get("encoding-type")
    if isinstance(encoding, bytes):
        encoding = encoding.decode()
    return str(encoding) if encoding is not None else "csr_matrix"


def matrix_nnz(node) -> int:
    if matrix_encoding(node) == "dense":
        return int(node.shape[0]) * int(node.shape[1])
    return int(node["data"].shape[0])


def _var_group(handle: h5py.File, matrix_source: str) -> h5py.Group:
    """基因标识必须取矩阵所属的那份 var：raw.X 的基因集与 var 可能不同。"""
    if matrix_source == "raw.X":
        return handle["raw"]["var"]
    return handle["var"]


def read_gene_ids(handle: h5py.File, matrix_source: str) -> np.ndarray:
    var = _var_group(handle, matrix_source)
    index_key = var.attrs.get("_index", "_index")
    if isinstance(index_key, bytes):
        index_key = index_key.decode()
    return np.asarray(var[index_key]).astype(str)


def _load_csr(node, n_cells: int, n_genes: int) -> sp.csr_matrix:
    """把任意一种存储形态整载成细胞主序的 CSR。"""
    encoding = matrix_encoding(node)

    if encoding == "dense":
        return sp.csr_matrix(np.asarray(node[:, :]))

    data = np.asarray(node["data"])
    indices = np.asarray(node["indices"])
    indptr = np.asarray(node["indptr"])
    shape = (n_cells, n_genes)

    if encoding == "csc_matrix":
        # AnnData 的 shape 仍为 (n_cells, n_genes)，indptr 沿基因方向。
        return sp.csc_matrix((data, indices, indptr), shape=shape).tocsr()

    if encoding != "csr_matrix":
        raise ValueError(f"unsupported matrix encoding {encoding!r}")
    return sp.csr_matrix((data, indices, indptr), shape=shape)


def _csr_row_block(group: h5py.Group, start: int, stop: int, n_genes: int) -> sp.csr_matrix:
    """只读取 [start, stop) 这些细胞行，避免整载。仅适用于细胞主序 CSR。"""
    indptr = np.asarray(group["indptr"][start : stop + 1])
    lo, hi = int(indptr[0]), int(indptr[-1])
    data = np.asarray(group["data"][lo:hi])
    indices = np.asarray(group["indices"][lo:hi])
    return sp.csr_matrix(
        (data, indices, indptr - lo), shape=(stop - start, n_genes)
    )


def _group_index(labels: list[np.ndarray]) -> tuple[np.ndarray, list[tuple[str, ...]]]:
    """把多列标签压成分组下标，分组键按字典序固定顺序。"""
    tuples = list(zip(*[column.tolist() for column in labels]))
    ordered = sorted(set(tuples))
    lookup = {key: i for i, key in enumerate(ordered)}
    index = np.fromiter((lookup[t] for t in tuples), dtype=np.int64, count=len(tuples))
    return index, ordered


def summarise_source_file(entry) -> StageAResult:
    with h5py.File(entry.source_path, "r") as handle:
        obs = handle["obs"]
        donor = read_obs_values(obs, entry.donor_field)
        region = read_obs_values(obs, entry.region_field)
        region_gyral = read_obs_values(obs, entry.region_gyral_field)
        cell_type = read_obs_values(obs, entry.cell_type_field)

        index, ordered = _group_index([donor, region, region_gyral, cell_type])
        n_groups = len(ordered)

        gene_ids = read_gene_ids(handle, entry.matrix_source)
        matrix_group = _matrix_group(handle, entry.matrix_source)
        n_cells_total = donor.shape[0]
        n_genes = gene_ids.shape[0]
        nnz = matrix_nnz(matrix_group)

        if nnz > BLOCKED_NNZ_THRESHOLD:
            # 磁盘分块读取靠 indptr 沿细胞方向切片，CSC / 密集形态不适用。
            # 实测那 7 个非 CSR 文件最大 2.28 亿 nnz，远低于阈值；
            # 若数据换版后越过阈值，宁可显式报错也不能静静算错。
            encoding = matrix_encoding(matrix_group)
            if encoding != "csr_matrix":
                raise NotImplementedError(
                    f"{entry.file_id}: {encoding} 超过分块阈值，需先转成细胞主序 CSR"
                )
            result = _aggregate_blocked_from_disk(
                matrix_group, index, n_groups, n_cells_total, n_genes
            )
        else:
            counts = _load_csr(matrix_group, n_cells_total, n_genes)
            result = _aggregate.aggregate_groups(counts, index, n_groups)

    return StageAResult(
        file_id=entry.file_id,
        dataset_id=entry.dataset_id,
        gene_ids=gene_ids,
        group_keys=[GroupKey(*key) for key in ordered],
        mean=result.mean,
        detection=result.detection,
        n_cells=result.n_cells,
    )


def _aggregate_blocked_from_disk(
    matrix_group: h5py.Group,
    group_index: np.ndarray,
    n_groups: int,
    n_cells_total: int,
    n_genes: int,
):
    """逐块从磁盘读细胞行并累加，全程不持有完整矩阵。"""
    mean_sum = np.zeros((n_groups, n_genes), dtype=np.float64)
    detect_sum = np.zeros((n_groups, n_genes), dtype=np.float64)
    n_cells = np.zeros(n_groups, dtype=np.int64)

    for start in range(0, n_cells_total, BLOCK_SIZE):
        stop = min(start + BLOCK_SIZE, n_cells_total)
        block = _csr_row_block(matrix_group, start, stop, n_genes)
        indicator = _aggregate._indicator(group_index[start:stop], n_groups)

        normalised = _aggregate.normalise_cp10k_log1p(block)
        mean_sum += np.asarray((indicator @ normalised).todense())

        structure = block.tocsr(copy=True)
        structure.data = np.ones_like(structure.data, dtype=np.float64)
        detect_sum += np.asarray((indicator @ structure).todense())

        n_cells += np.asarray(indicator.sum(axis=1)).ravel().astype(np.int64)

    safe = np.where(n_cells == 0, 1, n_cells).astype(np.float64)
    return _aggregate.GroupAggregate(
        mean=mean_sum / safe[:, None],
        detection=detect_sum / safe[:, None],
        n_cells=n_cells,
    )


def summarise_source_file_by_id(file_id: str) -> StageAResult:
    inventory = _inventory.load_inventory()
    for entry in inventory.usable:
        if entry.file_id == file_id:
            return summarise_source_file(entry)
    raise KeyError(f"{file_id} is not a usable source file")


def cache_path(cache_dir: Path, file_id: str) -> Path:
    return Path(cache_dir) / f"{file_id}.npz"


def write_cache(result: StageAResult, out_dir: Path) -> Path:
    """先写临时文件再原子重命名。

    np.savez_compressed 是增量写：长任务中途被杀会留下截断的 .npz，
    而续跑只看文件存在就跳过，坐实会静默采用坏缓存。
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = cache_path(out_dir, result.file_id)
    # 传文件句柄而不是路径，numpy 就不会自行补 .npz 后缀。
    staging = target.with_name(target.name + ".partial")
    with open(staging, "wb") as handle:
        np.savez_compressed(
            handle,
            file_id=np.array(result.file_id),
            dataset_id=np.array(result.dataset_id),
            gene_ids=result.gene_ids,
            donor=np.array([k.donor for k in result.group_keys]),
            region=np.array([k.region for k in result.group_keys]),
            region_gyral=np.array([k.region_gyral for k in result.group_keys]),
            cell_type=np.array([k.cell_type for k in result.group_keys]),
            # float32 足够：与上游比对的误差本就在 float32 机器精度量级。
            mean=result.mean.astype(np.float32),
            detection=result.detection.astype(np.float32),
            n_cells=result.n_cells.astype(np.int64),
        )
    staging.replace(target)
    return target


def read_cache(path: Path) -> StageAResult:
    with np.load(path, allow_pickle=False) as payload:
        keys = [
            GroupKey(donor=d, region=r, region_gyral=g, cell_type=c)
            for d, r, g, c in zip(
                payload["donor"].astype(str),
                payload["region"].astype(str),
                payload["region_gyral"].astype(str),
                payload["cell_type"].astype(str),
            )
        ]
        return StageAResult(
            file_id=str(payload["file_id"]),
            dataset_id=str(payload["dataset_id"]),
            gene_ids=payload["gene_ids"].astype(str),
            group_keys=keys,
            mean=payload["mean"],
            detection=payload["detection"],
            n_cells=payload["n_cells"],
        )
