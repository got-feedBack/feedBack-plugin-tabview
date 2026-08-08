// Tab View — renders arrangements as scrolling tablature via alphaTab
// (https://alphatab.net/), built directly from the renderer bundle
// (bundle.notes/.chords/.tuning/.stringCount/.beats — see
// src/chart-quantize.js and src/score-builder.js) instead of a server-
// converted Guitar Pro file. The bundle is already chart-transform-applied
// (highway.js stages any registered transform first), so a provider's
// remap reaches the tab automatically, and alphaTab's model has no GP5-
// style string-count ceiling.
//
// Per-instance state lives in createFactory() closures so N tabview
// instances coexist under splitscreen panels (slopsmith#36). Module scope
// is reserved for the one genuine singleton: the alphaTab CDN script load.
//
// No MIDI input, no focus-driven behavior — each panel renders from its
// own bundle.currentTime; the splitscreen helper is only consulted for
// the mount target (panelChromeFor()).
//
// alphaTab's font/soundfont are CDN-cached static assets, so multiple
// AlphaTabApi instances on one page share them without coordination; each
// instance owns its own scoreLoaded/renderFinished/error subscriptions.

import { buildScoreFromBundle } from './src/score-builder.js';

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Module-level state (singletons)
// ═══════════════════════════════════════════════════════════════════════

// Monotonic id suffixed onto every DOM node a tabview instance creates,
// so N instances don't collide on getElementById.
let _nextInstanceId = 0;

// ═══════════════════════════════════════════════════════════════════════
// alphaTab CDN loader (memoized — one load per page)
// ═══════════════════════════════════════════════════════════════════════

// Pin alphaTab to a specific release, kept in sync with package.json's
// @coderline/alphatab devDependency, so CDN cache/version drift can't
// land silently. Bump only after QA against cursor-sync/tab-highlight.
const ALPHATAB_VERSION = '1.8.2';
const ALPHATAB_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@' + ALPHATAB_VERSION + '/dist';

// alphaTab's internal MIDI tick resolution (ticks per quarter note) —
// confirmed fixed at 960 (MidiUtils.QuarterTime). Bar 1 starts at tick 0.
const TICKS_PER_BEAT = 960;

// Sentinel for "nothing tracked" in the chart-identity state below —
// distinct from any real bundle.notes value, including null, so a
// null-notes chart can still be tracked correctly.
const _NO_NOTES_REF = Symbol('no-notes-ref');

let _alphaTabLoadPromise = null;
function _tvLoadScript() {
    if (window.alphaTab) return Promise.resolve();
    if (_alphaTabLoadPromise) return _alphaTabLoadPromise;
    _alphaTabLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = ALPHATAB_CDN_BASE + '/alphaTab.min.js';
        s.onload = resolve;
        s.onerror = () => {
            _alphaTabLoadPromise = null;  // allow retry on next init
            reject(new Error('Failed to load alphaTab'));
        };
        document.head.appendChild(s);
    });
    return _alphaTabLoadPromise;
}

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helper wrapper
// ═══════════════════════════════════════════════════════════════════════
//
// Tabview only needs panelChromeFor(); validate just that so a partial
// helper (missing the focus/MIDI methods tabview doesn't use) still
// routes through the splitscreen mount target.

function _ssActive() {
    const ss = window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    return typeof ss.panelChromeFor === 'function';
}

function _ssPanelChrome(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return ss.panelChromeFor(highwayCanvas);
}

// Resolve the DOM mount target for tabview's container / error banner.
// Splitscreen-active: ONLY the panel chrome is acceptable. If
// panelChromeFor() returns null mid-creation, return null so callers
// retry later instead of caching _tvContainer against the wrong mount
// (main player) or confusing _tvSizeContainer's branch logic.
function _resolveMount(highwayCanvas) {
    if (_ssActive()) {
        return _ssPanelChrome(highwayCanvas);
    }
    return document.getElementById('player');
}

// ═══════════════════════════════════════════════════════════════════════
// Cursor sync helpers (stateless — beats come from the bundle)
// ═══════════════════════════════════════════════════════════════════════

// Count of leading elements (arr sorted ascending by keyFn) with
// keyFn(el) <= target. One less than this is "largest index with
// keyFn <= target", what both call sites below want (verified against
// 17k+ randomized cases). Shared here since highway.js's own
// lowerBoundTime is bundle-scoped, and the single-player cursor loop has
// no bundle to read it from.
function _countLE(arr, target, keyFn) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (keyFn(arr[mid]) <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function _tvTimeToTick(seconds, beats) {
    if (!beats || beats.length < 2) return 0;
    if (!isFinite(seconds) || seconds < beats[0].time) return 0;

    // Largest idx in [0, beats.length-2] with beats[idx].time <= seconds.
    const count = _countLE(beats, seconds, b => b.time);
    const idx = Math.min(count - 1, beats.length - 2);

    let frac = 0;
    if (idx < beats.length - 1) {
        const bStart = beats[idx].time;
        const bEnd = beats[idx + 1].time;
        if (bEnd > bStart) {
            frac = Math.min(1, Math.max(0, (seconds - bStart) / (bEnd - bStart)));
        }
    }

    return Math.round((idx + frac) * TICKS_PER_BEAT);
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract (multi-instance)
// ═══════════════════════════════════════════════════════════════════════

function createFactory() {
    const _instanceId = ++_nextInstanceId;

    // Lifecycle
    let _isReady = false;

    // alphaTab + DOM state (per-instance)
    let _tvApi = null;           // persists across chart rebuilds — see _tvInitAlphaTab
    let _tvUnsubscribe = null;   // current render's [off, off, off] from _tvApi's .on() calls
    let _tvContainer = null;
    let _tvAtMount = null;       // inner <div> alphaTab renders into
    let _tvHighlight = null;     // cursor highlight overlay element
    let _tvErrorBanner = null;   // current error banner element (if any)
    let _tvErrorBannerTimeout = null;
    let _tvReady = false;

    // Highway canvas swap state
    let _tvHighwayCanvas = null;
    let _tvPrevVisibility = '';

    // Mount position restore — when _tvCreateContainer() promotes a static
    // mount to position:relative it saves the original inline style here so
    // _tvRemoveContainer() can put it back on teardown.
    let _tvPrevMountPosition = null;

    // Re-insets the overlay when #player-controls wraps to a second row
    // (slopsmith#336) — window-resize alone misses in-viewport content
    // reflow. Main-player mode only; splitscreen owns its own layout.
    let _tvControlsObserver = null;

    // Keyed on bundle.notes IDENTITY: highway.js restages a fresh array
    // whenever the effective chart changes (song load, mastery move,
    // transform rerun), so a reference change means "rebuild the tab".
    let _tvCurrentNotesRef = _NO_NOTES_REF;  // notes ref the currently-rendered score reflects
    let _tvPendingNotesRef = _NO_NOTES_REF;  // notes ref a render is currently in flight for
    let _tvFailedNotesRef = _NO_NOTES_REF;   // notes ref that last failed (avoid a per-frame retry storm)

    // Cursor sync
    let _tvLastTick = -9999;  // far below any real tick (0 is now a valid position)

    // Self-driven cursor rAF handle — single-player advances the marker
    // from our own loop, not the host draw() pump (see _tvCursorLoop).
    let _tvCursorRAF = null;

    // We render our own playback marker from alphaTab's layout geometry
    // (boundsLookup, via core.includeNoteBounds) instead of alphaTab's
    // internal player cursor, which only appears once its synth reaches
    // "ready" — fragile, and unused here since slopsmith drives audio, not
    // alphaTab's player (slopsmith#734).
    //
    // _tvAtBeats: flat [{ beat, start }] for every beat, sorted by tick
    // (960-ppq, bar 0 beat 0 == tick 0). Rebuilt on each scoreLoaded.
    // _tvLastBeat: the beat the marker sits on, kept so a resize can
    // re-place it without waiting for the next time tick.
    let _tvAtBeats = [];
    let _tvLastBeat = null;

    // Latest beats snapshot, per-instance — not the bare `highway` global,
    // which under splitscreen is the main player's, not this panel's.
    let _tvLatestBeats = null;

    // Monotonic init counter. Async continuations (CDN load, alphaTab's
    // render pipeline) capture it and bail if a newer init/render has
    // started since, so a rapid switch can't install a stale score.
    let _tvInitToken = 0;

    // ── Listener ref (per-instance so destroy() detach matches) ──
    const _onWinResize = () => _tvSizeContainer();

    // Tells the host highway whether it's covered by the tab: hiding it
    // with visibility:hidden alone (so alphaTab can still measure width)
    // doesn't trip the highway's rAF gate, so the underlying renderer
    // (e.g. 3D WebGL) keeps rendering behind the opaque tab. setVisible
    // trips that gate and fires highway:visibility for overlay renderers.
    // Guarded for older cores without the API (slopsmith#654).
    function _tvSetHighwayVisible(v) {
        // window.highway is the main-player highway, not per-panel, and
        // panels expose no per-canvas setVisible — so only force-hide
        // (false) in single-player mode. Clearing (null) is always safe
        // and must run even if splitscreen activated since a single-player
        // hide, so a prior force-hide can't strand the highway paused.
        if (v === false && _ssActive()) return;
        try {
            const hw = window.highway;
            if (hw && typeof hw.setVisible === 'function') hw.setVisible(v);
        } catch (_) { /* best-effort: visibility hint only */ }
    }

    // ── Container setup ─────────────────────────────────────────────

    function _tvCreateContainer() {
        if (_tvContainer) return _tvContainer;
        const mount = _resolveMount(_tvHighwayCanvas);
        if (!mount) return null;

        // left:0/right:0 needs a positioned mount ancestor; existing mounts
        // are, this is an idempotent guard for a future static one. The
        // original inline position is saved so _tvRemoveContainer() can
        // restore it on teardown.
        if (getComputedStyle(mount).position === 'static') {
            _tvPrevMountPosition = mount.style.position; // save inline value (often '')
            mount.style.position = 'relative';
        }

        const c = document.createElement('div');
        c.id = 'tabview-dev-container-' + _instanceId;
        c.className = 'tabview-dev-container';
        c.dataset.tabviewInstance = String(_instanceId);
        // visibility:hidden (not display:none) so alphaTab can still
        // measure width during init — display:none gives clientWidth=0
        // and alphaTab skips rendering entirely. renderFinished swaps
        // this to '' once the first paint lands.
        c.style.cssText = [
            'visibility:hidden',
            'position:absolute',
            'top:0',
            'left:0',
            'right:0',
            'overflow-y:auto',
            'background:#fff',
            'z-index:5',
        ].join(';');

        const inner = document.createElement('div');
        inner.id = 'tabview-dev-at-' + _instanceId;
        inner.className = 'tabview-dev-at';
        c.appendChild(inner);

        // Playback marker (slopsmith#734): a Songsterr-style vertical band,
        // translucent fill over the beat's width/height with a bright
        // left-border playhead. Positioned from boundsLookup geometry in
        // _tvUpdateMarker, not alphaTab's own cursor.
        const hl = document.createElement('div');
        hl.id = 'tabview-dev-marker-' + _instanceId;
        hl.className = 'tabview-dev-marker';
        hl.style.cssText = [
            'position:absolute',
            'left:0',
            'top:0',
            'width:0',
            'height:0',
            'background:rgba(34,211,238,0.16)',
            'border-left:2px solid rgba(34,211,238,0.95)',
            'box-shadow:0 0 8px rgba(34,211,238,0.55)',
            'pointer-events:none',
            'z-index:999',
            'display:none',
        ].join(';');
        c.appendChild(hl);

        mount.appendChild(c);
        _tvContainer = c;
        _tvAtMount = inner;
        _tvHighlight = hl;

        // Re-inset on content reflow of #player-controls (e.g. flex-wrap
        // promotes the controls to a second row at narrow widths).
        if (!_ssActive() && typeof ResizeObserver !== 'undefined') {
            const controls = document.getElementById('player-controls');
            if (controls) {
                _tvControlsObserver = new ResizeObserver(() => _tvSizeContainer());
                _tvControlsObserver.observe(controls);
            }
        }
        return c;
    }

    function _tvSizeContainer() {
        if (!_tvContainer) return;
        const mount = _resolveMount(_tvHighwayCanvas);
        if (!mount) return;
        // Splitscreen fills the panel chrome; main-player insets
        // #player-hud/#player-controls, measured dynamically so controls
        // wrapping to a second row (slopsmith#336) still leaves the last
        // tab row visible. Fallbacks match the historical single-row case.
        let topInset = 0;
        let bottomInset = 0;
        if (!_ssActive()) {
            const hud = document.getElementById('player-hud');
            const controls = document.getElementById('player-controls');
            topInset = (hud && hud.offsetHeight) || 60;
            bottomInset = (controls && controls.offsetHeight) || 48;
        }
        _tvContainer.style.top = topInset + 'px';
        _tvContainer.style.height = Math.max(0, mount.clientHeight - topInset - bottomInset) + 'px';
        // A resize rebuilds boundsLookup, changing marker geometry at the
        // same tick; _tvSyncCursor skips redundant same-tick updates, so
        // resize has to re-place the marker itself.
        _tvUpdateMarker();
    }

    function _tvRemoveContainer() {
        if (_tvControlsObserver) {
            try { _tvControlsObserver.disconnect(); } catch (_) {}
            _tvControlsObserver = null;
        }
        if (_tvContainer) {
            // Restore mount's position style if we changed it in _tvCreateContainer().
            if (_tvPrevMountPosition !== null) {
                const mount = _tvContainer.parentElement;
                if (mount) mount.style.position = _tvPrevMountPosition;
                _tvPrevMountPosition = null;
            }
            _tvContainer.remove();
            _tvContainer = null;
            _tvAtMount = null;
            _tvHighlight = null;
        }
    }

    // ── Error banner ────────────────────────────────────────────────
    //
    // A failed build/render hides the tab container so the 2D highway
    // shows through. This banner surfaces the failure to anyone without
    // devtools open — outside the container, so it doesn't occlude it.

    function _tvShowErrorBanner(message) {
        _tvRemoveErrorBanner();
        const mount = _resolveMount(_tvHighwayCanvas);
        if (!mount) return;
        const banner = document.createElement('div');
        banner.id = 'tabview-dev-error-banner-' + _instanceId;
        banner.className = 'tabview-dev-error-banner';
        banner.dataset.tabviewInstance = String(_instanceId);
        banner.setAttribute('role', 'alert');
        banner.style.cssText = [
            'position:absolute',
            'top:10px',
            'left:50%',
            'transform:translateX(-50%)',
            'background:rgba(220,80,80,0.94)',
            'color:#fff',
            'padding:8px 16px',
            'border-radius:8px',
            'z-index:30',
            'font-size:12px',
            'font-family:system-ui,sans-serif',
            'max-width:80%',
            'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
            'pointer-events:none',
        ].join(';');
        banner.textContent = 'Tab View: ' + (message || 'failed to load');
        mount.appendChild(banner);
        _tvErrorBanner = banner;
        _tvErrorBannerTimeout = setTimeout(_tvRemoveErrorBanner, 6000);
    }

    function _tvRemoveErrorBanner() {
        if (_tvErrorBanner) {
            _tvErrorBanner.remove();
            _tvErrorBanner = null;
        }
        if (_tvErrorBannerTimeout) {
            clearTimeout(_tvErrorBannerTimeout);
            _tvErrorBannerTimeout = null;
        }
    }

    // ── Failure handling ─────────────────────────────────────────────
    // Shared by a synchronous score-build failure and an async alphaTab
    // render error: hide any stale overlay, fall back to the highway.
    function _tvShowFailure(message) {
        _tvReady = false;
        if (_tvContainer) _tvContainer.style.visibility = 'hidden';
        if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
        _tvSetHighwayVisible(null);
        console.warn('[TabView dev] ' + message);
        _tvShowErrorBanner(message);
    }

    // Detaches the current render's listeners from the persistent _tvApi —
    // called before a new render's listeners, on failure, and on teardown,
    // so none are ever left dangling on the live api.
    function _tvUnsubscribeAll() {
        if (!_tvUnsubscribe) return;
        for (const off of _tvUnsubscribe) { try { off(); } catch (_) {} }
        _tvUnsubscribe = null;
    }

    // ── alphaTab init / render ───────────────────────────────────────

    // Caller must have already confirmed _tvContainer exists.
    //
    // _tvApi persists across chart rebuilds (only destroyed in
    // _teardown()) — renderScore() on a live instance is alphaTab's own
    // documented way to switch content. Each render still registers its
    // own scoreLoaded/renderFinished/error closures (they capture this
    // call's notesRef/myToken), so the previous render's listeners are
    // unregistered first.
    //
    // We don't clear _tvAtMount's DOM ourselves before re-rendering:
    // alphaTab creates its own canvas once and each render pass removes
    // its own stale child elements (verified against the pinned source).
    // Clearing it here would desync that bookkeeping instead.
    function _tvInitAlphaTab(score, notesRef, myToken) {
        if (!_tvApi) {
            _tvApi = new alphaTab.AlphaTabApi(_tvAtMount, {
                core: {
                    fontDirectory: ALPHATAB_CDN_BASE + '/font/',
                    // Builds boundsLookup during layout, mapping beat ->
                    // pixel geometry for our own marker (slopsmith#734).
                    includeNoteBounds: true,
                },
                display: {
                    layoutMode: alphaTab.LayoutMode.Page,
                    scale: 0.9,
                },
                player: {
                    // No alphaTab synth: slopsmith owns audio. Disabling it
                    // skips the soundfont download and the player-ready
                    // dependency the old cursor relied on (slopsmith#734).
                    enablePlayer: false,
                },
            });
        }

        _tvUnsubscribeAll();
        _tvReady = false;
        _tvAtBeats = [];
        _tvLastBeat = null;
        // Set once renderFinished fires for this generation — distinguishes
        // a fresh chart (reset scroll, below) from a same-chart resize
        // re-layout (must NOT reset it).
        let isFirstRenderForThisGeneration = true;

        // Flattens into a tick-sorted beat timeline so _tvSyncCursor can
        // resolve tick -> Beat -> boundsLookup geometry.
        const offScoreLoaded = _tvApi.scoreLoaded.on(function (loadedScore) {
            if (_tvInitToken !== myToken) return;
            _tvAtBeats = _tvBuildBeatTimeline(loadedScore);
            _tvLastBeat = null;
        });

        const offRenderFinished = _tvApi.renderFinished.on(function () {
            if (_tvInitToken !== myToken) return;
            _tvReady = true;
            // Started here, not init(): _tvReady only becomes true once
            // rendered, so starting earlier idle-spins through the render.
            _tvStartCursorLoop();
            // Swap visibility only once alphaTab has actual output — the
            // first frame lands several rAFs later, or never on failure.
            if (_tvContainer) _tvContainer.style.visibility = '';
            if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = 'hidden';
            _tvSetHighwayVisible(false);
            if (isFirstRenderForThisGeneration) {
                isFirstRenderForThisGeneration = false;
                // Reset scroll now, after the new chart replaces the old
                // (any earlier would visibly snap the still-displayed old
                // chart) — so a shorter arrangement doesn't stay scrolled
                // past its content until playback catches up.
                if (_tvContainer) { _tvContainer.scrollTop = 0; _tvContainer.scrollLeft = 0; }
            }
            _tvCurrentNotesRef = notesRef;
            _tvPendingNotesRef = _NO_NOTES_REF;
            _tvFailedNotesRef = _NO_NOTES_REF;
            _tvRemoveErrorBanner();
            // renderFinished also fires on a resize re-layout, where
            // boundsLookup is freshly valid — re-place the marker so it
            // doesn't stay hidden after a resize while paused
            // (slopsmith#734). No-op on the first render.
            _tvUpdateMarker();
        });

        const offError = _tvApi.error.on(function (e) {
            if (_tvInitToken !== myToken) return;
            console.error('[TabView dev] alphaTab error:', e);
            // This generation has failed — detach its listeners now rather
            // than leaving them until a later render happens to clean up.
            _tvUnsubscribeAll();
            _tvPendingNotesRef = _NO_NOTES_REF;
            _tvFailedNotesRef = notesRef;
            const msg = (e && e.message) ? e.message : (typeof e === 'string' ? e : 'render failed');
            _tvShowFailure(msg);
        });

        _tvUnsubscribe = [offScoreLoaded, offRenderFinished, offError];

        try {
            score.finish(_tvApi.settings);
            _tvApi.renderScore(score, [0]);
        } catch (e) {
            // _tvUnsubscribe unambiguously refers to the 3 listeners just
            // registered — safe to detach here (unlike the caller's catch,
            // reachable without this function running). Re-throw so
            // failure bookkeeping happens once, in the caller.
            _tvUnsubscribeAll();
            throw e;
        }
    }

    // Builds the score from `bundle` and renders it. Awaits the CDN script
    // load first: buildScoreFromBundle and _tvInitAlphaTab both need
    // window.alphaTab, and _tvLoadScript is the only place that requests it.
    async function _tvRenderFromBundle(bundle, myToken) {
        if (!bundle) return;
        if (!_resolveMount(_tvHighwayCanvas)) return;

        // One snapshot for the whole attempt — draw()'s dirty-check and
        // every ref below must agree on the same value, so a
        // falsy-but-not-null bundle.notes can't desync the guards.
        const notesRef = bundle.notes || null;

        // Marked in flight for the WHOLE attempt, before the CDN-load
        // await — otherwise every draw() frame during a cold network wait
        // re-invokes this, stacking redundant attempts.
        _tvPendingNotesRef = notesRef;

        try {
            await _tvLoadScript();
            if (_tvInitToken !== myToken) return;

            const score = buildScoreFromBundle(window.alphaTab && window.alphaTab.model, bundle);
            if (!score) {
                _tvPendingNotesRef = _NO_NOTES_REF;
                _tvFailedNotesRef = notesRef;
                return;
            }

            // null mount target (player closed, transition timing) — clear
            // pending so the next draw() retries cleanly.
            const container = _tvCreateContainer();
            if (!container) {
                _tvPendingNotesRef = _NO_NOTES_REF;
                console.warn('[TabView dev] mount container missing; leaving highway visible');
                if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
                _tvSetHighwayVisible(null);
                return;
            }
            _tvSizeContainer();

            // Stays in flight until renderFinished/error resolves it (async
            // from here). Don't swap visibility here — that happens in
            // those handlers so the player isn't stranded blank mid-render.
            _tvInitAlphaTab(score, notesRef, myToken);

            // Watchdog: a width=0 mount makes alphaTab skip rendering without
            // ever firing renderFinished/error, leaving _tvPendingNotesRef
            // stuck. No-op once this attempt resolves normally.
            setTimeout(() => {
                if (_tvInitToken !== myToken) return;
                if (_tvPendingNotesRef !== notesRef) return;
                _tvPendingNotesRef = _NO_NOTES_REF;
            }, 6000);
        } catch (e) {
            if (_tvInitToken !== myToken) return;
            console.error('[TabView dev] render failed:', e);
            // Don't _tvUnsubscribeAll() here: if this threw before
            // _tvInitAlphaTab ran, _tvUnsubscribe still belongs to a
            // different, live generation — detaching would drop its
            // listeners. _tvInitAlphaTab owns its own cleanup on a
            // finish()/renderScore() failure.
            _tvPendingNotesRef = _NO_NOTES_REF;
            _tvFailedNotesRef = notesRef;
            _tvShowFailure((e && e.message) ? e.message : String(e));
        }
    }

    // ── Beat timeline (tick → Beat) ─────────────────────────────────

    // Flattens into a tick-sorted [{ beat, start }] list (960-ppq MIDI
    // ticks, bar 0 beat 0 == tick 0). Single track/voice 0. Returns [] on
    // any unexpected shape so the marker just stays hidden.
    function _tvBuildBeatTimeline(score) {
        const out = [];
        try {
            const track = score && score.tracks && score.tracks[0];
            const staff = track && track.staves && track.staves[0];
            const bars = staff && staff.bars;
            if (!bars) return out;
            for (let i = 0; i < bars.length; i++) {
                const voices = bars[i].voices || [];
                const voice = voices[0];
                const beats = voice && voice.beats;
                if (!beats) continue;
                for (let j = 0; j < beats.length; j++) {
                    const b = beats[j];
                    const start = (typeof b.absoluteDisplayStart === 'number')
                        ? b.absoluteDisplayStart
                        : b.absolutePlaybackStart;
                    if (typeof start === 'number') out.push({ beat: b, start: start });
                }
            }
        } catch (_) { /* malformed score → empty timeline → marker hidden */ }
        out.sort(function (a, b) { return a.start - b.start; });
        return out;
    }

    // Greatest beat whose start <= tick (the beat currently sounding).
    // Binary search — runs once per advanced tick, per instance.
    function _tvFindBeatAtTick(tick) {
        const arr = _tvAtBeats;
        if (!arr || arr.length === 0) return null;
        if (tick < arr[0].start) return arr[0].beat;
        const ans = _countLE(arr, tick, b => b.start) - 1;
        return arr[ans].beat;
    }

    // ── Cursor sync ─────────────────────────────────────────────────

    function _tvSyncCursor(currentTime) {
        if (!_tvApi || !_tvReady) return;

        const tick = _tvTimeToTick(currentTime, _tvLatestBeats);
        // Skips the (relatively expensive) lookup+reposition when the tick
        // hasn't advanced — meaningful at 60fps x N splitscreen instances.
        // Resize still re-places the marker via _onWinResize.
        if (Math.abs(tick - _tvLastTick) <= 30) return;
        _tvLastTick = tick;
        _tvLastBeat = _tvFindBeatAtTick(tick);
        _tvUpdateMarker();
    }

    // ── Self-driven cursor loop (slopsmith#734 follow-up) ────────────
    //
    // setVisible(false) (slopsmith#654) also gates the host's draw() pump,
    // so once we're the active renderer, our own draw(bundle) stops being
    // called after the first render and the marker would freeze. We
    // advance it from our own rAF loop instead, reading clock+beats
    // straight off window.highway.
    //
    // Time source is getTime() (audio-aligned chartTime), NOT
    // bundle.currentTime (chartTime + avOffset — non-zero on stem songs,
    // which drags the marker onto the previous note).
    //
    // Splitscreen rides the per-panel draw(bundle) path instead:
    // setVisible is skipped there, and window.highway is the main
    // player's (wrong clock/beats for a panel), so this loop bows out
    // under _ssActive().
    function _tvCursorLoop() {
        _tvCursorRAF = window.requestAnimationFrame(_tvCursorLoop);
        if (!_isReady || !_tvReady) return;
        if (_ssActive()) return;
        const hw = window.highway;
        if (!hw || typeof hw.getTime !== 'function') return;
        if (typeof hw.getBeats === 'function') {
            const b = hw.getBeats();
            if (b) _tvLatestBeats = b;
        }
        // getTime() can return NaN in transient states (pre-anchor boot,
        // mid-seek flush — see highway.js); skip the frame rather than
        // snapping the marker to beat 0.
        const t = hw.getTime();
        if (t == null || !isFinite(t)) return;
        _tvSyncCursor(t);
    }

    function _tvStartCursorLoop() {
        if (_tvCursorRAF != null) return;
        _tvCursorRAF = window.requestAnimationFrame(_tvCursorLoop);
    }

    function _tvStopCursorLoop() {
        if (_tvCursorRAF != null) {
            window.cancelAnimationFrame(_tvCursorRAF);
            _tvCursorRAF = null;
        }
    }

    // ── Playback marker (boundsLookup-driven, slopsmith#734) ─────────

    function _tvUpdateMarker() {
        if (!_tvHighlight || !_tvContainer || !_tvAtMount) return;
        if (!_tvLastBeat) { _tvHighlight.style.display = 'none'; return; }

        // Can be briefly null between a resize and the next renderFinished.
        const bl = _tvApi && _tvApi.boundsLookup;
        const bb = bl ? bl.findBeat(_tvLastBeat) : null;
        const vb = bb && bb.visualBounds;
        if (!vb) { _tvHighlight.style.display = 'none'; return; }

        // visualBounds share _tvAtMount's coordinate space; both it and the
        // marker are absolutely positioned inside the scrolling
        // _tvContainer, so adding _tvAtMount's offset needs no scroll math.
        const baseX = _tvAtMount.offsetLeft;
        const baseY = _tvAtMount.offsetTop;

        const left = Math.round(baseX + vb.x);
        const top = Math.round(baseY + vb.y);
        const width = Math.max(2, Math.round(vb.w));
        const height = Math.max(8, Math.round(vb.h));

        _tvHighlight.style.left = left + 'px';
        _tvHighlight.style.top = top + 'px';
        _tvHighlight.style.width = width + 'px';
        _tvHighlight.style.height = height + 'px';
        _tvHighlight.style.display = '';

        // Auto-advance: scroll to keep the marker comfortably in view.
        const viewW = _tvContainer.clientWidth;
        const viewH = _tvContainer.clientHeight;
        const paddingX = Math.min(180, viewW * 0.3);
        const paddingY = Math.min(100, viewH * 0.25);

        const relX = left - _tvContainer.scrollLeft;
        const relY = top - _tvContainer.scrollTop;

        let needScroll = false;
        let targetX = _tvContainer.scrollLeft;
        let targetY = _tvContainer.scrollTop;

        if (relX < paddingX || relX > viewW - paddingX) {
            targetX = left - viewW / 2;
            needScroll = true;
        }
        if (relY < paddingY || relY > viewH - paddingY) {
            targetY = top - viewH / 2;
            needScroll = true;
        }

        if (needScroll) {
            _tvContainer.scrollTo({
                left: Math.max(0, targetX),
                top: Math.max(0, targetY),
                behavior: 'auto',
            });
        }
    }

    // ── Teardown ────────────────────────────────────────────────────

    function _teardown(restoreCanvas) {
        _tvStopCursorLoop();
        _tvReady = false;
        _tvLastTick = -9999;
        _tvCurrentNotesRef = _NO_NOTES_REF;
        _tvPendingNotesRef = _NO_NOTES_REF;
        _tvFailedNotesRef = _NO_NOTES_REF;
        _tvLatestBeats = null;
        _tvAtBeats = [];
        _tvLastBeat = null;
        // Detach before destroying the api — don't rely on destroy() to
        // also clear its own event emitters' subscriber lists.
        _tvUnsubscribeAll();
        if (_tvApi) {
            try { _tvApi.destroy(); } catch (_) {}
            _tvApi = null;
        }
        _tvRemoveContainer();
        _tvRemoveErrorBanner();
        if (restoreCanvas && _tvHighwayCanvas) {
            _tvHighwayCanvas.style.visibility = _tvPrevVisibility;
            _tvSetHighwayVisible(null);
            _tvHighwayCanvas = null;
            _tvPrevVisibility = '';
        }
    }

    // ── Factory return: setRenderer contract ────────────────────────

    return {
        init(canvas, bundle) {
            // Token bumps BEFORE teardown, not after: _teardown() destroys
            // _tvApi, and if that synchronously re-fires a still-attached
            // listener, its staleness guard must already see a mismatched
            // token.
            const myToken = ++_tvInitToken;

            // Always tears down, even with nothing visible: a previous
            // activation that failed before alphaTab initialized would
            // otherwise leak _tvFailedNotesRef into this lifetime, hitting
            // draw()'s previouslyFailed guard and silently doing nothing.
            //
            // restoreCanvas=true is required: a prior successful render
            // hid the highway canvas, so skipping the restore would
            // capture _tvPrevVisibility as "hidden" below, stranding the
            // player blank on a later failure.
            _teardown(/* restoreCanvas */ true);
            window.removeEventListener('resize', _onWinResize);

            _tvHighwayCanvas = canvas;
            _tvPrevVisibility = canvas ? canvas.style.visibility : '';

            // Don't hide the highway yet — if the build/render fails we
            // want it still visible as a fallback. renderFinished hides
            // it on success; a failure restores _tvPrevVisibility.

            window.addEventListener('resize', _onWinResize);

            _tvRenderFromBundle(bundle, myToken);

            _isReady = true;
            // Started from renderFinished (once _tvReady is true), not
            // here, so it doesn't idle-spin through the async render.
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;

            // Per-instance, not the main-player `highway` global, which
            // under splitscreen belongs to the hidden default highway.
            _tvLatestBeats = bundle.beats || null;

            // Rebuilds whenever bundle.notes' identity differs — covers a
            // song switch and a chart-transform provider rerunning, since
            // highway.js restages a fresh array either way. Guarded
            // against retry storms: skip while in flight or previously
            // failed for this exact ref.
            const notesRef = bundle.notes || null;
            const chartChanged = notesRef !== _tvCurrentNotesRef;
            const buildInFlight = _tvPendingNotesRef === notesRef;
            const previouslyFailed = _tvFailedNotesRef === notesRef;
            if (chartChanged && !buildInFlight && !previouslyFailed) {
                // Defense-in-depth: _tvRenderFromBundle also checks this,
                // but avoids a wasted token bump while the mount is
                // transiently null.
                if (_resolveMount(_tvHighwayCanvas)) {
                    const myToken = ++_tvInitToken;
                    _tvLastTick = -9999;
                    _tvRenderFromBundle(bundle, myToken);
                    // fall through — cursor sync below will be a no-op
                    // until _tvReady flips true again after the re-render.
                }
            }

            // Splitscreen only — single-player's _tvCursorLoop owns the
            // marker from the audio-aligned clock. Letting draw() ALSO
            // drive it would double-sync from bundle.currentTime (render
            // clock), flipping the marker each frame when the host pump
            // isn't gated off. The loop bows out under _ssActive(),
            // keeping the two mutually exclusive.
            if (_ssActive()) {
                // Same NaN guard as _tvCursorLoop: a NaN currentTime would
                // pin _tvLastTick to NaN, permanently breaking the "skip
                // redundant frame" check above.
                const t = bundle.currentTime;
                if (t != null && isFinite(t)) _tvSyncCursor(t);
            }
        },
        resize(/* w, h */) {
            if (!_isReady) return;
            _tvSizeContainer();
        },
        destroy() {
            _isReady = false;
            _tvInitToken++;  // invalidate in-flight builds/renders
            window.removeEventListener('resize', _onWinResize);
            _teardown(/* restoreCanvas */ true);
        },
    };
}

// Arrangement-agnostic — Auto mode should not auto-select tabview.
// (The static matchesArrangement is intentionally absent.)

window.slopsmithViz_tabview_dev = createFactory;
// slopsmith→feedBack rename: host viz picker looks up `window.feedBackViz_<id>`.
window.feedBackViz_tabview_dev = window.slopsmithViz_tabview_dev;

})();
