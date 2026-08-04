"""Stage C：把 Stage B 的合并结果导出成前端按需加载的按基因 JSON。

产物布局（gene_atlas_web/，本目录被 .gitignore 忽略，由发布流程拷入 github-pages/）：

    index.json            基因名→文件名索引 + scope 披露（首屏加载）
    genes/<SYMBOL>.json   单基因全量：region 级 + region×cellType 级，双聚合规则并存

契约：
- 每个 cellType 项必须带 cells，前端做 cell_weighted 的细胞类型子集重算时要用作权重。
- 无数据的 (region, cellType) / region 组合**缺键**，绝不写 0。零表达与无数据在生物学上
  是不同结论。
- 请求了但缓存里没有任何数据的基因**不写文件、不进索引**——空文件会被读成「测过但不表达」。

内存：全量蛋白编码基因（~1.9 万）的 donor 级行数达十亿量级，不能一次性载入。export()
按调用方给定的基因子集工作，CLI 负责把清单分批，每批独立流式读缓存、落盘、释放。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent

DEFAULT_CACHE_DIR = _ROOT / "gene_atlas_cache" / "stage_a"
DEFAULT_OUT_DIR = _ROOT / "gene_atlas_web"
HGNC_TABLE = _ROOT / "data" / "vendor" / "hgnc_complete_set.txt"
EXPLORER_DATA = _ROOT / "digitalneuron_data.js"
DEFAULT_DETAIL_LIST = _ROOT / "data" / "gene_atlas_detail_genes.txt"

METRICS = ["mean", "detection"]


def _load_sibling(name: str):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, _HERE / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {name}")
    module = importlib.util.module_from_spec(spec)
    # dataclasses 解析注解时会回查 sys.modules[cls.__module__]，未注册会在类定义阶段崩。
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _round(value):
    # None 表示无数据，保持缺失语义；其余四位小数够前端着色与展示。
    return None if value is None else round(float(value), 4)


def read_symbol_list(path) -> list[str]:
    """读一行一个的符号清单：跳注释/空行，保留首现顺序并去重。"""
    symbols: list[str] = []
    seen: set[str] = set()
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        symbol = line.strip()
        if not symbol or symbol.startswith("#"):
            continue
        if symbol not in seen:
            seen.add(symbol)
            symbols.append(symbol)
    return symbols


def protein_coding_symbols(table_path: Path = HGNC_TABLE) -> list[str]:
    """HGNC 中 locus_group == 'protein-coding gene' 的当前批准符号，去重排序。

    非编码 RNA、假基因对「看基因在脑区的表达」是噪声，且占并集的绝大多数，排除。
    """
    symbols: set[str] = set()
    with open(table_path, "r", encoding="utf-8") as handle:
        header = handle.readline().rstrip("\n").split("\t")
        column = {name: i for i, name in enumerate(header)}
        for need in ("symbol", "locus_group"):
            if need not in column:
                raise ValueError(f"hgnc table lacks column {need!r}")
        s_i, g_i = column["symbol"], column["locus_group"]
        for line in handle:
            row = line.rstrip("\n").split("\t")
            if len(row) <= max(s_i, g_i):
                continue
            if row[g_i].strip() == "protein-coding gene" and row[s_i].strip():
                symbols.add(row[s_i].strip())
    return sorted(symbols)


def default_scope() -> dict:
    """从审计清单推导 scope 披露，避免硬编码后与数据脱节。"""
    inventory = _load_sibling("gene_atlas_inventory")
    inv = inventory.load_inventory()
    return {
        "datasets": len(inv.usable),
        "cells": inv.usable_cells,
        "excludedDatasets": len(inv.skipped),
        "excludedCells": inv.excluded_cells,
    }


def explorer_cell_types(data_path: Path = EXPLORER_DATA) -> list[str]:
    """Overview 页面 digitalneuron_data.js 的 31 类细胞词表，去重排序。

    这是基因图层细胞类型过滤器的权威来源；Task 2 已守卫它与源 obs 逐字相同。
    """
    text = Path(data_path).read_text(encoding="utf-8")
    types: set[str] = set()
    for block in re.findall(r'"cell_types":\s*\[(.*?)\]', text, re.S):
        types |= set(re.findall(r'"([^"]+)"', block))
    return sorted(types)


def _default_rows(cache_dir: Path, index, wanted_keys):
    """流式读缓存目录里的全部 Stage A 产物，只展开命中的基因主键。"""
    stage_b = _load_sibling("gene_atlas_stage_b")
    for path in sorted(Path(cache_dir).glob("*.npz")):
        yield from stage_b.rows_from_cache(path, index, genes=wanted_keys)


def build_gene_payload(symbol: str, ensembl: str | None, merge_by_rule: dict, has_detail: bool) -> dict:
    """把每规则一份的 MergeResult（已按单基因过滤）拼成单基因 JSON。

    support 提到顶层：datasets/donors/cells 计数与聚合规则无关（来自同一组行），
    双规则下完全相同，存两份纯浪费 ~35% 体积。
    """
    payload: dict = {"symbol": symbol, "ensembl": ensembl, "hasDetail": has_detail}
    # 取任意一个规则的 region_support 作为唯一 support
    first_result = next(iter(merge_by_rule.values()))
    payload["support"] = {
        region: {
            "datasets": int(s.datasets),
            "donors": int(s.donors),
            "cells": int(s.cells),
        }
        for (region, _g), s in first_result.region_support.items()
    }
    for rule, result in merge_by_rule.items():
        region_mean = {region: _round(v) for (region, _g), v in result.regions.items()}
        region_detect = {
            region: _round(v) for (region, _g), v in result.region_detection.items()
        }
        payload[rule] = {
            "regions": {"mean": region_mean, "detection": region_detect},
        }
    return payload


def build_detail_payload(symbol: str, merge_by_rule: dict) -> dict:
    """cellType 级明细，仅精选基因会产出此文件。"""
    payload: dict = {"symbol": symbol}
    for rule, result in merge_by_rule.items():
        cell_types: dict = {}
        for (region, cell_type, _g), value in result.mean.items():
            inner = (region, cell_type, _g)
            cell_types.setdefault(region, {})[cell_type] = {
                "mean": _round(value),
                "detection": _round(result.detection[inner]),
                "cells": int(result.cells[inner]),
            }
        payload[rule] = {"cellTypes": cell_types}
    return payload


def export(
    genes,
    out_dir,
    *,
    detail_genes: set | None = None,
    cache_dir: Path = DEFAULT_CACHE_DIR,
    index=None,
    rows_provider=None,
    scope: dict | None = None,
    cell_types=None,
    write_index: bool = True,
) -> list[str]:
    """导出一批基因。返回真正写出（有数据）的符号列表，排序。

    detail_genes 控制哪些基因除了区域级文件外还产出 .detail.json（cellType 明细）。
    缺省 None = 全部带详情（但仅少量精选时才合理,全编码 19k 时应给空集或子集）。
    rows_provider(index, wanted_keys) 可注入，默认流式读 cache_dir。
    write_index=False 时只落基因文件，供 CLI 分批后统一写索引。
    """
    stage_b = _load_sibling("gene_atlas_stage_b")
    if index is None:
        identifier = _load_sibling("gene_identifier_index")
        index = identifier.load_hgnc_index()

    # 符号 → 主键（Ensembl 优先，兜底 SYMBOL:）；同时记住反查用于命名与 ensembl 字段。
    key_to_symbol: dict[str, str] = {}
    key_to_ensembl: dict[str, str | None] = {}
    wanted_keys: set[str] = set()
    for symbol in genes:
        ensembl = index.ensembl_for_symbol(symbol)
        key = ensembl or f"SYMBOL:{symbol}"
        wanted_keys.add(key)
        key_to_symbol[key] = symbol
        key_to_ensembl[key] = ensembl
    if not wanted_keys:
        rows = []
    else:
        provider = rows_provider or (lambda idx, keys: _default_rows(cache_dir, idx, keys))
        rows = provider(index, wanted_keys)

    rows_by_key: dict[str, list] = {}
    for row in rows:
        if row.gene in wanted_keys:
            rows_by_key.setdefault(row.gene, []).append(row)

    out_dir = Path(out_dir)
    genes_dir = out_dir / "genes"
    genes_dir.mkdir(parents=True, exist_ok=True)

    written: list[str] = []
    detail_written: list[str] = []
    effective_detail = detail_genes if detail_genes is not None else set(genes)
    for key, gene_rows in rows_by_key.items():
        merge_by_rule = {rule: stage_b.merge(gene_rows, rule) for rule in stage_b.RULES}
        # 所有规则都空说明该基因在覆盖区里无有效组合，跳过（不写空文件）。
        if all(not result.mean for result in merge_by_rule.values()):
            continue
        symbol = key_to_symbol[key]
        has_detail = symbol in effective_detail
        payload = build_gene_payload(symbol, key_to_ensembl[key], merge_by_rule, has_detail)
        (genes_dir / f"{symbol}.json").write_text(
            json.dumps(payload, separators=(",", ":")), encoding="utf-8"
        )
        written.append(symbol)
        if has_detail:
            detail = build_detail_payload(symbol, merge_by_rule)
            (genes_dir / f"{symbol}.detail.json").write_text(
                json.dumps(detail, separators=(",", ":")), encoding="utf-8"
            )
            detail_written.append(symbol)

    written.sort()
    detail_written.sort()
    if write_index:
        write_index_file(
            out_dir, written, detail_genes=detail_written,
            scope=scope, cell_types=cell_types,
        )
    return written


def write_index_file(out_dir, symbols, *, detail_genes=None, scope=None, cell_types=None) -> dict:
    """写 index.json：scope 披露 + 指标/规则 + 词表 + 基因→文件映射 + 详情子集。"""
    if scope is None:
        scope = default_scope()
    if cell_types is None:
        cell_types = explorer_cell_types()
    stage_b = _load_sibling("gene_atlas_stage_b")
    doc = {
        "scope": scope,
        "metrics": METRICS,
        "rules": list(stage_b.RULES),
        "cellTypes": list(cell_types),
        "genes": {symbol: f"genes/{symbol}.json" for symbol in sorted(symbols)},
        "detailGenes": sorted(detail_genes) if detail_genes else [],
    }
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.json").write_text(
        json.dumps(doc, separators=(",", ":")), encoding="utf-8"
    )
    return doc


def _chunked(items, size):
    for start in range(0, len(items), size):
        yield items[start : start + size]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Export the browser-facing gene atlas payload")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--gene-list", type=Path, help="一行一个符号；缺省用全部蛋白编码基因")
    parser.add_argument("--detail-list", type=Path, default=DEFAULT_DETAIL_LIST,
                        help="带 cellType 明细的精选基因清单；明细约 350 KB/基因，不得全量")
    parser.add_argument("--batch-size", type=int, default=800,
                        help="每批基因数，控制流式读缓存时的内存峰值")
    args = parser.parse_args(argv)

    identifier = _load_sibling("gene_identifier_index")
    index = identifier.load_hgnc_index()

    if args.gene_list:
        symbols = read_symbol_list(args.gene_list)
    else:
        symbols = protein_coding_symbols()
    # 显式固定详情子集：export(detail_genes=None) 意为全带详情，全编码下会破预算。
    detail_genes = set(read_symbol_list(args.detail_list))
    print(f"requested {len(symbols)} symbols, batch size {args.batch_size}, "
          f"{len(detail_genes)} with cellType detail", flush=True)

    written: list[str] = []
    detail_written: list[str] = []
    batches = list(_chunked(symbols, args.batch_size))
    for i, batch in enumerate(batches, 1):
        got = export(
            batch,
            args.out_dir,
            detail_genes=detail_genes,
            cache_dir=args.cache_dir,
            index=index,
            write_index=False,
        )
        written.extend(got)
        detail_written.extend(symbol for symbol in got if symbol in detail_genes)
        print(f"[{i}/{len(batches)}] batch {len(batch)} -> {len(got)} with data "
              f"(cumulative {len(written)})", flush=True)

    write_index_file(args.out_dir, written, detail_genes=detail_written)
    print(f"done: {len(written)} gene files ({len(detail_written)} with detail) "
          f"+ index.json in {args.out_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
