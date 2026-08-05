"""从已导出的基因产物算出点云密度标定表，并补写进 index.json。

标定表必须与它所量出的数据同版。`gene_atlas_web/` 被 gitignore，index.json 是
部署期产物，所以这里从产物重算，而不是把常量写死在代码里。

统计口径（设计文档 §4.2 与 §十）：只取**有几何映射的区内的非零值**——没有几何的
区永远画不出来，计入分位数只会歪掉标定；且只统计至少有 40 个非零区的基因，
少数几个区里测到的基因不构成语料样本。
"""
from __future__ import annotations

import argparse
import json
from array import array
from pathlib import Path

import numpy as np

RULES = ("cell_weighted", "donor_balanced")
METRICS = ("mean", "detection")
K = 12                    # 低段节点数，lowKnots 有 K + 1 项
LOW_QUANTILE = 0.90       # 低段分到语料底部 90% 的值
REFERENCE_QUANTILE = 0.9999  # 取 p99.99 而非 max：max 会把 24% 的量程让给离群值
MIN_NONZERO_REGIONS = 40
DIGITS = 6

WEB_DIR = Path(__file__).resolve().parent.parent
GEOMETRY_PATH = WEB_DIR / "interactive_brain_atlas" / "data" / "allen_3d_geometry.js"
EXPORT_DIR = WEB_DIR / "gene_atlas_web"


def read_mapped_acronyms(geometry_path=GEOMETRY_PATH) -> set:
    """取有 3D 几何的区名，即 atlas 有可能画出来的全部区。

    该文件是 `window.ALLEN_3D_ATLAS = {...};` 的 JS 赋值，截出 JSON 直接解析，
    不必为了读一个键去引 node。
    """
    text = Path(geometry_path).read_text(encoding="utf-8")
    atlas = json.loads(text[text.index("{"): text.rindex("}") + 1])
    return set(atlas["regionMappings"])


def _quantile(pooled, fraction: float) -> float:
    """取不超过该分位的最大**真实值**，而不是两个相邻值的线性插值。

    导出的基因值量化到 4 位小数。p99.99 落在尾部稀疏处，线性插值会在
    3.5091 与 3.5092 之间造出 3.509169 这样一个数据里不存在、且精度高于数据源
    的值。用 lower 使标定值始终落在实测取值格上（对应设计文档 §十 的实测表）。
    分位落在大量重复值区间时（低段节点与断点均如此），两种取法结果相同。
    """
    return float(np.quantile(pooled, fraction, method="lower"))


def _scale_for(pooled, metric: str) -> dict:
    breakpoint_ = round(_quantile(pooled, LOW_QUANTILE), DIGITS)
    # detection 是比率，语义上界本就是 1。用数据派生的分位会让同一个 0.95 在两个
    # 规则下渲染出不同密度，那是无意义的差别。
    reference = 1 if metric == "detection" else round(
        _quantile(pooled, REFERENCE_QUANTILE), DIGITS
    )
    knots = [0]
    for index in range(1, K + 1):
        knots.append(round(_quantile(pooled, (index / K) * LOW_QUANTILE), DIGITS))
    # 末节点就是断点本身，直接赋值以保证两者逐位相同。
    knots[K] = breakpoint_
    return {"breakpoint": breakpoint_, "reference": reference, "lowKnots": knots}


def density_scales(payloads, mapped_acronyms) -> dict:
    """按 `规则 × 指标` 各出一份标定。

    `payloads` 只被遍历一次，可以传生成器：全量 19k 个基因文件不必同时驻留内存。
    """
    pools = {rule: {metric: array("d") for metric in METRICS} for rule in RULES}
    for payload in payloads:
        for rule in RULES:
            regions = payload.get(rule, {}).get("regions", {})
            for metric in METRICS:
                values = [
                    value
                    for acronym, value in regions.get(metric, {}).items()
                    if acronym in mapped_acronyms
                    and isinstance(value, (int, float))
                    and value > 0
                ]
                if len(values) < MIN_NONZERO_REGIONS:
                    continue
                pools[rule][metric].extend(values)

    scales = {}
    for rule in RULES:
        scales[rule] = {}
        for metric in METRICS:
            pooled = pools[rule][metric]
            if not len(pooled):
                raise ValueError(f"no pooled values for {rule}/{metric}")
            scales[rule][metric] = _scale_for(np.frombuffer(pooled, dtype=np.float64), metric)
    return scales


def iter_payloads(genes_dir):
    """逐个产出基因产物；`*.detail.json` 是细胞类型明细，不参与区域级标定。"""
    for path in sorted(Path(genes_dir).glob("*.json")):
        if path.name.endswith(".detail.json"):
            continue
        yield json.loads(path.read_text(encoding="utf-8"))


def _report(scales) -> None:
    for rule in RULES:
        for metric in METRICS:
            scale = scales[rule][metric]
            print(f"{rule}/{metric}: breakpoint={scale['breakpoint']} reference={scale['reference']}")
            print(f"  lowKnots={scale['lowKnots']}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="补写 index.json 的 densityScale")
    parser.add_argument("--export-dir", type=Path, default=EXPORT_DIR)
    parser.add_argument(
        "--check", action="store_true",
        help="只比对不改写，有偏差退出码 1",
    )
    args = parser.parse_args(argv)

    index_path = args.export_dir / "index.json"
    scales = density_scales(iter_payloads(args.export_dir / "genes"), read_mapped_acronyms())
    _report(scales)

    index = json.loads(index_path.read_text(encoding="utf-8"))
    if args.check:
        if index.get("densityScale") != scales:
            print("densityScale 与产物不一致：index.json 需要重新补写")
            return 1
        print("densityScale 与产物一致")
        return 0

    index["densityScale"] = scales
    index_path.write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    print(f"已写入 {index_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
