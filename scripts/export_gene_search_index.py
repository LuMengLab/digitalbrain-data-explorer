"""基因搜索索引：让下拉框既能回答「这是什么基因」，也能被 ENSG 号、HGNC 全名、
细胞位置、峰值细胞类别搜到。

产物（gene_atlas_web/search-index.json，与基因载荷同目录，随发布流程一并拷入）：

    {
      "version": 1,
      "ensemblPrefix": "ENSG00000",
      "biotypes": [...], "classes": [...],      # 字典，下面的整数列引用它
      "symbols":   [...],                        # 按字母序，是下面所有列的位置键
      "ensembl":   [...], "names": [...], "locations": [...],
      "biotype":   [...], "peak": [...], "regions": [...],
      "detail":    [...]                         # 有 cellType 明细的基因位置
    }

为什么是一个文件而不是按首字母分片：前一版按首字母分片，前提是「搜索只匹配符号前缀，
一次输入只命中一片」。一旦要支持按 ENSG 号和基因全名搜索，这个前提就不成立了——
ENSG00000131095 命中的是 G 片里的 GFAP，「glial fibrillary」命中的基因散落在所有片里。
所以改为一次取全表。

同时改成列式 + 字典编码：19227 条记录里每条重复一遍 6 个字段名、以及把 31 个细胞类别名
重复上万遍，是这份数据里最大的一块。列式后整表 1.35 MB（分片版 26 片合计 3.34 MB），
gzip 后约 300 KB，首次击键取一次、之后常驻。

字段来源与口径：
- ensembl              取自已导出的 genes/<SYMBOL>.json，即本次构建真正使用的那一个。
                       HGNC 表里也有 ensembl_gene_id，但两者可能不同，以载荷为准。
                       存储时去掉 ENSG00000 前缀；不符合该前缀的按原样存整串，前端以
                       「是否以 ENS 开头」区分两种情形。
- name/location/biotype  HGNC 官方表 data/vendor/hgnc_complete_set.txt。
- peakClass/regions    data/gene_specificity_ranking.csv，即数据自己算出的「表达最高的
                       细胞类别」与「有数据的脑区数」。数据驱动的功能线索比静态基因家族
                       更贴合本图谱要回答的问题。
- detail               本次构建是否为该基因导出了 cellType 明细，决定 Cell class 筛选
                       是否可用——这是候选行里唯一会改变后续操作可能性的字段。

不导出的：HGNC 别名与旧符号。42747 条别名会让整表从 1.35 MB 涨到 2.10 MB（+55%），
而它要解决的问题（用旧符号搜到新符号）与本次要解决的问题无关，不搭这趟车。

缺失一律写空位（""/-1/0）不写占位值：列式结构必须逐位对齐，而空位在前端一律读成
「这条没有」，不会显示成一个编造的类别。
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent

DEFAULT_PAYLOAD_DIR = _ROOT / "gene_atlas_web"
DEFAULT_HGNC_TABLE = _ROOT / "data" / "vendor" / "hgnc_complete_set.txt"
DEFAULT_SPECIFICITY = _ROOT / "data" / "gene_specificity_ranking.csv"
INDEX_FILE_NAME = "search-index.json"
FORMAT_VERSION = 1

# 人类 ENSG 号全部是 ENSG00000 + 6 位数字，去掉这 9 个字符 × 1.9 万条约省 173 KB。
ENSEMBL_PREFIX = "ENSG00000"

# 只读文件开头：单基因文件把 symbol/ensembl 放在最前，为拿两个字段解析 17 KB × 1.9 万
# 是没必要的。
_HEAD_BYTES = 240
_ENSEMBL_RE = re.compile(r'"ensembl"\s*:\s*"([^"]+)"')

# locus_group 的四个取值收窄成候选行放得下的短标签。
_BIOTYPES = {
    "protein-coding gene": "protein-coding",
    "non-coding RNA": "ncRNA",
    "pseudogene": "pseudogene",
    "other": "other",
}


def pack_ensembl(ensembl: str) -> str:
    """去掉共同前缀。不符合前缀的原样返回，前端凭「以 ENS 开头」还原。"""
    text = str(ensembl or "").strip()
    if text.startswith(ENSEMBL_PREFIX):
        return text[len(ENSEMBL_PREFIX):]
    return text


def read_hgnc(path: Path) -> dict[str, dict]:
    """symbol -> {name, location, biotype}，别名与旧符号一并登记。

    载荷里的符号来自 99 个原始数据集，其中一部分是 HGNC 的旧符号或别名。只认 approved
    symbol 会让这些基因在下拉框里没有名称——现列优先，别名只在无冲突时兜底。
    """
    primary: dict[str, dict] = {}
    fallback: dict[str, dict] = {}
    if not path.exists():
        return primary

    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle, delimiter="\t"):
            record = {
                "name": (row.get("name") or "").strip(),
                "location": (row.get("location") or "").strip(),
                "biotype": _BIOTYPES.get(
                    (row.get("locus_group") or "").strip(),
                    (row.get("locus_group") or "").strip(),
                ),
            }
            symbol = (row.get("symbol") or "").strip()
            if symbol:
                primary[symbol] = record
            for column in ("alias_symbol", "prev_symbol"):
                for alias in (row.get(column) or "").strip().strip('"').split("|"):
                    alias = alias.strip()
                    if alias and alias not in fallback:
                        fallback[alias] = record

    for alias, record in fallback.items():
        primary.setdefault(alias, record)
    return primary


def read_specificity(path: Path) -> dict[str, dict]:
    """symbol -> {peakClass, regions}，来自 rank_gene_specificity.py 的排名表。

    specificity 分数本身不导出：它在谱系相邻的共高场景下容易被读错，而候选行没有解释
    它的空间。峰值类别与覆盖脑区数是能独立看懂的两个事实。
    """
    table: dict[str, dict] = {}
    if not path.exists():
        return table

    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            symbol = (row.get("symbol") or "").strip()
            if not symbol:
                continue
            record: dict[str, object] = {}
            peak = (row.get("peak_cell_type") or "").strip()
            if peak:
                record["peakClass"] = peak
            try:
                regions = int(row.get("n_regions") or 0)
            except ValueError:
                regions = 0
            if regions > 0:
                record["regions"] = regions
            if record:
                table[symbol] = record
    return table


def read_payload_ensembl(genes_dir: Path, symbols: list[str]) -> dict[str, str]:
    """symbol -> ensembl，从每个单基因文件的开头取。缺文件或缺字段就跳过。"""
    found: dict[str, str] = {}
    for symbol in symbols:
        path = genes_dir / f"{symbol}.json"
        if not path.exists():
            continue
        with path.open("rb") as handle:
            head = handle.read(_HEAD_BYTES).decode("utf-8", errors="ignore")
        match = _ENSEMBL_RE.search(head)
        if match:
            found[symbol] = match.group(1)
    return found


def build_index(
    symbols: list[str],
    *,
    detail_genes: set[str] | None = None,
    hgnc: dict[str, dict] | None = None,
    specificity: dict[str, dict] | None = None,
    ensembl: dict[str, str] | None = None,
) -> dict:
    """列式索引。symbols 排序后即为所有列的位置键。"""
    detail_genes = detail_genes or set()
    hgnc = hgnc or {}
    specificity = specificity or {}
    ensembl = ensembl or {}

    ordered = sorted(symbols)
    biotypes: list[str] = []
    classes: list[str] = []

    def interned(vocabulary: list[str], value: str) -> int:
        """字典编码：缺失是 -1，而不是指向词表里的某一项。"""
        if not value:
            return -1
        if value not in vocabulary:
            vocabulary.append(value)
        return vocabulary.index(value)

    index = {
        "version": FORMAT_VERSION,
        "ensemblPrefix": ENSEMBL_PREFIX,
        "biotypes": biotypes,
        "classes": classes,
        "symbols": ordered,
        "ensembl": [],
        "names": [],
        "locations": [],
        "biotype": [],
        "peak": [],
        "regions": [],
        "detail": [],
    }
    for position, symbol in enumerate(ordered):
        annotation = hgnc.get(symbol) or {}
        ranking = specificity.get(symbol) or {}
        index["ensembl"].append(pack_ensembl(ensembl.get(symbol, "")))
        index["names"].append(annotation.get("name") or "")
        index["locations"].append(annotation.get("location") or "")
        index["biotype"].append(interned(biotypes, annotation.get("biotype") or ""))
        index["peak"].append(interned(classes, str(ranking.get("peakClass") or "")))
        index["regions"].append(int(ranking.get("regions") or 0))
        if symbol in detail_genes:
            index["detail"].append(position)
    return index


def write_index(payload_dir: Path, index: dict) -> Path:
    path = payload_dir / INDEX_FILE_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return path


def export(
    payload_dir: Path = DEFAULT_PAYLOAD_DIR,
    hgnc_table: Path = DEFAULT_HGNC_TABLE,
    specificity_table: Path = DEFAULT_SPECIFICITY,
) -> dict[str, int]:
    index_path = payload_dir / "index.json"
    if not index_path.exists():
        raise FileNotFoundError(f"no gene payload to annotate: {index_path}")
    payload_index = json.loads(index_path.read_text(encoding="utf-8"))
    symbols = sorted((payload_index.get("genes") or {}).keys())
    detail_genes = set(payload_index.get("detailGenes") or [])

    index = build_index(
        symbols,
        detail_genes=detail_genes,
        hgnc=read_hgnc(hgnc_table),
        specificity=read_specificity(specificity_table),
        ensembl=read_payload_ensembl(payload_dir / "genes", symbols),
    )
    written = write_index(payload_dir, index)

    return {
        "symbols": len(symbols),
        "named": sum(1 for name in index["names"] if name),
        "identified": sum(1 for value in index["ensembl"] if value),
        "detail": len(index["detail"]),
        "bytes": written.stat().st_size,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export the gene search index for the search dropdown."
    )
    parser.add_argument("--payload-dir", type=Path, default=DEFAULT_PAYLOAD_DIR)
    parser.add_argument("--hgnc-table", type=Path, default=DEFAULT_HGNC_TABLE)
    parser.add_argument("--specificity-table", type=Path, default=DEFAULT_SPECIFICITY)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        stats = export(args.payload_dir, args.hgnc_table, args.specificity_table)
    except FileNotFoundError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(
        f"done: {stats['symbols']} genes indexed "
        f"({stats['named']} named, {stats['identified']} with an Ensembl id, "
        f"{stats['detail']} with cell-class detail) "
        f"in {stats['bytes'] / 1e6:.2f} MB",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
