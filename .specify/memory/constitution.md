# Tab View — Constitution

## Inheritance

Slopsmith's core plugin contract governs everything in this repo (manifest,
plugin context: `get_dlc_dir`, `get_sloppak_cache_dir`, asset serving, the
`slopsmithViz_*` visualization factory contract, splitscreen mounting). This
constitution lists Tab View's own non-negotiables.

## Core Principles

### I. alphaTab is the renderer; we're the bridge
Tab View MUST NOT render notation glyphs itself. alphaTab is the source of
truth for all musical glyphs, beam grouping, stems, and bar layout. Our job
is to translate Rocksmith XML → Guitar Pro 5 (`rs2gp.py`) and to drive
alphaTab's cursor (`tickPosition`) from `audio.currentTime` using beat
timing data the highway already exposes.

### II. Multi-instance by construction (slopsmith#36)
Per-instance state lives in factory closures returned from `createFactory()`.
Module-level scope is reserved for genuine singletons:
- The CDN script load promise (one `<script>` per page).
- `_tvFilename` captured from `window.playSong` and `arrangement:changed`
  (one global player → one filename, even when multiple panels render
  different arrangements of the same song).
- `_nextInstanceId` for unique DOM ids.

### III. Pin the alphaTab CDN version
`ALPHATAB_VERSION = '1.8.2'` MUST be an explicit constant. New jsDelivr
cache invalidations or upstream breaking changes cannot land silently in
production. Bumps require local QA against cursor-sync and tab-highlight
behaviour.

### IV. Path-traversal guard on the GP5 endpoint
`GET /api/plugins/tabview/gp5/{filename:path}` MUST resolve `filename`
under the configured DLC dir and reject anything that escapes (`..`, absolute
paths). The endpoint is publicly mounted; the guard is the single defence.

### V. Sloppak path is loaded lazily
Older Slopsmith cores ship without `lib/sloppak.py`. A top-level
`import sloppak` here would disable Tab View entirely on those installs
(including for PSARC songs). The sloppak branch MUST `import sloppak`
inside the function and surface a `501 Not Implemented` when missing.

### VI. Visualization is opt-in (`matchesArrangement` deliberately absent)
Tab View does not advertise itself as the auto-select renderer for any
arrangement type. Users explicitly switch to it via the Tab View button in
the player controls. Adding `matchesArrangement` would require careful UX
review.

## Governance

Amendments touching the GP5 conversion (`rs2gp.py`) must keep a back-compat
fall-through for older Rocksmith XML formats. Amendments touching the
factory contract must align with whatever the latest core
`slopsmithViz_*` interface requires.

**Version**: 3.0.0 | **Ratified**: 2026-05-09 | **Last Amended**: 2026-05-09
