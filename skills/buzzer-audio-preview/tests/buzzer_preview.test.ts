import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeMidi,
  encodeWav,
  main,
  parseScore,
  type ScoreConfig,
  type ScoreEvent,
} from "../scripts/buzzer_preview.ts";

function readU16BE(data: Uint8Array, offset: number): number {
  return (data[offset]! << 8) | data[offset + 1]!;
}

function readU32LE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}

function readVarLen(data: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let next = offset;
  while (next < data.length) {
    const byte = data[next++]!;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next };
  }
  throw new Error("unterminated MIDI variable-length value");
}

interface MidiEvent {
  delta: number;
  absolute: number;
  status: number;
  data: number[];
}

function decodeMidi(data: Uint8Array): { division: number; events: MidiEvent[] } {
  const decoder = new TextDecoder();
  expect(decoder.decode(data.slice(0, 4))).toBe("MThd");
  expect(new DataView(data.buffer, data.byteOffset + 4, 4).getUint32(0, false)).toBe(6);
  expect(readU16BE(data, 8)).toBe(0);
  expect(readU16BE(data, 10)).toBe(1);
  const division = readU16BE(data, 12);
  let offset = 14;
  expect(decoder.decode(data.slice(offset, offset + 4))).toBe("MTrk");
  const trackLength = new DataView(data.buffer, data.byteOffset + offset + 4, 4).getUint32(0, false);
  offset += 8;
  const end = offset + trackLength;
  const events: MidiEvent[] = [];
  let absolute = 0;
  let runningStatus = 0;
  while (offset < end) {
    const delta = readVarLen(data, offset);
    offset = delta.next;
    let status = data[offset]!;
    if (status < 0x80) status = runningStatus;
    else offset += 1;
    if (status === 0xff) {
      const type = data[offset++]!;
      const length = readVarLen(data, offset);
      offset = length.next + length.value;
      events.push({ delta: delta.value, absolute, status: 0xff00 | type, data: [] });
      continue;
    }
    runningStatus = status;
    const length = status === 0xc0 || status === 0xd0 ? 1 : 2;
    const payload = [...data.slice(offset, offset + length)];
    offset += length;
    absolute += delta.value;
    events.push({ delta: delta.value, absolute, status, data: payload });
  }
  expect(offset).toBe(end);
  return { division, events };
}

function decodeWav(data: Uint8Array): { sampleRate: number; channels: number; bits: number; samples: number[] } {
  const decoder = new TextDecoder();
  expect(decoder.decode(data.slice(0, 4))).toBe("RIFF");
  expect(decoder.decode(data.slice(8, 12))).toBe("WAVE");
  expect(decoder.decode(data.slice(12, 16))).toBe("fmt ");
  expect(new DataView(data.buffer, data.byteOffset + 20, 2).getUint16(0, true)).toBe(1);
  const channels = new DataView(data.buffer, data.byteOffset + 22, 2).getUint16(0, true);
  const sampleRate = readU32LE(data, 24);
  const bits = new DataView(data.buffer, data.byteOffset + 34, 2).getUint16(0, true);
  expect(decoder.decode(data.slice(36, 40))).toBe("data");
  const dataLength = readU32LE(data, 40);
  const samples: number[] = [];
  const view = new DataView(data.buffer, data.byteOffset + 44, dataLength);
  for (let offset = 0; offset < dataLength; offset += 2) samples.push(view.getInt16(offset, true));
  return { sampleRate, channels, bits, samples };
}

describe("buzzer MIDI and WAV helper", () => {
  const config: ScoreConfig = {
    tempoBpm: 120,
    ppqn: 480,
    midi: { channel: 0, program: 80, velocity: 96 },
    audio: { sampleRateHz: 8_000, waveform: "square", dutyCycle: 0.5, volume: 0.7, fadeMs: 0 },
  };
  const events: ScoreEvent[] = [
    { kind: "note", durationS: 0.5, midiNote: 60, freqHz: 261.6255653005986, velocity: 96 },
    { kind: "rest", durationS: 0.25 },
    { kind: "note", durationS: 0.25, midiNote: 69, freqHz: 440, velocity: 96 },
  ];

  test("produces independently decodable MIDI events and timing", () => {
    const midi = decodeMidi(encodeMidi(config, events));
    expect(midi.division).toBe(480);
    const noteEvents = midi.events.filter((event) => (event.status & 0xf0) === 0x90 || (event.status & 0xf0) === 0x80);
    expect(noteEvents.map((event) => [event.status & 0xf0, event.absolute, event.data[0]])).toEqual([
      [0x90, 0, 60],
      [0x80, 480, 60],
      [0x90, 720, 69],
      [0x80, 960, 69],
    ]);
    expect(midi.events.at(-1)?.status).toBe(0xff2f);
  });

  test("produces valid PCM WAV samples with bounded tone and rest behavior", () => {
    const wav = decodeWav(encodeWav(config, events));
    expect(wav.sampleRate).toBe(8_000);
    expect(wav.channels).toBe(1);
    expect(wav.bits).toBe(16);
    expect(wav.samples.length).toBe(8_000);
    expect(Math.max(...wav.samples)).toBeLessThanOrEqual(Math.round(32_767 * 0.7 * 0.9));
    expect(Math.min(...wav.samples)).toBeGreaterThanOrEqual(-Math.round(32_767 * 0.7 * 0.9));
    expect(wav.samples.slice(4_000, 6_000).every((sample) => sample === 0)).toBe(true);
    expect(new Set(wav.samples.slice(1_000, 2_000)).size).toBeGreaterThan(1);
  });

  test("supports score variants and rejects malformed input", () => {
    const parsed = parseScore({
      tempo_bpm: 100,
      events: [{ note: "Bb3", beats: 0.5 }, { rest_ms: 100 }, { freq_hz: 440, ms: 20 }],
    });
    expect(parsed.events.map((event) => event.kind)).toEqual(["note", "rest", "note"]);
    expect(parsed.events[0]?.kind === "note" ? parsed.events[0].midiNote : undefined).toBe(58);
    expect(() => parseScore({ events: [] })).toThrow(/non-empty array/);
    expect(() => parseScore({ events: [{ note: "H4", beats: 1 }] })).toThrow(/invalid note name/);
    expect(() => parseScore({ events: [{ note: "C4" }] })).toThrow(/missing duration/);
    expect(() => parseScore({ events: [{ note: "C4", beats: 1, ms: 10 }] })).toThrow(/ambiguous duration/);
  });

  test("writes the direct Bun CLI outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-"));
    try {
      const input = join(root, "fixture.json");
      const output = join(root, "out");
      await writeFile(input, JSON.stringify({ tempo_bpm: 120, events: [{ note: "C4", ms: 20 }] }));
      expect(await main(["--in", input, "--out-dir", output])).toBe(0);
      expect((await readFile(join(output, "fixture.mid"))).slice(0, 4).toString()).toBe("MThd");
      expect((await readFile(join(output, "fixture.wav"))).slice(0, 4).toString()).toBe("RIFF");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
