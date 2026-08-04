"""基因标识符双向解析：符号 <-> Ensembl，主键统一为 Ensembl ID。

实测 99 个源文件中 44 个主键为 Ensembl（另有 feature_name 提供符号），
55 个主键即符号（其中 54 个无独立符号字段），因此必须双向解析。
桥接表为 data/vendor/hgnc_complete_set.txt。

解析不出 Ensembl 的特征以 SYMBOL:<name> 作兜底主键并计入审计，
绝不静默丢弃——静默丢弃会让某个基因在部分数据集里凭空消失。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

HGNC_TABLE = Path(__file__).resolve().parent.parent / "data" / "vendor" / "hgnc_complete_set.txt"

# ENSG00000131095 / ENSG00000131095.12
_ENSEMBL_RE = re.compile(r"^(ENS[A-Z]*G\d{5,})(?:\.\d+)?$")
# SEA-AD 的复合形式：TSPAN6_ENSG00000000003
_COMPOUND_RE = re.compile(r"^(.+)_(ENS[A-Z]*G\d{5,})(?:\.\d+)?$")


def parse_identifier(value: str) -> tuple[str | None, str | None]:
    """把一个 var 主键拆成 (符号, Ensembl)，缺失的一侧为 None。

    三级匹配：复合形式 -> 纯 Ensembl（可带版本号）-> 裸符号。
    """
    text = str(value).strip()

    compound = _COMPOUND_RE.match(text)
    if compound:
        return compound.group(1), compound.group(2)

    ensembl = _ENSEMBL_RE.match(text)
    if ensembl:
        return None, ensembl.group(1)

    return text, None


def _split_multi(value: str) -> list[str]:
    """HGNC 的 alias_symbol / prev_symbol 用竖线分隔，且可能带引号。"""
    text = value.strip().strip('"')
    if not text:
        return []
    return [part.strip().strip('"') for part in text.split("|") if part.strip()]


@dataclass
class HgncIndex:
    symbol_to_ensembl: dict[str, str] = field(default_factory=dict)
    ensembl_to_symbol: dict[str, str] = field(default_factory=dict)
    alias_to_symbol: dict[str, str] = field(default_factory=dict)
    hgnc_to_symbol: dict[str, str] = field(default_factory=dict)

    def canonical_symbol(self, value: str) -> str | None:
        """把 HGNC id / 别名 / 退役符号 归一到当前批准符号。"""
        text = str(value).strip()
        if text in self.hgnc_to_symbol:
            return self.hgnc_to_symbol[text]
        if text in self.symbol_to_ensembl:
            return text
        if text in self.alias_to_symbol:
            return self.alias_to_symbol[text]
        # 大小写不敏感兜底：源数据里存在大小写不一致的符号。
        upper = text.upper()
        if upper in self.symbol_to_ensembl:
            return upper
        return self.alias_to_symbol.get(upper)

    def ensembl_for_symbol(self, symbol: str) -> str | None:
        canonical = self.canonical_symbol(symbol)
        if canonical is None:
            return None
        return self.symbol_to_ensembl.get(canonical)

    def symbol_for_ensembl(self, ensembl: str) -> str | None:
        _, parsed = parse_identifier(ensembl)
        key = parsed or str(ensembl).strip()
        return self.ensembl_to_symbol.get(key)

    def primary_key(self, value: str) -> str:
        """统一主键：能解析出 Ensembl 就用它，否则 SYMBOL:<name> 兜底。"""
        symbol, ensembl = parse_identifier(value)
        if ensembl:
            return ensembl
        if symbol:
            resolved = self.ensembl_for_symbol(symbol)
            if resolved:
                return resolved
            return f"SYMBOL:{symbol}"
        return f"SYMBOL:{value}"

    def primary_keys(self, values) -> tuple[list[str], dict[str, int]]:
        """批量解析并返回审计计数，供 Stage B 判断某文件是否解析异常。"""
        keys = [self.primary_key(v) for v in values]
        fallback = sum(1 for k in keys if k.startswith("SYMBOL:"))
        audit = {
            "total": len(keys),
            "resolved": len(keys) - fallback,
            "fallback": fallback,
        }
        return keys, audit


def load_hgnc_index(table_path: Path = HGNC_TABLE) -> HgncIndex:
    index = HgncIndex()

    with open(table_path, "r", encoding="utf-8") as handle:
        header = handle.readline().rstrip("\n").split("\t")
        column = {name: i for i, name in enumerate(header)}
        need = ("hgnc_id", "symbol", "ensembl_gene_id", "alias_symbol", "prev_symbol")
        missing = [name for name in need if name not in column]
        if missing:
            raise ValueError(f"hgnc table lacks columns {missing}")

        for line in handle:
            row = line.rstrip("\n").split("\t")
            if len(row) <= column["symbol"]:
                continue

            symbol = row[column["symbol"]].strip()
            if not symbol:
                continue
            hgnc_id = row[column["hgnc_id"]].strip()
            ensembl = (
                row[column["ensembl_gene_id"]].strip()
                if len(row) > column["ensembl_gene_id"]
                else ""
            )

            if hgnc_id:
                index.hgnc_to_symbol[hgnc_id] = symbol
            if ensembl:
                index.symbol_to_ensembl[symbol] = ensembl
                # 一个 Ensembl 可能被多行引用，首次出现的批准符号优先。
                index.ensembl_to_symbol.setdefault(ensembl, symbol)
            else:
                index.symbol_to_ensembl.setdefault(symbol, "")

            for key in ("alias_symbol", "prev_symbol"):
                if len(row) <= column[key]:
                    continue
                for alias in _split_multi(row[column[key]]):
                    # 批准符号优先，别名不得覆盖已存在的批准符号。
                    if alias not in index.symbol_to_ensembl:
                        index.alias_to_symbol.setdefault(alias, symbol)

    # 清掉没有 Ensembl 的占位空值，避免 ensembl_for_symbol 返回空串。
    index.symbol_to_ensembl = {
        symbol: ensembl for symbol, ensembl in index.symbol_to_ensembl.items() if ensembl
    }
    return index
