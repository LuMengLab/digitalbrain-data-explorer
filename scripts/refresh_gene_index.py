"""按磁盘实况重建 `gene_atlas_web/index.json`。

**为什么需要**：`export_gene_atlas_web.py --gene-list` 只跑一小批基因时，索引是用
**这一批**的符号写的，其余 19,000 个基因的 `genes` 映射会被清空 —— 前端按索引取数，
站点的基因图层直接空掉。增量导出（例如放宽精选清单后只补新增的明细）之后必须用本
脚本把索引恢复成磁盘上真实存在的全部基因。

`densityScale` 由 `compute_density_scale.py` 单独算出，不在导出流程里，所以重建时从
旧索引原样搬过来；`scope` / `cellTypes` 同理，避免重建顺手改掉披露文案。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent

DEFAULT_OUT_DIR = _ROOT / "gene_atlas_web"

CARRIED_KEYS = ("scope", "cellTypes", "densityScale")


def _load_sibling(name: str):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, _HERE / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def scan_symbols(genes_dir) -> tuple[list[str], list[str]]:
    """返回 (全部基因符号, 有明细的符号)。

    `*.detail.json` 也匹配 `*.json`，必须显式排除 —— 否则会凭空造出 `GAPDH.detail`
    这种符号，前端拿它去取一个不存在的文件。
    """
    genes_dir = Path(genes_dir)
    symbols, detail = [], []
    for path in sorted(genes_dir.glob("*.json")):
        if path.name.endswith(".detail.json"):
            detail.append(path.name[: -len(".detail.json")])
            continue
        symbols.append(path.stem)
    # 只承认区域级文件也在的明细：孤立的 .detail.json 前端根本走不到。
    known = set(symbols)
    return sorted(symbols), sorted(s for s in detail if s in known)


def refresh(out_dir) -> dict:
    export = _load_sibling("export_gene_atlas_web")
    out_dir = Path(out_dir)
    symbols, detail = scan_symbols(out_dir / "genes")

    index_path = out_dir / "index.json"
    carried: dict = {}
    if index_path.exists():
        old = json.loads(index_path.read_text(encoding="utf-8"))
        carried = {key: old[key] for key in CARRIED_KEYS if key in old}

    return export.write_index_file(
        out_dir,
        symbols,
        detail_genes=detail,
        scope=carried.get("scope"),
        cell_types=carried.get("cellTypes"),
        density_scale=carried.get("densityScale"),
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild index.json from the gene files actually present on disk"
    )
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    args = parser.parse_args(argv)

    doc = refresh(args.out_dir)
    print(f"[write] {args.out_dir / 'index.json'}")
    print(f"  genes: {len(doc['genes'])}  detailGenes: {len(doc['detailGenes'])}")
    if not doc["densityScale"]:
        print("  ! densityScale 为空：旧索引没有它，或需重跑 compute_density_scale.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
