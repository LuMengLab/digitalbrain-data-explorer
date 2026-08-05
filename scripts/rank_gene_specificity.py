"""按数据特异性给基因排名，与生物学先验合并成「带 cellType 明细」的精选清单。

**为什么不用覆盖率**（已实测，见 test_rank_gene_specificity.py 的模块注释）：
区域级覆盖对几乎所有基因都是 150-163 区（1,600 万细胞下，任何基因在任何区都能
找到至少一个表达的细胞），完全没有区分度；细胞类型覆盖有区分度但与特异性
Spearman rho = -0.675 —— 覆盖率最高的 APP/FUS 特异性只有 1.2x，31 类表达几乎
一样，明细面板等于没信息；覆盖率低的 CX3CR1/FOXJ1 反而是 300x 的清晰标记。
按覆盖率排序会系统性筛掉最值得看明细的基因。

**指标**：特异性 = 峰值类的跨区中位 / 全部有数据类的中位。用中位而非均值抗离群，
只统计真实有数据的类（把无数据的类当 0 会把每个基因的特异性都虚高成「峰值 / 0」）。

**按类配额而非全局排序**：全局 top N 会让 Microglia 这种信号极干净的类占满名额，
而 Splatter、Mammillary body 等一个代表都没有。明细面板的价值在于「这个基因在哪类
细胞里」，31 类各有代表才撑得起这个问题。

**先验的位置**：数据管特异性发现，先验管数据给不出的东西 —— 高频查询的疾病基因
（APP/MAPT/APOE 特异性只有 1.2x，纯数据驱动绝不会选，但读者一定会搜）、教科书
经典标记、神经递质通路。两者取并集。
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import statistics
import sys
from dataclasses import dataclass, replace
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
export = _load_sibling("export_gene_atlas_web")

# 与导出脚本共用同一个读法，否则两边对行尾注释的处理一旦不一致，生成的清单
# 就会被导出时读成垃圾符号。
read_symbol_list = export.read_symbol_list

DEFAULT_CACHE_DIR = _ROOT / "gene_atlas_cache" / "stage_a"
DEFAULT_PRIOR_LIST = _ROOT / "data" / "gene_atlas_prior_genes.txt"
DEFAULT_OUT_LIST = _ROOT / "data" / "gene_atlas_detail_genes.txt"
DEFAULT_RANKING_CSV = _ROOT / "data" / "gene_specificity_ranking.csv"

# 一个基因至少要在这么多 (region, cellType) 组合里有数据才配 357 KB 的明细文件；
# 低于此值面板几乎全是 "No data"。3,478 是实测的真实组合总数。
MIN_COMBOS = 200
# 每类取几个特异基因。31 类 x 13 去重后约 400 个。
#
# 6 -> 13 的依据：配额松紧只能按「类名基因是否进得来」定。LAMP5 是自己那类
# （LAMP5-LHX6 and Chandelier）的命名基因，特异性 14.4x 在类内排第 13，而 per_type=6
# 的门槛是 18.4x，正好把它卡在外面。放到 13 后数据驱动 186 -> 403，明细从 79 MB 到
# 约 131 MB，仍在预算内。
#
# 再往下没有可放的档：ASIC2 要放到类内第 297 名（8,221 个基因、2.1 GB）、AKT2 要第
# 703 名（14,075 个、3.6 GB），等于取消筛选。它们 2.3x 的特异性本就在全库中位附近，
# 走 data/gene_atlas_prior_genes.txt 的特例通道。
PER_TYPE = 13


# 一个类至少要在这么多个区有数据，它的跨区中位才值得信。实测教训：TH 的峰值类
# 算出来是 Bergmann glia，而该类只在 2 个区有数据，最大值落在红核 —— 那是中脑
# 多巴胺神经元的 ambient RNA 渗到了附近的胶质核里，不是 Bergmann glia 在表达 TH。
MIN_REGIONS_FOR_PEAK = 20


@dataclass
class GeneScore:
    symbol: str
    specificity: float
    peak_cell_type: str
    peak_value: float
    combos: int
    n_cell_types: int
    n_regions: int
    # 峰值类自己覆盖了多少个区。低于 MIN_REGIONS_FOR_PEAK 说明连退让后也没有可信的类，
    # 这个基因的峰值标签只能当线索看。
    peak_regions: int = 0


def score_genes(
    rows,
    rule: str = "cell_weighted",
    *,
    min_regions_for_peak: int = MIN_REGIONS_FOR_PEAK,
) -> dict[str, GeneScore]:
    """每个基因一份特异性打分。rows 是 stage_b.CacheRow 的可迭代。

    峰值类只从「至少覆盖 min_regions_for_peak 个区」的类里选；若一个都没有，退回
    全局峰值并用 peak_regions 如实标出来，而不是把基因丢掉。
    """
    merged = stage_b.merge(list(rows), rule)

    # (gene, cell_type) -> 该类在各区的表达值；缺失的组合根本不在 merged.mean 里，
    # 所以天然不会被当成 0。
    per_class: dict[str, dict[str, list[float]]] = {}
    regions_seen: dict[str, set[str]] = {}
    for (region, cell_type, gene), value in merged.mean.items():
        if value is None:
            continue
        per_class.setdefault(gene, {}).setdefault(cell_type, []).append(float(value))
        regions_seen.setdefault(gene, set()).add(region)

    scored: dict[str, GeneScore] = {}
    for gene, classes in per_class.items():
        class_medians = {
            cell_type: statistics.median(values) for cell_type, values in classes.items()
        }
        combos = sum(len(values) for values in classes.values())
        believable = {
            cell_type: median
            for cell_type, median in class_medians.items()
            if len(classes[cell_type]) >= min_regions_for_peak
        }
        pool = believable or class_medians
        peak_type, peak_value = max(pool.items(), key=lambda item: item[1])
        middle = statistics.median(class_medians.values())
        # 分母加极小量：全类同值时得 1.0，而非除零。
        specificity = peak_value / (middle + 1e-9) if peak_value > 0 else 0.0
        scored[gene] = GeneScore(
            symbol=gene,
            specificity=specificity,
            peak_cell_type=peak_type,
            peak_value=peak_value,
            combos=combos,
            n_cell_types=len(classes),
            n_regions=len(regions_seen.get(gene, ())),
            peak_regions=len(classes[peak_type]),
        )
    return scored


def rekey(score: GeneScore, symbol: str) -> GeneScore:
    """把缓存主键（Ensembl）换成 HGNC 符号，其余字段原样保留。

    用 replace 而不是手工重列字段：手工列表漏过 peak_regions，诊断表里那一列
    因此整列为 0，而它正是用来识别「峰值类只覆盖 2 个区、不可信」的依据。
    """
    return replace(score, symbol=symbol)


def select_by_cell_type(
    scored: dict[str, GeneScore],
    *,
    per_type: int = PER_TYPE,
    min_combos: int = MIN_COMBOS,
) -> list[str]:
    """每个细胞类型取 per_type 个特异性最高的基因（以该基因的峰值类归属）。"""
    by_type: dict[str, list[GeneScore]] = {}
    for score in scored.values():
        if score.combos < min_combos or score.peak_value <= 0:
            continue
        by_type.setdefault(score.peak_cell_type, []).append(score)

    picked: set[str] = set()
    for cell_type in sorted(by_type):
        ranked = sorted(
            by_type[cell_type], key=lambda s: (-s.specificity, -s.peak_value, s.symbol)
        )
        for score in ranked[:per_type]:
            picked.add(score.symbol)
    return sorted(picked)


def merge_with_prior(selected, prior, known) -> list[str]:
    """并集，但先验里不在本次导出中的符号要丢掉。

    留着会让前端按 index.json 的 detailGenes 去取一个不存在的 .detail.json，
    换来一个 404 和一个空面板 —— 比没有明细更糟，因为它看起来像故障。
    """
    known = set(known)
    merged = set(selected)
    for symbol in prior:
        if symbol in known:
            merged.add(symbol)
    return sorted(merged)


def write_ranking(path, scored: dict[str, GeneScore], *, min_combos: int = MIN_COMBOS) -> None:
    """诊断表。合格行排在前面：按纯特异性排序时 top 15 实测全是嗅觉受体、
    毛发角蛋白、精子蛋白这类脑内不该表达的基因——它们本就过不了门槛，但会
    把人工审阅带偏。
    """
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["symbol", "eligible", "specificity", "peak_cell_type", "peak_value",
             "peak_regions", "combos", "n_cell_types", "n_regions"]
        )
        ordered = sorted(
            scored.values(),
            key=lambda s: (0 if s.combos >= min_combos else 1, -s.specificity),
        )
        for score in ordered:
            writer.writerow([
                score.symbol,
                "yes" if score.combos >= min_combos else "no",
                f"{score.specificity:.3f}",
                score.peak_cell_type,
                f"{score.peak_value:.4f}",
                score.peak_regions,
                score.combos,
                score.n_cell_types,
                score.n_regions,
            ])


def write_detail_list(path, symbols, scored, prior_only) -> None:
    lines = [
        "# 带 cellType 明细（.detail.json）的精选基因。",
        "# 由 scripts/rank_gene_specificity.py 生成，勿手工编辑 —— 改先验请编辑",
        "# data/gene_atlas_prior_genes.txt 后重跑该脚本。",
        "#",
        "# 组成：每个细胞类型的 top 特异基因（数据驱动）∪ 生物学先验（疾病/经典标记/递质通路）。",
        "# 特异性 = 峰值类跨区中位 / 全类中位。覆盖率不作排序依据（与特异性负相关，",
        "# 详见脚本模块注释）。",
        "",
    ]
    by_type: dict[str, list[str]] = {}
    for symbol in symbols:
        score = scored.get(symbol)
        key = score.peak_cell_type if score else "(prior only)"
        by_type.setdefault(key, []).append(symbol)

    for cell_type in sorted(by_type):
        lines.append(f"# --- {cell_type} ---")
        for symbol in sorted(by_type[cell_type]):
            score = scored.get(symbol)
            tag = " (prior)" if symbol in prior_only else ""
            if score:
                lines.append(f"{symbol}{'':<{max(0, 12 - len(symbol))}} # {score.specificity:8.1f}x{tag}")
            else:
                lines.append(f"{symbol}{tag}")
        lines.append("")
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def stream_cache_rows(cache_dir: Path, index, wanted_keys):
    """流式读缓存目录里的全部 Stage A 产物，只展开命中的基因主键。"""
    for path in sorted(Path(cache_dir).glob("*.npz")):
        yield from stage_b.rows_from_cache(path, index, genes=wanted_keys)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Rank genes by cell-type specificity and merge with the biological prior"
    )
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--prior-list", type=Path, default=DEFAULT_PRIOR_LIST)
    parser.add_argument("--out-list", type=Path, default=DEFAULT_OUT_LIST)
    parser.add_argument("--ranking-csv", type=Path, default=DEFAULT_RANKING_CSV)
    parser.add_argument("--per-type", type=int, default=PER_TYPE)
    parser.add_argument("--min-combos", type=int, default=MIN_COMBOS)
    parser.add_argument("--batch-size", type=int, default=800,
                        help="每批基因数，控制流式读缓存时的内存峰值")
    args = parser.parse_args(argv)

    export = _load_sibling("export_gene_atlas_web")
    identifier = _load_sibling("gene_identifier_index")
    index = identifier.load_hgnc_index()

    symbols = export.protein_coding_symbols()
    print(f"scoring {len(symbols)} protein-coding genes, batch size {args.batch_size}",
          flush=True)

    scored: dict[str, GeneScore] = {}
    batches = [symbols[i:i + args.batch_size] for i in range(0, len(symbols), args.batch_size)]
    for i, batch in enumerate(batches, 1):
        wanted, key_to_symbol = {}, {}
        for symbol in batch:
            ensembl = index.ensembl_for_symbol(symbol)
            key = ensembl or symbol
            wanted[key] = symbol
            key_to_symbol[key] = symbol
        rows = list(stream_cache_rows(args.cache_dir, index, set(wanted)))
        batch_scores = score_genes(rows)
        # merge() 以缓存主键分组，换回 HGNC 符号后再入总表。
        for key, score in batch_scores.items():
            symbol = key_to_symbol.get(key, key)
            scored[symbol] = rekey(score, symbol)
        print(f"[{i}/{len(batches)}] {len(batch)} -> {len(batch_scores)} scored "
              f"(cumulative {len(scored)})", flush=True)

    write_ranking(args.ranking_csv, scored, min_combos=args.min_combos)
    selected = select_by_cell_type(
        scored, per_type=args.per_type, min_combos=args.min_combos
    )
    prior = read_symbol_list(args.prior_list) if args.prior_list.exists() else []
    merged = merge_with_prior(selected, prior, set(scored))
    prior_only = set(merged) - set(selected)
    write_detail_list(args.out_list, merged, scored, prior_only)

    dropped = [s for s in prior if s not in scored]
    print(f"[write] {args.ranking_csv}  ({len(scored)} genes)")
    print(f"[write] {args.out_list}")
    print(f"  data-driven: {len(selected)}  prior-only: {len(prior_only)}  total: {len(merged)}")
    print(f"  detail budget: ~{len(merged) * 357 / 1024:.1f} GB" if len(merged) * 357 > 1024 * 1024
          else f"  detail budget: ~{len(merged) * 357 / 1024:.0f} MB")
    if dropped:
        print(f"  ! {len(dropped)} prior symbols have no data and were dropped: "
              f"{', '.join(dropped[:12])}{'...' if len(dropped) > 12 else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
