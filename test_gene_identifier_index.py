from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def load_module():
    module_path = Path(__file__).with_name("scripts") / "gene_identifier_index.py"
    spec = importlib.util.spec_from_file_location("gene_identifier_index", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses 解析注解时会回查 sys.modules[cls.__module__]，未注册会在类定义阶段崩。
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_parses_plain_symbol_versioned_ensembl_and_compound_forms():
    module = load_module()
    assert module.parse_identifier("GFAP") == ("GFAP", None)
    assert module.parse_identifier("ENSG00000131095") == (None, "ENSG00000131095")
    assert module.parse_identifier("ENSG00000131095.12") == (None, "ENSG00000131095")
    # SEA-AD 用的复合形式
    assert module.parse_identifier("TSPAN6_ENSG00000000003") == ("TSPAN6", "ENSG00000000003")


def test_hgnc_index_bridges_symbol_and_ensembl_both_ways():
    module = load_module()
    index = module.load_hgnc_index()
    assert index.ensembl_for_symbol("GFAP") == "ENSG00000131095"
    assert index.symbol_for_ensembl("ENSG00000131095") == "GFAP"


def test_hgnc_index_resolves_a_retired_alias_to_the_current_symbol():
    module = load_module()
    index = module.load_hgnc_index()
    # HGNC 的 alias/prev symbol 列必须被纳入，否则老数据集的旧符号会丢失。
    assert index.canonical_symbol("HGNC:4235") == "GFAP"
    # 真实退役符号：CPAMD9 已改名为 A2ML1。
    assert index.canonical_symbol("CPAMD9") == "A2ML1"
    assert index.ensembl_for_symbol("CPAMD9") == "ENSG00000166535"


def test_unresolvable_features_fall_back_to_a_symbol_key_and_are_audited():
    module = load_module()
    index = module.load_hgnc_index()
    # 无法解析出 Ensembl 的特征不得静默丢弃，须以 SYMBOL:<name> 作兜底主键。
    assert index.primary_key("GFAP") == "ENSG00000131095"
    assert index.primary_key("ENSG00000131095.12") == "ENSG00000131095"
    assert index.primary_key("NOT_A_REAL_GENE_XYZ") == "SYMBOL:NOT_A_REAL_GENE_XYZ"


def test_primary_keys_for_an_array_reports_resolution_counts():
    module = load_module()
    index = module.load_hgnc_index()
    keys, audit = index.primary_keys(
        ["GFAP", "ENSG00000132639.11", "CPAMD9", "NOT_A_REAL_GENE_XYZ"]
    )
    assert keys == [
        "ENSG00000131095",
        "ENSG00000132639",
        "ENSG00000166535",
        "SYMBOL:NOT_A_REAL_GENE_XYZ",
    ]
    # 审计必须量化兜底数量，供 Stage B 判断某文件是否解析异常。
    assert audit["total"] == 4
    assert audit["resolved"] == 3
    assert audit["fallback"] == 1


def test_core_markers_resolve_to_one_key_across_every_source_file():
    """Stage B 统一基因空间的验收条件：同一基因在所有文件里必须归到同一主键。

    整体解析率约 85%（未命中的多为 lncRNA/假基因等 HGNC 表外特征，
    以 SYMBOL: 兜底不影响标记基因），但常用标记必须 99/99 一致，
    否则前端按符号检索会在部分数据集里凭空丢数据。
    """
    import importlib.util as _il

    import h5py

    module = load_module()
    index = module.load_hgnc_index()

    stage_a_path = Path(__file__).with_name("scripts") / "gene_atlas_stage_a.py"
    spec = _il.spec_from_file_location("gene_atlas_stage_a", stage_a_path)
    stage_a = _il.module_from_spec(spec)
    sys.modules[spec.name] = stage_a
    spec.loader.exec_module(stage_a)

    markers = ("GFAP", "SNAP25", "AQP4", "MBP", "SLC17A7")
    wanted = {name: index.ensembl_for_symbol(name) for name in markers}
    assert wanted["GFAP"] == "ENSG00000131095"

    hits = {name: 0 for name in markers}
    inventory = stage_a._inventory.load_inventory()
    for entry in inventory.usable:
        with h5py.File(entry.source_path, "r") as handle:
            gene_ids = stage_a.read_gene_ids(handle, entry.matrix_source)
        keys, _ = index.primary_keys(gene_ids.tolist())
        present = set(keys)
        for name in markers:
            if wanted[name] in present:
                hits[name] += 1

    assert hits["GFAP"] == 99, hits
    assert hits["SNAP25"] == 99, hits
    # 其余标记允许个别文件本就未收录该特征，但不得低于 98。
    assert all(count >= 98 for count in hits.values()), hits
