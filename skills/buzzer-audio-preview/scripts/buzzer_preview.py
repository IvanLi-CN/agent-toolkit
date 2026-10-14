#!/usr/bin/env python3
"""
Generate a MIDI (.mid) + WAV (.wav) preview for passive/piezo buzzer melodies.

Input is a small JSON score (see assets/score.example.json).
Output WAV is a simple square/sine synth preview (not a physical buzzer model).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import struct
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal


NOTE_OFFSETS = {
    "C": 0,
    "D": 2,
    "E": 4,
    "F": 5,
    "G": 7,
    "A": 9,
    "B": 11,
}


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def note_to_midi(note: int | str) -> int:
    if isinstance(note, int):
        if 0 <= note <= 127:
            return note
        raise ValueError(f"midi note out of range: {note} (expected 0..127)")

    s = note.strip()
    m = re.fullmatch(r"([A-Ga-g])([#b]?)(-?\d+)", s)
    if not m:
        raise ValueError(f"invalid note name: {note!r} (expected like C4, D#5, Bb3)")

    letter = m.group(1).upper()
    accidental = m.group(2)
    octave = int(m.group(3))

    semitone = NOTE_OFFSETS[letter]
    if accidental == "#":
        semitone += 1
    elif accidental == "b":
        semitone -= 1

    # MIDI: C4 == 60 (middle C). This implies octave number where C-1 == 0.
    midi = (octave + 1) * 12 + semitone
    if not 0 <= midi <= 127:
        raise ValueError(f"note out of MIDI range: {note!r} -> {midi} (expected 0..127)")
    return midi


def midi_to_freq_hz(midi_note: int) -> float:
    return 440.0 * (2.0 ** ((midi_note - 69) / 12.0))


def freq_to_nearest_midi(freq_hz: float) -> int:
    if freq_hz <= 0:
        raise ValueError(f"freq_hz must be > 0, got {freq_hz}")
    midi = 69 + 12 * math.log2(freq_hz / 440.0)
    return int(round(midi))


def _varlen(value: int) -> bytes:
    if value < 0:
        raise ValueError("varlen cannot be negative")
    out = bytearray()
    out.append(value & 0x7F)
    value >>= 7
    while value:
        out.insert(0, 0x80 | (value & 0x7F))
        value >>= 7
    return bytes(out)


def _midi_event(delta_ticks: int, payload: bytes) -> bytes:
    return _varlen(delta_ticks) + payload


@dataclass(frozen=True)
class MidiConfig:
    channel: int = 0
    program: int = 80  # Lead 1 (square) in GM, but many players ignore it
    velocity: int = 96


@dataclass(frozen=True)
class AudioConfig:
    sample_rate_hz: int = 44_100
    waveform: Literal["square", "sine"] = "square"
    duty_cycle: float = 0.5
    volume: float = 0.7
    fade_ms: int = 2


@dataclass(frozen=True)
class ScoreConfig:
    tempo_bpm: float = 120.0
    ppqn: int = 480
    midi: MidiConfig = MidiConfig()
    audio: AudioConfig = AudioConfig()


@dataclass(frozen=True)
class Event:
    kind: Literal["note", "rest"]
    duration_s: float
    midi_note: int | None = None
    freq_hz: float | None = None
    velocity: int | None = None


def _duration_seconds(*, tempo_bpm: float, beats: float | None, ms: float | None) -> float:
    if beats is None and ms is None:
        raise ValueError("missing duration: provide 'beats' or 'ms'")
    if beats is not None and ms is not None:
        raise ValueError("ambiguous duration: provide only one of 'beats' or 'ms'")
    if beats is not None:
        if beats < 0:
            raise ValueError(f"beats must be >= 0, got {beats}")
        return (60.0 / tempo_bpm) * beats
    if ms is not None:
        if ms < 0:
            raise ValueError(f"ms must be >= 0, got {ms}")
        return ms / 1000.0
    raise AssertionError("unreachable")


def parse_score(path: Path) -> tuple[ScoreConfig, list[Event]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("score root must be a JSON object")

    tempo_bpm = float(raw.get("tempo_bpm", 120.0))
    if tempo_bpm <= 0:
        raise ValueError(f"tempo_bpm must be > 0, got {tempo_bpm}")

    ppqn = int(raw.get("ppqn", 480))
    if ppqn <= 0:
        raise ValueError(f"ppqn must be > 0, got {ppqn}")

    midi_raw = raw.get("midi", {}) or {}
    if not isinstance(midi_raw, dict):
        raise ValueError("midi must be an object")
    midi_cfg = MidiConfig(
        channel=int(midi_raw.get("channel", 0)),
        program=int(midi_raw.get("program", 80)),
        velocity=int(midi_raw.get("velocity", 96)),
    )
    if not 0 <= midi_cfg.channel <= 15:
        raise ValueError("midi.channel must be 0..15")
    if not 0 <= midi_cfg.program <= 127:
        raise ValueError("midi.program must be 0..127")
    if not 0 <= midi_cfg.velocity <= 127:
        raise ValueError("midi.velocity must be 0..127")

    audio_raw = raw.get("audio", {}) or {}
    if not isinstance(audio_raw, dict):
        raise ValueError("audio must be an object")
    waveform = str(audio_raw.get("waveform", raw.get("waveform", "square"))).lower()
    if waveform not in {"square", "sine"}:
        raise ValueError("audio.waveform must be 'square' or 'sine'")
    sample_rate_hz = int(audio_raw.get("sample_rate_hz", raw.get("sample_rate_hz", 44_100)))
    if sample_rate_hz <= 0:
        raise ValueError("sample_rate_hz must be > 0")
    volume = float(audio_raw.get("volume", raw.get("volume", 0.7)))
    fade_ms = int(audio_raw.get("fade_ms", raw.get("fade_ms", 2)))
    duty_cycle = float(audio_raw.get("duty_cycle", raw.get("duty_cycle", 0.5)))

    audio_cfg = AudioConfig(
        sample_rate_hz=sample_rate_hz,
        waveform=waveform,  # type: ignore[arg-type]
        duty_cycle=_clamp01(duty_cycle),
        volume=_clamp01(volume),
        fade_ms=max(0, fade_ms),
    )

    cfg = ScoreConfig(tempo_bpm=tempo_bpm, ppqn=ppqn, midi=midi_cfg, audio=audio_cfg)

    events_raw = raw.get("events")
    if not isinstance(events_raw, list) or not events_raw:
        raise ValueError("events must be a non-empty array")

    events: list[Event] = []
    for idx, e in enumerate(events_raw):
        if not isinstance(e, dict):
            raise ValueError(f"events[{idx}] must be an object")

        beats = e.get("beats")
        ms = e.get("ms")
        rest_beats = e.get("rest_beats")
        rest_ms = e.get("rest_ms")

        if ("note" in e) or ("freq_hz" in e):
            duration_s = _duration_seconds(tempo_bpm=tempo_bpm, beats=_as_optional_float(beats), ms=_as_optional_float(ms))

            midi_note: int | None = None
            freq_hz: float | None = None

            if "note" in e:
                midi_note = note_to_midi(e["note"])  # type: ignore[arg-type]
                freq_hz = midi_to_freq_hz(midi_note)
            elif "freq_hz" in e:
                freq_hz = float(e["freq_hz"])
                midi_note = freq_to_nearest_midi(freq_hz)

            velocity = int(e.get("velocity", midi_cfg.velocity))
            if not 0 <= velocity <= 127:
                raise ValueError(f"events[{idx}].velocity must be 0..127")

            events.append(
                Event(
                    kind="note",
                    duration_s=duration_s,
                    midi_note=midi_note,
                    freq_hz=freq_hz,
                    velocity=velocity,
                )
            )
            continue

        if ("rest_beats" in e) or ("rest_ms" in e):
            duration_s = _duration_seconds(
                tempo_bpm=tempo_bpm,
                beats=_as_optional_float(rest_beats),
                ms=_as_optional_float(rest_ms),
            )
            events.append(Event(kind="rest", duration_s=duration_s))
            continue

        raise ValueError(
            f"events[{idx}] must be a note/tone event (note/freq_hz + beats/ms) or a rest event (rest_beats/rest_ms)"
        )

    return cfg, events


def _as_optional_float(value: Any) -> float | None:
    if value is None:
        return None
    return float(value)


def write_midi(path: Path, cfg: ScoreConfig, events: list[Event]) -> None:
    tempo_us_per_quarter = int(round(60_000_000 / cfg.tempo_bpm))

    track = bytearray()
    track.extend(_midi_event(0, b"\xFF\x51\x03" + tempo_us_per_quarter.to_bytes(3, "big")))
    track.extend(_midi_event(0, bytes([0xC0 | cfg.midi.channel, cfg.midi.program])))

    pending_delta = 0
    for e in events:
        ticks = int(round(e.duration_s * cfg.tempo_bpm * cfg.ppqn / 60.0))
        ticks = max(0, ticks)

        if e.kind == "rest":
            pending_delta += ticks
            continue

        if e.midi_note is None:
            raise ValueError("note event missing midi_note")

        velocity = cfg.midi.velocity if e.velocity is None else int(e.velocity)
        track.extend(_midi_event(pending_delta, bytes([0x90 | cfg.midi.channel, e.midi_note, velocity])))
        track.extend(_midi_event(ticks, bytes([0x80 | cfg.midi.channel, e.midi_note, 0])))
        pending_delta = 0

    track.extend(_midi_event(pending_delta, b"\xFF\x2F\x00"))

    header = b"MThd" + (6).to_bytes(4, "big") + (0).to_bytes(2, "big") + (1).to_bytes(2, "big") + cfg.ppqn.to_bytes(2, "big")
    track_chunk = b"MTrk" + len(track).to_bytes(4, "big") + bytes(track)

    path.write_bytes(header + track_chunk)


def write_wav(path: Path, cfg: ScoreConfig, events: list[Event]) -> None:
    sr = cfg.audio.sample_rate_hz
    fade_samples = int(round(sr * cfg.audio.fade_ms / 1000.0))
    fade_samples = max(0, fade_samples)
    volume = _clamp01(cfg.audio.volume) * 0.9

    frames = bytearray()
    two_pi = 2.0 * math.pi
    phase = 0.0

    for e in events:
        count = int(round(e.duration_s * sr))
        if count <= 0:
            continue

        if e.kind == "rest":
            frames.extend(b"\x00\x00" * count)
            continue

        freq = float(e.freq_hz if e.freq_hz is not None else midi_to_freq_hz(int(e.midi_note)))
        if freq <= 0:
            frames.extend(b"\x00\x00" * count)
            continue

        if cfg.audio.waveform == "sine":
            inc = two_pi * freq / sr
            for i in range(count):
                amp = _envelope(i, count, fade_samples) * volume
                sample = math.sin(phase) * amp
                frames.extend(struct.pack("<h", int(max(-1.0, min(1.0, sample)) * 32767)))
                phase += inc
                if phase > two_pi:
                    phase -= two_pi
        else:  # square
            inc = freq / sr
            duty = _clamp01(cfg.audio.duty_cycle)
            for i in range(count):
                amp = _envelope(i, count, fade_samples) * volume
                sample = (1.0 if phase < duty else -1.0) * amp
                frames.extend(struct.pack("<h", int(sample * 32767)))
                phase += inc
                if phase >= 1.0:
                    phase -= 1.0

    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(frames)


def _envelope(i: int, total: int, fade: int) -> float:
    if fade <= 0 or total <= 1:
        return 1.0
    start = i / fade if i < fade else 1.0
    end = (total - 1 - i) / fade if i >= total - fade else 1.0
    return max(0.0, min(1.0, start, end))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Generate MIDI + WAV previews for passive/piezo buzzer scores.")
    ap.add_argument("--in", dest="in_path", required=True, help="Input JSON score path (e.g. score.json)")
    ap.add_argument("--out-dir", default=".", help="Output directory (default: current dir)")
    ap.add_argument("--stem", default=None, help="Output filename stem (default: input file stem)")
    args = ap.parse_args(argv)

    in_path = Path(args.in_path).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.stem or in_path.stem

    cfg, events = parse_score(in_path)

    midi_path = out_dir / f"{stem}.mid"
    wav_path = out_dir / f"{stem}.wav"
    write_midi(midi_path, cfg, events)
    write_wav(wav_path, cfg, events)

    total_s = sum(e.duration_s for e in events)
    print(f"[OK] Wrote: {midi_path}")
    print(f"[OK] Wrote: {wav_path}")
    print(f"[INFO] Duration: {total_s:.2f}s, tempo={cfg.tempo_bpm:g} bpm, waveform={cfg.audio.waveform}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
