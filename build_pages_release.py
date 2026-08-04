from __future__ import annotations

import argparse
import shutil
from pathlib import Path


def release_file_map() -> dict[str, str]:
    return {
        "digitalneuron_main.html": "index.html",
        "README.md": "README.md",
        "styles.css": "styles.css",
        "app.js": "app.js",
        "ui.js": "ui.js",
        "charts.js": "charts.js",
        "data-model.js": "data-model.js",
        "atlas-bridge.js": "atlas-bridge.js",
        "digitalneuron_data.js": "digitalneuron_data.js",
        "gene-atlas-data.js": "gene-atlas-data.js",
        "gene-atlas-view.js": "gene-atlas-view.js",
    }


def atlas_asset_map() -> dict[str, str]:
    """Runtime atlas assets copied into <output>/atlas/.

    The development tree keeps the atlas at interactive_brain_atlas/; the
    published bundle serves it at atlas/. Scripts, audits, README and demo CSV
    are intentionally excluded.
    """
    return {
        "interactive_brain_atlas/index.html": "atlas/index.html",
        "interactive_brain_atlas/styles.css": "atlas/styles.css",
        "interactive_brain_atlas/app.js": "atlas/app.js",
        "interactive_brain_atlas/data/regions.js": "atlas/data/regions.js",
        "interactive_brain_atlas/data/allen_3d_geometry.js": "atlas/data/allen_3d_geometry.js",
        "interactive_brain_atlas/data/connectivity.js": "atlas/data/connectivity.js",
        "interactive_brain_atlas/data/atlas_knowledge.js": "atlas/data/atlas_knowledge.js",
    }


# The atlas is embedded directly in index.html; every dev-tree reference to
# interactive_brain_atlas/ (stylesheet link + runtime scripts) is rewritten to
# the published atlas/ prefix.
DEV_ATLAS_PREFIX = "interactive_brain_atlas/"
RELEASE_ATLAS_PREFIX = "atlas/"

# The gene payload is a tree of ~19k files rather than a fixed whitelist, so it is
# copied wholesale. index.html carries the directory name in a single data
# attribute, which is rewritten here so the dev tree and the bundle can differ.
DEV_GENE_DIR = "gene_atlas_web"
RELEASE_GENE_DIR = "gene-data"
GENE_BASE_ATTRIBUTE = "data-gene-atlas-base"


def copy_gene_payload(source_dir: Path, output_dir: Path) -> int:
    """Copy gene_atlas_web/ into <output>/gene-data/. Returns the file count.

    The export is optional: a build without it still succeeds and the page shows
    the "not available in this build" note the frontend already handles. Failing
    here instead would block every release that has not run the 3-hour export.
    """
    payload = source_dir / DEV_GENE_DIR
    index_file = payload / "index.json"
    if not index_file.exists():
        return 0

    destination = output_dir / RELEASE_GENE_DIR
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copy2(index_file, destination / "index.json")
    copied = 1

    genes_dir = payload / "genes"
    if genes_dir.is_dir():
        genes_out = destination / "genes"
        genes_out.mkdir(parents=True, exist_ok=True)
        for gene_file in sorted(genes_dir.glob("*.json")):
            shutil.copy2(gene_file, genes_out / gene_file.name)
            copied += 1
    return copied


def build_release_dir(source_dir: Path, output_dir: Path) -> None:
    source_dir = source_dir.resolve()
    output_dir = output_dir.resolve()

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    for source_name, output_name in release_file_map().items():
        source_path = source_dir / source_name
        if not source_path.exists():
            raise FileNotFoundError(f"Missing required release file: {source_path}")
        shutil.copy2(source_path, output_dir / output_name)

    # Rewrite every embedded atlas reference from the dev-tree prefix to the
    # published atlas/ folder, and point the gene payload at its released name.
    index_path = output_dir / "index.html"
    index_html = index_path.read_text(encoding="utf-8")
    index_html = index_html.replace(DEV_ATLAS_PREFIX, RELEASE_ATLAS_PREFIX)
    index_html = index_html.replace(
        f'{GENE_BASE_ATTRIBUTE}="{DEV_GENE_DIR}"',
        f'{GENE_BASE_ATTRIBUTE}="{RELEASE_GENE_DIR}"',
    )
    index_path.write_text(index_html, encoding="utf-8")

    for source_name, output_name in atlas_asset_map().items():
        source_path = source_dir / source_name
        if not source_path.exists():
            raise FileNotFoundError(f"Missing required atlas asset: {source_path}")
        destination = output_dir / output_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination)

    copy_gene_payload(source_dir, output_dir)

    (output_dir / ".nojekyll").write_text("", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    base_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description="Prepare a GitHub Pages release bundle for the DigitalBrain Data Explorer."
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=base_dir,
        help="Source directory containing the web assets. Defaults to the current web directory.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=base_dir / "github-pages",
        help="Output directory for the Pages-ready bundle. Defaults to web/github-pages.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    build_release_dir(args.source, args.output)
    print(f"[write] {args.output.resolve()}")
    print("[files]")
    for output_name in sorted(release_file_map().values()):
        print(f" - {output_name}")
    for output_name in sorted(atlas_asset_map().values()):
        print(f" - {output_name}")
    print(" - .nojekyll")

    gene_dir = args.output / RELEASE_GENE_DIR
    if gene_dir.exists():
        count = len(list((gene_dir / "genes").glob("*.json"))) if (gene_dir / "genes").is_dir() else 0
        print(f" - {RELEASE_GENE_DIR}/index.json + {count} gene files")
    else:
        print(
            f" ! {DEV_GENE_DIR}/ not found: the gene expression layer will show its"
            " \"not available in this build\" note."
            f" Run scripts/export_gene_atlas_web.py to populate it."
        )


if __name__ == "__main__":
    main()
