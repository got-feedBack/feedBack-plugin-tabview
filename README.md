# slopsmith-plugin-tabview

A [feedBack](https://github.com/got-feedback/feedback) plugin that renders custom-song arrangements as traditional guitar tablature using [alphaTab](https://www.alphatab.net/).

## Features

- Builds an alphaTab score directly from the renderer bundle (notes, chords, tuning, string count, beats) — no server round trip
- Renders scrolling tablature notation via alphaTab in the browser
- Cursor syncs to the existing audio playback
- Supports guitar and bass arrangements, including extended-range instruments (no string-count ceiling)
- Preserves techniques: bends, slides, hammer-ons, pull-offs, harmonics, palm mutes, tremolo picking, accents
- Per-measure tempo changes
- Reflects any active chart-transform provider — since the tab is built from the same bundle every other renderer sees, a provider's remapped notes/strings/tuning show up automatically

## Installation

Copy (or symlink) this directory into your feedBack `plugins/` folder:

```bash
cd /path/to/feedBack/plugins
git clone https://github.com/got-feedback/feedback-plugin-tabview.git tabview
```

Restart feedBack. The plugin loads automatically.

## Usage

1. Open any song in the player
2. Click the **Tab View** button in the player controls bar
3. The highway canvas is replaced with scrolling tablature notation
4. The cursor follows the audio playback
5. Click **Highway** to switch back to the note highway

## Dependencies

- **Client**: alphaTab is loaded from CDN on first use
- **Dev/test**: `@coderline/alphatab` (npm, pinned to the same version as the CDN load) — used only to test `src/score-builder.js` against the real alphaTab model classes in Node; never shipped to the browser

## How it works

1. **screen.js** gathers the current chart bundle (notes/chords/tuning/stringCount/beats/songInfo — the same bundle any custom renderer's `init`/`draw` receives) and passes it to `buildScoreFromBundle`.
2. **src/chart-quantize.js** does the alphaTab-independent chart math: groups beats into measures, quantizes note onsets to a 32nd-note grid, decomposes gaps into duration/dots pairs, and builds the tuning table.
3. **src/score-builder.js** builds an `alphaTab.model.Score` from that: constructs the `Track`/`Staff`/`Bar`/`Voice`/`Beat`/`Note` graph and maps techniques (hammer-on/pull-off, slides, bends, harmonics, palm mute, tremolo, accents) onto alphaTab `Note`/`Beat` fields.
4. **screen.js** hands the built `Score` to `alphaTabApi.renderScore()` (reusing one `AlphaTabApi` instance across rebuilds) and positions its own boundsLookup-driven marker from `window.highway.getTime()` (single-player) or `bundle.currentTime` (splitscreen).

The tab rebuilds whenever `bundle.notes`' identity changes — on a song/arrangement switch, a mastery-slider move, or a chart-transform provider rerunning (a provider always restages a fresh notes array), so the tab always reflects the same effective chart the highway itself is drawing.

## Files

| File | Purpose |
|------|---------|
| `plugin.json` | Plugin manifest |
| `screen.js` | Frontend: alphaTab integration, cursor sync, UI |
| `src/chart-quantize.js` | Pure chart math: measures, quantization, tuning table (no alphaTab dependency) |
| `src/score-builder.js` | bundle → alphaTab `Score` builder (techniques, track/staff/bar assembly) |
| `test/` | Node tests for `src/chart-quantize.js` and `src/score-builder.js` (`npm test`) |
