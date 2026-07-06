// Tab View visualization plugin — renders arrangements as
// scrolling tablature via alphaTab (https://alphatab.net/).
//
// Wave C (slopsmith#36): per-instance refactor. Earlier Wave B
// landed setRenderer support with an explicit single-instance
// module-state assumption (one alphaTab API, one container, one
// cursor highlight, one set of fetch sentinels). Wave C lifts that:
// every piece of per-render state moves into createFactory closures
// so N tabview instances coexist under splitscreen panels.
//
// Module-scope retained for genuine singletons:
//   - alphaTab CDN script load (one <script> tag per tab)
//   - _tvFilename — captured from window.playSong + arrangement:changed,
//     applies to the single global player so all instances share it
//
// Tabview has no MIDI input and no focus-driven behavior — every
// panel renders independently from its own bundle.currentTime, and
// the splitscreen helper is consulted only for the mount target via
// panelChromeFor(). Absence of window.slopsmithSplitscreen OR
// isActive()===false means "main-player, mount into #player."
//
// alphaTab multi-instance: alphaTab loads its font + soundfont as
// CDN-cached static resources, so N AlphaTabApi instances on the
// same page share the underlying assets without coordination. Each
// instance owns its own AlphaTabApi + its own scoreLoaded /
// renderFinished / error subscriptions.

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Module-level state (singletons)
// ═══════════════════════════════════════════════════════════════════════

// Captured from playSong wrap + arrangement:changed. All tabview
// instances see the same filename because slopsmith plays one song
// per tab — splitscreen panels render different arrangements OF THE
// SAME song, not different songs. Per-instance arrangement index
// arrives via bundle.songInfo.arrangement_index.
let _tvFilename = null;

// Monotonic id for per-instance DOM tagging (containers, alphaTab
// mount divs, highlight overlays, error banners — every node a
// tabview instance creates is suffixed with this so N instances
// don't collide on getElementById.
let _nextInstanceId = 0;

// ═══════════════════════════════════════════════════════════════════════
// alphaTab CDN loader (memoized — one load per page)
// ═══════════════════════════════════════════════════════════════════════

// Pin alphaTab to a specific release so new jsDelivr cache invalidations
// or upstream breaking changes can't land silently in production. Bump
// this when the alphaTab CDN publishes a version tested against the
// cursor-sync / tab-highlight behavior below.
const ALPHATAB_VERSION = '1.8.2';
const ALPHATAB_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@' + ALPHATAB_VERSION + '/dist';

// Matches rs2gp.py:TICKS_PER_BEAT. The GP5 builder places the first measure
// at tick TICKS_PER_BEAT (one beat in), hence the baseline offset added in
// _tvTimeToTick and subtracted back out in _tvSyncCursor before looking the
// beat up against alphaTab's 0-based absoluteDisplayStart (slopsmith#336).
const TICKS_PER_BEAT = 960;

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
// Filename tracking (module-level — one global player)
// ═══════════════════════════════════════════════════════════════════════
//
// slopsmith core doesn't expose the current song's filename via a
// getter (song_info carries metadata, not the WS URL). Capture it
// ourselves by wrapping window.playSong once at module load and
// subscribing to arrangement:changed. init() consumes the cached
// _tvFilename when bundle.songInfo.filename isn't populated.

(function () {
    // Idempotency: if screen.js is re-evaluated (loader cache miss, hot reload,
    // older core builds without the load-side guard), don't re-wrap playSong
    // and don't re-subscribe to arrangement:changed — re-wrap grows the
    // wrapper chain, and a duplicate listener would update _tvFilename twice
    // per event.
    //
    // Two independent install steps with their own guards: the first eval
    // may run before window.playSong / window.slopsmith are populated (load
    // order, hot reload), so a single combined flag would lock out a later
    // retry from the second eval. Mark the wrapper itself for playSong (per
    // notedetect/stepmode convention) and a window flag for the listener.

    const origPlay = typeof window.playSong === 'function' ? window.playSong : null;
    if (origPlay && !origPlay._tabviewWrapped) {
        const wrapper = async function (filename, arrangement) {
            _tvFilename = filename;
            return origPlay.call(this, filename, arrangement);
        };
        wrapper._tabviewWrapped = true;
        window.playSong = wrapper;
    }

    if (
        window.slopsmith &&
        typeof window.slopsmith.on === 'function' &&
        !window.__slopsmithTabviewArrangementSubscribed
    ) {
        window.slopsmith.on('arrangement:changed', (e) => {
            // detail = { index, filename }
            if (e && e.detail && e.detail.filename) _tvFilename = e.detail.filename;
        });
        window.__slopsmithTabviewArrangementSubscribed = true;
    }
})();

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helper wrapper
// ═══════════════════════════════════════════════════════════════════════
//
// Tabview only needs panelChromeFor() — there's no MIDI routing or
// focus-driven behavior. Validate ONLY that surface so a partial
// helper that lacks the focus-related methods (which tabview doesn't
// consume) still routes through the splitscreen mount target.

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
// Splitscreen-active: ONLY the panel chrome is acceptable; if
// panelChromeFor returns null mid-creation or during a screen
// transition, return null so callers treat the mount as unavailable
// (the container won't be cached, and a later draw() / resize() /
// banner attempt retries cleanly once the panel chrome resolves).
// Falling through to #player here would (a) cache _tvContainer
// against the main player surface for the rest of the instance's
// lifetime, rendering this panel's tabs over the wrong area, and
// (b) confuse _tvSizeContainer's splitscreen vs main-player branch
// since _ssActive() would still be true on subsequent calls.
function _resolveMount(highwayCanvas) {
    if (_ssActive()) {
        return _ssPanelChrome(highwayCanvas);
    }
    return document.getElementById('player');
}

// ═══════════════════════════════════════════════════════════════════════
// Cursor sync helpers (stateless — beats come from the bundle)
// ═══════════════════════════════════════════════════════════════════════

function _tvTimeToTick(seconds, beats) {
    if (!beats || beats.length < 2) return TICKS_PER_BEAT;
    if (seconds < beats[0].time) return TICKS_PER_BEAT;

    // Largest idx in [0, beats.length-2] with beats[idx].time <= seconds.
    // Binary search (beats are time-sorted) — identical result to a linear
    // scan, but O(log n) per frame instead of O(n) (CodeRabbit nitpick: this
    // is the dominant per-frame sync cost). beats[0].time <= seconds holds
    // here (guarded above), so idx is always >= 0.
    let idx = 0, lo = 0, hi = beats.length - 2;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (beats[mid].time <= seconds) { idx = mid; lo = mid + 1; }
        else { hi = mid - 1; }
    }

    let frac = 0;
    if (idx < beats.length - 1) {
        const bStart = beats[idx].time;
        const bEnd = beats[idx + 1].time;
        if (bEnd > bStart) {
            frac = Math.min(1, Math.max(0, (seconds - bStart) / (bEnd - bStart)));
        }
    }

    return TICKS_PER_BEAT + Math.round((idx + frac) * TICKS_PER_BEAT);
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract (multi-instance)
// ═══════════════════════════════════════════════════════════════════════

function createFactory() {
    const _instanceId = ++_nextInstanceId;

    // Lifecycle
    let _isReady = false;

    // alphaTab + DOM state (per-instance)
    let _tvApi = null;
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

    // Observes #player-controls so the overlay re-insets when the controls
    // bar wraps to a second row on narrow viewports (slopsmith#336). The
    // window-resize listener only fires for viewport changes; this catches
    // content reflow within an unchanged viewport. Main-player mode only —
    // splitscreen panel chrome owns its own bottom-bar layout.
    let _tvControlsObserver = null;

    // Fetch / load tracking
    let _tvCurrentFile = null;   // filename the currently-loaded GP5 was fetched for
    let _tvCurrentArr = null;    // arrangement_index the current GP5 was fetched for
    let _tvLoadingFile = null;   // filename a currently-in-flight fetch is targeting
    let _tvLoadingArr = null;    // arrangement_index that fetch is targeting
    let _tvFailedFile = null;    // last (filename, arr_index) pair whose fetch failed —
    let _tvFailedArr = null;     // used by draw() to avoid a per-frame retry storm

    // Cursor sync
    let _tvLastTick = -1;

    // Self-driven cursor rAF handle (slopsmith#734 follow-up). In
    // single-player the marker is advanced from our OWN requestAnimationFrame
    // loop, not the host draw() pump — see _tvCursorLoop for why.
    let _tvCursorRAF = null;

    // Marker positioning (slopsmith#734). We render our OWN playback
    // marker from alphaTab's layout geometry instead of relying on
    // alphaTab's internal player cursor (.at-cursor-bar). That cursor
    // only appears once alphaTab's *player* reaches the "ready" state,
    // which requires the soundfont to download from the CDN — fragile
    // in the desktop shell (the cursor silently vanished in 0.2.9-beta.2).
    // We don't use alphaTab's synth at all (slopsmith drives audio), so
    // the player is disabled and the marker is driven by boundsLookup,
    // which is available from layout alone (core.includeNoteBounds).
    //
    // _tvAtBeats: flat [{ beat, start }] for every rhythmic beat in the
    // loaded score, sorted by absoluteDisplayStart (960-ppq MIDI ticks,
    // bar 0 beat 0 == tick 0). Rebuilt on each scoreLoaded.
    // _tvLastBeat: the alphaTab Beat the marker currently sits on — kept
    // so a resize (which re-lays-out and rebuilds boundsLookup) can
    // re-place the marker without waiting for the next time tick.
    let _tvAtBeats = [];
    let _tvLastBeat = null;

    // Latest beats snapshot — bundle.beats is the source of truth
    // under Wave C (the bare `highway` global used in Wave B was the
    // main-player's highway, not ours under splitscreen).
    let _tvLatestBeats = null;

    // Monotonic init counter. Each init() bumps it; fetch / alphaTab
    // callbacks capture the token and bail if a newer init has started
    // since. Guards against a rapid arrangement switch where a pending
    // fetch would otherwise install stale GP5 bytes over the new one.
    let _tvInitToken = 0;

    // ── Listener ref (per-instance so destroy() detach matches) ──
    const _onWinResize = () => _tvSizeContainer();

    // Tell the core highway whether its canvas is currently covered by the
    // tab view. We hide the host canvas with visibility:hidden (so alphaTab
    // can still measure its width), but visibility:hidden doesn't trip the
    // highway's offsetParent-based rAF gate — so without this the underlying
    // renderer (e.g. the 3D Highway WebGL overlay) keeps rendering full-tilt
    // behind the opaque tab view. setVisible(false) trips the gate (pausing
    // the host draw) and fires highway:visibility so overlay renderers hide
    // their sibling DOM; setVisible(null) restores DOM-based detection when
    // we hand the highway back. Guarded for older cores without the API.
    // (slopsmith#654)
    function _tvSetHighwayVisible(v) {
        // Splitscreen: window.highway is the *main-player* highway, not a
        // per-panel instance, and panels expose no per-canvas setVisible
        // (only panelChromeFor). So only *force-hide* (false) in single-
        // player mode — where _tvHighwayCanvas IS window.highway's canvas;
        // forcing it from a panel would pause the wrong renderer and panels
        // would race the shared gate. Clearing the override (null) is always
        // safe and idempotent, and MUST run even if splitscreen became
        // active after a single-player hide, so a prior force-hide can't
        // strand the global highway paused. (slopsmith#654)
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

        // The overlay is positioned with left:0/right:0 to inherit width
        // from the mount; that requires the mount to be a positioned
        // ancestor. Existing splitscreen/main-player mounts are; this
        // is an idempotent guard so a future host with a static mount
        // doesn't silently collapse our overlay to 0 width. The original
        // inline position value is saved to _tvPrevMountPosition so
        // _tvRemoveContainer() can restore it on teardown.
        if (getComputedStyle(mount).position === 'static') {
            _tvPrevMountPosition = mount.style.position; // save inline value (often '')
            mount.style.position = 'relative';
        }

        const c = document.createElement('div');
        c.id = 'tabview-container-' + _instanceId;
        c.className = 'tabview-container';
        c.dataset.tabviewInstance = String(_instanceId);
        // visibility:hidden (not display:none) so alphaTab can measure
        // the container's width during init. With display:none the
        // element is out of layout and clientWidth is 0, which makes
        // alphaTab skip the render entirely (warning: "AlphaTab skipped
        // rendering because of width=0"). renderFinished swaps
        // visibility to '' once the first paint lands, preserving the
        // flash-free handoff this layer was originally designed for.
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
        inner.id = 'tabview-at-' + _instanceId;
        inner.className = 'tabview-at';
        c.appendChild(inner);

        // Playback marker overlay (slopsmith#734). A Songsterr-style
        // vertical band: a translucent fill spanning the current beat's
        // width + staff height, with a bright left border reading as the
        // playhead at the beat's leading edge. Positioned from boundsLookup
        // geometry in _tvUpdateMarker — NOT from alphaTab's internal cursor.
        const hl = document.createElement('div');
        hl.id = 'tabview-marker-' + _instanceId;
        hl.className = 'tabview-marker';
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
        // Splitscreen: fill the panel chrome top-to-bottom (the panel bar
        // layers on top via z-index). Main-player: clear #player-hud at
        // the top and #player-controls at the bottom (slopsmith#336 —
        // the previous code reserved the wrong edge, hiding the last
        // tab row behind the controls bar). Measure dynamically so the
        // controls' flex-wrap to a second row at narrow widths still
        // leaves the last row visible. Fallbacks match the historical
        // 60px top assumption + a single-row controls bar.
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
        // After a resize alphaTab re-lays-out and rebuilds boundsLookup,
        // so the marker's geometry changes even at the same tick. Re-place
        // it from the last known beat; _tvSyncCursor skips redundant
        // same-tick updates, so resize has to drive this itself.
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
    // When the GP5 fetch or alphaTab render fails, we hide the tabview
    // container so the 2D highway stays visible. That alone leaves the
    // failure silent to anyone who can't open devtools. A small,
    // auto-dismissing banner anchored to this instance's mount surfaces
    // the error without covering the highway — living OUTSIDE the
    // tabview container so it coexists with the fallback renderer
    // instead of occluding it.

    function _tvShowErrorBanner(message) {
        _tvRemoveErrorBanner();
        const mount = _resolveMount(_tvHighwayCanvas);
        if (!mount) return;
        const banner = document.createElement('div');
        banner.id = 'tabview-error-banner-' + _instanceId;
        banner.className = 'tabview-error-banner';
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

    // ── alphaTab init ───────────────────────────────────────────────

    async function _tvInitAlphaTab(arrayBuffer, myToken) {
        const c = _tvCreateContainer();
        if (!c) return;

        // Destroy previous API before re-init so scoreLoaded / error
        // handlers from the old lifetime don't fire into stale DOM.
        if (_tvApi) {
            try { _tvApi.destroy(); } catch (_) {}
            _tvApi = null;
        }
        _tvReady = false;
        _tvAtBeats = [];
        _tvLastBeat = null;
        if (_tvAtMount) _tvAtMount.innerHTML = '';

        _tvApi = new alphaTab.AlphaTabApi(_tvAtMount, {
            core: {
                fontDirectory: ALPHATAB_CDN_BASE + '/font/',
                // Build the bounds lookup during layout so we can map a
                // beat → rendered pixel geometry for our own marker
                // (slopsmith#734). Without this api.boundsLookup is null.
                includeNoteBounds: true,
            },
            display: {
                layoutMode: alphaTab.LayoutMode.Page,
                scale: 0.9,
            },
            player: {
                // No alphaTab synth: slopsmith owns audio. Disabling the
                // player drops the soundfont CDN download entirely and,
                // crucially, removes the player-ready dependency that the
                // old .at-cursor-bar marker relied on (slopsmith#734).
                enablePlayer: false,
            },
        });

        // On load, flatten the score into a tick-sorted beat timeline so
        // _tvSyncCursor can resolve the current playback tick → Beat →
        // boundsLookup geometry. Single track (rs2gp emits one).
        _tvApi.scoreLoaded.on(function (score) {
            if (_tvInitToken !== myToken) return;
            _tvAtBeats = _tvBuildBeatTimeline(score);
            _tvLastBeat = null;
        });

        _tvApi.renderFinished.on(function () {
            if (_tvInitToken !== myToken) return;
            _tvReady = true;
            // Start the self-driven cursor loop here (not in init()): _tvReady
            // is only true once the score has rendered, so starting earlier
            // just idle-spins for the whole async GP5 fetch. Idempotent, so
            // the resize-driven re-fires of renderFinished are harmless.
            _tvStartCursorLoop();
            // Swap visibility only once alphaTab has actually produced
            // output. _tvApi.load() kicks off rendering synchronously
            // but the first frame lands several rAFs later; if we hid
            // the highway in _tvFetchAndInit right after load() returned
            // (the previous behaviour) the player flashed blank for
            // the duration of the render, or stayed blank forever if
            // renderFinished never fired. Doing it here guarantees a
            // painted-to-painted handoff and lets the error path below
            // fall back to the still-visible 2D highway.
            if (_tvContainer) _tvContainer.style.visibility = '';
            if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = 'hidden';
            _tvSetHighwayVisible(false);
            _tvFailedFile = null;
            _tvFailedArr = null;
            // A successful render supersedes any prior error banner.
            _tvRemoveErrorBanner();
            // renderFinished fires after EVERY (re)layout, including a
            // resize-driven re-render. boundsLookup is freshly valid at
            // this point, so re-place the marker from the last known beat:
            // a width-change resize transiently nulls boundsLookup, and
            // _tvSizeContainer's _tvUpdateMarker() call mid-relayout hides
            // the marker — without this it would stay hidden while paused
            // (or until _tvSyncCursor's tick advances >30) (slopsmith#734).
            // No-op on the first render (_tvLastBeat is null → marker hidden).
            _tvUpdateMarker();
        });

        _tvApi.error.on(function (e) {
            if (_tvInitToken !== myToken) return;
            console.error('[TabView] alphaTab error:', e);
            // Render or parse error after GP5 fetch succeeded: tabview
            // can't display anything for this target. Mark it failed so
            // draw()'s change-detection doesn't re-fetch on every rAF,
            // hide our (possibly empty) overlay, and restore highway
            // visibility so the player isn't stranded blank. Use
            // _tvCurrentFile/Arr if set (post-fetch) else fall back to
            // the in-flight _tvLoadingFile/Arr so we always remember
            // what went wrong.
            const failedFile = _tvCurrentFile || _tvLoadingFile;
            const failedArr = _tvCurrentArr != null ? _tvCurrentArr : _tvLoadingArr;
            _tvReady = false;
            _tvCurrentFile = null;
            _tvCurrentArr = null;
            if (failedFile != null) {
                _tvFailedFile = failedFile;
                _tvFailedArr = failedArr;
            }
            if (_tvContainer) _tvContainer.style.visibility = 'hidden';
            if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
            _tvSetHighwayVisible(null);
            const msg = (e && e.message) ? e.message : (typeof e === 'string' ? e : 'render failed');
            _tvShowErrorBanner(msg);
        });

        _tvApi.load(new Uint8Array(arrayBuffer));
    }

    async function _tvFetchAndInit(filename, arrIdx, myToken) {
        if (!filename) {
            console.warn('[TabView] no filename known yet; skipping fetch');
            return;
        }
        // Mount-availability guard. In splitscreen the panel chrome
        // can be null transiently (panel mid-creation, screen
        // transitions) — _resolveMount returns null in that case.
        // Bail BEFORE setting _tvLoading* / hitting the network so
        // draw()'s change-detect doesn't treat us as in-flight, and
        // so we don't spam the GP5 endpoint with fetches that would
        // immediately discard their results because _tvCreateContainer
        // returns null too. The next draw() retries cleanly once the
        // panel chrome resolves; load state stays "needs fetch" via
        // _tvCurrentFile/_tvCurrentArr remaining unset.
        if (!_resolveMount(_tvHighwayCanvas)) {
            return;
        }
        _tvLoadingFile = filename;
        _tvLoadingArr = arrIdx;
        try {
            await _tvLoadScript();
            if (_tvInitToken !== myToken) return;

            // Decode first — filename may already be URI-encoded from
            // the data-play attribute — then re-encode for the request
            // path. decodeURIComponent throws URIError on stray % or
            // bare `%xx` where xx isn't valid hex; fall back to the raw
            // filename so a rare encoding edge case doesn't land in the
            // (_tvFailedFile, _tvFailedArr) cache and permanently block
            // retries for that song / arrangement.
            let decoded = filename;
            try {
                decoded = decodeURIComponent(filename);
            } catch (e) {
                console.warn('[TabView] decodeURIComponent failed; using raw filename:', filename, e);
            }
            const url = '/api/plugins/tabview/gp5/' + encodeURIComponent(decoded) +
                '?arrangement=' + arrIdx;
            const resp = await fetch(url);
            if (_tvInitToken !== myToken) return;
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.arrayBuffer();
            if (_tvInitToken !== myToken) return;

            // _tvCreateContainer returns null when the mount target
            // isn't in the DOM (player screen closed, unusual timing
            // during screen transitions). Without this guard the next
            // line's _tvContainer.style.visibility = '' would throw on
            // null and the failure path below would cache this as a
            // permanent failure for the song, even though the real
            // issue is transient DOM state.
            const container = _tvCreateContainer();
            if (!container) {
                console.warn('[TabView] mount container missing; leaving highway visible');
                if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
                _tvSetHighwayVisible(null);
                return;
            }
            _tvSizeContainer();
            await _tvInitAlphaTab(data, myToken);

            if (_tvInitToken !== myToken) return;
            _tvCurrentFile = filename;
            _tvCurrentArr = arrIdx;
            // DO NOT show the container or hide the highway here:
            // _tvApi.load() inside _tvInitAlphaTab kicks off rendering
            // but resolves before the first frame is painted, so doing
            // the visibility swap at this point would flash the player
            // blank during the render setup (or forever if render never
            // completes). The renderFinished handler inside
            // _tvInitAlphaTab takes over: on success it swaps in the
            // overlay, on error it keeps the highway visible.
        } catch (e) {
            if (_tvInitToken !== myToken) return;
            console.error('[TabView] GP5 fetch/init failed:', e);
            _tvFailedFile = filename;
            _tvFailedArr = arrIdx;
            // Hide any stale tab overlay (either a prior successful load
            // that's being reloaded into a failing song, or the freshly
            // created empty container from an initial failed load) so
            // the highway fallback actually becomes visible.
            if (_tvContainer) _tvContainer.style.visibility = 'hidden';
            if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
            _tvSetHighwayVisible(null);
            const msg = (e && e.message) ? e.message : String(e);
            console.warn('[TabView] ' + msg);
            _tvShowErrorBanner(msg);
        } finally {
            // Only clear the loading-target if this fetch is still the
            // latest in-flight one — a newer token bump already cleared /
            // re-set these fields for a subsequent fetch.
            if (_tvInitToken === myToken) {
                _tvLoadingFile = null;
                _tvLoadingArr = null;
            }
        }
    }

    // ── Beat timeline (tick → Beat) ─────────────────────────────────

    // Flatten the loaded score into a tick-sorted [{ beat, start }] list.
    // `start` is absoluteDisplayStart in 960-ppq MIDI ticks (bar 0 beat 0
    // == tick 0). One track only (rs2gp emits a single guitar/bass track);
    // voice 0 carries the notes. Returns [] on any unexpected shape so the
    // marker simply stays hidden rather than throwing on the rAF path.
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
        let lo = 0, hi = arr.length - 1, ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].start <= tick) { ans = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        return arr[ans].beat;
    }

    // ── Cursor sync ─────────────────────────────────────────────────

    function _tvSyncCursor(currentTime) {
        if (!_tvApi || !_tvReady) return;

        const tick = _tvTimeToTick(currentTime, _tvLatestBeats);
        // Skip the (relatively expensive) beat lookup + marker reposition
        // when the tick hasn't advanced — at 60fps × N splitscreen
        // instances that's meaningful cost for state that doesn't change
        // between frames. Resize-driven movement still re-places the
        // marker via _onWinResize → _tvSizeContainer → _tvUpdateMarker.
        if (Math.abs(tick - _tvLastTick) <= 30) return;
        _tvLastTick = tick;
        // _tvTimeToTick adds a one-beat baseline because rs2gp starts the
        // first measure at tick TICKS_PER_BEAT; alphaTab's
        // absoluteDisplayStart is 0-based, so subtract it back out before
        // looking the beat up. Floor at 0 for the very first beat.
        const lookupTick = Math.max(0, tick - TICKS_PER_BEAT);
        _tvLastBeat = _tvFindBeatAtTick(lookupTick);
        _tvUpdateMarker();
    }

    // ── Self-driven cursor loop (slopsmith#734 follow-up) ────────────
    //
    // Single-player Tab View hides the highway via setVisible(false) so the
    // occluded underlying renderer stops burning GPU behind the opaque tab
    // (slopsmith#654). But that same flag gates the host's per-frame draw
    // pump (`highway.js`: `if (!_lastVisible) return` *before* it calls the
    // active renderer's draw(bundle)) — and we ARE the active renderer. So
    // our draw(bundle) stopped being called the instant the first render
    // finished, and the boundsLookup marker silently froze / never appeared.
    //
    // Fix: advance the marker from our own requestAnimationFrame loop,
    // reading the clock + beats straight off window.highway, so the cursor
    // no longer depends on whether the host pumps draw().
    //
    // Time source is getTime() (chartTime — the AUDIO-aligned clock), NOT
    // bundle.currentTime. bundle.currentTime is the *render* clock
    // (chartTime + avOffset); on stem songs avOffset is non-zero (e.g.
    // −215 ms), which dragged the marker onto the previous note. getTime()
    // is exactly the audio position, so the marker sits on the note you hear.
    //
    // Splitscreen still rides the per-panel draw(bundle) path: setVisible
    // (false) is skipped there (so draw() keeps flowing), and window.highway
    // is the *main* player's instance — wrong clock/beats for a panel — so
    // the loop bows out when _ssActive().
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
        // mid-seek flush — see highway.js). Feeding NaN to _tvSyncCursor
        // resolves to lookupTick 0 and snaps the marker back to beat 0, so
        // skip the frame instead.
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

        // boundsLookup is rebuilt on every (re)layout; it can be briefly
        // null between a resize and the next renderFinished. Bail quietly.
        const bl = _tvApi && _tvApi.boundsLookup;
        const bb = bl ? bl.findBeat(_tvLastBeat) : null;
        const vb = bb && bb.visualBounds;
        if (!vb) { _tvHighlight.style.display = 'none'; return; }

        // visualBounds are in the rendered surface's coordinate space,
        // whose origin is _tvAtMount's content box. Both the marker and
        // _tvAtMount are absolutely positioned children of the scrolling
        // _tvContainer, so they share its scrolled space — add _tvAtMount's
        // offset, no scroll math needed. The translucent band spans the
        // beat's width; the bright left border (static CSS) reads as the
        // playhead at the beat's leading edge.
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
        _tvLastTick = -1;
        _tvCurrentFile = null;
        _tvCurrentArr = null;
        _tvLoadingFile = null;
        _tvLoadingArr = null;
        _tvFailedFile = null;
        _tvFailedArr = null;
        _tvLatestBeats = null;
        _tvAtBeats = [];
        _tvLastBeat = null;
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
            // Always run teardown at init start, even when there's
            // no visible container/API to tear down. A previous
            // activation that failed BEFORE alphaTab initialised
            // (e.g. CDN load error, fetch error pre-container) would
            // otherwise leak _tvFailedFile / _tvFailedArr into this
            // lifetime — the new fetch would hit the previouslyFailed
            // guard in draw() and silently skip, so re-picking Tab
            // View would appear to do nothing.
            //
            // restoreCanvas=true (not false) is critical here: a
            // prior successful render hid the highway canvas via
            // renderFinished, and skipping the restore would leave
            // the canvas at visibility:hidden when the new init
            // captures _tvPrevVisibility below — so a subsequent
            // failed fetch / destroy would "restore" the canvas to
            // hidden and strand the player blank. The
            // _tvHighwayCanvas reference is also nulled by the
            // restore branch, freeing the new init() to install
            // the freshly-passed canvas without aliasing.
            _teardown(/* restoreCanvas */ true);
            window.removeEventListener('resize', _onWinResize);

            const myToken = ++_tvInitToken;
            _tvHighwayCanvas = canvas;
            _tvPrevVisibility = canvas ? canvas.style.visibility : '';

            // DON'T hide the 2D highway yet — if GP5 fetch, CDN load,
            // or alphaTab init fails (missing filename, server down,
            // network error), we want the default visible as a
            // fallback so the player isn't stranded blank. The hide
            // happens inside renderFinished on success, and a failed
            // fetch restores _tvPrevVisibility explicitly.

            _tvLastTick = -1;
            window.addEventListener('resize', _onWinResize);

            const songInfo = (bundle && bundle.songInfo) || {};
            const filename = (typeof songInfo.filename === 'string' && songInfo.filename)
                || _tvFilename;
            const arrIdx = Number.isInteger(songInfo.arrangement_index)
                ? songInfo.arrangement_index : 0;
            _tvFetchAndInit(filename, arrIdx, myToken);

            _isReady = true;
            // The self-driven cursor loop (the marker can't rely on the host
            // draw() pump once the highway is hidden — slopsmith#654 gate) is
            // started from renderFinished, once _tvReady is true, so it
            // doesn't idle-spin through the async GP5 fetch.
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;

            // Cache beats per frame so cursor sync uses the
            // filter-aware beats from THIS instance's bundle, not
            // the main-player's `highway` global (which under
            // splitscreen belongs to the hidden default highway and
            // wouldn't reflect this panel's arrangement).
            _tvLatestBeats = bundle.beats || null;

            // Detect arrangement / song change: re-fetch GP5 when the
            // active (filename, arrangement_index) differs from the
            // one the currently-displayed score was loaded for. Guard
            // against per-frame retry loops — while a fetch is in
            // flight for the same target, skip. draw() runs every rAF
            // and a typical fetch takes well over one frame; without
            // this check we'd spam the endpoint and keep bumping the
            // init token, invalidating each request before it lands.
            //
            // Prefer bundle.songInfo.filename when present and fall
            // back to the _tvFilename cache from our playSong wrap.
            // slopsmith core doesn't expose filename in song_info
            // today, but routing through bundle first means we pick
            // it up automatically when/if core adds it, and it
            // eliminates the small race where _tvFilename lags
            // bundle.songInfo during a rapid song switch.
            const songInfo = bundle.songInfo || {};
            const filename = (typeof songInfo.filename === 'string' && songInfo.filename)
                || _tvFilename;
            const arrIdx = Number.isInteger(songInfo.arrangement_index)
                ? songInfo.arrangement_index : 0;
            const chartChanged = filename &&
                (filename !== _tvCurrentFile || arrIdx !== _tvCurrentArr);
            const loadInFlight = _tvLoadingFile !== null &&
                _tvLoadingFile === filename && _tvLoadingArr === arrIdx;
            const previouslyFailed = _tvFailedFile === filename &&
                _tvFailedArr === arrIdx;
            if (chartChanged && !loadInFlight && !previouslyFailed) {
                // Defense-in-depth mount check. _tvFetchAndInit also
                // guards (and is the single source of truth), but
                // doing the check here too saves a per-frame
                // _tvInitToken bump while the panel chrome is
                // transient-null; tokens are cheap but the bump+bail
                // pattern is dead work.
                if (_resolveMount(_tvHighwayCanvas)) {
                    const myToken = ++_tvInitToken;
                    _tvLastTick = -1;
                    _tvFetchAndInit(filename, arrIdx, myToken);
                    // fall through — cursor sync below will be a no-op
                    // until _tvReady flips true again after the re-init.
                }
            }

            // Splitscreen only. In single-player the rAF loop
            // (_tvCursorLoop) owns the marker, driven from the
            // audio-aligned highway.getTime(). Letting draw() ALSO drive
            // it would double-sync from a second clock: bundle.currentTime
            // is the render clock (chartTime + avOffset), so on a core
            // where the host pump isn't gated off (no highway.setVisible,
            // or the one transition frame before the highway hides) the
            // marker would flip a beat back and forth every frame between
            // audio time and render time. The loop bows out under
            // _ssActive(), so the two paths stay mutually exclusive.
            if (_ssActive()) {
                _tvSyncCursor(bundle.currentTime);
            }
        },
        resize(/* w, h */) {
            if (!_isReady) return;
            _tvSizeContainer();
        },
        destroy() {
            _isReady = false;
            _tvInitToken++;  // invalidate in-flight fetches
            window.removeEventListener('resize', _onWinResize);
            _teardown(/* restoreCanvas */ true);
        },
    };
}

// Arrangement-agnostic — Auto mode should not auto-select tabview.
// (The static matchesArrangement is intentionally absent.)

window.slopsmithViz_tabview = createFactory;
// slopsmith→feedBack rename: host viz picker looks up `window.feedBackViz_<id>`.
window.feedBackViz_tabview = window.slopsmithViz_tabview;

})();
