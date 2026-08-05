"""给一组基因量「跨类平坦度」，用来挑选和复核 housekeeping 对照基因。

**为什么不能直接用 `rank_gene_specificity.py` 的 specificity**：那个指标是
峰值类 / 全类中位，分母会跟着峰一起动。ENO2 实测 peak/median 只有 1.55x，看着像
housekeeping，但它的跨类 max/min 是 10.4x —— 它在所有神经元类都高，把中位自己抬
起来了。判断平坦必须看 max/min，以及检出率下界。

**为什么要看检出率**：低表达基因的「平」是 dropout 造出来的。SNRPD3 跨类检出率
中位仅 0.08，31 类全是接近 0 的格子，谈不上平坦，只是没测到。

**为什么排除薄类**：一个类只在两三个区有数据时，它的跨区中位方差极大，会凭噪声
当上最低类，把倍数虚高。与 rank 脚本的 MIN_REGIONS_FOR_PEAK 同一个理由和阈值。
"""

from __future__ import annotations

import argparse
import importlib.util
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent


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


stage_b = _load_sibling("gene_atlas_stage_b")

DEFAULT_CACHE_DIR = _ROOT / "gene_atlas_cache" / "stage_a"

# 与 rank_gene_specificity.MIN_REGIONS_FOR_PEAK 保持一致。
MIN_REGIONS = 20

# 已接进 gene-compare-view.js 的 CONTROL_GENES 的对照面板，加上两个实测过、但因检出率
# 偏低而没接进去的候选。默认探针目标：跑一次即可复算
# docs/gene-atlas-housekeeping-panel.md 里的表。
HOUSEKEEPING_PANEL = (
    "ARID4B", "BPTF", "TBL1XR1", "RAB7A",  # Stable reference set
    "ACTB", "GAPDH",                        # Classic controls
    "RPL32", "VCP",                         # 实测候选，未作对照
)


@dataclass
class FlatnessScore:
    symbol: str
    # 最高类跨区中位 / 最低类跨区中位。1.0 = 完全平坦。
    fold: float
    mean_median: float
    det_min: float
    det_median: float
    n_classes: int
    top_class: str
    bottom_class: str
    # 检出率最低的类。它和 bottom_class 常常不是同一个类：均值低可能是表达低，
    # 检出率低才说明这一类根本没测到。
    weakest_detection_class: str


def flatness(rows, rule: str = "cell_weighted", *, min_regions: int = MIN_REGIONS):
    """每个基因一份平坦度。rows 是 stage_b.CacheRow 的可迭代，键沿用 rows 里的基因键。"""
    merged = stage_b.merge(list(rows), rule)

    per_class_mean: dict[str, dict[str, list[float]]] = {}
    per_class_det: dict[str, dict[str, list[float]]] = {}
    for (region, cell_type, gene), value in merged.mean.items():
        if value is None:
            continue
        per_class_mean.setdefault(gene, {}).setdefault(cell_type, []).append(float(value))
        detection = merged.detection.get((region, cell_type, gene))
        if detection is not None:
            per_class_det.setdefault(gene, {}).setdefault(cell_type, []).append(float(detection))

    scored: dict[str, FlatnessScore] = {}
    for gene, classes in per_class_mean.items():
        solid = {ct: values for ct, values in classes.items() if len(values) >= min_regions}
        if not solid:
            continue
        medians = {ct: statistics.median(values) for ct, values in solid.items()}
        detections = {
            ct: statistics.median(per_class_det.get(gene, {}).get(ct, [0.0])) for ct in solid
        }
        top_class, top = max(medians.items(), key=lambda item: item[1])
        bottom_class, bottom = min(medians.items(), key=lambda item: item[1])
        weakest = min(detections.items(), key=lambda item: item[1])
        scored[gene] = FlatnessScore(
            symbol=gene,
            fold=top / (bottom + 1e-9),
            mean_median=statistics.median(medians.values()),
            det_min=weakest[1],
            det_median=statistics.median(detections.values()),
            n_classes=len(solid),
            top_class=top_class,
            bottom_class=bottom_class,
            weakest_detection_class=weakest[0],
        )
    return scored


def stream_cache_rows(cache_dir: Path, index, wanted_keys):
    for path in sorted(Path(cache_dir).glob("*.npz")):
        yield from stage_b.rows_from_cache(path, index, genes=wanted_keys)


def format_table(scores) -> str:
    lines = [
        f"{'symbol':10} {'fold':>6} {'medExpr':>8} {'detMin':>7} {'detMed':>7} {'classes':>7}"
        f"  {'top class':28} {'bottom class':28} weakest detection"
    ]
    for score in sorted(scores, key=lambda s: s.fold):
        lines.append(
            f"{score.symbol:10} {score.fold:6.2f} {score.mean_median:8.3f} "
            f"{score.det_min:7.3f} {score.det_median:7.3f} {score.n_classes:>7}"
            f"  {score.top_class[:28]:28} {score.bottom_class[:28]:28} "
            f"{score.weakest_detection_class}"
        )
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Measure cross-cell-class flatness (max/min and detection floor) for genes"
    )
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--gene-list", type=Path, help="一行一个符号；缺省用 housekeeping 面板")
    parser.add_argument("--genes", nargs="*", help="直接给符号，优先于 --gene-list")
    parser.add_argument("--min-regions", type=int, default=MIN_REGIONS)
    args = parser.parse_args(argv)

    export = _load_sibling("export_gene_atlas_web")
    identifier = _load_sibling("gene_identifier_index")
    index = identifier.load_hgnc_index()

    if args.genes:
        symbols = list(args.genes)
    elif args.gene_list:
        symbols = export.read_symbol_list(args.gene_list)
    else:
        symbols = list(HOUSEKEEPING_PANEL)

    key_to_symbol, wanted = {}, set()
    for symbol in symbols:
        ensembl = index.ensembl_for_symbol(symbol)
        key = ensembl or f"SYMBOL:{symbol}"
        wanted.add(key)
        key_to_symbol[key] = symbol

    print(f"probing {len(symbols)} genes over {args.cache_dir}", flush=True)
    rows = list(stream_cache_rows(args.cache_dir, index, wanted))
    scored = flatness(rows, min_regions=args.min_regions)

    resolved = [
        FlatnessScore(**{**score.__dict__, "symbol": key_to_symbol.get(key, key)})
        for key, score in scored.items()
    ]
    print(format_table(resolved))
    missing = [s for s in symbols if s not in {score.symbol for score in resolved}]
    if missing:
        print(f"\n! no usable data (all classes below {args.min_regions} regions): "
              f"{', '.join(missing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
