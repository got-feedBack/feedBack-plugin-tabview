"""Pure/deterministic helpers in rs2gp.py: measure parsing, event merging,
sixteenth-note quantization and duration decomposition. guitarpro's Duration
objects are used directly (real dependency, pip-installable) but nothing
here touches the GP5 binary writer or the host `song` module beyond the
stub in conftest.py."""

from types import SimpleNamespace

import guitarpro
import rs2gp


def beat(time, measure=-1):
    return SimpleNamespace(time=time, measure=measure)


# ── _parse_measures ───────────────────────────────────────────────────────────

def test_parse_measures_empty_input():
    assert rs2gp._parse_measures([]) == []
    assert rs2gp._parse_measures(None) == []


def test_parse_measures_groups_by_measure_marker():
    beats = [
        beat(0.0, measure=0), beat(0.5), beat(1.0), beat(1.5),
        beat(2.0, measure=1), beat(2.5), beat(3.0), beat(3.5),
    ]
    measures = rs2gp._parse_measures(beats)
    assert len(measures) == 2
    assert measures[0]["num_beats"] == 4
    assert measures[0]["start_time"] == 0.0
    assert measures[0]["end_time"] == 2.0
    assert measures[1]["start_time"] == 2.0


def test_parse_measures_estimates_bpm_from_beat_interval():
    # 0.5s between beats -> 120 BPM.
    beats = [beat(0.0, measure=0), beat(0.5), beat(1.0), beat(1.5)]
    measures = rs2gp._parse_measures(beats)
    assert abs(measures[0]["bpm"] - 120.0) < 0.01


def test_parse_measures_last_measure_extrapolates_end_time():
    beats = [beat(0.0, measure=0), beat(0.5), beat(1.0), beat(1.5)]
    measures = rs2gp._parse_measures(beats)
    # avg beat interval 0.5 -> end_time = last beat + 0.5
    assert measures[-1]["end_time"] == 2.0


def test_parse_measures_single_beat_final_measure_reuses_prior_interval():
    beats = [
        beat(0.0, measure=0), beat(0.5), beat(1.0), beat(1.5),
        beat(2.0, measure=1),  # lone trailing beat, no follow-up
    ]
    measures = rs2gp._parse_measures(beats)
    assert measures[1]["num_beats"] == 1
    # reuses measure 0's duration (2.0s) since there's no next group or 2nd beat
    assert measures[1]["end_time"] == 2.0 + (measures[0]["end_time"] - measures[0]["start_time"])
    assert measures[1]["bpm"] == measures[0]["bpm"]


def test_fallback_measure_defaults_and_custom_length():
    m = rs2gp._fallback_measure(None)
    assert m["end_time"] == 60.0
    assert m["num_beats"] == 4
    assert m["bpm"] == 120.0

    m2 = rs2gp._fallback_measure(30.0)
    assert m2["end_time"] == 30.0


# ── _note_dict / _merge_events / _used_string_indices ──────────────────────────

def make_note(string=0, fret=3, sustain=0.0, time=0.0, **extra):
    defaults = dict(slide_to=None, bend=None, hammer_on=False, pull_off=False,
                     harmonic=False, harmonic_pinch=False, palm_mute=False,
                     mute=False, tremolo=False, accent=False, tap=False)
    defaults.update(extra)
    return SimpleNamespace(string=string, fret=fret, sustain=sustain, time=time, **defaults)


def test_note_dict_carries_declared_fields_and_defaults_missing_to_false():
    n = SimpleNamespace(string=1, fret=5, sustain=0.2)  # no effect flags set
    d = rs2gp._note_dict(n)
    assert d["string"] == 1
    assert d["fret"] == 5
    assert d["hammer_on"] is False
    assert d["accent"] is False


def test_merge_events_sorts_notes_and_chords_by_time():
    arr = SimpleNamespace(
        notes=[make_note(time=1.0), make_note(time=0.0)],
        chords=[SimpleNamespace(time=0.5, high_density=False,
                                 notes=[make_note(time=0.5, string=2)])],
    )
    events = rs2gp._merge_events(arr)
    assert [e["time"] for e in events] == [0.0, 0.5, 1.0]
    assert events[1]["type"] == "chord"
    assert events[0]["type"] == "note"


def test_merge_events_skips_high_density_chords():
    arr = SimpleNamespace(
        notes=[],
        chords=[SimpleNamespace(time=0.0, high_density=True, notes=[])],
    )
    assert rs2gp._merge_events(arr) == []


def test_used_string_indices_covers_notes_and_chord_members():
    events = [
        {"type": "note", "string": 0},
        {"type": "chord", "chord_notes": [{"string": 2}, {"string": 3}]},
    ]
    assert rs2gp._used_string_indices(events) == {0, 2, 3}


# ── _quantize_sixteenth ────────────────────────────────────────────────────────

def test_quantize_sixteenth_snaps_to_the_nearest_subdivision():
    beat_times = [0.0, 1.0, 2.0, 3.0]
    # SUBDIV=8 32nd-note slots per beat, so beat 0 spans indices 0..7.
    idx = rs2gp._quantize_sixteenth(0.0, beat_times, measure_end=4.0)
    assert idx == 0
    idx_mid = rs2gp._quantize_sixteenth(1.0, beat_times, measure_end=4.0)
    assert idx_mid == rs2gp.SUBDIV  # exactly on beat 2 -> index SUBDIV*1


# ── _decompose_sixteenths / _dur_sixteenths round-trip ──────────────────────────

def test_decompose_sixteenths_zero_or_negative_yields_a_whole_rest():
    durs = rs2gp._decompose_sixteenths(0)
    assert len(durs) == 1
    assert durs[0].value == 4


def test_decompose_and_dur_sixteenths_round_trip_common_counts():
    for count in [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 17, 33]:
        durs = rs2gp._decompose_sixteenths(count)
        total = sum(rs2gp._dur_sixteenths(d) for d in durs)
        assert total == count, f"count={count} -> durs summed to {total}"


def test_dur_sixteenths_applies_dotted_multiplier():
    d = guitarpro.Duration(value=4)
    d.isDotted = True
    assert rs2gp._dur_sixteenths(d) == 12  # base 8 * 1.5
