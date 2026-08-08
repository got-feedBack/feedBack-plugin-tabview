// src/chart-quantize.js: measure/tempo parsing, event merging, 32nd-note
// quantization, duration decomposition, tuning tables. No alphaTab
// dependency — see score-builder.test.mjs for the parts that need
// real alphaTab model classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseMeasures, fallbackMeasure, mergeEvents,
    quantizeThirtySecond, decomposeThirtySeconds, thirtySecondsForDuration,
    buildTuning,
} from '../src/chart-quantize.js';

test('parseMeasures: empty input', () => {
    assert.deepEqual(parseMeasures([]), []);
    assert.deepEqual(parseMeasures(null), []);
});

test('parseMeasures: groups by measure marker', () => {
    const beats = [
        { time: 0.0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 },
        { time: 2.0, measure: 1 }, { time: 2.5 }, { time: 3.0 }, { time: 3.5 },
    ];
    const measures = parseMeasures(beats);
    assert.equal(measures.length, 2);
    assert.equal(measures[0].numBeats, 4);
    assert.equal(measures[0].startTime, 0.0);
    assert.equal(measures[0].endTime, 2.0);
    assert.equal(measures[1].startTime, 2.0);
});

test('parseMeasures: a null measure field does not start a new group', () => {
    // null >= 0 is true in JS, so an unguarded check would wrongly treat a
    // beat with measure:null as a measure boundary.
    const beats = [
        { time: 0.0, measure: 0 }, { time: 0.5, measure: null }, { time: 1.0 }, { time: 1.5 },
    ];
    const measures = parseMeasures(beats);
    assert.equal(measures.length, 1);
    assert.equal(measures[0].numBeats, 4);
});

test('parseMeasures: estimates bpm from beat interval', () => {
    const beats = [{ time: 0.0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }];
    const measures = parseMeasures(beats);
    assert.ok(Math.abs(measures[0].bpm - 120.0) < 0.01);
});

test('parseMeasures: last measure extrapolates end time', () => {
    const beats = [{ time: 0.0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 }];
    const measures = parseMeasures(beats);
    assert.equal(measures[measures.length - 1].endTime, 2.0);
});

test('parseMeasures: single-beat final measure reuses prior interval', () => {
    const beats = [
        { time: 0.0, measure: 0 }, { time: 0.5 }, { time: 1.0 }, { time: 1.5 },
        { time: 2.0, measure: 1 },
    ];
    const measures = parseMeasures(beats);
    assert.equal(measures[1].numBeats, 1);
    assert.equal(measures[1].endTime, 2.0 + (measures[0].endTime - measures[0].startTime));
    assert.equal(measures[1].bpm, measures[0].bpm);
});

test('fallbackMeasure: defaults and custom length', () => {
    const m = fallbackMeasure(null);
    assert.equal(m.endTime, 60.0);
    assert.equal(m.numBeats, 4);
    assert.equal(m.bpm, 120.0);
    assert.equal(fallbackMeasure(30.0).endTime, 30.0);
});

test('fallbackMeasure: beatTimes has exactly numBeats entries spanning the full length', () => {
    const m = fallbackMeasure(40.0);
    assert.equal(m.beatTimes.length, m.numBeats);
    assert.deepEqual(m.beatTimes, [0, 10, 20, 30]);
});

test('fallbackMeasure: non-positive/invalid length falls back to the default span', () => {
    assert.equal(fallbackMeasure(0).endTime, 60.0);
    assert.equal(fallbackMeasure(-5).endTime, 60.0);
    assert.equal(fallbackMeasure(NaN).endTime, 60.0);
    assert.equal(fallbackMeasure(undefined).endTime, 60.0);
});

test('mergeEvents: sorts notes and chords by time', () => {
    const events = mergeEvents(
        [{ t: 1.0, s: 0, f: 0 }, { t: 0.0, s: 1, f: 2 }],
        [{ t: 0.5, hd: false, notes: [{ s: 2, f: 1 }] }],
    );
    assert.deepEqual(events.map(e => e.time), [0.0, 0.5, 1.0]);
    assert.equal(events[0].type, 'note');
    assert.equal(events[1].type, 'chord');
});

test('mergeEvents: skips high-density chords', () => {
    assert.deepEqual(mergeEvents([], [{ t: 0.0, hd: true, notes: [] }]), []);
});

test('quantizeThirtySecond: snaps to nearest subdivision', () => {
    const beatTimes = [0.0, 1.0, 2.0, 3.0];
    assert.equal(quantizeThirtySecond(0.0, beatTimes, 4.0), 0);
    assert.equal(quantizeThirtySecond(1.0, beatTimes, 4.0), 8); // SUBDIV=8 -> exactly beat 2
});

test('decomposeThirtySeconds: non-positive yields a quarter-note filler', () => {
    assert.deepEqual(decomposeThirtySeconds(0), [{ duration: 4, dots: 0 }]);
});

test('decomposeThirtySeconds/thirtySecondsForDuration: round-trip common counts', () => {
    for (const count of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 17, 33]) {
        const total = decomposeThirtySeconds(count).reduce((sum, d) => sum + thirtySecondsForDuration(d), 0);
        assert.equal(total, count, `count=${count} -> summed to ${total}`);
    }
});

test('thirtySecondsForDuration: dotted multiplier', () => {
    assert.equal(thirtySecondsForDuration({ duration: 4, dots: 1 }), 12); // base 8 * 1.5
});

test('buildTuning: standard 6-string guitar, no offsets', () => {
    const tunings = buildTuning([0, 0, 0, 0, 0, 0], false, 6);
    assert.deepEqual(tunings, [64, 59, 55, 50, 45, 40]);
});

test('buildTuning: offset shifts the right RS string', () => {
    // RS string 0 (lowest) raised 2 semitones -> lands on the LAST (lowest-pitch) tuning slot.
    const tunings = buildTuning([2, 0, 0, 0, 0, 0], false, 6);
    assert.equal(tunings[5], 42);
});

test('buildTuning: 4-string bass uses the bass table', () => {
    assert.deepEqual(buildTuning([0, 0, 0, 0], true, 4), [43, 38, 33, 28]);
});

test('buildTuning: 8-string guitar (no GP5-style string cap)', () => {
    const tunings = buildTuning(new Array(8).fill(0), false, 8);
    assert.deepEqual(tunings, [64, 59, 55, 50, 45, 40, 35, 30]);
});

test('buildTuning: 9-string guitar extrapolates beyond the known table', () => {
    const tunings = buildTuning(new Array(9).fill(0), false, 9);
    assert.equal(tunings.length, 9);
    assert.equal(tunings[8], 25); // one more perfect fourth (5 semitones) below 30
});

test('buildTuning: bass beyond the known table (4/5/6) extends and nearest-matches', () => {
    const tunings = buildTuning(new Array(7).fill(0), true, 7);
    assert.equal(tunings.length, 7);
    // nearest known key is 6 ([48,43,38,33,28,23]), extended one more fourth down.
    assert.deepEqual(tunings, [48, 43, 38, 33, 28, 23, 18]);
});

test('buildTuning: RS-XML pads tuning to length 6 even for a 4-string instrument', () => {
    // Known real-world shape: only the first 4 offsets (indices 0-3,
    // lowest-string-first) are meaningful; indices 4-5 are padding that
    // must be ignored, not read as extra strings.
    const tunings = buildTuning([1, 2, 0, 0, 0, 0], true, 4);
    // rsIdx 0 (offset 1) lands on the lowest-pitch (last) slot, rsIdx 1
    // (offset 2) on the next one up — buildTuning's index0=highest-pitch
    // convention, opposite of the RS-string-index (lowest-first) input.
    assert.deepEqual(tunings, [43, 38, 33 + 2, 28 + 1]);
});

test('buildTuning: tuning array shorter than stringCount defaults missing offsets to 0', () => {
    const tunings = buildTuning([3], false, 6);
    assert.deepEqual(tunings, [64, 59, 55, 50, 45, 40 + 3]);
});

test('buildTuning: non-finite offsets (untrusted chart-transform output) fall back to 0', () => {
    // Indexed by rsIdx (lowest string first): only tuningOffsets[5], the
    // highest string, is a finite value — everything else must default to 0
    // instead of propagating NaN/Infinity into the tunings array.
    const tunings = buildTuning([NaN, Infinity, -Infinity, undefined, 'x', 2], false, 6);
    assert.deepEqual(tunings, [64 + 2, 59, 55, 50, 45, 40]);
});
