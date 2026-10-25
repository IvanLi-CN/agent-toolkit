import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeMidi, encodeWav, main, MAX_EVENTS, MAX_INPUT_BYTES, noteToMidi, parseScore, readBoundedInput } from "../scripts/buzzer_preview.ts";

function midiEvents(bytes: Buffer) {
  expect(bytes.toString("ascii", 0, 4)).toBe("MThd");
  expect(bytes.readUInt32BE(4)).toBe(6);
  expect(bytes.readUInt16BE(8)).toBe(0);
  expect(bytes.readUInt16BE(10)).toBe(1);
  expect(bytes.toString("ascii", 14, 18)).toBe("MTrk");
  expect(bytes.readUInt32BE(18)).toBe(bytes.length - 22);
  let at = 22, tick = 0;
  const events: { tick: number; status: number; data: number[] }[] = [];
  function variable() {
    let value = 0, byte: number, count = 0;
    do { byte = bytes[at++]; value = value * 128 + (byte & 127); expect(++count).toBeLessThanOrEqual(4); } while (byte & 128);
    return value;
  }
  while (at < bytes.length) {
    tick += variable();
    const status = bytes[at++];
    if (status === 255) {
      const type = bytes[at++], length = variable();
      events.push({ tick, status: 0xff00 | type, data: Array.from(bytes.subarray(at, at + length)) }); at += length;
    } else {
      const length = (status & 240) === 192 ? 1 : 2;
      events.push({ tick, status, data: Array.from(bytes.subarray(at, at + length)) }); at += length;
    }
  }
  expect(at).toBe(bytes.length); return events;
}
function wavSamples(bytes: Buffer) {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
  expect(bytes.toString("ascii", 8, 16)).toBe("WAVEfmt ");
  expect(bytes.readUInt32LE(16)).toBe(16);
  expect(bytes.readUInt16LE(20)).toBe(1);
  expect(bytes.readUInt16LE(22)).toBe(1);
  expect(bytes.readUInt32LE(28)).toBe(bytes.readUInt32LE(24) * 2);
  expect(bytes.readUInt16LE(32)).toBe(2);
  expect(bytes.readUInt16LE(34)).toBe(16);
  expect(bytes.toString("ascii", 36, 40)).toBe("data");
  expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44);
  return Array.from({ length: (bytes.length - 44) / 2 }, (_, i) => bytes.readInt16LE(44 + 2 * i));
}
describe("VER-FOUNDATION-HELPERS-01: independent media decoding", () => {
  test("MIDI note names, raw notes, frequencies, rests, tempo and channel scheduling", () => {
    const score = parseScore({ tempo_bpm: 120, ppqn: 480, midi: { channel: 3, program: 7, velocity: 90 }, events: [
      { rest_ms: 250 }, { note: "Bb3", beats: 0.5, velocity: 64 }, { note: 60, ms: 500 }, { freq_hz: 440, ms: 125 }, { rest_beats: 0.5 },
    ] });
    const bytes = encodeMidi(score);
    expect(bytes.readUInt16BE(12)).toBe(480);
    expect(midiEvents(bytes)).toEqual([
      { tick: 0, status: 0xff51, data: [7, 161, 32] }, { tick: 0, status: 195, data: [7] },
      { tick: 240, status: 147, data: [58, 64] }, { tick: 480, status: 131, data: [58, 0] },
      { tick: 480, status: 147, data: [60, 90] }, { tick: 960, status: 131, data: [60, 0] },
      { tick: 960, status: 147, data: [69, 90] }, { tick: 1080, status: 131, data: [69, 0] },
      { tick: 1320, status: 0xff2f, data: [] },
    ]);
    expect(noteToMidi("c-1")).toBe(0); expect(noteToMidi("G9")).toBe(127); expect(noteToMidi("D#5")).toBe(75);
  });
  test("square PCM has expected duty, volume, exact rests and rounded duration", () => {
    const bytes = encodeWav(parseScore({ sample_rate_hz: 8000, waveform: "square", volume: 1, fade_ms: 0, audio: { duty_cycle: 0.25 }, events: [{ freq_hz: 1000, ms: 10 }, { rest_ms: 2 }] }));
    expect(bytes.readUInt32LE(24)).toBe(8000);
    const samples = wavSamples(bytes);
    expect(samples).toHaveLength(96);
    expect(samples.slice(0, 8)).toEqual([29490, 29490, -29490, -29490, -29490, -29490, -29490, -29490]);
    expect(samples.slice(0, 80).filter(n => n > 0)).toHaveLength(20);
    expect(samples.slice(80)).toEqual(Array(16).fill(0));
    expect(Math.max(...samples)).toBeLessThanOrEqual(32767); expect(Math.min(...samples)).toBeGreaterThanOrEqual(-32768);
  });
  test("sine PCM tone and fade match analytic samples within one PCM integer", () => {
    const samples = wavSamples(encodeWav(parseScore({ audio: { waveform: "sine", sample_rate_hz: 8000, volume: 0.5, fade_ms: 1 }, events: [{ freq_hz: 500, ms: 20 }] })));
    expect(samples).toHaveLength(160);
    for (let i = 0; i < samples.length; i++) {
      const fade = Math.max(0, Math.min(1, i / 8, (159 - i) / 8));
      // One integer allows floating point sin/phase differences at quantization boundaries.
      expect(Math.abs(samples[i] - Math.trunc(Math.sin(i * Math.PI / 8) * 0.45 * 32767 * fade))).toBeLessThanOrEqual(1);
    }
    expect(samples[0]).toBe(0); expect(samples.at(-1)).toBe(0);
  });
  test("zero durations, all rests, clamping, and round-to-even quantization", () => {
    const score = parseScore({ tempo_bpm: 120, ppqn: 1, audio: { sample_rate_hz: 1000, volume: 3, duty_cycle: -1, fade_ms: -2 }, events: [{ note: "A4", ms: 0 }, { rest_ms: 0.5 }, { rest_ms: 1.5 }] });
    expect(score.audio).toMatchObject({ volume: 1, duty: 0, fade: 0 });
    expect(wavSamples(encodeWav(score))).toEqual([0, 0]);
    expect(midiEvents(encodeMidi(parseScore({ events: [{ rest_beats: 1 }] }))).at(-1)?.tick).toBe(480);
  });
  test("rejects oversized JSON before parsing or output creation", () => {
    const root = mkdtempSync(join(tmpdir(), "buzzer-preview-"));
    try {
      const input = join(root, "oversized.json"), out = join(root, "out");
      writeFileSync(input, Buffer.alloc(MAX_INPUT_BYTES + 1, 0x20));
      expect(() => main(["--in", input, "--out-dir", out])).toThrow(`input exceeds ${MAX_INPUT_BYTES} bytes`);
      expect(existsSync(out)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("bounded descriptor reads reject over-limit content before parsing", () => {
    const root = mkdtempSync(join(tmpdir(), "buzzer-preview-"));
    try {
      const input = join(root, "grown.json"), valid = Buffer.from('{"events":[{"note":"C4","ms":0}]}');
      writeFileSync(input, valid);
      expect(readBoundedInput(input)).toEqual(valid);
      writeFileSync(input, Buffer.alloc(MAX_INPUT_BYTES + 1, 0x20));
      expect(() => readBoundedInput(input)).toThrow(`input exceeds ${MAX_INPUT_BYTES} bytes`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("rejects excessive zero-duration events before mapping", () => {
    const events = Array.from({ length: MAX_EVENTS + 1 }, () => ({ note: "C4", ms: 0 }));
    expect(() => parseScore({ events })).toThrow(`events exceed ${MAX_EVENTS}`);
  });
  test("invalid and unrepresentable scores fail before encoding", () => {
    for (const value of [{ events: [] }, { tempo_bpm: 0 }, { ppqn: 32768 }, { midi: [] }, { audio: [] }, { audio: { waveform: "triangle" } }, { sample_rate_hz: 0 }, { volume: NaN }]) {
      expect(() => parseScore({ events: [{ note: "C4", ms: 1 }], ...value })).toThrow();
    }
    for (const event of [{ note: true, ms: 1 }, { note: 1.5, ms: 1 }, { note: "Q4", ms: 1 }, { note: 128, ms: 1 }, { note: "C4" }, { note: "C4", ms: 1, beats: 1 }, { rest_ms: -1 }, { freq_hz: 0, ms: 1 }, { freq_hz: 1e20, ms: 1 }, { note: "C4", ms: Infinity }, { note: "C4", ms: 1, velocity: 128 }, { rest_ms: 1e15 }]) expect(() => parseScore({ events: [event] })).toThrow();
    expect(() => parseScore(null)).toThrow("object"); expect(() => parseScore([])).toThrow("object");
    expect(() => parseScore({})).toThrow("events");
  });
});
