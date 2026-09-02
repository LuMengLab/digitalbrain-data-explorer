# Atlas threshold ranges design

Date: 2026-09-02

## Goal

Expose the full 0–100% range for both threshold sliders in the Atlas settings
drawer, including the embedded explorer and the standalone atlas release.

## Behaviour

- **Minimum abundance** ranges from 0% to 100%, defaults to 0%, and continues
  to hide cell-profile markers whose abundance is below the selected fraction.
- **Connection threshold** ranges from the 0th to the 100th percentile and
  defaults to the existing 96th-percentile cutoff. At 0% all connections are
  eligible; at 100% only connections at the maximum percentile are eligible.
- The connection output displays the percentile cutoff directly (for example,
  `96%`) instead of translating it to the inverse phrase `Top 4%`.
- Endpoint captions read `0%` and `100%` for both controls.

## Implementation scope

The source HTML files define the range bounds and captions. The atlas runtime
continues to store connection thresholds as percentiles and abundance thresholds
as fractions. The generated `github-pages/` copies are refreshed through
`build_pages_release.py` rather than edited independently.

## Testing

Add regression coverage that loads the real source markup and asserts the
minimum, maximum, default, and endpoint captions for both sliders. Runtime tests
will verify connection threshold labels and boundary filtering at 0 and 100.
After the focused tests pass, run the complete Python and Node test suites and
verify the regenerated GitHub Pages markup matches the source behaviour.
