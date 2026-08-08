// buildScoreFromBundle against the REAL alphaTab model classes (pinned to
// the same version screen.js loads from the CDN — see package.json). Runs
// entirely in Node; alphaTab's model classes need no browser/canvas.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as alphaTab from '@coderline/alphatab';
import { buildScoreFromBundle } from '../src/score-builder.js';

function note(overrides) {
    return { s: 0, f: 0, sus: 0, sl: -1, slu: -1, bn: 0, ho: false, po: false,
        hm: false, hp: false, pm: false, mt: false, tr: false, ac: false, tp: false, ...overrides };
}

function finish(score) {
    score.finish(new alphaTab.Settings());
    return score;
}

function bars(score) {
    return score.tracks[0].staves[0].bars;
}

test('buildScoreFromBundle: title/artist/track name/tuning/tempo', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [], chords: [],
        songInfo: { title: 'My Song', artist: 'Someone', arrangement: 'Lead', duration: 2.0 },
    }));
    assert.equal(score.title, 'My Song');
    assert.equal(score.artist, 'Someone');
    assert.equal(score.tracks[0].name, 'Lead');
    assert.equal(score.tempo, 120);
    assert.deepEqual(score.tracks[0].staves[0].tuning, [64, 59, 55, 50, 45, 40]);
});

test('buildScoreFromBundle: bass detection sets bass tuning and channel', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 4,
        tuning: [0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [], chords: [],
        songInfo: { arrangement: 'Bass', duration: 2.0 },
    }));
    assert.deepEqual(score.tracks[0].staves[0].tuning, [43, 38, 33, 28]);
    assert.equal(score.tracks[0].playbackInfo.primaryChannel, 1);
});

test('buildScoreFromBundle: bass detection requires a whole word, not a substring', () => {
    // "BasslineKeys" contains "bass" as a substring but isn't a bass
    // arrangement.
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [], chords: [],
        songInfo: { arrangement: 'BasslineKeys', duration: 2.0 },
    }));
    assert.deepEqual(score.tracks[0].staves[0].tuning, [64, 59, 55, 50, 45, 40]); // guitar, not bass
    assert.equal(score.tracks[0].playbackInfo.primaryChannel, 0);
});

test('buildScoreFromBundle: note lands on the right string/fret', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [{ t: 0.0, ...note({ s: 0, f: 3 }) }],
        chords: [],
        songInfo: {},
    }));
    const n = bars(score)[0].voices[0].beats[0].notes[0];
    assert.equal(n.string, 1); // RS string 0 (lowest) -> alphaTab string 1 (lowest)
    assert.equal(n.fret, 3);
});

test('buildScoreFromBundle: chord notes land in one beat, each with its own fret', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [],
        chords: [{ t: 0.0, hd: false, notes: [note({ s: 0, f: 2 }), note({ s: 5, f: 7 })] }],
        songInfo: {},
    }));
    const beat = bars(score)[0].voices[0].beats[0];
    assert.equal(beat.notes.length, 2);
    // Cross-check fret-to-string pairing, not just which strings sounded —
    // distinct frets (2 vs 7) so a cross-assignment bug can't pass by
    // coincidence the way two equal/default frets could.
    const byString = new Map(beat.notes.map(n => [n.string, n.fret]));
    assert.equal(byString.get(1), 2); // RS string 0 -> alphaTab string 1
    assert.equal(byString.get(6), 7); // RS string 5 -> alphaTab string 6
});

test('buildScoreFromBundle: an out-of-range string index is dropped, not corrupted', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [
            { t: 0.0, ...note({ s: 8, f: 3 }) },  // out of range for stringCount=6
            { t: 0.5, ...note({ s: 2, f: 1 }) },  // valid
        ],
        chords: [],
        songInfo: {},
    }));
    const beats = bars(score)[0].voices[0].beats;
    assert.equal(beats[0].notes.length, 0); // dropped, not a corrupted/NaN-pitch note
    assert.equal(beats[1].notes.length, 1);
    assert.equal(beats[1].notes[0].string, 3); // s:2 -> alphaTab string 3
    assert.equal(Number.isFinite(beats[1].notes[0].realValue), true);
});

test('buildScoreFromBundle: NaN/non-integer string or fret is dropped, not a crash', () => {
    // wire.s < 0 || wire.s >= stringCount alone lets NaN through (NaN fails
    // both comparisons), and wire.f had no validation at all.
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [
            { t: 0.0, ...note({ s: NaN, f: 3 }) },
            { t: 0.5, ...note({ s: 2, f: NaN }) },
            { t: 1.0, ...note({ s: 2, f: 1 }) },  // valid
        ],
        chords: [],
        songInfo: {},
    }));
    const beats = bars(score)[0].voices[0].beats;
    assert.equal(beats[0].notes.length, 0);
    assert.equal(beats[1].notes.length, 0);
    assert.equal(beats[2].notes.length, 1);
});

test('buildScoreFromBundle: an odd gap (17 32nd-notes) ties the sustain, not silence', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [
            { t: 0.0, ...note({ s: 0, f: 5 }) },
            { t: 1.0625, ...note({ s: 1, f: 2 }) },  // quantizes 17 slots after t=0.0
        ],
        chords: [],
        songInfo: {},
    }));
    const beats = bars(score)[0].voices[0].beats;
    // decomposeThirtySeconds(17) -> [half note, 32nd note]: origin + one tied continuation.
    assert.equal(beats[0].duration, alphaTab.model.Duration.Half);
    assert.equal(beats[0].notes[0].isTieDestination, false);

    assert.equal(beats[1].duration, alphaTab.model.Duration.ThirtySecond);
    assert.equal(beats[1].notes.length, 1);
    const tied = beats[1].notes[0];
    assert.equal(tied.isTieDestination, true);
    assert.equal(tied.string, 1);
    assert.equal(tied.fret, 5);
    assert.equal(tied.tieOrigin, beats[0].notes[0]);
});

test('buildScoreFromBundle: hammer-on/slide auto-resolve to the next note on the same string', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [
            { t: 0.0, ...note({ s: 0, f: 3, ho: true, sl: 1 }) },
            { t: 0.5, ...note({ s: 0, f: 5 }) },
        ],
        chords: [],
        songInfo: {},
    }));
    const beats = bars(score)[0].voices[0].beats;
    const origin = beats[0].notes[0];
    assert.equal(origin.isHammerPullOrigin, true);
    assert.equal(origin.hammerPullDestination.fret, 5);
    assert.equal(origin.slideTarget.fret, 5);
});

test('buildScoreFromBundle: bend/harmonic/accent/palm-mute map onto the note', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [{ t: 0.0, ...note({ s: 0, f: 2, bn: 2, hm: true, ac: true, pm: true }) }],
        chords: [],
        songInfo: {},
    }));
    const n = bars(score)[0].voices[0].beats[0].notes[0];
    assert.equal(n.hasBend, true);
    assert.deepEqual(n.bendPoints.map(p => [p.offset, p.value]), [[0, 0], [30, 4], [60, 4]]);
    assert.equal(n.harmonicType, alphaTab.model.HarmonicType.Natural);
    assert.equal(n.accentuated, alphaTab.model.AccentuationType.Normal);
    assert.equal(n.isPalmMute, true);
});

test('buildScoreFromBundle: mute and tap map onto the note', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [
            { t: 0.0, ...note({ s: 0, f: 2, mt: true }) },
            { t: 0.5, ...note({ s: 1, f: 3, tp: true }) },
        ],
        chords: [],
        songInfo: {},
    }));
    const beats = bars(score)[0].voices[0].beats;
    assert.equal(beats[0].notes[0].isDead, true);
    assert.equal(beats[1].notes[0].isLeftHandTapped, true);
});

test('buildScoreFromBundle: tremolo only marks the beat when every note requests it', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [{ time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }],
        notes: [],
        chords: [
            // Mixed: only one of two notes wants tremolo -> not applied.
            { t: 0.0, hd: false, notes: [note({ s: 0, f: 1, tr: true }), note({ s: 1, f: 2, tr: false })] },
            // Uniform: both notes want tremolo -> applied.
            { t: 0.5, hd: false, notes: [note({ s: 0, f: 3, tr: true }), note({ s: 1, f: 4, tr: true })] },
        ],
        songInfo: {},
    }));
    const beats = bars(score)[0].voices[0].beats;
    assert.equal(beats[0].tremoloPicking, undefined);
    assert.notEqual(beats[1].tremoloPicking, undefined);
    assert.equal(beats[1].tremoloPicking.marks, 1);
});

test('buildScoreFromBundle: events partition correctly across measures (and outliers drop)', () => {
    // Notes before the first measure's start and after the last measure's
    // end are dropped (matches the old per-measure >= start && < end
    // filter); one note lands in each real measure.
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [
            { time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 },
            { time: 2.0, measure: 1 }, { time: 2.5 }, { time: 3.0 }, { time: 3.5 },
        ],
        notes: [
            { t: -1.0, ...note({ s: 0, f: 9 }) },  // before measure 0 -> dropped
            { t: 0.0, ...note({ s: 0, f: 1 }) },   // measure 0
            { t: 2.0, ...note({ s: 0, f: 2 }) },   // measure 1
            { t: 99.0, ...note({ s: 0, f: 9 }) },  // after the last measure -> dropped
        ],
        chords: [],
        songInfo: { duration: 4.0 },
    }));
    const b = bars(score);
    assert.equal(b[0].voices[0].beats[0].notes[0].fret, 1);
    assert.equal(b[1].voices[0].beats[0].notes[0].fret, 2);
    const allFrets = b.flatMap(bar => bar.voices[0].beats.flatMap(beat => beat.notes.map(n => n.fret)));
    assert.deepEqual(allFrets.sort((x, y) => x - y), [1, 2]);
});

test('buildScoreFromBundle: an empty measure renders as a rest, not a dropped bar', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [
            { time: 0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 },
            { time: 2.0, measure: 1 }, { time: 2.5 }, { time: 3.0 }, { time: 3.5 },
        ],
        notes: [{ t: 0.0, ...note({ s: 0, f: 1 }) }], // only measure 0 has content
        chords: [],
        songInfo: { duration: 4.0 },
    }));
    const b = bars(score);
    assert.equal(b.length, 2);
    assert.equal(b[1].voices[0].beats.every(beat => beat.isRest), true);
});

test('buildScoreFromBundle: no beats falls back to a single default measure', () => {
    const score = finish(buildScoreFromBundle(alphaTab.model, {
        stringCount: 6,
        tuning: [0, 0, 0, 0, 0, 0],
        beats: [],
        notes: [{ t: 0.0, ...note({ s: 0, f: 0 }) }],
        chords: [],
        songInfo: { duration: 4.0 },
    }));
    assert.equal(bars(score).length, 1);
    assert.equal(score.masterBars[0].timeSignatureNumerator, 4);
});
