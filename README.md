# feedBack Plugin: Tab View

A [feedBack](https://github.com/got-feedBack/feedBack) plugin that renders custom-song arrangements as traditional guitar tablature using [alphaTab](https://www.alphatab.net/).

## Features

- Converts arrangement XML to Guitar Pro 5 format on the fly
- Renders scrolling tablature notation via alphaTab in the browser
- Cursor syncs to the existing audio playback
- Supports guitar and bass arrangements
- Preserves techniques: bends, slides, hammer-ons, pull-offs, harmonics, palm mutes, tremolo picking
- Handles custom tunings and capo
- Per-measure tempo changes

## Installation

Copy (or symlink) this directory into your feedBack `plugins/` folder:

```bash
cd /path/to/feedBack/plugins
git clone https://github.com/got-feedBack/feedBack-plugin-tabview.git tabview
docker compose restart
```

After the restart, the plugin loads automatically.

## Usage

1. Open any song in the player
2. Open the **Visualization & quality** menu in the player rail and pick **Tab View** in the **Visualization** dropdown
3. The highway canvas is replaced with scrolling tablature notation
4. The cursor follows the audio playback
5. Pick another visualization in the same dropdown to switch back

## Dependencies

- **Server**: `pyguitarpro` (already included in feedBack's requirements)
- **Client**: alphaTab is loaded from CDN on first use

## How it works

1. **routes.py** exposes `GET /api/plugins/tabview/gp5/{filename}?arrangement=N`
2. **rs2gp.py** converts the arrangement (notes, chords, beats, tuning, techniques) into a Guitar Pro 5 file using `pyguitarpro`
3. **screen.js** loads alphaTab from CDN, fetches the GP5 file, renders it, and syncs the cursor to `audio.currentTime` using the beat timing data from the highway

## Files

| File | Purpose |
|------|---------|
| `plugin.json` | Plugin manifest |
| `routes.py` | FastAPI endpoint serving GP5 files |
| `rs2gp.py` | arrangement → Guitar Pro 5 converter |
| `screen.js` | Frontend: alphaTab integration, cursor sync, UI |
