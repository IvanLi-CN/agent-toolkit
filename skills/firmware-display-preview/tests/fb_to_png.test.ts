import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readlink, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { convertFramebuffer, encodePng, expandUser, main, MAX_FRAMEBUFFER_INPUT_BYTES, MAX_FRAMEBUFFER_PIXELS, MAX_FRAMEBUFFER_ROWS, type ConvertOptions } from "../scripts/fb_to_png.ts";

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function decodePngIndependently(data: Uint8Array): { width: number; height: number; colorType: number; rows: Uint8Array[] } {
  expect([...data.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  const decoder = new TextDecoder();
  while (offset < data.length) {
    const length = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
    const typeBytes = data.slice(offset + 4, offset + 8);
    const type = decoder.decode(typeBytes);
    const payload = data.slice(offset + 8, offset + 8 + length);
    const crc = new DataView(data.buffer, data.byteOffset + offset + 8 + length, 4).getUint32(0, false);
    expect(crc).toBe(crc32(concat(typeBytes, payload)));
    if (type === "IHDR") {
      width = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
      height = new DataView(payload.buffer, payload.byteOffset + 4, 4).getUint32(0, false);
      expect(payload[8]).toBe(8);
      colorType = payload[9]!;
      expect([...payload.slice(10)]).toEqual([0, 0, 0]);
    } else if (type === "IDAT") idat.push(payload);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 0;
  expect(channels).toBeGreaterThan(0);
  const raw = new Uint8Array(inflateSync(concat(...idat)));
  const rowBytes = width * channels;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (rowBytes + 1)]).toBe(0);
    rows.push(raw.slice(y * (rowBytes + 1) + 1, y * (rowBytes + 1) + 1 + rowBytes));
  }
  return { width, height, colorType, rows };
}

const defaults: Omit<ConvertOptions, "width" | "height"> = {
  endian: "le",
  bitOrder: "msb",
  ssd1306BitOrder: "lsb",
  invert: false,
};

describe("framebuffer to PNG helper", () => {
  test("converts every supported framebuffer format with stride and bit rules", () => {
    const gray = convertFramebuffer(Uint8Array.from([0, 127, 99, 255, 64, 88]), "gray8", { ...defaults, width: 2, height: 2, strideBytes: 3 });
    expect(gray.mode).toBe("L");
    expect(gray.rows.map((row) => [...row])).toEqual([[0, 127], [255, 64]]);

    const rgb888 = convertFramebuffer(Uint8Array.from([255, 0, 0, 0, 255, 0]), "rgb888", { ...defaults, width: 2, height: 1 });
    expect(rgb888.rows.map((row) => [...row])).toEqual([[255, 0, 0, 0, 255, 0]]);

    const rgb565 = convertFramebuffer(Uint8Array.from([0x00, 0xf8, 0x1f, 0x00]), "rgb565", { ...defaults, width: 2, height: 1 });
    expect(rgb565.rows.map((row) => [...row])).toEqual([[255, 0, 0, 0, 0, 255]]);

    const monoMsb = convertFramebuffer(Uint8Array.from([0x80, 0x01]), "mono1", { ...defaults, width: 9, height: 1 });
    expect([...monoMsb.rows[0]!]).toEqual([255, 0, 0, 0, 0, 0, 0, 0, 0]);
    const monoLsb = convertFramebuffer(Uint8Array.from([0x01, 0x01]), "mono1", { ...defaults, width: 9, height: 1, bitOrder: "lsb" });
    expect([...monoLsb.rows[0]!]).toEqual([255, 0, 0, 0, 0, 0, 0, 0, 255]);

    const ssd1306 = convertFramebuffer(Uint8Array.from([0x01, 0x80, 0x01, 0x00]), "ssd1306", { ...defaults, width: 2, height: 9 });
    expect(ssd1306.rows[0]![0]).toBe(255);
    expect(ssd1306.rows[7]![1]).toBe(255);
    expect(ssd1306.rows[8]![0]).toBe(255);
    expect(ssd1306.rows[8]![1]).toBe(0);
    const inverted = convertFramebuffer(Uint8Array.from([0x00]), "gray8", { ...defaults, width: 1, height: 1, invert: true });
    expect(inverted.rows[0]![0]).toBe(255);
  });

  test("writes PNG chunks that an independent decoder accepts", () => {
    const converted = convertFramebuffer(Uint8Array.from([0, 255, 127, 64]), "gray8", { ...defaults, width: 2, height: 2 });
    const png = decodePngIndependently(encodePng(2, 2, converted.mode, converted.rows));
    expect(png.width).toBe(2);
    expect(png.height).toBe(2);
    expect(png.colorType).toBe(0);
    expect(png.rows.map((row) => [...row])).toEqual([[0, 255], [127, 64]]);
  });

  test("rejects invalid dimensions, stride, and truncated input", () => {
    expect(() => convertFramebuffer(new Uint8Array(), "gray8", { ...defaults, width: 0, height: 1 })).toThrow(/width\/height/);
    expect(() => convertFramebuffer(new Uint8Array(), "gray8", { ...defaults, width: 2, height: 1, strideBytes: 1 })).toThrow(/stride_bytes too small/);
    expect(() => convertFramebuffer(Uint8Array.from([1]), "rgb888", { ...defaults, width: 1, height: 1 })).toThrow(/input too short/);
    expect(() => convertFramebuffer(new Uint8Array(), "gray8", { ...defaults, width: MAX_FRAMEBUFFER_PIXELS + 1, height: 1 })).toThrow(/pixel limit/);
    expect(() => convertFramebuffer(new Uint8Array(), "mono1", { ...defaults, width: 1, height: MAX_FRAMEBUFFER_ROWS + 1 })).toThrow(/row limit/);
  });

  test("keeps native renderer resources present and executable entrypoint direct", async () => {
    const root = join(import.meta.dir, "..", "assets", "host_c");
    const scene = await readFile(join(root, "scene.c"), "utf8");
    const mainSource = await readFile(join(root, "preview_main.c"), "utf8");
    expect(scene).toContain("render_scene");
    expect(mainSource).toContain("main(");
    expect(mainSource).toContain("framebuffer");
    expect(await main(["--help"])).toBe(0);
  });

  test("uses explicit HOME and account-home fallback for tilde paths", () => {
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = "/tmp/fixture-home";
      expect(expandUser("~/frame.raw")).toBe("/tmp/fixture-home/frame.raw");
      delete process.env.HOME;
      expect(expandUser("~")).toBe(homedir());
      expect(expandUser("~/frame.raw")).toBe(join(homedir(), "frame.raw"));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("returns argparse failures as exit code 2", async () => {
    expect(await main(["--unknown"])).toBe(2);
    expect(await main(["--width"])).toBe(2);
    expect(await main(["--format", "invalid", "--width", "1", "--height", "1", "--in", "fixture", "--out", "fixture"])).toBe(2);
  });

  test("rejects input files with unbounded trailing data", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-toolkit-fb-input-bound-"));
    try {
      const input = join(root, "frame.raw");
      const output = join(root, "frame.png");
      await writeFile(input, new Uint8Array(1));
      await truncate(input, MAX_FRAMEBUFFER_INPUT_BYTES + 1);
      expect(await main(["--format", "gray8", "--width", "1", "--height", "1", "--in", input, "--out", output])).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts bounded trailing framebuffer data for legacy captures", async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "agent-toolkit-fb-trailing-"));
    try {
      const input = join(root, "frame.raw");
      const output = join(root, "frame.png");
      await writeFile(input, Uint8Array.from([255, 7, 8, 9, 10, 11]));
      expect(await main(["--format", "gray8", "--width", "1", "--height", "1", "--in", input, "--out", output])).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces an output symlink without touching its target", async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "agent-toolkit-fb-output-"));
    try {
      const input = join(root, "frame.raw");
      const output = join(root, "preview.png");
      const outside = join(root, "outside.bin");
      await writeFile(input, Uint8Array.from([255]));
      await writeFile(outside, "sentinel");
      await symlink(outside, output);
      expect(await main(["--format", "gray8", "--width", "1", "--height", "1", "--in", input, "--out", output])).toBe(0);
      expect(await readFile(outside, "utf8")).toBe("sentinel");
      expect([...((await readFile(output)).slice(0, 8))]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await expect(readlink(output)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
