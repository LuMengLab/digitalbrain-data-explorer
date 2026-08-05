"""`scripts/refresh_gene_index.py` 的契约测试：增量导出后索引要按磁盘实况重建。

背景：`export_gene_atlas_web.py --gene-list` 只跑一小批基因时会用这一批覆盖
index.json，把其余基因的映射清空。本脚本是那个坑的兜底，所以下面每条都在验
「重建后不丢基因、不造出假符号、不改披露字段」。
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_module():
    name = "refresh_gene_index"
    if name in sys.modules:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, HERE / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def build_out_dir(tmp_path, *, old_index=None):
    genes = tmp_path / "genes"
    genes.mkdir()
    for symbol, has_detail in (("ACTB", True), ("GAPDH", True), ("ZZZ3", False)):
        (genes / f"{symbol}.json").write_text(
            json.dumps({"symbol": symbol, "hasDetail": has_detail}), encoding="utf-8"
        )
        if has_detail:
            (genes / f"{symbol}.detail.json").write_text(
                json.dumps({"symbol": symbol, "cellTypes": {}}), encoding="utf-8"
            )
    if old_index is not None:
        (tmp_path / "index.json").write_text(json.dumps(old_index), encoding="utf-8")
    return tmp_path


def test_every_gene_file_on_disk_lands_in_the_index(tmp_path):
    module = load_module()
    out_dir = build_out_dir(tmp_path)

    doc = module.refresh(out_dir)

    assert sorted(doc["genes"]) == ["ACTB", "GAPDH", "ZZZ3"]
    assert doc["genes"]["ACTB"] == "genes/ACTB.json"
    assert doc["detailGenes"] == ["ACTB", "GAPDH"]


def test_detail_files_do_not_become_fake_symbols(tmp_path):
    module = load_module()
    out_dir = build_out_dir(tmp_path)

    symbols, detail = module.scan_symbols(out_dir / "genes")

    # "ACTB.detail" 会被前端拿去取一个不存在的文件，换来 404 和一个像故障的空面板。
    assert not [s for s in symbols if s.endswith(".detail")]
    assert detail == ["ACTB", "GAPDH"]


def test_an_orphan_detail_file_is_ignored(tmp_path):
    module = load_module()
    out_dir = build_out_dir(tmp_path)
    (out_dir / "genes" / "ORPHAN.detail.json").write_text("{}", encoding="utf-8")

    doc = module.refresh(out_dir)

    # 没有区域级文件的基因，前端根本走不到明细，列进去只会误导。
    assert "ORPHAN" not in doc["detailGenes"]
    assert "ORPHAN" not in doc["genes"]


def test_density_scale_and_scope_survive_the_rebuild(tmp_path):
    module = load_module()
    old = {
        "scope": {"note": "手写披露文案，不能被重建顺手改掉"},
        "cellTypes": ["Microglia", "Astrocyte"],
        "densityScale": {"mean": {"cell_weighted": 4.9}},
        "genes": {},
        "detailGenes": [],
    }
    out_dir = build_out_dir(tmp_path, old_index=old)

    doc = module.refresh(out_dir)

    # densityScale 由 compute_density_scale.py 单独算，重建不该把它清空。
    assert doc["densityScale"] == old["densityScale"]
    assert doc["scope"] == old["scope"]
    assert doc["cellTypes"] == old["cellTypes"]
    assert json.loads((out_dir / "index.json").read_text(encoding="utf-8")) == doc
