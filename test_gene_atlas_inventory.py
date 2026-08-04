from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def load_module():
    module_path = Path(__file__).with_name("scripts") / "gene_atlas_inventory.py"
    spec = importlib.util.spec_from_file_location("gene_atlas_inventory", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses 解析注解时会回查 sys.modules[cls.__module__]，未注册会在类定义阶段崩。
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_inventory_selects_only_files_with_counts():
    module = load_module()
    inv = module.load_inventory()

    # 109 个数据集中 99 个有 counts 矩阵，10 个 no_count_like_matrix_source。
    assert len(inv.usable) == 99
    assert len(inv.skipped) == 10
    assert all(e.matrix_source in ("X", "raw.X") or e.matrix_source.startswith("layer:")
               for e in inv.usable)


def test_inventory_records_resolved_field_names_per_file():
    module = load_module()
    inv = module.load_inventory()

    # 字段名逐文件解析，不可硬编码：细胞类型有两种取值。
    region_fields = {e.region_field for e in inv.usable}
    assert region_fields == {"atlas_ontology_term_Mod-Brodmann"}

    cell_type_fields = {e.cell_type_field for e in inv.usable}
    assert cell_type_fields == {"DigitalNeuron_cell_type", "supercluster_term"}

    counts = {}
    for entry in inv.usable:
        counts[entry.cell_type_field] = counts.get(entry.cell_type_field, 0) + 1
    assert counts["DigitalNeuron_cell_type"] == 97
    assert counts["supercluster_term"] == 2

    # donor 字段同样有两种取值（实测 46 / 53），硬编码 donor_id 会漏掉过半文件。
    donor_counts = {}
    for entry in inv.usable:
        donor_counts[entry.donor_field] = donor_counts.get(entry.donor_field, 0) + 1
    assert donor_counts == {"donor_id": 46, "publication_donor_id": 53}


def test_inventory_reports_excluded_cell_budget():
    module = load_module()
    inv = module.load_inventory()

    # Overview 页面 16,352,123 细胞；可用 16,247,724；差额 104,399（0.64%）须可披露。
    assert inv.explorer_cells == 16_352_123
    assert inv.usable_cells == 16_247_724
    assert inv.excluded_cells == 104_399


def test_every_usable_source_file_exists():
    module = load_module()
    inv = module.load_inventory()
    missing = [e.source_path for e in inv.usable if not Path(e.source_path).exists()]
    assert missing == []


def test_region_vocabulary_is_exactly_163_and_matches_atlas_axis():
    module = load_module()
    inv = module.load_inventory()
    vocab = module.collect_vocabularies(inv)

    # obs/atlas_ontology_term_Mod-Brodmann 在 99/99 文件中存在，
    # 全局取值恰为 163 区——脑区协调已在源文件内完成，无需自建映射。
    assert len(vocab.regions) == 163


def test_cell_type_vocabulary_matches_the_explorer_taxonomy():
    module = load_module()
    inv = module.load_inventory()
    vocab = module.collect_vocabularies(inv)

    # 源 obs 的细胞类型与 digitalneuron_data.js 的 31 类逐字相同，
    # 因此基因图层不需要任何归并映射。
    assert len(vocab.cell_types) == 31
    assert "Amygdala excitatory" in vocab.cell_types
    assert "Oligodendrocyte precursor" in vocab.cell_types
    # 上游二阶段 summary 的 11 类广义标签不属于本站口径，不应出现。
    assert "Glia, other" not in vocab.cell_types
    assert "Microglia/macrophage" not in vocab.cell_types


def test_cell_type_vocabulary_is_identical_to_digitalneuron_data_js():
    """「零映射」前提的直接守卫：源 obs 词表与 Overview 页面词表必须逐字相同。

    只断言个数与抽查两项不足以发现改名——一旦两侧出现任何差异，
    基因图层与 Overview 的口径就分裂了，必须在此炸掉。
    """
    import re

    module = load_module()
    vocab = module.collect_vocabularies(module.load_inventory())

    text = Path(__file__).with_name("digitalneuron_data.js").read_text(encoding="utf-8")
    explorer: set[str] = set()
    for block in re.findall(r'"cell_types":\s*\[(.*?)\]', text, re.S):
        explorer |= set(re.findall(r'"([^"]+)"', block))

    assert len(explorer) == 31
    assert explorer == set(vocab.cell_types)
