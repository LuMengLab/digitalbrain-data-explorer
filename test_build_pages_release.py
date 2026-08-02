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

        atlas_dir = source_dir / "interactive_brain_atlas"
        (atlas_dir / "data").mkdir(parents=True)
        write_file(atlas_dir / "index.html", "<html>atlas</html>")
        write_file(atlas_dir / "styles.css", "body{}")
        write_file(atlas_dir / "app.js", "console.log('atlas')")
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


def test_release_file_map_uses_index_html():
    module = load_module()
    mapping = module.release_file_map()
    assert mapping["digitalneuron_main.html"] == "index.html"
    assert mapping["README.md"] == "README.md"
    assert "digitalneuron_data.js" in mapping
    assert mapping["atlas-bridge.js"] == "atlas-bridge.js"
    assert "atlas_celltype_map.js" not in mapping
    assert "test_smoke.js" not in mapping
    atlas_assets = module.atlas_asset_map()
    assert atlas_assets["interactive_brain_atlas/index.html"] == "atlas/index.html"
    assert atlas_assets["interactive_brain_atlas/data/regions.js"] == "atlas/data/regions.js"


def main():
    test_build_release_dir_creates_expected_pages_bundle()
    print("PASS test_build_release_dir_creates_expected_pages_bundle")
    test_release_file_map_uses_index_html()
    print("PASS test_release_file_map_uses_index_html")


if __name__ == "__main__":
    main()
