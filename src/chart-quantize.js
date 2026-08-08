// Pure chart math for score-builder.js: grouping beats into measures,
// merging notes/chords into a time-sorted event list, quantizing note
// onsets to a 32nd-note grid, decomposing a 32nd-note count into
// alphaTab Duration/dots pairs, and building a tuning table. No alphaTab
// dependency — see test/chart-quantize.test.mjs.

export const SUBDIV = 8; // 32nd-note slots per beat

// GP string 1 (highest) to N (lowest); index0 = highest pitch, matching
// alphaTab's Tuning.tunings convention (staff.stringTuning: "the first
// item is the most top tablature line").
const GUITAR_STANDARD = [64, 59, 55, 50, 45, 40, 35, 30];
const BASS_STANDARD = {
    4: [43, 38, 33, 28],
    5: [43, 38, 33, 28, 23],
    6: [48, 43, 38, 33, 28, 23],
};

// ── Measure / tempo parsing ─────────────────────────────────────────────

export function parseMeasures(beats) {
    if (!beats || !beats.length) return [];
    const groups = [];
    let cur = [];
    for (const b of beats) {
        if (typeof b.measure === 'number' && b.measure >= 0 && cur.length) { groups.push(cur); cur = []; }
        cur.push(b);
    }
    if (cur.length) groups.push(cur);

    const result = [];
    for (let i = 0; i < groups.length; i++) {
        const grp = groups[i];
        const start = grp[0].time;
        let end;
        if (i + 1 < groups.length) {
            end = groups[i + 1][0].time;
        } else if (grp.length > 1) {
            const avg = (grp[grp.length - 1].time - grp[0].time) / (grp.length - 1);
            end = grp[grp.length - 1].time + avg;
        } else if (result.length) {
            const prev = result[result.length - 1];
            end = start + (prev.endTime - prev.startTime);
        } else {
            end = start + 2.0;
        }

        const n = grp.length;
        let bpm;
        if (n > 1) {
            const interval = (grp[n - 1].time - grp[0].time) / (n - 1);
            bpm = interval > 0 ? 60.0 / interval : 120.0;
        } else if (result.length) {
            bpm = result[result.length - 1].bpm;
        } else {
            bpm = 120.0;
        }

        result.push({ startTime: start, endTime: end, numBeats: n, beatTimes: grp.map(b => b.time), bpm });
    }
    return result;
}

export function fallbackMeasure(length) {
    // Falls back to a default span for any non-positive/invalid length.
    // `length || 60.0` isn't equivalent: it also lets a negative length
    // through (only 0/NaN/null/undefined are falsy), producing a measure
    // that ends before it starts.
    const len = (typeof length === 'number' && length > 0) ? length : 60.0;
    const numBeats = 4;
    return {
        startTime: 0.0,
        endTime: len,
        numBeats,
        // One entry per numBeats, evenly spanning the measure —
        // quantizeThirtySecond treats the last entry's next boundary as
        // endTime, so a length mismatch here left late slots unreachable.
        beatTimes: Array.from({ length: numBeats }, (_, i) => (len * i) / numBeats),
        bpm: 120.0,
    };
}

// ── Event merging (notes/chords are already wire-shaped: t/s/f/sus/sl/... ) ──

export function mergeEvents(notes, chords) {
    const events = [];
    for (const n of (notes || [])) {
        events.push({ time: n.t, type: 'note', note: n });
    }
    for (const ch of (chords || [])) {
        if (ch.hd) continue; // high-density chords are a rendering aid, not real notation
        events.push({ time: ch.t, type: 'chord', chordNotes: ch.notes || [] });
    }
    events.sort((a, b) => a.time - b.time);
    return events;
}

// ── Rhythm quantization (32nd-note grid) ────────────────────────────────

export function quantizeThirtySecond(eventTime, beatTimes, measureEnd) {
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < beatTimes.length; i++) {
        const bt = beatTimes[i];
        const next = i + 1 < beatTimes.length ? beatTimes[i + 1] : measureEnd;
        const dur = next - bt;
        for (let sub = 0; sub < SUBDIV; sub++) {
            const t = bt + (dur * sub) / SUBDIV;
            const d = Math.abs(eventTime - t);
            if (d < bestDist) { bestDist = d; best = i * SUBDIV + sub; }
        }
    }
    return best;
}

// {duration, dots} pairs using alphaTab's own Duration enum values
// (1=whole, 2=half, 4=quarter, 8=eighth, 16, 32 — same numeric convention
// GP5 uses, so these values need no translation at the call site).
export function decomposeThirtySeconds(count) {
    if (count <= 0) return [{ duration: 4, dots: 0 }];
    const durs = [];
    let rem = count;
    while (rem > 0) {
        let duration, dots = 0;
        if (rem >= 32) { duration = 1; rem -= 32; }
        else if (rem >= 24) { duration = 2; dots = 1; rem -= 24; }
        else if (rem >= 16) { duration = 2; rem -= 16; }
        else if (rem >= 12) { duration = 4; dots = 1; rem -= 12; }
        else if (rem >= 8) { duration = 4; rem -= 8; }
        else if (rem >= 6) { duration = 8; dots = 1; rem -= 6; }
        else if (rem >= 4) { duration = 8; rem -= 4; }
        else if (rem >= 3) { duration = 16; dots = 1; rem -= 3; }
        else if (rem >= 2) { duration = 16; rem -= 2; }
        else { duration = 32; rem -= 1; }
        durs.push({ duration, dots });
    }
    return durs;
}

const BASE_THIRTY_SECONDS = { 1: 32, 2: 16, 4: 8, 8: 4, 16: 2, 32: 1 };

export function thirtySecondsForDuration(part) {
    let v = BASE_THIRTY_SECONDS[part.duration] ?? 8;
    if (part.dots) v = Math.trunc(v * 1.5);
    return Math.max(v, 1);
}

// ── Tuning table ─────────────────────────────────────────────────────────

// tuningOffsets: per-RS-string semitone offsets from standard (index 0 =
// lowest string, same convention as songInfo.tuning). Returns tunings[]
// ordered index0 = highest pitch, matching alphaTab's Tuning.tunings.
export function buildTuning(tuningOffsets, isBass, stringCount) {
    let standard;
    if (isBass) {
        standard = BASS_STANDARD[stringCount];
        if (!standard) {
            const keys = Object.keys(BASS_STANDARD).map(Number);
            const nearest = keys.reduce((a, b) => (Math.abs(b - stringCount) < Math.abs(a - stringCount) ? b : a));
            const base = BASS_STANDARD[nearest].slice();
            while (base.length < stringCount) base.push(base[base.length - 1] - 5);
            standard = base.slice(0, stringCount);
        }
    } else {
        standard = GUITAR_STANDARD;
    }
    const tunings = [];
    for (let gpIdx = 0; gpIdx < stringCount; gpIdx++) {
        const rsIdx = stringCount - 1 - gpIdx;
        const baseMidi = gpIdx < standard.length
            ? standard[gpIdx]
            : standard[standard.length - 1] - 5 * (gpIdx - standard.length + 1);
        const raw = rsIdx < tuningOffsets.length ? tuningOffsets[rsIdx] : 0;
        const offset = Number.isFinite(raw) ? raw : 0;
        tunings.push(baseMidi + offset);
    }
    return tunings;
}
