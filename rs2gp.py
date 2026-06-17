"""Convert arrangement data to Guitar Pro 5 format."""

import io
import guitarpro
from song import arrangement_string_count

TICKS_PER_BEAT = 960
SUBDIV = 8  # 32nd notes per beat

# Standard open-string MIDI values: GP string 1 (highest) to N (lowest).
#
# Guitar: extended to cover 6/7/8-string instruments. Each extra lower string
# is a perfect fourth (5 semitones) below the previous one in standard tuning.
#   6-string standard: E4 B3 G3 D3 A2 E2
#   7-string adds:     B1  (standard low-B 7-string)
#   8-string adds:     F#1 (standard low-F# 8-string)
GUITAR_STANDARD = [64, 59, 55, 50, 45, 40, 35, 30]  # E4 B3 G3 D3 A2 E2 B1 F#1

# Bass: keyed by string count because a 6-string bass gains a *high* string
# (C3) relative to 4/5-string, shifting the whole table upward — not just
# appending a new low string. 4-string and 5-string share the same high
# string (G2=43), so they can share a contiguous prefix.
#   4-string standard: G2 D2 A1 E1
#   5-string adds low: B0
#   6-string adds low B0 AND high C3
BASS_STANDARD = {
    4: [43, 38, 33, 28],
    5: [43, 38, 33, 28, 23],
    6: [48, 43, 38, 33, 28, 23],
}


def arrangement_to_gp5(song, arrangement_index=0):
    """Convert a Song arrangement to GP5 bytes."""
    arr = song.arrangements[arrangement_index]

    # path_bass is populated from existing arrangement data and is more reliable than
    # name-matching alone for official DLC (which can have localised or
    # abbreviated arrangement names). Name-match is the fallback for CDLC and
    # sloppaks that don't carry path flags.
    is_bass = bool(arr.path_bass) or "bass" in arr.name.lower()

    # arrangement_string_count() (song.py) handles the RS XML quirk where
    # arr.tuning is always length 6 regardless of instrument: it combines the
    # highest string index seen in notes/chords, a name-based fallback (4 for
    # bass, 6 for guitar), and len(arr.tuning) when it isn't the RS-XML
    # padded value of 6 (trustworthy for sloppak/GP-imported sources).
    num_strings = arrangement_string_count(arr)

    measures_info = _parse_measures(song.beats)
    if not measures_info:
        measures_info = [_fallback_measure(song.song_length)]

    events = _merge_events(arr)

    # --- GP3/4/5 hard limit: writeTrack only writes 7 tuning slots, and
    # writeNotes packs note strings into an 8-bit stringFlags byte via
    # `1 << (7 - note.string)`, so note.string must be in 1..7. There is no
    # way to represent an 8-string instrument in this format — pyguitarpro
    # has no GP6+/.gpx writer that would lift this cap.
    #
    # Workaround for 8-string guitar: in practice most 8-string CDLC only
    # plays 7 distinct strings (the 8th exists in the tuning/instrument
    # definition but is never actually notated). If that's true for this
    # arrangement, drop the one *unused* string and shift the remaining 7
    # into GP strings 1-7 — this preserves every note. If all 8 strings are
    # genuinely used, fall back to dropping the lowest string (gp_str > 7),
    # which is the only option GP5 leaves us.
    #
    # TODO: the real fix is to stop going through pyguitarpro/GP5 for this
    # path and feed alphaTab (already used by screen.js for rendering) its
    # own score format directly, which has no string-count ceiling.
    remap = None
    if num_strings == 8:
        used = _used_string_indices(events)
        if len(used) <= 7:
            remaining = sorted(used)
            remap = {rs: len(remaining) - rank for rank, rs in enumerate(remaining)}
            num_strings = len(remaining)

    gp = guitarpro.Song()
    gp.title = song.title or "Untitled"
    gp.artist = song.artist or ""
    gp.album = song.album or ""
    gp.measureHeaders = []
    gp.tracks = []

    # Set initial tempo from first measure
    gp.tempo = max(30, min(300, round(measures_info[0]["bpm"])))

    track = guitarpro.Track(gp, number=1)
    track.name = arr.name or ("Bass" if is_bass else "Guitar")
    track.channel = guitarpro.MidiChannel(
        channel=1 if is_bass else 0,
        effectChannel=3 if is_bass else 2,
        instrument=33 if is_bass else 30,
    )
    track.strings = _make_strings(arr.tuning, is_bass, num_strings, remap)
    track.indicateTuning = True
    track.measures = []

    tick = TICKS_PER_BEAT
    prev_bpm = gp.tempo

    for i, m_info in enumerate(measures_info):
        header = guitarpro.MeasureHeader(number=i + 1, start=tick)
        header.timeSignature = guitarpro.TimeSignature()
        header.timeSignature.numerator = m_info["num_beats"]
        header.timeSignature.denominator = guitarpro.Duration(value=4)
        gp.measureHeaders.append(header)

        m_events = [
            e
            for e in events
            if m_info["start_time"] <= e["time"] < m_info["end_time"]
        ]

        measure = guitarpro.Measure(track, header)
        voice = measure.voices[0]
        voice.beats = _create_beats(m_events, m_info, voice, num_strings, remap)

        # Tempo change via MixTableChange on the first beat
        cur_bpm = max(30, min(300, round(m_info["bpm"])))
        if i > 0 and cur_bpm != prev_bpm and voice.beats:
            first_beat = voice.beats[0]
            first_beat.effect.mixTableChange = guitarpro.MixTableChange(
                tempo=guitarpro.MixTableItem(value=cur_bpm, duration=1, allTracks=True),
            )
        prev_bpm = cur_bpm

        track.measures.append(measure)
        tick += m_info["num_beats"] * TICKS_PER_BEAT

    gp.tracks = [track]

    buf = io.BytesIO()
    guitarpro.write(gp, buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Measure parsing
# ---------------------------------------------------------------------------

def _parse_measures(beats):
    """Parse arrangement beats into measure info dicts."""
    if not beats:
        return []

    groups = []
    cur = []
    for b in beats:
        if b.measure >= 0 and cur:
            groups.append(cur)
            cur = []
        cur.append(b)
    if cur:
        groups.append(cur)

    result = []
    for i, grp in enumerate(groups):
        start = grp[0].time
        if i + 1 < len(groups):
            end = groups[i + 1][0].time
        else:
            if len(grp) > 1:
                avg = (grp[-1].time - grp[0].time) / (len(grp) - 1)
                end = grp[-1].time + avg
            elif result:
                end = start + (result[-1]["end_time"] - result[-1]["start_time"])
            else:
                end = start + 2.0

        n = len(grp)
        if n > 1:
            interval = (grp[-1].time - grp[0].time) / (n - 1)
            bpm = 60.0 / interval if interval > 0 else 120.0
        elif result:
            bpm = result[-1]["bpm"]
        else:
            bpm = 120.0

        result.append(
            {
                "start_time": start,
                "end_time": end,
                "num_beats": n,
                "beat_times": [b.time for b in grp],
                "bpm": bpm,
            }
        )
    return result


def _fallback_measure(length):
    length = length or 60.0
    return {
        "start_time": 0.0,
        "end_time": length,
        "num_beats": 4,
        "beat_times": [i * 0.5 for i in range(8)],
        "bpm": 120.0,
    }


# ---------------------------------------------------------------------------
# Event merging
# ---------------------------------------------------------------------------

_NOTE_FIELDS = [
    "slide_to",
    "bend",
    "hammer_on",
    "pull_off",
    "harmonic",
    "harmonic_pinch",
    "palm_mute",
    "mute",
    "tremolo",
    "accent",
    "tap",
]


def _note_dict(n):
    d = {"string": n.string, "fret": n.fret, "sustain": n.sustain}
    for f in _NOTE_FIELDS:
        d[f] = getattr(n, f, False)
    return d


def _merge_events(arr):
    events = []
    for n in arr.notes:
        ev = _note_dict(n)
        ev["time"] = n.time
        ev["type"] = "note"
        events.append(ev)

    for ch in arr.chords:
        if ch.high_density:
            continue
        events.append(
            {
                "time": ch.time,
                "type": "chord",
                "chord_notes": [_note_dict(cn) for cn in ch.notes],
            }
        )

    events.sort(key=lambda e: e["time"])
    return events


def _used_string_indices(events):
    """Set of RS string indices (0-based) actually played in this arrangement."""
    used = set()
    for ev in events:
        if ev["type"] == "chord":
            for nd in ev["chord_notes"]:
                used.add(nd["string"])
        else:
            used.add(ev["string"])
    return used


# ---------------------------------------------------------------------------
# String tuning helpers
# ---------------------------------------------------------------------------

def _make_strings(tuning, is_bass, num_strings, remap=None):
    """Build the GP GuitarString list for a track.

    For guitar, GUITAR_STANDARD covers 6–8 strings directly. For bass,
    BASS_STANDARD is keyed by count because 6-string bass adds a high C
    string (shifting the whole table up) rather than just appending a low
    string. Both tables are extended by perfect-fourth extrapolation for
    any count beyond the defined range, which should only occur for
    genuinely exotic instruments not currently in Rocksmith's CDLC corpus.

    `remap` (8-string guitar only): dict of {rs_string_index: gp_string_number}
    covering 7 of the 8 RS strings (one unused string dropped). When present,
    builds a 7-string GP track using the correct GUITAR_STANDARD entry and
    tuning offset for each remaining RS string, in its proper gp_str slot.
    """
    if is_bass:
        standard = BASS_STANDARD.get(num_strings)
        if standard is None:
            # Nearest defined key, then extend downward by perfect fourths.
            nearest_key = min(BASS_STANDARD.keys(), key=lambda k: abs(k - num_strings))
            base = list(BASS_STANDARD[nearest_key])
            while len(base) < num_strings:
                base.append(base[-1] - 5)
            standard = base[:num_strings]
    else:
        standard = GUITAR_STANDARD

    if remap is not None:
        strings = [None] * 7
        for rs_idx, gp_str in remap.items():
            gp_idx_8 = 7 - rs_idx  # this RS string's position in the original 8-string table
            if gp_idx_8 < len(standard):
                base_midi = standard[gp_idx_8]
            else:
                base_midi = standard[-1] - 5 * (gp_idx_8 - len(standard) + 1)
            midi_val = base_midi + (tuning[rs_idx] if rs_idx < len(tuning) else 0)
            strings[gp_str - 1] = guitarpro.GuitarString(number=gp_str, value=midi_val)
        return strings

    # GP3/4/5 can only represent 7 strings; for num_strings==8 without a
    # remap (all 8 strings genuinely used), gp_str > 7 notes are dropped in
    # _create_beats, so only build the 7 strings that can be represented.
    n = min(num_strings, 7)
    strings = []
    for gp_idx in range(n):
        rs_idx = num_strings - 1 - gp_idx
        if gp_idx < len(standard):
            base_midi = standard[gp_idx]
        else:
            # Extrapolate downward by perfect fourths beyond the table.
            base_midi = standard[-1] - 5 * (gp_idx - len(standard) + 1)
        midi_val = base_midi + (tuning[rs_idx] if rs_idx < len(tuning) else 0)
        strings.append(guitarpro.GuitarString(number=gp_idx + 1, value=midi_val))
    return strings


# ---------------------------------------------------------------------------
# Beat creation
# ---------------------------------------------------------------------------

def _quantize_sixteenth(event_time, beat_times, measure_end):
    """Return the nearest 32nd-note position index within a measure."""
    best, best_d = 0, float("inf")
    for i, bt in enumerate(beat_times):
        nxt = beat_times[i + 1] if i + 1 < len(beat_times) else measure_end
        dur = nxt - bt
        for sub in range(SUBDIV):
            t = bt + dur * sub / SUBDIV
            d = abs(event_time - t)
            if d < best_d:
                best_d = d
                best = i * SUBDIV + sub
    return best


def _decompose_sixteenths(count):
    """Break a 32nd-note count into a list of guitarpro.Duration objects."""
    if count <= 0:
        return [guitarpro.Duration(value=4)]
    durs = []
    rem = count
    while rem > 0:
        d = guitarpro.Duration()
        if rem >= 32:
            d.value = 1
            rem -= 32
        elif rem >= 24:
            d.value = 2
            d.isDotted = True
            rem -= 24
        elif rem >= 16:
            d.value = 2
            rem -= 16
        elif rem >= 12:
            d.value = 4
            d.isDotted = True
            rem -= 12
        elif rem >= 8:
            d.value = 4
            rem -= 8
        elif rem >= 6:
            d.value = 8
            d.isDotted = True
            rem -= 6
        elif rem >= 4:
            d.value = 8
            rem -= 4
        elif rem >= 3:
            d.value = 16
            d.isDotted = True
            rem -= 3
        elif rem >= 2:
            d.value = 16
            rem -= 2
        else:
            d.value = 32
            rem -= 1
        durs.append(d)
    return durs


def _dur_sixteenths(d):
    """Number of 32nd notes a Duration occupies."""
    base = {1: 32, 2: 16, 4: 8, 8: 4, 16: 2, 32: 1}
    v = base.get(d.value, 8)
    if d.isDotted:
        v = int(v * 1.5)
    return max(v, 1)


def _create_beats(events, m_info, voice, num_strings, remap=None):
    """Build GP Beat list for one measure."""
    total = m_info["num_beats"] * SUBDIV

    if not events:
        return _rest_beats(total, voice)

    slots = {}
    for ev in events:
        pos = _quantize_sixteenth(ev["time"], m_info["beat_times"], m_info["end_time"])
        pos = max(0, min(pos, total - 1))
        slots.setdefault(pos, []).append(ev)

    positions = sorted(slots.keys())
    beats = []
    cursor = 0

    for i, pos in enumerate(positions):
        if pos > cursor:
            beats.extend(_rest_beats(pos - cursor, voice))
            cursor = pos

        nxt = positions[i + 1] if i + 1 < len(positions) else total
        gap = max(1, nxt - pos)
        durations = _decompose_sixteenths(gap)

        beat = guitarpro.Beat(voice, status=guitarpro.BeatStatus.normal)
        beat.duration = durations[0]

        seen = set()
        for ev in slots[pos]:
            note_dicts = (
                ev.get("chord_notes", []) if ev["type"] == "chord" else [ev]
            )
            for nd in note_dicts:
                if remap is not None:
                    gp_str = remap.get(nd["string"])
                    if gp_str is None:
                        # this is the one unused 8th string — nothing to drop here
                        continue
                else:
                    gp_str = num_strings - nd["string"]
                    if gp_str < 1 or gp_str > 7:
                        continue

                if gp_str in seen:
                    continue
                seen.add(gp_str)
                note = guitarpro.Note(
                    beat, value=nd["fret"], string=gp_str,
                    velocity=guitarpro.Velocities.forte,
                    type=guitarpro.NoteType.normal,
                )
                if nd.get("mute"):
                    note.type = guitarpro.NoteType.dead
                _apply_effects(note, nd)
                beat.notes.append(note)

        beats.append(beat)
        cursor += _dur_sixteenths(durations[0])

        for rd in durations[1:]:
            beats.extend(_rest_beats(_dur_sixteenths(rd), voice))
            cursor += _dur_sixteenths(rd)

    if cursor < total:
        beats.extend(_rest_beats(total - cursor, voice))

    return beats


def _rest_beats(sixteenths, voice):
    beats = []
    for d in _decompose_sixteenths(sixteenths):
        b = guitarpro.Beat(voice, status=guitarpro.BeatStatus.rest)
        b.duration = d
        beats.append(b)
    return beats


# ---------------------------------------------------------------------------
# Technique mapping
# ---------------------------------------------------------------------------

def _apply_effects(gp_note, nd):
    eff = gp_note.effect

    if nd.get("hammer_on") or nd.get("pull_off"):
        eff.hammer = True

    slide = nd.get("slide_to", -1)
    if isinstance(slide, int) and slide >= 0:
        eff.slides = [guitarpro.SlideType.shiftSlideTo]

    bend_val = nd.get("bend", 0)
    if bend_val and bend_val > 0:
        gp_val = int(bend_val * 2)  # RS semitones -> GP quarter-tones
        eff.bend = guitarpro.BendEffect(
            type=guitarpro.BendType.bend,
            value=gp_val,
            points=[
                guitarpro.BendPoint(position=0, value=0),
                guitarpro.BendPoint(position=6, value=gp_val),
                guitarpro.BendPoint(position=12, value=gp_val),
            ],
        )

    if nd.get("harmonic"):
        eff.harmonic = guitarpro.NaturalHarmonic()
    elif nd.get("harmonic_pinch"):
        try:
            eff.harmonic = guitarpro.PinchHarmonic()
        except Exception:
            eff.harmonic = guitarpro.NaturalHarmonic()

    if nd.get("palm_mute"):
        eff.palmMute = True

    if nd.get("tremolo"):
        eff.tremoloPicking = guitarpro.TremoloPickingEffect(
            duration=guitarpro.Duration(value=8),
        )

    if nd.get("accent"):
        eff.accentuatedNote = True

    if nd.get("tap"):
        eff.hammer = True