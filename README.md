# DigitalBrain Data Explorer

Static web explorer for harmonized single-cell brain datasets across collections, datasets, donors, disease conditions, cell types, and brain regions.

## What It Shows

- Collection, dataset, and donor level drill-down
- Donor-normalized metadata and disease summaries
- Cell type distribution views
- Brodmann and gyral brain-region distribution views

## Published Site

After GitHub Pages is enabled for this repository, the site will be available at:

`https://<your-github-username>.github.io/digitalbrain-data-explorer/`

## Deploy With GitHub Pages

1. Create a GitHub repository, for example `digitalbrain-data-explorer`
2. Upload the contents of this directory to the repository root
3. In GitHub, open `Settings -> Pages`
4. Set `Source` to `Deploy from a branch`
5. Set `Branch` to `main` and folder to `/(root)`
6. Save and wait for Pages to publish

This bundle already includes `.nojekyll`, so GitHub Pages will serve the static files directly.

## Update The Site

The deployable bundle is generated from the source project directory with:

```bash
python web/build_pages_release.py
```

That command refreshes `web/github-pages` with the current production files:

- `index.html`
- `styles.css`
- `app.js`
- `ui.js`
- `charts.js`
- `data-model.js`
- `digitalneuron_data.js`
- `.nojekyll`

## Local Preview

From this directory, you can preview the site with:

```bash
python -m http.server 8000
```

Then open:

`http://127.0.0.1:8000/`
