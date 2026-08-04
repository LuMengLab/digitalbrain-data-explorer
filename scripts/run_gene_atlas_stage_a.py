"""Stage A 批量执行器：按文件粒度并行，支持中断续跑。

预算（已实测）：99 个文件、563 亿非零值、需读 553 GiB，吞吐约 224 MiB/s，
单进程约 1.6 小时，--workers 4 约 25 分钟。
若单文件耗时远超 nnz / 1e7 秒，多半是误走了整载路径，应停下来查。

并行只在文件之间做——文件内部的稀疏矩阵乘法已由底层库用上多核，
再嵌一层并行只会互相抢核。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load_sibling(name: str):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, _HERE / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_inventory = _load_sibling("gene_atlas_inventory")
_stage_a = _load_sibling("gene_atlas_stage_a")

load_inventory = _inventory.load_inventory

DEFAULT_CACHE_DIR = Path("gene_atlas_cache/stage_a")


@dataclass(frozen=True)
class Outcome:
    file_id: str
    ok: bool
    elapsed: float
    n_groups: int = 0
    n_genes: int = 0
    n_cells: int = 0
    error: str = ""


def pending_entries(inventory, cache_dir: Path) -> list:
    """过滤掉已有缓存的条目，使中断后可以直接续跑。"""
    cache_dir = Path(cache_dir)
    return [
        entry
        for entry in inventory.usable
        if not _stage_a.cache_path(cache_dir, entry.file_id).exists()
    ]


def summarise_one(entry, cache_dir: Path) -> Outcome:
    """汇总单个文件并落盘。异常收成 Outcome 返回，绝不向上抛。

    一个坏文件不能拖垮整批运行；失败清单由 main() 汇总后以非零码退出。
    """
    started = time.time()
    try:
        result = _stage_a.summarise_source_file(entry)
        _stage_a.write_cache(result, cache_dir)
        return Outcome(
            file_id=entry.file_id,
            ok=True,
            elapsed=time.time() - started,
            n_groups=len(result.group_keys),
            n_genes=int(result.gene_ids.shape[0]),
            n_cells=int(result.n_cells.sum()),
        )
    except Exception:
        return Outcome(
            file_id=entry.file_id,
            ok=False,
            elapsed=time.time() - started,
            error=traceback.format_exc(limit=6),
        )


def _report(done: int, total: int, outcome: Outcome) -> None:
    if outcome.ok:
        print(
            f"[{done}/{total}] {outcome.file_id} "
            f"groups={outcome.n_groups} genes={outcome.n_genes} "
            f"cells={outcome.n_cells} elapsed={outcome.elapsed:.1f}s",
            flush=True,
        )
    else:
        print(
            f"[{done}/{total}] FAILED {outcome.file_id} "
            f"elapsed={outcome.elapsed:.1f}s\n{outcome.error}",
            flush=True,
        )


def run(entries: list, cache_dir: Path, workers: int) -> list[Outcome]:
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    total = len(entries)
    outcomes: list[Outcome] = []

    if workers <= 1:
        for done, entry in enumerate(entries, start=1):
            outcome = summarise_one(entry, cache_dir)
            _report(done, total, outcome)
            outcomes.append(outcome)
        return outcomes

    with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(summarise_one, entry, cache_dir) for entry in entries]
        for done, future in enumerate(
            concurrent.futures.as_completed(futures), start=1
        ):
            outcome = future.result()
            _report(done, total, outcome)
            outcomes.append(outcome)
    return outcomes


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Stage A over all usable sources.")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument(
        "--limit", type=int, default=None, help="只处理前 N 个待办文件（冒烟用）"
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    inventory = load_inventory()
    entries = pending_entries(inventory, args.cache_dir)
    if args.limit is not None:
        entries = entries[: args.limit]

    print(
        f"stage A: {len(entries)} pending of {len(inventory.usable)} usable "
        f"-> {args.cache_dir} (workers={args.workers})",
        flush=True,
    )
    if not entries:
        print("nothing to do", flush=True)
        return 0

    started = time.time()
    outcomes = run(entries, args.cache_dir, args.workers)
    failures = [o for o in outcomes if not o.ok]

    print(
        f"done in {time.time() - started:.1f}s: "
        f"{len(outcomes) - len(failures)} ok, {len(failures)} failed",
        flush=True,
    )
    for outcome in failures:
        print(f"  FAILED {outcome.file_id}", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
