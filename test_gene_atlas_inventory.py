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
