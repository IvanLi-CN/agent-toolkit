#!/usr/bin/env bun
/** Portable score validation and MIDI/PCM encoding; no physical buzzer model. */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

type ObjectValue = Record<string, unknown>;
export type Event = { kind: "rest"; duration: number } | { kind: "note"; duration: number; note: number; frequency: number; velocity: number };
export interface Score {
  tempo: number; ppqn: number;
  midi: { channel: number; program: number; velocity: number };
  audio: { sampleRate: number; waveform: "square" | "sine"; volume: number; duty: number; fade: number };
  events: Event[];
}
export const MAX_INPUT_BYTES = 1_048_576;
export const MAX_EVENTS = 65_536;
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as ObjectValue;
}
function number(value: unknown, label: string, min: number, max = Infinity, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be ${integer ? "an integer" : "a finite number"} in ${min}..${max}`);
  }
  return value;
}
// Match Python's round-to-even at exact half values, preserving event quantization.
export function roundEven(value: number): number {
  const low = Math.floor(value);
  return value - low === 0.5 ? low + (low % 2) : Math.round(value);
}
export function noteToMidi(value: unknown): number {
  if (typeof value === "number") return number(value, "midi note", 0, 127, true);
  const match = typeof value === "string" && /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(value.trim());
  if (!match) throw new Error("invalid note name (expected C4, D#5, Bb3 or MIDI 0..127)");
  const offset: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return number((Number(match[3]) + 1) * 12 + offset[match[1].toUpperCase()] + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0), "midi note", 0, 127, true);
}
export function parseScore(value: unknown): Score {
  const raw = object(value, "score root");
  const tempo = number(raw.tempo_bpm ?? 120, "tempo_bpm", 60_000_000 / 0xffffff, 60_000_000);
  const ppqn = number(raw.ppqn ?? 480, "ppqn", 1, 32767, true);
  const midiRaw = object(raw.midi ?? {}, "midi");
  const midi = {
    channel: number(midiRaw.channel ?? 0, "midi.channel", 0, 15, true),
    program: number(midiRaw.program ?? 80, "midi.program", 0, 127, true),
    velocity: number(midiRaw.velocity ?? 96, "midi.velocity", 0, 127, true),
  };
  const audioRaw = object(raw.audio ?? {}, "audio");
  const field = (key: string, fallback: unknown) => audioRaw[key] ?? raw[key] ?? fallback;
  const waveform = String(field("waveform", "square")).toLowerCase();
  if (waveform !== "square" && waveform !== "sine") throw new Error("audio.waveform must be 'square' or 'sine'");
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const audio = {
    sampleRate: number(field("sample_rate_hz", 44100), "sample_rate_hz", 1, 384000, true),
    waveform,
    volume: clamp(number(field("volume", 0.7), "volume", -Number.MAX_VALUE)),
    duty: clamp(number(field("duty_cycle", 0.5), "duty_cycle", -Number.MAX_VALUE)),
    fade: Math.max(0, number(field("fade_ms", 2), "fade_ms", -Number.MAX_VALUE, Infinity, true)),
  } satisfies Score["audio"];
  if (!Array.isArray(raw.events) || !raw.events.length) throw new Error("events must be a non-empty array");
  if (raw.events.length > MAX_EVENTS) throw new Error(`events exceed ${MAX_EVENTS}`);
  const duration = (event: ObjectValue, rest: boolean): number => {
    const beats = event[rest ? "rest_beats" : "beats"];
    const ms = event[rest ? "rest_ms" : "ms"];
    if ((beats == null) === (ms == null)) throw new Error("provide exactly one duration: beats/ms or rest_beats/rest_ms");
    return beats != null ? number(beats, "beats", 0) * 60 / tempo : number(ms, "ms", 0) / 1000;
  };
  const events: Event[] = raw.events.map((value, index) => {
    const event = object(value, `events[${index}]`);
    if ("note" in event || "freq_hz" in event) {
      const seconds = duration(event, false);
      const frequency = "note" in event ? 440 * 2 ** ((noteToMidi(event.note) - 69) / 12) : number(event.freq_hz, "freq_hz", Number.MIN_VALUE);
      const note = "note" in event ? noteToMidi(event.note) : number(roundEven(69 + 12 * Math.log2(frequency / 440)), "nearest MIDI note", 0, 127, true);
      return { kind: "note", duration: seconds, note, frequency, velocity: number(event.velocity ?? midi.velocity, "event.velocity", 0, 127, true) };
    }
    if ("rest_beats" in event || "rest_ms" in event) return { kind: "rest", duration: duration(event, true) };
    throw new Error(`events[${index}] must contain note/freq_hz or rest_beats/rest_ms`);
  });
  // Bound allocation and MIDI's four-byte variable length deltas before any output write.
  let frames = 0;
  let pending = 0;
  for (const event of events) {
    frames += roundEven(event.duration * audio.sampleRate);
    const ticks = roundEven(event.duration * tempo * ppqn / 60);
    if (!Number.isSafeInteger(ticks) || ticks > 0x0fffffff) throw new Error("event duration exceeds MIDI delta limit");
    pending = event.kind === "rest" ? pending + ticks : 0;
    if (pending > 0x0fffffff) throw new Error("rest duration exceeds MIDI delta limit");
  }
  if (!Number.isSafeInteger(frames) || frames > 50_000_000) throw new Error("score exceeds 50000000 PCM frames");
  return { tempo, ppqn, midi, audio, events };
}
function vlq(value: number): Buffer {
  const out = [value & 127];
  while ((value = Math.floor(value / 128))) out.unshift(128 | (value & 127));
  return Buffer.from(out);
}
export function encodeMidi(score: Score): Buffer {
  const tempo = Buffer.alloc(3);
  tempo.writeUIntBE(roundEven(60_000_000 / score.tempo), 0, 3);
  const chunks: Buffer[] = [Buffer.from([0, 255, 81, 3]), tempo, Buffer.from([0, 192 | score.midi.channel, score.midi.program])];
  let pending = 0;
  for (const event of score.events) {
    const ticks = roundEven(event.duration * score.tempo * score.ppqn / 60);
    if (event.kind === "rest") { pending += ticks; continue; }
    chunks.push(vlq(pending), Buffer.from([144 | score.midi.channel, event.note, event.velocity]), vlq(ticks), Buffer.from([128 | score.midi.channel, event.note, 0]));
    pending = 0;
  }
  chunks.push(vlq(pending), Buffer.from([255, 47, 0]));
  const track = Buffer.concat(chunks);
  const header = Buffer.from("4d546864000000060000000100004d54726b00000000", "hex");
  header.writeUInt16BE(score.ppqn, 12);
  header.writeUInt32BE(track.length, 18);
  return Buffer.concat([header, track]);
}
export function encodeWav(score: Score): Buffer {
  const { sampleRate, waveform, fade, volume, duty } = score.audio;
  const frames = score.events.reduce((sum, event) => sum + roundEven(event.duration * sampleRate), 0);
  const out = Buffer.alloc(44 + frames * 2);
  out.write("RIFF", 0); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(frames * 2, 40);
  let phase = 0, offset = 44;
  const fadeSamples = roundEven(sampleRate * fade / 1000);
  for (const event of score.events) {
    const count = roundEven(event.duration * sampleRate);
    if (event.kind === "rest") { offset += count * 2; continue; }
    for (let i = 0; i < count; i++) {
      const envelope = fadeSamples <= 0 || count <= 1 ? 1 : Math.max(0, Math.min(1, i / fadeSamples, (count - 1 - i) / fadeSamples));
      const sample = waveform === "sine" ? Math.sin(phase * 2 * Math.PI) : phase < duty ? 1 : -1;
      out.writeInt16LE(Math.trunc(sample * envelope * volume * 0.9 * 32767), offset);
      offset += 2;
      phase = (phase + event.frequency / sampleRate) % 1;
    }
  }
  return out;
}
export function main(args = process.argv.slice(2)): void {
  const { values } = parseArgs({ args, options: { in: { type: "string" }, "out-dir": { type: "string", default: "." }, stem: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) { console.log("Usage: bun buzzer_preview.ts --in score.json [--out-dir .] [--stem name]"); return; }
  if (!values.in) throw new Error("--in is required");
  const input = resolve(values.in);
  const stem = values.stem ?? basename(input, extname(input));
  if (!stem || stem === "." || stem === ".." || /[/\\]/.test(stem)) throw new Error("--stem must be a filename stem");
  const inputStat = statSync(input);
  if (!inputStat.isFile()) throw new Error("input must be a regular file");
  if (inputStat.size > MAX_INPUT_BYTES) throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  const source = readFileSync(input);
  if (source.length > MAX_INPUT_BYTES) throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  const score = parseScore(JSON.parse(source.toString("utf8")));
  const midi = encodeMidi(score), wav = encodeWav(score);
  const out = resolve(values["out-dir"]!);
  mkdirSync(out, { recursive: true });
  for (const [extension, bytes] of [["mid", midi], ["wav", wav]] as const) {
    const path = join(out, `${stem}.${extension}`); writeFileSync(path, bytes); console.log(`[OK] Wrote: ${path}`);
  }
  console.log(`[INFO] Duration: ${score.events.reduce((sum, e) => sum + e.duration, 0).toFixed(2)}s, tempo=${score.tempo} bpm, waveform=${score.audio.waveform}`);
}
if (import.meta.main) {
  try { main(); } catch (error) { console.error(`error: ${(error as Error).message}`); process.exitCode = 2; }
}
