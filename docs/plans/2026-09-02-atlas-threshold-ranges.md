# Atlas Threshold Ranges Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Minimum abundance and Connection threshold controls cover the complete 0–100% interval in both source views and the GitHub Pages release.

**Architecture:** Keep the existing atlas state representation: abundance remains a 0–1 fraction and connectivity remains a 0–100 percentile cutoff. Change the HTML bounds and captions, render the connectivity cutoff directly as a percentage, then regenerate the checked-in Pages shell with the existing release builder.

**Tech Stack:** Static HTML, browser JavaScript, Node.js `assert`/jsdom tests, Python release builder and pytest.

---

### Task 1: Add threshold regression tests

**Files:**
- Modify: `test_gene_atlas_layer.js`
- Test: `test_gene_atlas_layer.js`

**Step 1: Write the failing markup test**

Add `testThresholdControlsCoverTheFullPercentageRange` using `bootAtlas()`. Assert
that `abundanceFilter` and `connectivityFilter` both have `min="0"`, `max="100"`,
their existing defaults (`0` and `96`), and endpoint captions `0%` / `100%`.

**Step 2: Write the failing runtime test**

Add `testConnectionThresholdUsesDirectPercentileLabelsAndBoundaryFiltering`.
Switch to the functional layer, drive the connection slider to 0 and 100, and
assert the output/legend use direct labels (`0%`, `100%`), the 0% boundary makes
all matrix links eligible, and the 100% boundary retains only maximum-valued links.

**Step 3: Run the focused test to verify RED**

Run: `node test_gene_atlas_layer.js`

Expected: FAIL because the current controls use maximums 50 and 99 and the
connection output says `Top N%`.

**Step 4: Commit the failing tests**

```bash
git add test_gene_atlas_layer.js
git commit -m "test: cover full atlas threshold ranges"
```

### Task 2: Implement full source ranges

**Files:**
- Modify: `digitalneuron_main.html`
- Modify: `interactive_brain_atlas/index.html`
- Modify: `interactive_brain_atlas/app.js`
- Modify: `README.md`
- Modify: `interactive_brain_atlas/README.md`
- Test: `test_gene_atlas_layer.js`

**Step 1: Extend both HTML controls**

Set both range inputs to `min="0" max="100" step="1"`. Preserve values 0 and
96. Replace both controls' endpoint captions with `0%` and `100%`, and initialize
the connection output to `96%`.

**Step 2: Render direct percentile labels**

In `updateConnectivityRangeBackground()` and the connectivity drawing status,
replace `Top ${100 - percentile}%` with `${percentile}%`. Preserve the `P96`
minimum-percentile annotation and quantile/filter calculations.

**Step 3: Update user-facing documentation**

Describe the connectivity control as a 0th–100th percentile cutoff instead of a
Top 10%–Top 1% selector in both README files.

**Step 4: Run the focused test to verify GREEN**

Run: `node test_gene_atlas_layer.js`

Expected: every case passes with no uncaught errors.

**Step 5: Commit the source change**

```bash
git add digitalneuron_main.html interactive_brain_atlas/index.html interactive_brain_atlas/app.js README.md interactive_brain_atlas/README.md
git commit -m "fix: expose full atlas threshold ranges"
```

### Task 3: Regenerate and verify GitHub Pages

**Files:**
- Modify: `github-pages/index.html`
- Modify: `github-pages/atlas/index.html`
- Modify: `github-pages/atlas/app.js`
- Modify: `github-pages/README.md`
- Test: `test_build_pages_release.py`

**Step 1: Build the Pages shell**

Run: `python3 build_pages_release.py`

Expected: the release directory is rebuilt and retains the local `gene-data/`
payload copied from `gene_atlas_web/`.

**Step 2: Run release tests**

Run: `pytest -q test_build_pages_release.py`

Expected: PASS.

**Step 3: Inspect the generated controls**

Run: `rg -n 'abundanceFilter|connectivityFilter|0%|100%' github-pages/index.html github-pages/atlas/index.html`

Expected: both Pages entry points contain the 0–100 bounds and captions.

**Step 4: Commit the generated shell**

```bash
git add github-pages/index.html github-pages/atlas/index.html github-pages/atlas/app.js github-pages/README.md
git commit -m "chore: regenerate pages for full threshold ranges"
```

### Task 4: Full verification

**Files:**
- Verify only

**Step 1: Run Python tests**

Run: `pytest -q`

Expected: all tests pass.

**Step 2: Run every Node test script**

Run each root `test_*.js` with Node and require every process to exit zero.

Expected: all scripts pass. Also inspect stderr so the known smoke-harness jsdom
`requestAnimationFrame` false positive is not mistaken for pristine output.

**Step 3: Confirm repository state**

Run: `git status --short --branch` and `git diff HEAD~3 --check`.

Expected: no uncommitted source changes and no whitespace errors.
