#!/usr/bin/env bun

import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";

const NOTE_OFFSETS: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export type Waveform = "square" | "sine";

export interface MidiConfig {
  channel: number;
  program: number;
  velocity: number;
}

export interface AudioConfig {
  sampleRateHz: number;
  waveform: Waveform;
  dutyCycle: number;
  volume: number;
  fadeMs: number;
}

export interface ScoreConfig {
  tempoBpm: number;
  ppqn: number;
  midi: MidiConfig;
  audio: AudioConfig;
}

export interface NoteEvent {
  kind: "note";
  durationS: number;
  midiNote: number;
  freqHz: number;
  velocity: number;
}

export interface RestEvent {
  kind: "rest";
  durationS: number;
}

export type ScoreEvent = NoteEvent | RestEvent;

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new Error(`${label} must be a number`);
}

function integerValue(value: unknown, label: string): number {
  const number = Math.trunc(numberValue(value, label));
  if (!Number.isSafeInteger(number)) throw new Error(`${label} must be a safe integer`);
  return number;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  return value === undefined || value === null ? undefined : numberValue(value, label);
}

function roundTiesToEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

export function noteToMidi(note: number | string): number {
  if (typeof note === "number") {
    if (Number.isInteger(note) && note >= 0 && note <= 127) return note;
    throw new Error(`midi note out of range: ${note} (expected 0..127)`);
  }

  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(note.trim());
  if (match === null) {
    throw new Error(`invalid note name: ${JSON.stringify(note)} (expected like C4, D#5, Bb3)`);
  }
  const [, rawLetter, accidental, rawOctave] = match;
  const letter = rawLetter!.toUpperCase();
  let semitone = NOTE_OFFSETS[letter]!;
  if (accidental === "#") semitone += 1;
  if (accidental === "b") semitone -= 1;

  const midi = (Number.parseInt(rawOctave!, 10) + 1) * 12 + semitone;
  if (midi < 0 || midi > 127) {
    throw new Error(`note out of MIDI range: ${JSON.stringify(note)} -> ${midi} (expected 0..127)`);
  }
  return midi;
}

export function midiToFreqHz(midiNote: number): number {
  return 440 * 2 ** ((midiNote - 69) / 12);
}

export function freqToNearestMidi(freqHz: number): number {
  if (freqHz <= 0 || !Number.isFinite(freqHz)) throw new Error(`freq_hz must be > 0, got ${freqHz}`);
  return roundTiesToEven(69 + 12 * Math.log2(freqHz / 440));
}

function durationSeconds(tempoBpm: number, beats: number | undefined, ms: number | undefined): number {
  if (beats === undefined && ms === undefined) throw new Error("missing duration: provide 'beats' or 'ms'");
  if (beats !== undefined && ms !== undefined) throw new Error("ambiguous duration: provide only one of 'beats' or 'ms'");
  if (beats !== undefined) {
    if (beats < 0) throw new Error(`beats must be >= 0, got ${beats}`);
    return (60 / tempoBpm) * beats;
  }
  if (ms! < 0) throw new Error(`ms must be >= 0, got ${ms}`);
  return ms! / 1000;
}

export function parseScore(raw: unknown): { config: ScoreConfig; events: ScoreEvent[] } {
  if (!isRecord(raw)) throw new Error("score root must be a JSON object");

  const tempoBpm = numberValue(raw.tempo_bpm ?? 120, "tempo_bpm");
  if (tempoBpm <= 0) throw new Error(`tempo_bpm must be > 0, got ${tempoBpm}`);
  const ppqn = integerValue(raw.ppqn ?? 480, "ppqn");
  if (ppqn <= 0) throw new Error(`ppqn must be > 0, got ${ppqn}`);

  const midiRawValue = raw.midi || {};
  if (!isRecord(midiRawValue)) throw new Error("midi must be an object");
  const midi: MidiConfig = {
    channel: integerValue(midiRawValue.channel ?? 0, "midi.channel"),
    program: integerValue(midiRawValue.program ?? 80, "midi.program"),
    velocity: integerValue(midiRawValue.velocity ?? 96, "midi.velocity"),
  };
  if (midi.channel < 0 || midi.channel > 15) throw new Error("midi.channel must be 0..15");
  if (midi.program < 0 || midi.program > 127) throw new Error("midi.program must be 0..127");
  if (midi.velocity < 0 || midi.velocity > 127) throw new Error("midi.velocity must be 0..127");

  const audioRawValue = raw.audio || {};
  if (!isRecord(audioRawValue)) throw new Error("audio must be an object");
  const waveformValue = String(audioRawValue.waveform ?? raw.waveform ?? "square").toLowerCase();
  if (waveformValue !== "square" && waveformValue !== "sine") {
    throw new Error("audio.waveform must be 'square' or 'sine'");
  }
  const sampleRateHz = integerValue(audioRawValue.sample_rate_hz ?? raw.sample_rate_hz ?? 44_100, "sample_rate_hz");
  if (sampleRateHz <= 0) throw new Error("sample_rate_hz must be > 0");
  const audio: AudioConfig = {
    sampleRateHz,
    waveform: waveformValue,
    dutyCycle: clamp01(numberValue(audioRawValue.duty_cycle ?? raw.duty_cycle ?? 0.5, "duty_cycle")),
    volume: clamp01(numberValue(audioRawValue.volume ?? raw.volume ?? 0.7, "volume")),
    fadeMs: Math.max(0, integerValue(audioRawValue.fade_ms ?? raw.fade_ms ?? 2, "fade_ms")),
  };

  const eventsRaw = raw.events;
  if (!Array.isArray(eventsRaw) || eventsRaw.length === 0) throw new Error("events must be a non-empty array");
  const events: ScoreEvent[] = [];
  for (const [index, eventValue] of eventsRaw.entries()) {
    if (!isRecord(eventValue)) throw new Error(`events[${index}] must be an object`);
    const beats = optionalNumber(eventValue.beats, `events[${index}].beats`);
    const ms = optionalNumber(eventValue.ms, `events[${index}].ms`);
    const restBeats = optionalNumber(eventValue.rest_beats, `events[${index}].rest_beats`);
    const restMs = optionalNumber(eventValue.rest_ms, `events[${index}].rest_ms`);

    if ("note" in eventValue || "freq_hz" in eventValue) {
      const durationS = durationSeconds(tempoBpm, beats, ms);
      let midiNote: number;
      let freqHz: number;
      if ("note" in eventValue) {
        const noteValue = eventValue.note;
        if (typeof noteValue !== "number" && typeof noteValue !== "string") {
          throw new Error(`events[${index}].note must be an integer or note name`);
        }
        midiNote = noteToMidi(noteValue);
        freqHz = midiToFreqHz(midiNote);
      } else {
        freqHz = numberValue(eventValue.freq_hz, `events[${index}].freq_hz`);
        midiNote = freqToNearestMidi(freqHz);
      }
      const velocity = integerValue(eventValue.velocity ?? midi.velocity, `events[${index}].velocity`);
      if (velocity < 0 || velocity > 127) throw new Error(`events[${index}].velocity must be 0..127`);
      events.push({ kind: "note", durationS, midiNote, freqHz, velocity });
      continue;
    }

    if ("rest_beats" in eventValue || "rest_ms" in eventValue) {
      events.push({ kind: "rest", durationS: durationSeconds(tempoBpm, restBeats, restMs) });
      continue;
    }
    throw new Error(`events[${index}] must be a note/tone event (note/freq_hz + beats/ms) or a rest event (rest_beats/rest_ms)`);
  }

  return { config: { tempoBpm, ppqn, midi, audio }, events };
}

export async function parseScoreFile(path: string): Promise<{ config: ScoreConfig; events: ScoreEvent[] }> {
  const input = await Bun.file(expandUser(path)).json();
  return parseScore(input);
}

function varLen(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("varlen cannot be negative");
  const bytes = [value & 0x7f];
  let remaining = Math.floor(value / 128);
  while (remaining > 0) {
    bytes.unshift(0x80 | (remaining & 0x7f));
    remaining = Math.floor(remaining / 128);
  }
  return Uint8Array.from(bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function midiEvent(deltaTicks: number, payload: Uint8Array): Uint8Array {
  return concatBytes(varLen(deltaTicks), payload);
}

function writeUint32BE(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

export function encodeMidi(config: ScoreConfig, events: ScoreEvent[]): Uint8Array {
  const tempoUsPerQuarter = roundTiesToEven(60_000_000 / config.tempoBpm);
  if (!Number.isSafeInteger(config.ppqn) || config.ppqn <= 0 || config.ppqn > 0xffff) {
    throw new Error("ppqn must be a positive MIDI 16-bit value");
  }
  if (!Number.isSafeInteger(tempoUsPerQuarter) || tempoUsPerQuarter <= 0 || tempoUsPerQuarter > 0xffffff) {
    throw new Error("tempo is outside the MIDI tempo meta-event range");
  }
  const trackParts: Uint8Array[] = [
    midiEvent(0, Uint8Array.from([0xff, 0x51, 0x03, (tempoUsPerQuarter >>> 16) & 0xff, (tempoUsPerQuarter >>> 8) & 0xff, tempoUsPerQuarter & 0xff])),
    midiEvent(0, Uint8Array.from([0xc0 | config.midi.channel, config.midi.program])),
  ];
  let pendingDelta = 0;
  for (const event of events) {
    const ticks = Math.max(0, roundTiesToEven(event.durationS * config.tempoBpm * config.ppqn / 60));
    if (event.kind === "rest") {
      pendingDelta += ticks;
      continue;
    }
    if (event.midiNote < 0 || event.midiNote > 127 || event.velocity < 0 || event.velocity > 127) {
      throw new Error("MIDI note and velocity must be 0..127");
    }
    trackParts.push(midiEvent(pendingDelta, Uint8Array.from([0x90 | config.midi.channel, event.midiNote, event.velocity])));
    trackParts.push(midiEvent(ticks, Uint8Array.from([0x80 | config.midi.channel, event.midiNote, 0])));
    pendingDelta = 0;
  }
  trackParts.push(midiEvent(pendingDelta, Uint8Array.from([0xff, 0x2f, 0x00])));
  const track = concatBytes(...trackParts);
  const header = concatBytes(
    new TextEncoder().encode("MThd"),
    writeUint32BE(6),
    Uint8Array.from([0, 0, 0, 1, (config.ppqn >>> 8) & 0xff, config.ppqn & 0xff]),
  );
  return concatBytes(header, new TextEncoder().encode("MTrk"), writeUint32BE(track.byteLength), track);
}

function envelope(index: number, total: number, fade: number): number {
  if (fade <= 0 || total <= 1) return 1;
  const start = index < fade ? index / fade : 1;
  const end = index >= total - fade ? (total - 1 - index) / fade : 1;
  return Math.max(0, Math.min(1, start, end));
}

function pushInt16LE(output: number[], sample: number): void {
  const value = Math.trunc(Math.max(-1, Math.min(1, sample)) * 32_767);
  output.push(value & 0xff, (value >> 8) & 0xff);
}

export function encodeWav(config: ScoreConfig, events: ScoreEvent[]): Uint8Array {
  const sampleRate = config.audio.sampleRateHz;
  const fadeSamples = Math.max(0, roundTiesToEven(sampleRate * config.audio.fadeMs / 1000));
  const volume = clamp01(config.audio.volume) * 0.9;
  const frames: number[] = [];
  const twoPi = 2 * Math.PI;
  let phase = 0;

  for (const event of events) {
    const count = roundTiesToEven(event.durationS * sampleRate);
    if (count <= 0) continue;
    if (event.kind === "rest") {
      for (let i = 0; i < count; i += 1) pushInt16LE(frames, 0);
      continue;
    }
    const freq = event.freqHz;
    if (freq <= 0) {
      for (let i = 0; i < count; i += 1) pushInt16LE(frames, 0);
      continue;
    }
    if (config.audio.waveform === "sine") {
      const increment = twoPi * freq / sampleRate;
      for (let i = 0; i < count; i += 1) {
        pushInt16LE(frames, Math.sin(phase) * envelope(i, count, fadeSamples) * volume);
        phase += increment;
        if (phase > twoPi) phase -= twoPi;
      }
    } else {
      const increment = freq / sampleRate;
      const duty = clamp01(config.audio.dutyCycle);
      for (let i = 0; i < count; i += 1) {
        pushInt16LE(frames, (phase < duty ? 1 : -1) * envelope(i, count, fadeSamples) * volume);
        phase += increment;
        if (phase >= 1) phase -= 1;
      }
    }
  }

  const data = Uint8Array.from(frames);
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + data.byteLength, true);
  header.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  header.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, data.byteLength, true);
  return concatBytes(header, data);
}

function expandUser(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
}

function optionValue(args: string[], index: number, option: string): [string, number] {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return [value, index + 2];
}

export function parseArgs(args: string[]): { input: string; outDir: string; stem?: string } | "help" {
  let input: string | undefined;
  let outDir = ".";
  let stem: string | undefined;
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--in") {
      [input, index] = optionValue(args, index, "--in");
      continue;
    }
    if (arg === "--out-dir") {
      [outDir, index] = optionValue(args, index, "--out-dir");
      continue;
    }
    if (arg === "--stem") {
      [stem, index] = optionValue(args, index, "--stem");
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }
  if (input === undefined) throw new Error("--in is required");
  return { input, outDir, stem };
}

export async function main(args: string[] = Bun.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if (parsed === "help") {
      console.log("Generate MIDI + WAV previews for passive/piezo buzzer scores.\n\nUsage: buzzer_preview.ts --in <score.json> [--out-dir <dir>] [--stem <name>]");
      return 0;
    }
    const inputPath = resolve(expandUser(parsed.input));
    const outDir = resolve(expandUser(parsed.outDir));
    await mkdir(outDir, { recursive: true });
    const { config, events } = parseScore(JSON.parse(await readFile(inputPath, "utf8")));
    const stem = parsed.stem ?? basename(inputPath, extname(inputPath));
    const midiPath = resolve(outDir, `${stem}.mid`);
    const wavPath = resolve(outDir, `${stem}.wav`);
    await Bun.write(midiPath, encodeMidi(config, events));
    await Bun.write(wavPath, encodeWav(config, events));
    const totalSeconds = events.reduce((total, event) => total + event.durationS, 0);
    console.log(`[OK] Wrote: ${midiPath}`);
    console.log(`[OK] Wrote: ${wavPath}`);
    console.log(`[INFO] Duration: ${totalSeconds.toFixed(2)}s, tempo=${config.tempoBpm}, waveform=${config.audio.waveform}`);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
