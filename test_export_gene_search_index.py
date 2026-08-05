"""scripts/export_gene_search_index.py 的单元测试。

关注四件事：列式结构逐位对齐（错位一格，整张表的注释就全部挂到别的基因上）、字段来源
正确（尤其 ensembl 以载荷为准而非 HGNC 表）、ENSG 前缀能被前端还原、缺失写空位不写占位
值。19k 个真实文件不进测试，构造最小载荷即可。
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory


def load_module():
    module_path = Path(__file__).with_name("scripts") / "export_gene_search_index.py"
    spec = importlib.util.spec_from_file_location("export_gene_search_index", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HGNC_HEADER = "hgnc_id\tsymbol\tname\tlocus_group\tlocation\talias_symbol\tprev_symbol\n"


def write_hgnc(path: Path, rows: list[tuple[str, str, str, str, str, str]]) -> None:
    lines = [HGNC_HEADER]
    for symbol, name, locus_group, location, alias, prev in rows:
        lines.append(f"HGNC:1\t{symbol}\t{name}\t{locus_group}\t{location}\t{alias}\t{prev}\n")
    path.write_text("".join(lines), encoding="utf-8")


def write_specificity(path: Path, rows: list[tuple[str, str, str]]) -> None:
    lines = ["symbol,eligible,specificity,peak_cell_type,peak_value,peak_regions,combos,n_cell_types,n_regions\n"]
    for symbol, peak, regions in rows:
        lines.append(f"{symbol},yes,10.0,{peak},1.0,10,100,31,{regions}\n")
    path.write_text("".join(lines), encoding="utf-8")


def _payload(root: Path) -> Path:
    payload = root / "gene_atlas_web"
    (payload / "genes").mkdir(parents=True)
    payload.joinpath("index.json").write_text(
        json.dumps(
            {
                "genes": {
                    "GFAP": "genes/GFAP.json",
                    "SNAP25": "genes/SNAP25.json",
                    "7SK": "genes/7SK.json",
                },
                "detailGenes": ["GFAP"],
            }
        ),
        encoding="utf-8",
    )
    for symbol, ensembl in (
        ("GFAP", "ENSG00000131095"),
        ("SNAP25", "ENSG00000132639"),
        ("7SK", "ENSG00000283293"),
    ):
        payload.joinpath("genes", f"{symbol}.json").write_text(
            json.dumps({"symbol": symbol, "ensembl": ensembl, "hasDetail": False}),
            encoding="utf-8",
        )
    return payload


def read_index(payload: Path) -> dict:
    return json.loads((payload / "search-index.json").read_text(encoding="utf-8"))


def column(index: dict, name: str, symbol: str):
    """按 symbols 的位置取某一列——列式索引唯一正确的读法。"""
    return index[name][index["symbols"].index(symbol)]


def test_pack_ensembl_is_reversible_by_the_frontend_rule():
    module = load_module()
    # 去掉共同前缀存，前端凭「是否以 ENS 开头」还原。
    assert module.pack_ensembl("ENSG00000131095") == "131095"
    prefix = module.ENSEMBL_PREFIX
    assert prefix + module.pack_ensembl("ENSG00000131095") == "ENSG00000131095"
    # 不符合前缀的原样保留，才不会被还原成一个不存在的 id。
    assert module.pack_ensembl("ENSMUSG00000020932") == "ENSMUSG00000020932"
    assert module.pack_ensembl("") == ""


def test_export_writes_one_aligned_index_with_every_source_joined():
    module = load_module()

    with TemporaryDirectory() as tmp_dir:
        root = Path(tmp_dir)
        payload = _payload(root)
        hgnc = root / "hgnc.txt"
        write_hgnc(
            hgnc,
            [
                ("GFAP", "glial fibrillary acidic protein", "protein-coding gene", "17q21.31", "", ""),
                ("SNAP25", "synaptosome associated protein 25", "protein-coding gene", "20p12.2", "", ""),
                ("RN7SK", "RNA component of 7SK", "non-coding RNA", "6p22.2", "7SK", ""),
            ],
        )
        specificity = root / "specificity.csv"
        write_specificity(specificity, [("GFAP", "Astrocyte", "163"), ("SNAP25", "Thalamic excitatory", "160")])

        stats = module.export(payload, hgnc, specificity)
        assert stats["symbols"] == 3
        assert stats["named"] == 3
        assert stats["identified"] == 3
        assert stats["detail"] == 1

        index = read_index(payload)
        # symbols 排序后是所有列的位置键；每一列都必须同长，否则注释会整体错位。
        assert index["symbols"] == ["7SK", "GFAP", "SNAP25"]
        for name in ("ensembl", "names", "locations", "biotype", "peak", "regions"):
            assert len(index[name]) == 3, name

        assert column(index, "ensembl", "GFAP") == "131095"
        assert column(index, "names", "GFAP") == "glial fibrillary acidic protein"
        assert column(index, "locations", "GFAP") == "17q21.31"
        assert index["biotypes"][column(index, "biotype", "GFAP")] == "protein-coding"
        assert index["classes"][column(index, "peak", "GFAP")] == "Astrocyte"
        assert column(index, "regions", "GFAP") == 163

        # 决定 Cell class 筛选可用性的那一位，只记导出了明细的基因，且记的是位置。
        assert index["detail"] == [index["symbols"].index("GFAP")]

        # 名称经别名列命中，否则这些基因在下拉框里没有名字。
        assert column(index, "names", "7SK") == "RNA component of 7SK"
        assert index["biotypes"][column(index, "biotype", "7SK")] == "ncRNA"


def test_missing_annotation_writes_an_empty_slot_not_a_placeholder():
    module = load_module()

    with TemporaryDirectory() as tmp_dir:
        root = Path(tmp_dir)
        payload = _payload(root)
        hgnc = root / "hgnc.txt"
        write_hgnc(hgnc, [])
        specificity = root / "specificity.csv"
        write_specificity(specificity, [])

        module.export(payload, hgnc, specificity)

        index = read_index(payload)
        # ensembl 来自载荷，所以它还在。
        assert column(index, "ensembl", "GFAP") == "131095"
        # 其余没有来源：写空位，且字典编码的两列用 -1 而不是指向词表第 0 项——那会把每个
        # 基因都标成同一个细胞类别。
        assert column(index, "names", "GFAP") == ""
        assert column(index, "locations", "GFAP") == ""
        assert column(index, "biotype", "GFAP") == -1
        assert column(index, "peak", "GFAP") == -1
        assert column(index, "regions", "GFAP") == 0
        assert index["classes"] == []


def test_ensembl_comes_from_the_payload_not_the_hgnc_table():
    """两处都有 ensembl，但只有载荷里的那个是这次构建真正用过的。"""
    module = load_module()

    with TemporaryDirectory() as tmp_dir:
        root = Path(tmp_dir)
        payload = _payload(root)
        payload.joinpath("genes", "GFAP.json").write_text(
            json.dumps({"symbol": "GFAP", "ensembl": "ENSG_PAYLOAD"}), encoding="utf-8"
        )
        hgnc = root / "hgnc.txt"
        write_hgnc(hgnc, [("GFAP", "glial fibrillary acidic protein", "protein-coding gene", "17q21.31", "", "")])
        specificity = root / "specificity.csv"
        write_specificity(specificity, [])

        module.export(payload, hgnc, specificity)

        assert column(read_index(payload), "ensembl", "GFAP") == "ENSG_PAYLOAD"


def test_export_without_a_payload_fails_loudly():
    """没有基因载荷就没有可注释的对象；静默产出空索引会让前端以为注释缺失。"""
    module = load_module()

    with TemporaryDirectory() as tmp_dir:
        try:
            module.export(Path(tmp_dir) / "missing")
        except FileNotFoundError:
            return
        raise AssertionError("a missing payload must raise")


def main():
    test_pack_ensembl_is_reversible_by_the_frontend_rule()
    print("PASS test_pack_ensembl_is_reversible_by_the_frontend_rule")
    test_export_writes_one_aligned_index_with_every_source_joined()
    print("PASS test_export_writes_one_aligned_index_with_every_source_joined")
    test_missing_annotation_writes_an_empty_slot_not_a_placeholder()
    print("PASS test_missing_annotation_writes_an_empty_slot_not_a_placeholder")
    test_ensembl_comes_from_the_payload_not_the_hgnc_table()
    print("PASS test_ensembl_comes_from_the_payload_not_the_hgnc_table")
    test_export_without_a_payload_fails_loudly()
    print("PASS test_export_without_a_payload_fails_loudly")


if __name__ == "__main__":
    main()
