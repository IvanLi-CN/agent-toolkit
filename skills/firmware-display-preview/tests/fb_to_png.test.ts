import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convert, type Format, type Options } from "../scripts/fb_to_png.ts";

function decode(png: Buffer) {
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const table = Array.from({ length: 256 }, (_, initial) => {
    let value = initial;
    for (let n = 0; n < 8; n++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const names: string[] = [], compressed: Buffer[] = [];
  let at = 8, width = 0, height = 0, channels = 0;
  while (at < png.length) {
    const size = png.readUInt32BE(at), kind = png.toString("ascii", at + 4, at + 8);
    let crc = 0xffffffff;
    for (const byte of png.subarray(at + 4, at + 8 + size)) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
    expect((crc ^ 0xffffffff) >>> 0).toBe(png.readUInt32BE(at + 8 + size));
    const data = png.subarray(at + 8, at + 8 + size); names.push(kind);
    if (kind === "IHDR") {
      expect(data.length).toBe(13); width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      expect(data[8]).toBe(8); channels = data[9] === 2 ? 3 : 1;
      expect(Array.from(data.subarray(10))).toEqual([0, 0, 0]);
    } else if (kind === "IDAT") compressed.push(data);
    else expect(size).toBe(0);
    at += 12 + size;
  }
  expect(at).toBe(png.length); expect(names).toEqual(["IHDR", "IDAT", "IEND"]);
  const raw = inflateSync(Buffer.concat(compressed));
  expect(raw.length).toBe(height * (width * channels + 1));
  const rows = Array.from({ length: height }, (_, y) => {
    const start = y * (width * channels + 1); expect(raw[start]).toBe(0);
    return Array.from(raw.subarray(start + 1, start + 1 + width * channels));
  });
  return { width, height, channels, rows };
}
test("VER-FOUNDATION-HELPERS-02: every row-major format and padding", () => {
  const fixtures: { format: Format; data: number[]; options: Options; rows: number[][] }[] = [
    { format: "gray8", data: [0, 128, 99, 255, 64], options: { width: 2, height: 2, strideBytes: 3 }, rows: [[0, 128], [255, 64]] },
    { format: "rgb888", data: [1, 2, 3, 9, 4, 5, 6], options: { width: 1, height: 2, strideBytes: 4 }, rows: [[1, 2, 3], [4, 5, 6]] },
    { format: "mono1", data: [128, 128, 42, 1, 0], options: { width: 9, height: 2, strideBytes: 3 }, rows: [[255, 0, 0, 0, 0, 0, 0, 0, 255], [0, 0, 0, 0, 0, 0, 0, 255, 0]] },
    { format: "mono1", data: [1], options: { width: 3, height: 1, bitOrder: "lsb" }, rows: [[255, 0, 0]] },
    { format: "rgb565", data: [0, 248, 224, 7, 31, 0], options: { width: 3, height: 1 }, rows: [[255, 0, 0, 0, 255, 0, 0, 0, 255]] },
    { format: "rgb565", data: [0x84, 0x10, 42, 0xff, 0xff], options: { width: 1, height: 2, strideBytes: 3, endian: "be" }, rows: [[132, 130, 132], [255, 255, 255]] },
  ];
  for (const f of fixtures) {
    expect(decode(convert(Uint8Array.from(f.data), f.format, f.options))).toMatchObject({ width: f.options.width, height: f.options.height, rows: f.rows });
    expect(decode(convert(Uint8Array.from([...f.data, 77]), f.format, { ...f.options, invert: true })).rows).toEqual(f.rows.map(row => row.map(v => v ^ 255)));
  }
});
test("SSD1306 page boundaries and both vertical bit orders preserve top-left orientation", () => {
  for (const order of ["lsb", "msb"] as const) {
    const data = order === "lsb" ? [1, 128, 1, 0] : [128, 1, 128, 0];
    const { rows } = decode(convert(Uint8Array.from(data), "ssd1306", { width: 2, height: 9, ssd1306BitOrder: order }));
    expect(rows).toEqual([[255, 0], ...Array.from({ length: 6 }, () => [0, 0]), [0, 255], [255, 0]]);
  }
});
test("bad dimensions, stride, format/options and truncated buffers fail", () => {
  for (const format of ["ssd1306", "mono1", "gray8", "rgb565", "rgb888"] as const) expect(() => convert(new Uint8Array(), format, { width: 2, height: 9 })).toThrow("too short");
  for (const options of [{ width: 0, height: 1 }, { width: 1.5, height: 1 }, { width: 1, height: NaN }, { width: 2, height: 2, strideBytes: 1 }, { width: 1, height: 1, endian: "bad" }]) expect(() => convert(new Uint8Array(20), "gray8", options as Options)).toThrow();
  expect(() => convert(new Uint8Array(20), "bad" as Format, { width: 1, height: 1 })).toThrow("format");
});
test("retained C harness compiles natively and fails closed until firmware accessor is supplied", () => {
  const root = mkdtempSync(join(tmpdir(), "firmware-native-"));
  try {
    const main = new URL("../assets/host_c/preview_main.c", import.meta.url).pathname;
    const scene = new URL("../assets/host_c/scene.c", import.meta.url).pathname;
    expect(readFileSync(main, "utf8")).toContain("render_scene()");
    const compile = Bun.spawnSync(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", main, scene, "-o", join(root, "preview")]);
    expect(compile.exitCode).toBe(0);
    const run = Bun.spawnSync([join(root, "preview")], { cwd: root });
    expect(run.exitCode).toBe(2); expect(run.stderr.toString()).toContain("get_framebuffer() not implemented");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
