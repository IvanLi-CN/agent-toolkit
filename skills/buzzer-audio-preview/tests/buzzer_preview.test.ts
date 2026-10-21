import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeMidi,
  encodeWav,
  MAX_RENDERED_AUDIO_BYTES,
  MAX_PUBLISHED_WAV_BYTES,
  MAX_SCORE_INPUT_BYTES,
  MAX_SCORE_EVENTS,
  main,
  parseScore,
  parseArgs,
  readPublishedPair,
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
    expect(() => parseScore({ events: Array.from({ length: MAX_SCORE_EVENTS + 1 }, () => ({ note: "C4", ms: 1 })) })).toThrow(/at most/);
    expect(() => encodeMidi(config, [{ kind: "rest", durationS: 1_000_000_000 }])).toThrow(/VLQ/);
  });

  test("preserves explicit null rejection and Python-compatible numeric conversions", () => {
    const parsed = parseScore({ ppqn: 480.5, midi: null, audio: null, events: [{ note: "C4", beats: 1 }] });
    expect(parsed.config.ppqn).toBe(480);
    expect(parsed.config.midi.channel).toBe(0);
    expect(parsed.config.audio.sampleRateHz).toBe(44_100);
    expect(() => parseScore({ tempo_bpm: null, events: [{ note: "C4", beats: 1 }] })).toThrow(/tempo_bpm must be a number/);
    expect(() => parseScore({ ppqn: "480.5", events: [{ note: "C4", beats: 1 }] })).toThrow(/ppqn must be an integer/);
    expect(() => parseScore({ sample_rate_hz: "8000.5", events: [{ note: "C4", beats: 1 }] })).toThrow(/sample_rate_hz must be an integer/);
    expect(() => parseScore({ midi: { channel: null }, events: [{ note: "C4", beats: 1 }] })).toThrow(/midi.channel must be a number/);
    expect(() => parseScore({ audio: { volume: null }, events: [{ note: "C4", beats: 1 }] })).toThrow(/volume must be a number/);
    expect(() => parseScore({ events: [{ note: "C4", beats: 1, velocity: null }] })).toThrow(/velocity must be a number/);
  });

  test("rejects WAV values that cannot fit fixed-width fields", () => {
    expect(() => encodeWav(
      { ...config, audio: { ...config.audio, sampleRateHz: 0x1_0000_0000 } },
      [{ kind: "rest", durationS: 0 }],
    )).toThrow(/sample rate/);
    expect(() => encodeWav(
      { ...config, audio: { ...config.audio, sampleRateHz: 0x8000_0000 } },
      [{ kind: "rest", durationS: 0 }],
    )).toThrow(/byte rate/);
    expect(() => encodeWav(
      config,
      [{ kind: "rest", durationS: (MAX_RENDERED_AUDIO_BYTES + 2) / config.audio.sampleRateHz / 2 }],
    )).toThrow(/rendering limit/);
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

  test("keeps argparse exit codes distinct from runtime failures", async () => {
    expect(parseArgs(["--help"])).toBe("help");
    expect(await main(["--help"])).toBe(0);
    expect(await main(["--unknown"])).toBe(2);
    expect(await main(["--in"])).toBe(2);
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-cli-"));
    try {
      expect(await main(["--in", join(root, "missing.json"), "--out-dir", join(root, "out")])).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects output stems that escape the selected directory", () => {
    expect(() => parseArgs(["--in", "fixture.json", "--stem", "../outside"])).toThrow(/without path separators/);
    expect(() => parseArgs(["--in", "fixture.json", "--stem", "/tmp/outside"])).toThrow(/without path separators/);
  });

  test("replaces preexisting output symlinks without touching their targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-symlink-"));
    try {
      const input = join(root, "fixture.json");
      const output = join(root, "out");
      const outside = join(root, "outside target\n");
      await writeFile(input, JSON.stringify({ tempo_bpm: 120, events: [{ note: "C4", ms: 20 }] }));
      await mkdir(output, { recursive: true });
      await writeFile(outside, "sentinel");
      await symlink(outside, join(output, "fixture.mid"));
      expect(await main(["--in", input, "--out-dir", output])).toBe(0);
      expect(await Bun.file(outside).text()).toBe("sentinel");
      expect((await readFile(join(output, "fixture.mid"))).slice(0, 4).toString()).toBe("MThd");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores a preexisting output symlink after a later publication failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-symlink-recovery-"));
    try {
      const input = join(root, "fixture.json");
      const output = join(root, "out");
      const outside = join(root, "outside target\n");
      await writeFile(input, JSON.stringify({ tempo_bpm: 120, events: [{ note: "C4", ms: 20 }] }));
      await mkdir(output, { recursive: true });
      await writeFile(outside, "sentinel");
      await symlink(outside, join(output, "fixture.mid"));
      await mkdir(join(output, "fixture.wav"));
      expect(await main(["--in", input, "--out-dir", output])).toBe(1);
      expect(await readlink(join(output, "fixture.mid"))).toBe(outside);
      expect(await readFile(outside, "utf8")).toBe("sentinel");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not reclaim a partially initialized lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-partial-lock-"));
    try {
      const input = join(root, "fixture.json");
      const output = join(root, "out");
      const lock = join(output, ".buzzer-preview-fixture.lock");
      await mkdir(lock, { recursive: true });
      await writeFile(join(lock, "pid"), "2147483647\n");
      await writeFile(input, JSON.stringify({ tempo_bpm: 120, events: [{ note: "C4", ms: 20 }] }));
      expect(await main(["--in", input, "--out-dir", output])).toBe(1);
      expect(await readdir(output)).toContain(".buzzer-preview-fixture.lock");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects output directories without deleting their contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-directory-"));
    try {
      const input = join(root, "fixture.json");
      const output = join(root, "out");
      const midiDirectory = join(output, "fixture.mid");
      const sentinel = join(midiDirectory, "sentinel.txt");
      await mkdir(midiDirectory, { recursive: true });
      await writeFile(sentinel, "keep");
      await writeFile(input, JSON.stringify({ tempo_bpm: 120, events: [{ note: "C4", ms: 20 }] }));
      expect(await main(["--in", input, "--out-dir", output])).toBe(1);
      expect(await readFile(sentinel, "utf8")).toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not delete user directories that resemble internal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-internal-collision-"));
    try {
      const input = join(root, "fixture.json");
      const output = join(root, "out");
      const transaction = join(output, ".buzzer-preview-txn-fixture-user");
      const sentinel = join(transaction, "sentinel.txt");
      await mkdir(transaction, { recursive: true });
      await writeFile(sentinel, "keep");
      await writeFile(input, JSON.stringify({ tempo_bpm: 120, events: [{ note: "C4", ms: 20 }] }));
      expect(await main(["--in", input, "--out-dir", output])).toBe(0);
      expect(await readFile(sentinel, "utf8")).toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not reclaim a lock directory with unknown contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-lock-collision-"));
    try {
      const input = join(root, "fixture.json");
      const output = join(root, "out");
      const lock = join(output, ".buzzer-preview-fixture.lock");
      const sentinel = join(lock, "sentinel.txt");
      await mkdir(lock, { recursive: true });
      await writeFile(sentinel, "keep");
      await writeFile(input, JSON.stringify({ tempo_bpm: 120, events: [{ note: "C4", ms: 20 }] }));
      expect(await main(["--in", input, "--out-dir", output])).toBe(1);
      expect(await readFile(sentinel, "utf8")).toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reclaims an aged empty lock directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-empty-lock-"));
    try {
      const input = join(root, "fixture.json");
      const output = join(root, "out");
      const lock = join(output, ".buzzer-preview-fixture.lock");
      await mkdir(lock, { recursive: true });
      const old = new Date(Date.now() - 10 * 60 * 1000);
      await utimes(lock, old, old);
      await writeFile(input, JSON.stringify({ tempo_bpm: 120, events: [{ note: "C4", ms: 20 }] }));
      expect(await main(["--in", input, "--out-dir", output])).toBe(0);
      expect(await readdir(output)).not.toContain(".buzzer-preview-fixture.lock");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reclaims a dead-owner lock immediately for readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-dead-lock-"));
    try {
      const output = join(root, "out");
      const lock = join(output, ".buzzer-preview-fixture.lock");
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "fixture.mid"), "midi");
      await writeFile(join(output, "fixture.wav"), "wav");
      await mkdir(lock);
      await writeFile(join(lock, "pid"), "2147483647\n");
      await writeFile(join(lock, "owner"), "dead-owner\n");
      await writeFile(join(lock, "ready"), "");
      const pair = await readPublishedPair(output, "fixture");
      expect(pair.midi.toString()).toBe("midi");
      expect(pair.wav.toString()).toBe("wav");
      expect(await readdir(output)).not.toContain(".buzzer-preview-fixture.lock");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reclaims an aged lock when process identity is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-identityless-lock-"));
    try {
      const output = join(root, "out");
      const lock = join(output, ".buzzer-preview-fixture.lock");
      const heartbeat = join(lock, "heartbeat");
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "fixture.mid"), "midi");
      await writeFile(join(output, "fixture.wav"), "wav");
      await mkdir(lock);
      await writeFile(join(lock, "pid"), `${process.pid}\n`);
      await writeFile(join(lock, "owner"), "identityless-owner\n");
      await writeFile(heartbeat, `${Date.now() - 10 * 60 * 1000}\n`);
      await writeFile(join(lock, "ready"), "");
      const old = new Date(Date.now() - 10 * 60 * 1000);
      await utimes(heartbeat, old, old);
      const pair = await readPublishedPair(output, "fixture");
      expect(pair.midi.toString()).toBe("midi");
      expect(pair.wav.toString()).toBe("wav");
      expect(await readdir(output)).not.toContain(".buzzer-preview-fixture.lock");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers an interrupted publication before reading a pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-recovery-"));
    try {
      const output = join(root, "out");
      const transaction = join(output, ".buzzer-preview-txn-fixture-recovery");
      await mkdir(transaction, { recursive: true });
      await writeFile(join(output, "fixture.mid"), "new-midi");
      await writeFile(join(output, "fixture.wav"), "old-wav");
      await writeFile(join(transaction, "midi.backup"), "old-midi");
      await writeFile(join(transaction, ".state"), "midi-published\n");
      const pair = await readPublishedPair(output, "fixture");
      const decoder = new TextDecoder();
      expect(decoder.decode(pair.midi)).toBe("old-midi");
      expect(decoder.decode(pair.wav)).toBe("old-wav");
      expect(await readdir(output)).not.toContain(".buzzer-preview-txn-fixture-recovery");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not follow a transaction backup symlink during recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-backup-symlink-"));
    try {
      const output = join(root, "out");
      const transaction = join(output, ".buzzer-preview-txn-fixture-symlink");
      const outside = join(root, "outside-secret");
      await mkdir(transaction, { recursive: true });
      await writeFile(join(output, "fixture.mid"), "new-midi");
      await writeFile(join(output, "fixture.wav"), "old-wav");
      await writeFile(outside, "PRIVATE_BYTES");
      await symlink(outside, join(transaction, "midi.backup"));
      await writeFile(join(transaction, ".state"), "midi-published\n");
      await expect(readPublishedPair(output, "fixture")).rejects.toThrow(/regular file/);
      expect(await readFile(outside, "utf8")).toBe("PRIVATE_BYTES");
      expect(await readFile(join(output, "fixture.mid"), "utf8")).toBe("new-midi");
      expect(await readdir(output)).toContain(".buzzer-preview-txn-fixture-symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves an output after a restore crash marker is left behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-restore-marker-"));
    try {
      const output = join(root, "out");
      const transaction = join(output, ".buzzer-preview-txn-fixture-marker");
      await mkdir(transaction, { recursive: true });
      await writeFile(join(output, "fixture.mid"), "restored-midi");
      await writeFile(join(output, "fixture.wav"), "old-wav");
      await writeFile(join(transaction, "midi.restoring"), "");
      await writeFile(join(transaction, ".state"), "midi-published\n");
      const pair = await readPublishedPair(output, "fixture");
      expect(pair.midi.toString()).toBe("restored-midi");
      expect(pair.wav.toString()).toBe("old-wav");
      expect(await readdir(output)).not.toContain(".buzzer-preview-txn-fixture-marker");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes a newly published WAV after an interrupted pair commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-wav-recovery-"));
    try {
      const output = join(root, "out");
      const transaction = join(output, ".buzzer-preview-txn-fixture-wav-recovery");
      await mkdir(transaction, { recursive: true });
      await writeFile(join(output, "fixture.mid"), "new-midi");
      await writeFile(join(output, "fixture.wav"), "new-wav");
      await writeFile(join(transaction, "midi.backup"), "old-midi");
      await writeFile(join(transaction, ".state"), "wav-publishing\n");
      await expect(readPublishedPair(output, "fixture")).rejects.toThrow();
      expect(await readFile(join(output, "fixture.mid"), "utf8")).toBe("old-midi");
      await expect(readFile(join(output, "fixture.wav"), "utf8")).rejects.toThrow(/ENOENT/);
      expect(await readdir(output)).not.toContain(".buzzer-preview-txn-fixture-wav-recovery");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects path traversal through the published pair API", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-pair-boundary-"));
    try {
      await expect(readPublishedPair(root, "../outside")).rejects.toThrow(/without path separators/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds score input and published output reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-read-bounds-"));
    try {
      const input = join(root, "oversized.json");
      await writeFile(input, new Uint8Array(MAX_SCORE_INPUT_BYTES + 1));
      expect(await main(["--in", input, "--out-dir", join(root, "generated")])).toBe(1);

      const output = join(root, "out");
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "fixture.mid"), "MThd");
      await writeFile(join(output, "fixture.wav"), new Uint8Array(MAX_PUBLISHED_WAV_BYTES + 1));
      await expect(readPublishedPair(output, "fixture")).rejects.toThrow(/exceeds/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent pair publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-buzzer-concurrent-"));
    try {
      const input = join(root, "fixture.json");
      const output = join(root, "out");
      await writeFile(input, JSON.stringify({ tempo_bpm: 120, events: [{ note: "C4", ms: 20 }] }));
      expect(await Promise.all([
        main(["--in", input, "--out-dir", output]),
        main(["--in", input, "--out-dir", output]),
      ])).toEqual([0, 0]);
      expect((await readFile(join(output, "fixture.mid"))).slice(0, 4).toString()).toBe("MThd");
      expect((await readFile(join(output, "fixture.wav"))).slice(0, 4).toString()).toBe("RIFF");
      const pair = await readPublishedPair(output, "fixture");
      expect(pair.midi.slice(0, 4).toString()).toBe("MThd");
      expect(pair.wav.slice(0, 4).toString()).toBe("RIFF");
      expect((await readdir(output)).filter((entry) => entry.includes("buzzer-preview")).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
