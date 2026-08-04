from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def load_module():
    module_path = Path(__file__).with_name("scripts") / "export_gene_atlas_web.py"
    spec = importlib.util.spec_from_file_location("export_gene_atlas_web", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolve annotations against sys.modules[cls.__module__]; register first.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_stage_b():
    module_path = Path(__file__).with_name("scripts") / "gene_atlas_stage_b.py"
    spec = importlib.util.spec_from_file_location("gene_atlas_stage_b", module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# A stand-in for HgncIndex that only implements what export() consults, so the test
# does not have to load the 45k-row vendor table.
class FakeIndex:
    def __init__(self, symbol_to_ensembl):
        self._s2e = dict(symbol_to_ensembl)

    def ensembl_for_symbol(self, symbol):
        return self._s2e.get(symbol)


def gfap_rows(stage_b):
    row = stage_b.CacheRow
    key = "ENSG00000131095"
    # EC has Astrocyte (two donors) + Microglia; SWM only Astrocyte. No Pn anywhere,
    # so Pn must be absent from the payload rather than written as a zero.
    return [
        row(dataset="d1", donor="A", region="EC", cell_type="Astrocyte", gene=key,
            mean=1.0, detection=0.2, n_cells=10),
        row(dataset="d1", donor="B", region="EC", cell_type="Astrocyte", gene=key,
            mean=4.0, detection=0.6, n_cells=30),
        row(dataset="d1", donor="A", region="EC", cell_type="Microglia", gene=key,
            mean=0.4, detection=0.1, n_cells=10),
        row(dataset="d2", donor="C", region="SWM", cell_type="Astrocyte", gene=key,
            mean=2.0, detection=0.5, n_cells=20),
    ]


def make_provider(rows):
    def provider(index, wanted_keys):
        return [r for r in rows if r.gene in wanted_keys]

    return provider


SCOPE = {
    "datasets": 99,
    "cells": 16_247_724,
    "excludedDatasets": 10,
    "excludedCells": 104_399,
}
CELL_TYPES = ["Astrocyte", "Microglia", "Oligodendrocyte"]


def run_export(module, tmp_path, genes=("GFAP",), detail_genes=("GFAP",)):
    stage_b = load_stage_b()
    module.export(
        genes=list(genes),
        out_dir=tmp_path,
        detail_genes=set(detail_genes),
        index=FakeIndex({"GFAP": "ENSG00000131095", "SNAP25": "ENSG00000132639"}),
        rows_provider=make_provider(gfap_rows(stage_b)),
        scope=SCOPE,
        cell_types=CELL_TYPES,
    )


def test_export_writes_a_region_file_per_gene_plus_an_index(tmp_path):
    module = load_module()
    run_export(module, tmp_path, genes=["GFAP", "SNAP25"])
    assert (tmp_path / "index.json").exists()
    assert (tmp_path / "genes" / "GFAP.json").exists()
    # SNAP25 was requested but has no rows: neither written nor indexed. An empty file
    # would read as "measured, not expressed", which is false.
    assert not (tmp_path / "genes" / "SNAP25.json").exists()
    index = json.loads((tmp_path / "index.json").read_text())
    assert "GFAP" in index["genes"]
    assert "SNAP25" not in index["genes"]


def test_index_declares_scope_and_detail_genes(tmp_path):
    module = load_module()
    run_export(module, tmp_path)
    index = json.loads((tmp_path / "index.json").read_text())
    assert index["scope"] == SCOPE
    assert index["metrics"] == ["mean", "detection"]
    assert index["rules"] == ["cell_weighted", "donor_balanced"]
    assert index["cellTypes"] == CELL_TYPES
    assert index["genes"]["GFAP"] == "genes/GFAP.json"
    # The frontend needs to know which genes carry a cell-type breakdown before it
    # offers the cell-type filter / detail panel for them.
    assert index["detailGenes"] == ["GFAP"]


def test_region_file_is_region_level_only_and_flags_detail(tmp_path):
    module = load_module()
    run_export(module, tmp_path)
    payload = json.loads((tmp_path / "genes" / "GFAP.json").read_text())
    assert payload["symbol"] == "GFAP"
    assert payload["ensembl"] == "ENSG00000131095"
    # Whole-transcriptome colouring only needs region level, so the heavy per-cell-type
    # block must NOT be inlined here (that is what keeps 19k genes under the size cap).
    for rule in ("cell_weighted", "donor_balanced"):
        block = payload[rule]
        assert "EC" in block["regions"]["mean"]
        assert "EC" in block["regions"]["detection"]
        assert "cellTypes" not in block
    # support is at the top level (rule-independent), not duplicated per rule.
    assert payload["support"]["EC"]["cells"] > 0
    assert payload["hasDetail"] is True


def test_detail_file_carries_the_cell_type_breakdown(tmp_path):
    module = load_module()
    run_export(module, tmp_path)
    detail = json.loads((tmp_path / "genes" / "GFAP.detail.json").read_text())
    assert detail["symbol"] == "GFAP"
    for rule in ("cell_weighted", "donor_balanced"):
        ec = detail[rule]["cellTypes"]["EC"]
        assert "mean" in ec["Astrocyte"] and "detection" in ec["Astrocyte"]
        # cells must ride along or the frontend cannot do a cell_weighted subset.
        assert ec["Astrocyte"]["cells"] > 0


def test_a_gene_without_detail_has_no_detail_file_and_flags_false(tmp_path):
    module = load_module()
    run_export(module, tmp_path, genes=["GFAP"], detail_genes=[])
    payload = json.loads((tmp_path / "genes" / "GFAP.json").read_text())
    assert payload["hasDetail"] is False
    assert not (tmp_path / "genes" / "GFAP.detail.json").exists()
    index = json.loads((tmp_path / "index.json").read_text())
    assert index["detailGenes"] == []


def test_cell_weighted_region_value_matches_the_closed_form(tmp_path):
    module = load_module()
    run_export(module, tmp_path)
    payload = json.loads((tmp_path / "genes" / "GFAP.json").read_text())
    # EC region = ((EC Astrocyte 3.25 * 40) + (EC Microglia 0.4 * 10)) / 50 = 2.68
    assert payload["cell_weighted"]["regions"]["mean"]["EC"] == 2.68
    detail = json.loads((tmp_path / "genes" / "GFAP.detail.json").read_text())
    # EC Astrocyte cell-weighted = (1*10 + 4*30) / 40 = 3.25
    assert detail["cell_weighted"]["cellTypes"]["EC"]["Astrocyte"]["mean"] == 3.25


def test_absent_region_cell_type_combos_are_omitted_not_zero(tmp_path):
    module = load_module()
    run_export(module, tmp_path)
    payload = json.loads((tmp_path / "genes" / "GFAP.json").read_text())
    detail = json.loads((tmp_path / "genes" / "GFAP.detail.json").read_text())
    # SWM has no Microglia and Pn has nothing at all: absent, never a zero.
    assert "Microglia" not in detail["cell_weighted"]["cellTypes"]["SWM"]
    assert "Pn" not in payload["cell_weighted"]["regions"]["mean"]


def test_protein_coding_symbols_filters_by_locus_group():
    module = load_module()
    symbols = module.protein_coding_symbols()
    # HGNC lists 19,296 protein-coding genes; non-coding / pseudogenes are dropped.
    assert 18_000 < len(symbols) < 21_000
    assert "GFAP" in symbols
    # A well-known lncRNA must not appear in the coding list.
    assert "MALAT1" not in symbols


def test_read_symbol_list_skips_comments_and_blanks(tmp_path):
    module = load_module()
    listing = tmp_path / "genes.txt"
    listing.write_text("# a comment\n\nGFAP\n  SNAP25  \n# tail\nGFAP\n", encoding="utf-8")
    assert module.read_symbol_list(listing) == ["GFAP", "SNAP25"]


def test_shipped_detail_gene_list_is_a_usable_subset():
    module = load_module()
    detail = module.read_symbol_list(module.DEFAULT_DETAIL_LIST)
    coding = set(module.protein_coding_symbols())
    # Small enough to stay well inside the size budget at ~350 KB per gene.
    assert 40 < len(detail) < 400
    # Every entry must be a current HGNC approved symbol, otherwise it silently
    # exports nothing and the detail panel is mysteriously unavailable.
    unknown = [symbol for symbol in detail if symbol not in coding]
    assert unknown == [], f"not HGNC protein-coding symbols: {unknown}"
    assert "GFAP" in detail


def test_cli_defaults_to_the_shipped_detail_list_not_every_gene(tmp_path, monkeypatch):
    """守卫体积失控：detail 缺省不得是「所有基因」。

    export(detail_genes=None) 意为全带详情；若 CLI 不传该参数，全编码导出会从
    ~300 MB 膨到 ~7 GB，直接破 GitHub Pages 限额。
    """
    module = load_module()
    seen = {}

    def fake_export(genes, out_dir, **kwargs):
        seen["detail_genes"] = kwargs.get("detail_genes")
        return []

    monkeypatch.setattr(module, "export", fake_export)
    monkeypatch.setattr(module, "write_index_file", lambda *a, **k: {})

    gene_list = tmp_path / "g.txt"
    gene_list.write_text("GFAP\n", encoding="utf-8")
    module.main(["--out-dir", str(tmp_path), "--gene-list", str(gene_list)])

    detail = seen["detail_genes"]
    assert detail is not None, "CLI must pin an explicit detail subset"
    assert isinstance(detail, set)
    assert "GFAP" in detail
