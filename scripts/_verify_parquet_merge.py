"""验证用：把 chunks 合并成桶内按基因排序的服务布局，并测量体积。

布局：64 桶（hash(gene) % 64），每桶一个 parquet，桶内 ORDER BY gene，
ROW_GROUP_SIZE=100_000（point lookup 时按 row group 统计跳读）。

两个变体同口径对比：
- variant_a：mean/detection 保留 float32（当前精度）
- variant_b：mean float16、detection uint8（round(det*255)）、n_cells int32
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import duckdb

ROOT = Path("/data/DigitalBrain/data/scBrain/web")
BASE = ROOT / "gene_atlas_cache" / "parquet_verify"
CHUNKS = BASE / "chunks"
TMP = BASE / "tmp_buckets"
A_DIR = BASE / "variant_a"
B_DIR = BASE / "variant_b"
for d in (TMP, A_DIR, B_DIR):
    d.mkdir(parents=True, exist_ok=True)

KEY_COLS = "gene, dataset, donor, region, region_gyral, cell_type"


def main() -> None:
    con = duckdb.connect()
    con.execute("SET memory_limit='48GB'")
    con.execute(f"SET temp_directory='{BASE / 'ducktmp'}'")

    t0 = time.time()
    con.execute(f"""
        COPY (SELECT *, (hash(gene) % 64)::INTEGER AS bucket
              FROM '{CHUNKS}/*.parquet')
        TO '{TMP}' (FORMAT PARQUET, PARTITION_BY (bucket), COMPRESSION 'snappy')
    """)
    print(f"partition pass: {time.time() - t0:.1f}s", flush=True)

    stats = {}
    for b in range(64):
        t1 = time.time()
        src = f"{TMP}/bucket={b}/*.parquet"
        con.execute(f"""
            COPY (SELECT {KEY_COLS}, mean_f32 AS mean, det_f32 AS detection, n_cells
                  FROM '{src}' ORDER BY gene)
            TO '{A_DIR}/bucket_{b:02d}.parquet'
            (FORMAT PARQUET, COMPRESSION 'zstd', ROW_GROUP_SIZE 100000)
        """)
        con.execute(f"""
            COPY (SELECT {KEY_COLS}, mean_f16 AS mean, det_u8 AS detection, n_cells
                  FROM '{src}' ORDER BY gene)
            TO '{B_DIR}/bucket_{b:02d}.parquet'
            (FORMAT PARQUET, COMPRESSION 'zstd', ROW_GROUP_SIZE 100000)
        """)
        stats[b] = round(time.time() - t1, 1)
        if b % 8 == 7:
            print(f"bucket {b + 1}/64 done, last {stats[b]}s", flush=True)

    summary = con.execute(f"""
        SELECT count(*) AS rows,
               count(DISTINCT gene) AS genes,
               count(DISTINCT (dataset, donor)) AS donors,
               count(DISTINCT dataset) AS datasets
        FROM '{CHUNKS}/*.parquet'
    """).fetchone()
    per_gene = con.execute(f"""
        SELECT gene, count(*) AS n FROM '{CHUNKS}/*.parquet'
        GROUP BY gene ORDER BY n DESC LIMIT 5
    """).fetchall()
    median_rows = con.execute(f"""
        SELECT median(n) FROM (
            SELECT count(*) AS n FROM '{CHUNKS}/*.parquet' GROUP BY gene)
    """).fetchone()[0]
    out = {
        "rows": summary[0], "genes": summary[1],
        "donors": summary[2], "datasets": summary[3],
        "median_rows_per_gene": median_rows,
        "top_genes": per_gene,
    }
    (BASE / "summary.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2), flush=True)


if __name__ == "__main__":
    main()
