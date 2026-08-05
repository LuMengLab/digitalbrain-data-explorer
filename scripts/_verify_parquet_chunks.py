"""验证用：把 Stage A npz 缓存展平成 donor 级长表 Parquet 分块。

行语义与 gene_atlas_stage_b.rows_from_cache 完全一致：
- 跳过 n_cells<=0 的组；
- 跳过 mean==0 且 detection==0 的 (group, gene) 组合；
- 基因主键经 hgnc 索引统一（Ensembl 优先）。

每行同时携带原值与量化候选列，供后续同口径体积对比：
- mean_f32 / det_f32     原值（当前 npz 的精度）
- mean_f16 / det_u8      量化候选（det_u8 = round(det*255)）
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path("/data/DigitalBrain/data/scBrain/web")
sys.path.insert(0, str(ROOT / "scripts"))

import gene_identifier_index  # noqa: E402

CACHE = ROOT / "gene_atlas_cache" / "stage_a"
OUT = ROOT / "gene_atlas_cache" / "parquet_verify" / "chunks"
OUT.mkdir(parents=True, exist_ok=True)

SCHEMA = pa.schema([
    ("gene", pa.string()),
    ("dataset", pa.string()),
    ("donor", pa.string()),
    ("region", pa.string()),
    ("region_gyral", pa.string()),
    ("cell_type", pa.string()),
    ("mean_f32", pa.float32()),
    ("mean_f16", pa.float16()),
    ("det_f32", pa.float32()),
    ("det_u8", pa.uint8()),
    ("n_cells", pa.int32()),
])


def main() -> None:
    index = gene_identifier_index.load_hgnc_index()
    files = sorted(CACHE.glob("*.npz"))
    log_path = OUT.parent / "chunks_log.jsonl"
    total_rows = 0
    with open(log_path, "w", encoding="utf-8") as log:
        for i, path in enumerate(files, 1):
            t0 = time.time()
            with np.load(path) as z:
                gene_ids = z["gene_ids"].astype(str)
                keys, _audit = index.primary_keys(gene_ids.tolist())
                keys = np.asarray(keys)
                mean = z["mean"]
                det = z["detection"]
                n_cells = z["n_cells"]
                dataset = str(z["dataset_id"])
                donor = z["donor"].astype(str)
                region = z["region"].astype(str)
                gyral = z["region_gyral"].astype(str)
                ctype = z["cell_type"].astype(str)

            valid = n_cells > 0
            mask = ((mean != 0) | (det != 0)) & valid[:, None]
            gi, gj = np.nonzero(mask)
            n = gi.shape[0]
            if n:
                mean_vals = mean[gi, gj]
                det_vals = det[gi, gj]
                table = pa.Table.from_arrays(
                    [
                        pa.array(keys[gj]),
                        pa.array(np.repeat(dataset, n)),
                        pa.array(donor[gi]),
                        pa.array(region[gi]),
                        pa.array(gyral[gi]),
                        pa.array(ctype[gi]),
                        pa.array(mean_vals.astype(np.float32)),
                        pa.array(mean_vals.astype(np.float16)),
                        pa.array(det_vals.astype(np.float32)),
                        pa.array(np.round(det_vals * 255).astype(np.uint8)),
                        pa.array(n_cells[gi].astype(np.int32)),
                    ],
                    schema=SCHEMA,
                )
                pq.write_table(table, OUT / f"{path.stem}.parquet", compression="snappy")
            total_rows += n
            rec = {"file": path.name, "rows": n, "secs": round(time.time() - t0, 2)}
            log.write(json.dumps(rec) + "\n")
            log.flush()
            print(f"[{i}/{len(files)}] {path.name}: {n} rows, {rec['secs']}s", flush=True)
    print(f"TOTAL ROWS: {total_rows}", flush=True)


if __name__ == "__main__":
    main()
