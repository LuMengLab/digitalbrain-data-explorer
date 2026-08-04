from __future__ import annotations

import dataclasses
import importlib.util
import sys
from pathlib import Path


def load_module():
    module_path = Path(__file__).with_name("scripts") / "run_gene_atlas_stage_a.py"
    spec = importlib.util.spec_from_file_location("run_gene_atlas_stage_a", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses 解析注解时会回查 sys.modules[cls.__module__]，未注册会在类定义阶段崩。
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_cli_skips_files_whose_cache_already_exists(tmp_path):
    module = load_module()
    entry = module.load_inventory().usable[0]
    cache = tmp_path / f"{entry.file_id}.npz"
    cache.write_bytes(b"placeholder")
    todo = module.pending_entries(module.load_inventory(), tmp_path)
    assert entry.file_id not in {e.file_id for e in todo}


def test_cli_reports_every_usable_file_as_pending_on_empty_cache(tmp_path):
    module = load_module()
    inv = module.load_inventory()
    assert len(module.pending_entries(inv, tmp_path)) == 99


def test_a_single_broken_file_is_recorded_without_aborting_the_batch(tmp_path):
    """一个坏文件不得拖垮整批 1.6 小时的运行。

    summarise_one 必须把异常收成结果记录返回，由 main() 汇总后以非零码退出。
    """
    module = load_module()
    good = module.load_inventory().usable[0]
    broken = dataclasses.replace(good, source_path="/nonexistent/does_not_exist.h5ad")

    outcome = module.summarise_one(broken, tmp_path)

    assert outcome.ok is False
    assert outcome.file_id == broken.file_id
    assert outcome.error  # 失败原因必须可读，便于事后定位
    assert not (tmp_path / f"{broken.file_id}.npz").exists()


def test_summarise_one_writes_a_cache_file_on_success(tmp_path):
    module = load_module()
    entry = next(
        e
        for e in module.load_inventory().usable
        if e.file_id == "ec_stream_region_at_14_days_of_age_filtered_e4fde89832"
    )

    outcome = module.summarise_one(entry, tmp_path)

    assert outcome.ok is True, outcome.error
    assert (tmp_path / f"{entry.file_id}.npz").exists()
    assert outcome.n_groups == 17
    assert outcome.n_cells == 7_588
    # 落盘后该条目即视为已完成，续跑时不应再排进待办。
    assert module.pending_entries(module.load_inventory(), tmp_path) != []
    assert entry.file_id not in {
        e.file_id for e in module.pending_entries(module.load_inventory(), tmp_path)
    }
    # 写完必须可回读，且不遗留临时文件。
    restored = module._stage_a.read_cache(tmp_path / f"{entry.file_id}.npz")
    assert int(restored.n_cells.sum()) == 7_588
    assert list(tmp_path.glob("*.partial")) == []


def test_a_truncated_cache_is_not_mistaken_for_a_finished_file(tmp_path):
    """长任务中途被杀会留下未完成的临时文件。

    写入走 .partial 临时名 + 原子重命名，因此临时文件不得被续跑认为已完成，
    否则会静默采用截断的坏缓存。
    """
    module = load_module()
    entry = module.load_inventory().usable[0]
    (tmp_path / f"{entry.file_id}.npz.partial").write_bytes(b"truncated")

    todo = {e.file_id for e in module.pending_entries(module.load_inventory(), tmp_path)}
    assert entry.file_id in todo
