#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, rename, rm, rmdir, unlink, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

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

export const MAX_SCORE_EVENTS = 4_096;
export const MAX_SCORE_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_RENDERED_AUDIO_BYTES = 64 * 1024 * 1024;
export const MAX_MIDI_DELTA_TICKS = 0x0fff_ffff;
export const MAX_PUBLISHED_MIDI_BYTES = 16 * 1024 * 1024;
export const MAX_PUBLISHED_WAV_BYTES = MAX_RENDERED_AUDIO_BYTES + 44;
const MAX_TRANSACTION_METADATA_BYTES = 4 * 1024;

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NUMERIC_STRING = /^[+-]?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.(?:\d(?:_?\d)*))(?:[eE][+-]?\d(?:_?\d)*)?$/;

function numberValue(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const normalized = value.trim();
    if (NUMERIC_STRING.test(normalized)) {
      const number = Number(normalized.replaceAll("_", ""));
      if (Number.isFinite(number)) return number;
    }
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new Error(`${label} must be a number`);
}

function integerValue(value: unknown, label: string): number {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!/^[+-]?\d(?:_?\d)*$/.test(normalized)) throw new Error(`${label} must be an integer`);
    const number = Number(normalized.replaceAll("_", ""));
    if (!Number.isSafeInteger(number)) throw new Error(`${label} must be a safe integer`);
    return number;
  }
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

  const tempoBpm = numberValue(raw.tempo_bpm === undefined ? 120 : raw.tempo_bpm, "tempo_bpm");
  if (tempoBpm <= 0) throw new Error(`tempo_bpm must be > 0, got ${tempoBpm}`);
  const ppqn = integerValue(raw.ppqn === undefined ? 480 : raw.ppqn, "ppqn");
  if (ppqn <= 0) throw new Error(`ppqn must be > 0, got ${ppqn}`);

  const midiRawValue = raw.midi || {};
  if (!isRecord(midiRawValue)) throw new Error("midi must be an object");
  const midi: MidiConfig = {
    channel: integerValue(midiRawValue.channel === undefined ? 0 : midiRawValue.channel, "midi.channel"),
    program: integerValue(midiRawValue.program === undefined ? 80 : midiRawValue.program, "midi.program"),
    velocity: integerValue(midiRawValue.velocity === undefined ? 96 : midiRawValue.velocity, "midi.velocity"),
  };
  if (midi.channel < 0 || midi.channel > 15) throw new Error("midi.channel must be 0..15");
  if (midi.program < 0 || midi.program > 127) throw new Error("midi.program must be 0..127");
  if (midi.velocity < 0 || midi.velocity > 127) throw new Error("midi.velocity must be 0..127");

  const audioRawValue = raw.audio || {};
  if (!isRecord(audioRawValue)) throw new Error("audio must be an object");
  const waveformValue = String(
    audioRawValue.waveform === undefined
      ? raw.waveform === undefined
        ? "square"
        : raw.waveform
      : audioRawValue.waveform,
  ).toLowerCase();
  if (waveformValue !== "square" && waveformValue !== "sine") {
    throw new Error("audio.waveform must be 'square' or 'sine'");
  }
  const sampleRateHz = integerValue(
    audioRawValue.sample_rate_hz === undefined
      ? raw.sample_rate_hz === undefined
        ? 44_100
        : raw.sample_rate_hz
      : audioRawValue.sample_rate_hz,
    "sample_rate_hz",
  );
  if (sampleRateHz <= 0) throw new Error("sample_rate_hz must be > 0");
  const audio: AudioConfig = {
    sampleRateHz,
    waveform: waveformValue,
    dutyCycle: clamp01(numberValue(
      audioRawValue.duty_cycle === undefined
        ? raw.duty_cycle === undefined
          ? 0.5
          : raw.duty_cycle
        : audioRawValue.duty_cycle,
      "duty_cycle",
    )),
    volume: clamp01(numberValue(
      audioRawValue.volume === undefined
        ? raw.volume === undefined
          ? 0.7
          : raw.volume
        : audioRawValue.volume,
      "volume",
    )),
    fadeMs: Math.max(0, integerValue(
      audioRawValue.fade_ms === undefined
        ? raw.fade_ms === undefined
          ? 2
          : raw.fade_ms
        : audioRawValue.fade_ms,
      "fade_ms",
    )),
  };

  const eventsRaw = raw.events;
  if (!Array.isArray(eventsRaw) || eventsRaw.length === 0) throw new Error("events must be a non-empty array");
  if (eventsRaw.length > MAX_SCORE_EVENTS) throw new Error(`events must contain at most ${MAX_SCORE_EVENTS} items`);
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
      const velocity = integerValue(
        eventValue.velocity === undefined ? midi.velocity : eventValue.velocity,
        `events[${index}].velocity`,
      );
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
  const inputPath = expandUser(path);
  const input = JSON.parse(new TextDecoder().decode(await readBoundedRegularFile(inputPath, MAX_SCORE_INPUT_BYTES, "score input")));
  return parseScore(input);
}

function varLen(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MIDI_DELTA_TICKS) {
    throw new Error(`MIDI delta exceeds the four-byte VLQ limit (${MAX_MIDI_DELTA_TICKS} ticks)`);
  }
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

const UINT32_MAX = 0xffff_ffff;

function uint32Value(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`${label} must fit an unsigned 32-bit field`);
  }
  return value;
}

function writeUint32BE(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, uint32Value(value, "MIDI field"), false);
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
    if (!Number.isSafeInteger(ticks) || ticks > MAX_MIDI_DELTA_TICKS) {
      throw new Error(`MIDI event duration exceeds the four-byte VLQ limit (${MAX_MIDI_DELTA_TICKS} ticks)`);
    }
    if (event.kind === "rest") {
      if (pendingDelta > MAX_MIDI_DELTA_TICKS - ticks) {
        throw new Error(`MIDI rest duration exceeds the four-byte VLQ limit (${MAX_MIDI_DELTA_TICKS} ticks)`);
      }
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
  uint32Value(track.byteLength, "MIDI track length");
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

function writeInt16LE(output: Uint8Array, offset: number, sample: number): void {
  const value = Math.trunc(Math.max(-1, Math.min(1, sample)) * 32_767);
  output[offset] = value & 0xff;
  output[offset + 1] = (value >> 8) & 0xff;
}

export function encodeWav(config: ScoreConfig, events: ScoreEvent[]): Uint8Array {
  const sampleRate = config.audio.sampleRateHz;
  uint32Value(sampleRate, "sample rate");
  uint32Value(sampleRate * 2, "WAV byte rate");
  const fadeSamples = Math.max(0, roundTiesToEven(sampleRate * config.audio.fadeMs / 1000));
  const volume = clamp01(config.audio.volume) * 0.9;
  const frameCounts: number[] = [];
  let totalFrames = 0;
  for (const event of events) {
    const rawCount = event.durationS * sampleRate;
    if (!Number.isFinite(rawCount) || rawCount < 0 || rawCount > UINT32_MAX / 2) {
      throw new Error("WAV frame count is outside the representable range");
    }
    const count = roundTiesToEven(rawCount);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("WAV frame count is outside the representable range");
    totalFrames += count;
    if (!Number.isSafeInteger(totalFrames) || totalFrames > UINT32_MAX / 2) {
      throw new Error("WAV data length is outside the representable range");
    }
    if (totalFrames * 2 > MAX_RENDERED_AUDIO_BYTES) {
      throw new Error(`WAV data exceeds the ${MAX_RENDERED_AUDIO_BYTES}-byte rendering limit`);
    }
    frameCounts.push(count);
  }
  const dataByteLength = uint32Value(totalFrames * 2, "WAV data length");
  const riffChunkLength = uint32Value(36 + dataByteLength, "WAV RIFF chunk length");
  const data = new Uint8Array(totalFrames * 2);
  let frameOffset = 0;
  const twoPi = 2 * Math.PI;
  let phase = 0;

  for (const [eventIndex, event] of events.entries()) {
    const count = frameCounts[eventIndex]!;
    if (count <= 0) continue;
    if (event.kind === "rest") {
      for (let i = 0; i < count; i += 1) {
        writeInt16LE(data, frameOffset * 2, 0);
        frameOffset += 1;
      }
      continue;
    }
    const freq = event.freqHz;
    if (freq <= 0) {
      for (let i = 0; i < count; i += 1) {
        writeInt16LE(data, frameOffset * 2, 0);
        frameOffset += 1;
      }
      continue;
    }
    if (config.audio.waveform === "sine") {
      const increment = twoPi * freq / sampleRate;
      for (let i = 0; i < count; i += 1) {
        writeInt16LE(data, frameOffset * 2, Math.sin(phase) * envelope(i, count, fadeSamples) * volume);
        frameOffset += 1;
        phase += increment;
        if (phase > twoPi) phase -= twoPi;
      }
    } else {
      const increment = freq / sampleRate;
      const duty = clamp01(config.audio.dutyCycle);
      for (let i = 0; i < count; i += 1) {
        writeInt16LE(data, frameOffset * 2, (phase < duty ? 1 : -1) * envelope(i, count, fadeSamples) * volume);
        frameOffset += 1;
        phase += increment;
        if (phase >= 1) phase -= 1;
      }
    }
  }

  if (frameOffset !== totalFrames) throw new Error("internal WAV frame count mismatch");
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, riffChunkLength, true);
  header.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, uint32Value(sampleRate, "WAV sample rate"), true);
  view.setUint32(28, uint32Value(sampleRate * 2, "WAV byte rate"), true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  header.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, uint32Value(data.byteLength, "WAV data length"), true);
  return concatBytes(header, data);
}

function expandUser(path: string): string {
  const home = process.env.HOME ?? homedir();
  return path === "~" ? home : path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

class CliError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
  }
}

function optionValue(args: string[], index: number, option: string): [string, number] {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliError(`${option} requires a value`);
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
    throw new CliError(`Unknown arg: ${arg}`);
  }
  if (input === undefined) throw new CliError("--in is required");
  if (stem !== undefined) validateStem(stem);
  return { input, outDir, stem };
}

function validateStem(stem: string): string {
  if (stem.length === 0 || stem === "." || stem === ".." || stem.includes("\0") || isAbsolute(stem) || stem.includes("/") || stem.includes("\\")) {
    throw new CliError("--stem must be a non-empty filename without path separators");
  }
  return stem;
}

async function writeSyncedFile(path: string, data: Uint8Array): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;
type PublishState = "prepared" | "midi-backed-up" | "backups-complete" | "midi-published" | "wav-publishing" | "wav-published" | "complete";
const TRANSACTION_ENTRY_NAMES = new Set([
  ".state",
  ".state.tmp",
  "midi.new",
  "wav.new",
  "midi.backup",
  "wav.backup",
  "midi.restoring",
  "midi.restored",
  "wav.restoring",
  "wav.restored",
  "midi.symlink",
  "wav.symlink",
]);
const LOCK_ENTRY_NAMES = new Set(["pid", "owner", "identity", "heartbeat", "ready"]);

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

type MovedOutput = false | "file" | "symlink";

async function moveIfPresent(source: string, destination: string, allowSymlink = true): Promise<MovedOutput> {
  try {
    const metadata = await lstat(source);
    if (!metadata.isFile() && !(allowSymlink && metadata.isSymbolicLink())) {
      throw new Error(`output path is not a regular file${allowSymlink ? " or symlink" : ""}: ${source}`);
    }
    await rename(source, destination);
    return metadata.isSymbolicLink() ? "symlink" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function moveOutputToBackup(source: string, destination: string, symlinkMarker: string): Promise<MovedOutput> {
  try {
    const metadata = await lstat(source);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw new Error(`output path is not a regular file or symlink: ${source}`);
    }
    if (metadata.isSymbolicLink()) {
      await writeSyncedFile(symlinkMarker, new TextEncoder().encode(JSON.stringify(await readlink(source))));
      await syncDirectory(dirname(symlinkMarker));
    }
    await rename(source, destination);
    return metadata.isSymbolicLink() ? "symlink" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readRegularFile(path: string, maxBytes = MAX_TRANSACTION_METADATA_BYTES): Promise<Uint8Array> {
  return readBoundedRegularFile(path, maxBytes, "published output");
}

async function readBoundedRegularFile(path: string, maxBytes: number, label: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit: ${path}`);
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(data, offset, size - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const finalMetadata = await handle.stat();
    if (offset !== size || finalMetadata.size !== metadata.size) throw new Error(`${label} changed while reading: ${path}`);
    return data;
  } finally {
    await handle.close();
  }
}

async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EBADF" && code !== "EISDIR") throw error;
  }
}

async function removeTransactionDirectory(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.some((entry) => entry.isDirectory() || !TRANSACTION_ENTRY_NAMES.has(entry.name))) return;
  for (const entry of entries) {
    try {
      await unlink(join(directory, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    await rmdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writePublishState(directory: string, state: PublishState): Promise<void> {
  const temporary = join(directory, ".state.tmp");
  await writeSyncedFile(temporary, new TextEncoder().encode(`${state}\n`));
  await rename(temporary, join(directory, ".state"));
  await syncDirectory(directory);
}

async function readPublishState(directory: string): Promise<PublishState | undefined> {
  try {
    const state = new TextDecoder().decode(await readRegularFile(join(directory, ".state"))).trim();
    if (state === "prepared" || state === "midi-backed-up" || state === "backups-complete" || state === "midi-published" || state === "wav-publishing" || state === "wav-published" || state === "complete") return state;
    throw new Error(`transaction state is invalid: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof Error && error.message.startsWith("transaction state is invalid:")) throw error;
    throw new Error(`transaction state is unreadable: ${directory}`, { cause: error });
  }
}

async function hasRecoveryArtifacts(directory: string): Promise<boolean> {
  for (const name of [
    "midi.backup",
    "wav.backup",
    "midi.restoring",
    "midi.restored",
    "wav.restoring",
    "wav.restored",
    "midi.symlink",
    "wav.symlink",
  ]) {
    if (await pathExists(join(directory, name))) return true;
  }
  return false;
}

async function restoreOutput(
  directory: string,
  backupName: "midi.backup" | "wav.backup",
  outputPath: string,
  restoringName: "midi.restoring" | "wav.restoring",
  restoredName: "midi.restored" | "wav.restored",
  symlinkName: "midi.symlink" | "wav.symlink",
): Promise<{ hasBackup: boolean; inProgress: boolean }> {
  const backupPath = join(directory, backupName);
  const restoringPath = join(directory, restoringName);
  const restoredPath = join(directory, restoredName);
  const symlinkPath = join(directory, symlinkName);
  const hasBackup = await pathExists(backupPath);
  const inProgress = hasBackup || await pathExists(restoringPath) || await pathExists(restoredPath) || await pathExists(symlinkPath);
  if (!hasBackup) return { hasBackup: false, inProgress };

  await writeSyncedFile(restoringPath, new Uint8Array());
  const backupMetadata = await lstat(backupPath);
  if (backupMetadata.isSymbolicLink()) {
    if (!await pathExists(symlinkPath)) throw new Error(`transaction backup is not a regular file or approved symlink: ${backupPath}`);
    let expectedTarget: string;
    try {
      const decoded = JSON.parse(new TextDecoder().decode(await readRegularFile(symlinkPath)));
      if (typeof decoded !== "string") throw new Error("invalid symlink marker");
      expectedTarget = decoded;
    } catch {
      throw new Error(`transaction backup is not a regular file or approved symlink: ${backupPath}`);
    }
    const actualTarget = await readlink(backupPath);
    if (expectedTarget !== actualTarget) throw new Error(`transaction backup is not a regular file or approved symlink: ${backupPath}`);
    await moveIfPresent(backupPath, outputPath, true);
  } else {
    if (!backupMetadata.isFile() || await pathExists(symlinkPath)) throw new Error(`transaction backup is not a regular file: ${backupPath}`);
    await moveIfPresent(backupPath, outputPath, false);
  }
  await syncDirectory(dirname(outputPath));
  await syncDirectory(directory);
  await writeSyncedFile(restoredPath, new Uint8Array());
  await removeFile(restoringPath);
  await syncDirectory(directory);
  return { hasBackup: true, inProgress: true };
}

async function restoreTransaction(directory: string, midiPath: string, wavPath: string): Promise<void> {
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`transaction path is not a private directory: ${directory}`);
  }
  const state = await readPublishState(directory);
  if (state === undefined) {
    if (await hasRecoveryArtifacts(directory)) {
      throw new Error(`transaction state is missing while recovery artifacts exist: ${directory}`);
    }
    await removeTransactionDirectory(directory);
    await syncDirectory(dirname(directory));
    return;
  }
  if (state === "complete") {
    await removeTransactionDirectory(directory);
    await syncDirectory(dirname(directory));
    return;
  }

  const midi = await restoreOutput(directory, "midi.backup", midiPath, "midi.restoring", "midi.restored", "midi.symlink");
  const wav = await restoreOutput(directory, "wav.backup", wavPath, "wav.restoring", "wav.restored", "wav.symlink");
  if (state === "backups-complete" || state === "midi-published" || state === "wav-publishing" || state === "wav-published") {
    if (!midi.inProgress) await removeFile(midiPath);
    if ((state === "wav-publishing" || state === "wav-published") && !wav.inProgress) await removeFile(wavPath);
  }
  await syncDirectory(dirname(midiPath));
  await removeTransactionDirectory(directory);
  await syncDirectory(dirname(midiPath));
}

async function recoverPublishTransactions(outDir: string, stem: string, midiPath: string, wavPath: string): Promise<void> {
  const prefix = `.buzzer-preview-txn-${stem}-`;
  let entries;
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const transaction = join(outDir, entry.name);
    let transactionEntries;
    try {
      transactionEntries = await readdir(transaction, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (transactionEntries.some((candidate) => candidate.isDirectory() || !TRANSACTION_ENTRY_NAMES.has(candidate.name))) continue;
    const quarantine = join(outDir, `.buzzer-preview-recovery-${stem}-${randomUUID()}`);
    try {
      await rename(transaction, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      await restoreTransaction(quarantine, midiPath, wavPath);
    } catch (error) {
      await rename(quarantine, transaction).catch(() => undefined);
      throw error;
    }
  }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeLockDirectory(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((entry) => entry.isDirectory() || !LOCK_ENTRY_NAMES.has(entry.name))) return;
  for (const entry of entries) await unlink(join(directory, entry.name)).catch(() => undefined);
  await rmdir(directory).catch(() => undefined);
  await syncDirectory(dirname(directory));
}

async function processIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") return undefined;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const closingParenthesis = stat.lastIndexOf(")");
      if (closingParenthesis >= 0) {
        const fields = stat.slice(closingParenthesis + 2).trim().split(/\s+/);
        if (fields[19] !== undefined && fields[19].length > 0) return `linux:${fields[19]}`;
      }
    } catch {
      // The process may have exited or /proc may be unavailable.
    }
  }
  try {
    const child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
    const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const value = stdout.trim();
    return status === 0 && value.length > 0 ? `ps:${value}` : undefined;
  } catch {
    return undefined;
  }
}

async function refreshLockHeartbeat(path: string): Promise<void> {
  try {
    const now = new Date();
    await utimes(path, now, now);
  } catch {
    // A failed heartbeat is handled by the age-based stale-lock policy.
  }
}

async function acquirePublishLock(outDir: string, stem: string, reclaimDeadOwner = false): Promise<() => Promise<void>> {
  const lockDirectory = join(outDir, `.buzzer-preview-${stem}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDirectory);
      const owner = randomUUID();
      const identity = await processIdentity(process.pid);
      await syncDirectory(outDir);
      await writeSyncedFile(join(lockDirectory, "pid"), new TextEncoder().encode(`${process.pid}\n`));
      await writeSyncedFile(join(lockDirectory, "owner"), new TextEncoder().encode(`${owner}\n`));
      if (identity !== undefined) await writeSyncedFile(join(lockDirectory, "identity"), new TextEncoder().encode(`${identity}\n`));
      const heartbeatPath = join(lockDirectory, "heartbeat");
      await writeSyncedFile(heartbeatPath, new TextEncoder().encode(`${Date.now()}\n`));
      await syncDirectory(lockDirectory);
      await writeSyncedFile(join(lockDirectory, "ready"), new Uint8Array());
      await syncDirectory(lockDirectory);
      const heartbeat = setInterval(() => { void refreshLockHeartbeat(heartbeatPath); }, LOCK_HEARTBEAT_MS);
      return async () => {
        clearInterval(heartbeat);
        try {
          const currentOwner = new TextDecoder().decode(await readRegularFile(join(lockDirectory, "owner"), 128)).trim();
          if (currentOwner === owner) await removeLockDirectory(lockDirectory);
        } catch {
          // A replacement owner must never be removed by an old releaser.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const metadata = await lstat(lockDirectory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("lock path is not a private directory");
        const entries = await readdir(lockDirectory, { withFileTypes: true });
        if (entries.some((entry) => entry.isDirectory() || entry.isSymbolicLink() || !LOCK_ENTRY_NAMES.has(entry.name))) throw new Error("lock directory contains unknown entries");
        const heartbeatMetadata = await lstat(join(lockDirectory, "heartbeat")).catch(() => metadata);
        const age = Date.now() - heartbeatMetadata.mtimeMs;
        const ready = entries.some((entry) => entry.name === "ready");
        if (!ready) {
          stale = age > LOCK_STALE_MS;
        } else {
          const ownerText = new TextDecoder().decode(await readRegularFile(join(lockDirectory, "pid"), 128));
          const owner = Number(ownerText.trim());
          if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("lock pid is invalid");
          const alive = await isProcessAlive(owner);
          if (!alive) {
            stale = reclaimDeadOwner || age > LOCK_STALE_MS;
          } else {
            const recordedIdentity = await readRegularFile(join(lockDirectory, "identity"), 512)
              .then((value) => new TextDecoder().decode(value).trim())
              .catch(() => "");
            const currentIdentity = recordedIdentity.length > 0 ? await processIdentity(owner) : undefined;
            stale = currentIdentity === undefined
              ? age > LOCK_STALE_MS
              : recordedIdentity.length > 0 && currentIdentity !== recordedIdentity && age > LOCK_STALE_MS;
          }
        }
      } catch {
        stale = false;
      }
      if (!stale) throw new Error("output publication is already in progress");
      const quarantine = join(outDir, `.buzzer-preview-reclaim-${stem}-${randomUUID()}`);
      try {
        await rename(lockDirectory, quarantine);
      } catch {
        continue;
      }
      await removeLockDirectory(quarantine);
    }
  }
  throw new Error("could not acquire output publication lock");
}

const publishQueues = new Map<string, Promise<void>>();

async function publishOutputsLocked(outDir: string, stem: string, midi: Uint8Array, wav: Uint8Array): Promise<[string, string]> {
  const midiPath = resolve(outDir, `${stem}.mid`);
  const wavPath = resolve(outDir, `${stem}.wav`);
  await recoverPublishTransactions(outDir, stem, midiPath, wavPath);
  const transaction = await mkdtemp(join(outDir, `.buzzer-preview-txn-${stem}-`));
  const tempMidiPath = join(transaction, "midi.new");
  const tempWavPath = join(transaction, "wav.new");
  try {
    await writeSyncedFile(tempMidiPath, midi);
    await writeSyncedFile(tempWavPath, wav);
    await writePublishState(transaction, "prepared");
    await moveOutputToBackup(midiPath, join(transaction, "midi.backup"), join(transaction, "midi.symlink"));
    await syncDirectory(outDir);
    await syncDirectory(transaction);
    await writePublishState(transaction, "midi-backed-up");
    await moveOutputToBackup(wavPath, join(transaction, "wav.backup"), join(transaction, "wav.symlink"));
    await syncDirectory(outDir);
    await syncDirectory(transaction);
    await writePublishState(transaction, "backups-complete");
    await rename(tempMidiPath, midiPath);
    await syncDirectory(transaction);
    await syncDirectory(outDir);
    await writePublishState(transaction, "midi-published");
    await writePublishState(transaction, "wav-publishing");
    await rename(tempWavPath, wavPath);
    await syncDirectory(transaction);
    await syncDirectory(outDir);
    await writePublishState(transaction, "wav-published");
    await writePublishState(transaction, "complete");
    await removeTransactionDirectory(transaction);
    await syncDirectory(outDir);
    return [midiPath, wavPath];
  } catch (error) {
    try {
      await restoreTransaction(transaction, midiPath, wavPath);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "output publication failed and recovery was not completed");
    }
    throw error;
  } finally {
    await unlink(tempMidiPath).catch(() => undefined);
    await unlink(tempWavPath).catch(() => undefined);
  }
}

async function publishOutputs(outDir: string, stem: string, midi: Uint8Array, wav: Uint8Array): Promise<[string, string]> {
  const key = `${outDir}\0${stem}`;
  const previous = publishQueues.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  publishQueues.set(key, current);
  await previous;
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await acquirePublishLock(outDir, stem);
    return await publishOutputsLocked(outDir, stem, midi, wav);
  } finally {
    if (releaseLock !== undefined) await releaseLock();
    releaseQueue();
    if (publishQueues.get(key) === current) publishQueues.delete(key);
  }
}

export async function readPublishedPair(outDir: string, stem: string): Promise<{ midi: Uint8Array; wav: Uint8Array }> {
  validateStem(stem);
  const midiPath = resolve(outDir, `${stem}.mid`);
  const wavPath = resolve(outDir, `${stem}.wav`);
  let lastError: unknown;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const release = await acquirePublishLock(outDir, stem, true);
      try {
        await recoverPublishTransactions(outDir, stem, midiPath, wavPath);
        return {
          midi: await readRegularFile(midiPath, MAX_PUBLISHED_MIDI_BYTES),
          wav: await readRegularFile(wavPath, MAX_PUBLISHED_WAV_BYTES),
        };
      } finally {
        await release();
      }
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !/already in progress|could not acquire/.test(error.message)) throw error;
      await Bun.sleep(20);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("could not read published output pair");
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
    const outDirStat = await lstat(outDir);
    if (!outDirStat.isDirectory() || outDirStat.isSymbolicLink()) throw new CliError("--out-dir must resolve to a real directory");
    const { config, events } = await parseScoreFile(inputPath);
    const stem = validateStem(parsed.stem ?? basename(inputPath, extname(inputPath)));
    await publishOutputs(outDir, stem, encodeMidi(config, events), encodeWav(config, events));
    const totalSeconds = events.reduce((total, event) => total + event.durationS, 0);
    console.log("[OK] Wrote MIDI preview");
    console.log("[OK] Wrote WAV preview");
    console.log(`[INFO] Duration: ${totalSeconds.toFixed(2)}s, tempo=${config.tempoBpm}, waveform=${config.audio.waveform}`);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof CliError ? error.message : "preview generation failed"}`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}

if (import.meta.main) process.exitCode = await main();
