# Tab View — Constitution

## Inheritance

feedBack's core plugin contract governs everything in this repo (manifest,
the `slopsmithViz_*` visualization factory contract, splitscreen mounting).
This constitution lists Tab View's own non-negotiables.

## Core Principles

### I. alphaTab is the renderer; we're the bridge
Tab View MUST NOT render notation glyphs itself. alphaTab is the source of
truth for all musical glyphs, beam grouping, stems, and bar layout. Our job
is to translate the renderer bundle (notes/chords/tuning/stringCount/beats)
into an alphaTab `Score` (`src/chart-quantize.js` + `src/score-builder.js`)
and to drive our own boundsLookup-driven marker from `window.highway.getTime()`
(single-player) or `bundle.currentTime` (splitscreen), using beat timing data
the highway exposes.

### II. Multi-instance by construction (slopsmith#36)
Per-instance state lives in factory closures returned from `createFactory()`.
Module-level scope is reserved for genuine singletons:
- The CDN script load promise (one `<script>` per page).
- `_nextInstanceId` for unique DOM ids.

### III. Pin the alphaTab CDN version
`ALPHATAB_VERSION = '1.8.2'` MUST be an explicit constant, kept in sync with
package.json's `@coderline/alphatab` devDependency (used to test
score-builder.js against the real model classes). New jsDelivr cache
invalidations or upstream breaking changes cannot land silently in
production. Bumps require local QA against cursor-sync and tab-highlight
behaviour.

### IV. One AlphaTabApi instance per activation
Tab View MUST NOT destroy and recreate its `AlphaTabApi` instance on every
chart rebuild — `renderScore()` on a live instance is alphaTab's own
documented way to switch content; recreating redoes font/layout setup and
DOM teardown for no reason. The instance is destroyed only in
`_teardown()`. Each render registers its own `scoreLoaded`/
`renderFinished`/`error` closures; the previous render's listeners MUST be
unregistered first via the unregister functions `.on()` returns, or they
accumulate for the life of the instance.

### V. The tab is built from the bundle, not a converted file
Tab View MUST NOT fetch or convert a separate file server-side.
`buildScoreFromBundle` (`src/score-builder.js`) builds the alphaTab `Score`
directly from `bundle.notes`/`.chords`/`.tuning`/`.stringCount`/`.beats` —
the same bundle passed to any custom renderer's `init`/`draw`. Since
`highway.js` stages any registered chart-transform provider's output into
that bundle first, this is also the only path by which a transform reaches
the tab. This also drops GP5's hard 7-string cap — alphaTab's own model
has no string-count ceiling.

### VI. Visualization is opt-in (`matchesArrangement` deliberately absent)
Tab View does not advertise itself as the auto-select renderer for any
arrangement type. Users explicitly switch to it via the Tab View button in
the player controls. Adding `matchesArrangement` would require careful UX
review.

## Governance

Amendments touching score construction (`src/score-builder.js`,
`src/chart-quantize.js`) must keep `test/score-builder.test.mjs` and
`test/chart-quantize.test.mjs` passing — the former against the real
`@coderline/alphatab` package, the only verification available without a
live browser. New alphaTab-independent chart math belongs in
`chart-quantize.js`, keeping most conversion logic testable without
alphaTab. Amendments touching the factory contract must align with the
latest core `slopsmithViz_*` interface.

**Version**: 4.0.0 | **Ratified**: 2026-05-09 | **Last Amended**: 2026-07-22
