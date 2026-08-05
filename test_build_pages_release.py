from __future__ import annotations

import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory


def load_module():
    module_path = Path(__file__).with_name("build_pages_release.py")
    spec = importlib.util.spec_from_file_location("build_pages_release", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_file(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def test_build_release_dir_creates_expected_pages_bundle():
    module = load_module()

    with TemporaryDirectory() as tmp_dir:
        source_dir = Path(tmp_dir) / "web"
        output_dir = Path(tmp_dir) / "pages"
        source_dir.mkdir()

        write_file(
            source_dir / "digitalneuron_main.html",
            '<html><head><link rel="stylesheet" href="interactive_brain_atlas/styles.css"></head>'
            '<body><section id="atlasSection"></section>'
            '<script src="interactive_brain_atlas/data/regions.js"></script>'
            '<script src="interactive_brain_atlas/app.js"></script></body></html>',
        )
        write_file(source_dir / "README.md", "# DigitalBrain Data Explorer\n")
        write_file(source_dir / "styles.css", "body{}")
        write_file(source_dir / "app.js", "console.log('app')")
        write_file(source_dir / "ui.js", "console.log('ui')")
        write_file(source_dir / "charts.js", "console.log('charts')")
        write_file(source_dir / "data-model.js", "console.log('model')")
        write_file(source_dir / "atlas-bridge.js", "console.log('bridge')")
        write_file(source_dir / "digitalneuron_data.js", "window.currentData={}")
        write_file(source_dir / "digitalneuron_data-0.js", "legacy")
        write_file(source_dir / "test_smoke.js", "test")
        write_file(source_dir / "gene-atlas-data.js", "console.log('gene data')")
        write_file(source_dir / "gene-compare-view.js", "console.log('gene compare')")
        write_file(source_dir / "gene-atlas-view.js", "console.log('gene view')")

        atlas_dir = source_dir / "interactive_brain_atlas"
        (atlas_dir / "data").mkdir(parents=True)
        write_file(atlas_dir / "index.html", "<html>atlas</html>")
        write_file(atlas_dir / "styles.css", "body{}")
        write_file(atlas_dir / "app.js", "console.log('atlas')")
        write_file(atlas_dir / "gene_point_cloud.js", "window.GenePointCloud={}")
        write_file(atlas_dir / "data" / "regions.js", "window.DIGITALBRAIN_REGION_DATA={}")
        write_file(atlas_dir / "data" / "allen_3d_geometry.js", "window.ALLEN_3D_ATLAS={}")
        write_file(atlas_dir / "data" / "connectivity.js", "window.DIGITALBRAIN_CONNECTIVITY_DATA={}")
        write_file(atlas_dir / "data" / "atlas_knowledge.js", "window.DIGITALBRAIN_ATLAS_KNOWLEDGE={}")

        module.build_release_dir(source_dir, output_dir)

        index_html = (output_dir / "index.html").read_text(encoding="utf-8")
        assert 'href="atlas/styles.css"' in index_html
        assert 'src="atlas/app.js"' in index_html
        assert 'src="atlas/data/regions.js"' in index_html
        assert "interactive_brain_atlas/" not in index_html
        assert (output_dir / ".nojekyll").exists()
        assert (output_dir / "README.md").exists()
        assert (output_dir / "styles.css").exists()
        assert (output_dir / "atlas-bridge.js").exists()
        assert (output_dir / "digitalneuron_data.js").exists()
        assert (output_dir / "atlas" / "index.html").exists()
        assert (output_dir / "atlas" / "app.js").exists()
        assert (output_dir / "atlas" / "data" / "regions.js").exists()
        assert not (output_dir / "digitalneuron_data-0.js").exists()
        assert not (output_dir / "test_smoke.js").exists()
        assert (output_dir / "gene-atlas-data.js").exists()
        assert (output_dir / "gene-compare-view.js").exists()
        assert (output_dir / "gene-atlas-view.js").exists()


def _minimal_source(source_dir: Path) -> None:
    """只建 build_release_dir 必需的文件，供不关心 atlas 细节的用例复用。"""
    source_dir.mkdir(parents=True, exist_ok=True)
    write_file(
        source_dir / "digitalneuron_main.html",
        '<html><body data-gene-atlas-base="gene_atlas_web">'
        '<script src="interactive_brain_atlas/app.js"></script></body></html>',
    )
    for name in (
        "README.md",
        "styles.css",
        "app.js",
        "ui.js",
        "charts.js",
        "data-model.js",
        "atlas-bridge.js",
        "digitalneuron_data.js",
        "gene-atlas-data.js",
        "gene-compare-view.js",
        "gene-atlas-view.js",
    ):
        write_file(source_dir / name, "x")
    atlas_dir = source_dir / "interactive_brain_atlas"
    (atlas_dir / "data").mkdir(parents=True, exist_ok=True)
    write_file(atlas_dir / "index.html", "<html>atlas</html>")
    write_file(atlas_dir / "styles.css", "body{}")
    write_file(atlas_dir / "app.js", "x")
    write_file(atlas_dir / "gene_point_cloud.js", "x")
    for name in (
        "regions.js",
        "allen_3d_geometry.js",
        "connectivity.js",
        "atlas_knowledge.js",
    ):
        write_file(atlas_dir / "data" / name, "x")


def test_gene_atlas_payload_tree_is_copied_wholesale():
    """genes/ 下是不定个数的文件（全编码近 2 万），不能手写进白名单。"""
    module = load_module()

    with TemporaryDirectory() as tmp_dir:
        source_dir = Path(tmp_dir) / "web"
        output_dir = Path(tmp_dir) / "pages"
        _minimal_source(source_dir)

        payload = source_dir / "gene_atlas_web"
        (payload / "genes").mkdir(parents=True)
        write_file(payload / "index.json", '{"genes":{"GFAP":"genes/GFAP.json"}}')
        write_file(payload / "genes" / "GFAP.json", '{"symbol":"GFAP"}')
        write_file(payload / "genes" / "GFAP.detail.json", '{"symbol":"GFAP"}')
        write_file(payload / "genes" / "SNAP25.json", '{"symbol":"SNAP25"}')

        module.build_release_dir(source_dir, output_dir)

        released = output_dir / module.RELEASE_GENE_DIR
        assert (released / "index.json").exists()
        assert (released / "genes" / "GFAP.json").exists()
        assert (released / "genes" / "GFAP.detail.json").exists()
        assert (released / "genes" / "SNAP25.json").exists()


def test_the_search_index_travels_with_the_gene_payload():
    """搜索索引是另一个脚本的产物，漏拷不会报错：发布版的下拉框只是静默地退回
    只能按符号前缀搜的列表。
    """
    module = load_module()

    with TemporaryDirectory() as tmp_dir:
        source_dir = Path(tmp_dir) / "web"
        output_dir = Path(tmp_dir) / "pages"
        _minimal_source(source_dir)

        payload = source_dir / "gene_atlas_web"
        (payload / "genes").mkdir(parents=True)
        write_file(payload / "index.json", '{"genes":{"GFAP":"genes/GFAP.json"}}')
        write_file(payload / "genes" / "GFAP.json", '{"symbol":"GFAP"}')
        write_file(payload / module.SEARCH_INDEX_FILE, '{"version":1,"symbols":["GFAP"]}')

        module.build_release_dir(source_dir, output_dir)

        released = output_dir / module.RELEASE_GENE_DIR
        assert (released / module.SEARCH_INDEX_FILE).exists()
        # 与开发树同名：前端从 gene base 属性推导路径，改名会静默 404。
        assert (released / module.SEARCH_INDEX_FILE).read_text(encoding="utf-8").startswith("{")


def test_a_payload_without_a_search_index_still_releases():
    """索引未生成时发布仍须成功：前端对缺索引自带降级。"""
    module = load_module()

    with TemporaryDirectory() as tmp_dir:
        source_dir = Path(tmp_dir) / "web"
        output_dir = Path(tmp_dir) / "pages"
        _minimal_source(source_dir)

        payload = source_dir / "gene_atlas_web"
        (payload / "genes").mkdir(parents=True)
        write_file(payload / "index.json", '{"genes":{}}')

        module.build_release_dir(source_dir, output_dir)

        released = output_dir / module.RELEASE_GENE_DIR
        assert (released / "index.json").exists()
        assert not (released / module.SEARCH_INDEX_FILE).exists()


def test_index_html_points_at_the_released_gene_directory():
    module = load_module()

    with TemporaryDirectory() as tmp_dir:
        source_dir = Path(tmp_dir) / "web"
        output_dir = Path(tmp_dir) / "pages"
        _minimal_source(source_dir)
        module.build_release_dir(source_dir, output_dir)

        index_html = (output_dir / "index.html").read_text(encoding="utf-8")
        assert f'data-gene-atlas-base="{module.RELEASE_GENE_DIR}"' in index_html
        # The dev-tree name must not survive, or the published page would request a
        # directory that is not in the bundle.
        assert 'data-gene-atlas-base="gene_atlas_web"' not in index_html


def test_a_build_without_the_gene_export_still_succeeds():
    """基因数据是可选的：未导出时发布仍须成功，前端自带降级提示。"""
    module = load_module()

    with TemporaryDirectory() as tmp_dir:
        source_dir = Path(tmp_dir) / "web"
        output_dir = Path(tmp_dir) / "pages"
        _minimal_source(source_dir)

        module.build_release_dir(source_dir, output_dir)

        assert (output_dir / "index.html").exists()
        assert not (output_dir / module.RELEASE_GENE_DIR).exists()


def test_release_file_map_uses_index_html():
    module = load_module()
    mapping = module.release_file_map()
    assert mapping["digitalneuron_main.html"] == "index.html"
    assert mapping["README.md"] == "README.md"
    assert "digitalneuron_data.js" in mapping
    assert mapping["atlas-bridge.js"] == "atlas-bridge.js"
    assert mapping["gene-atlas-data.js"] == "gene-atlas-data.js"
    assert mapping["gene-compare-view.js"] == "gene-compare-view.js"
    assert mapping["gene-atlas-view.js"] == "gene-atlas-view.js"
    assert "atlas_celltype_map.js" not in mapping
    assert "test_smoke.js" not in mapping
    atlas_assets = module.atlas_asset_map()
    assert atlas_assets["interactive_brain_atlas/index.html"] == "atlas/index.html"
    assert atlas_assets["interactive_brain_atlas/data/regions.js"] == "atlas/data/regions.js"


def main():
    test_build_release_dir_creates_expected_pages_bundle()
    print("PASS test_build_release_dir_creates_expected_pages_bundle")
    test_gene_atlas_payload_tree_is_copied_wholesale()
    print("PASS test_gene_atlas_payload_tree_is_copied_wholesale")
    test_the_search_index_travels_with_the_gene_payload()
    print("PASS test_the_search_index_travels_with_the_gene_payload")
    test_a_payload_without_a_search_index_still_releases()
    print("PASS test_a_payload_without_a_search_index_still_releases")
    test_release_file_map_uses_index_html()
    print("PASS test_release_file_map_uses_index_html")


if __name__ == "__main__":
    main()
