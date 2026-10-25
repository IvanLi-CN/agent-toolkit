#!/usr/bin/env bun
/** Decode framebuffer bytes only. Rendering remains in the firmware/native harness. */
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { parseArgs } from "node:util";

export type Format = "ssd1306" | "mono1" | "gray8" | "rgb565" | "rgb888";
export interface Options {
  width: number; height: number; strideBytes?: number; endian?: "le" | "be";
  bitOrder?: "msb" | "lsb"; ssd1306BitOrder?: "lsb" | "msb"; invert?: boolean;
}
export const MAX_INPUT_BYTES = 256 * 1024 * 1024;
interface Layout { channels: number; rowBytes: number; stride: number; need: number; }
function layout(format: Format, opts: Options): Layout {
  if (!["ssd1306", "mono1", "gray8", "rgb565", "rgb888"].includes(format)) throw new Error("unsupported format");
  const { width, height } = opts;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) || width * height > 50_000_000) throw new Error("width/height must be positive integers (at most 50000000 pixels)");
  if (opts.endian && !["le", "be"].includes(opts.endian)) throw new Error("invalid endian");
  if (opts.bitOrder && !["msb", "lsb"].includes(opts.bitOrder)) throw new Error("invalid bit-order");
  if (opts.ssd1306BitOrder && !["msb", "lsb"].includes(opts.ssd1306BitOrder)) throw new Error("invalid ssd1306-bit-order");
  const channels = format === "rgb565" || format === "rgb888" ? 3 : 1;
  const rowBytes = format === "mono1" ? Math.ceil(width / 8) : width * (format === "rgb565" ? 2 : channels);
  const stride = format === "ssd1306" ? rowBytes : opts.strideBytes ?? rowBytes;
  if (!Number.isSafeInteger(stride) || stride < rowBytes) throw new Error(`stride_bytes too small or invalid (need >= ${rowBytes})`);
  const need = format === "ssd1306" ? width * Math.ceil(height / 8) : (height - 1) * stride + rowBytes;
  if (!Number.isSafeInteger(need) || need > MAX_INPUT_BYTES) throw new Error(`input size exceeds ${MAX_INPUT_BYTES} bytes`);
  return { channels, rowBytes, stride, need };
}
export function readBoundedInput(path: string, bytes: number): Buffer {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_INPUT_BYTES) throw new Error(`input size exceeds ${MAX_INPUT_BYTES} bytes`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("input must be a regular file");
    if (stat.size > MAX_INPUT_BYTES) throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes`);
    const buffer = Buffer.alloc(bytes);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (fstatSync(fd).size > MAX_INPUT_BYTES) throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes`);
    return buffer.subarray(0, offset);
  } finally { closeSync(fd); }
}
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0); out.write(kind, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
export function convert(data: Uint8Array, format: Format, opts: Options): Buffer {
  const { width, height } = opts, { channels, rowBytes, stride, need } = layout(format, opts);
  if (data.length > MAX_INPUT_BYTES) throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  if (data.length < need) throw new Error(`input too short: ${data.length} bytes (need >= ${need})`);
  const rows = Buffer.alloc(height * (width * channels + 1));
  for (let y = 0; y < height; y++) {
    let out = y * (width * channels + 1) + 1;
    for (let x = 0; x < width; x++) {
      let pixel: number[];
      if (format === "ssd1306") {
        const bit = opts.ssd1306BitOrder === "msb" ? 7 - y % 8 : y % 8;
        pixel = [(data[Math.floor(y / 8) * width + x] >> bit & 1) * 255];
      } else if (format === "mono1") {
        const bit = opts.bitOrder === "lsb" ? x % 8 : 7 - x % 8;
        pixel = [(data[y * stride + Math.floor(x / 8)] >> bit & 1) * 255];
      } else if (format === "rgb565") {
        const base = y * stride + x * 2;
        const value = opts.endian === "be" ? data[base] * 256 + data[base + 1] : data[base] + data[base + 1] * 256;
        pixel = [Math.floor(((value >> 11) * 255 + 15) / 31), Math.floor((((value >> 5) & 63) * 255 + 31) / 63), Math.floor(((value & 31) * 255 + 15) / 31)];
      } else {
        pixel = Array.from(data.slice(y * stride + x * channels, y * stride + (x + 1) * channels));
      }
      for (const value of pixel) rows[out++] = opts.invert ? value ^ 255 : value;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 0;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
export function main(args = process.argv.slice(2)): void {
  const { values } = parseArgs({ args, options: {
    format: { type: "string" }, width: { type: "string" }, height: { type: "string" }, in: { type: "string" }, out: { type: "string" },
    "stride-bytes": { type: "string" }, endian: { type: "string" }, "bit-order": { type: "string" }, "ssd1306-bit-order": { type: "string" },
    invert: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { console.log("Usage: bun fb_to_png.ts --format ssd1306|mono1|gray8|rgb565|rgb888 --width N --height N --in framebuffer.bin --out preview.png [--stride-bytes N] [--endian le|be] [--bit-order msb|lsb] [--ssd1306-bit-order lsb|msb] [--invert]"); return; }
  if (!values.in || !values.out || !values.format || !values.width || !values.height) throw new Error("--format, --width, --height, --in and --out are required");
  const format = values.format as Format;
  const options = {
    width: Number(values.width), height: Number(values.height), strideBytes: values["stride-bytes"] === undefined ? undefined : Number(values["stride-bytes"]),
    endian: values.endian as Options["endian"], bitOrder: values["bit-order"] as Options["bitOrder"], ssd1306BitOrder: values["ssd1306-bit-order"] as Options["ssd1306BitOrder"], invert: values.invert,
  } satisfies Options;
  const png = convert(readBoundedInput(values.in, layout(format, options).need), format, options);
  writeFileSync(values.out, png); console.log(`[OK] Wrote: ${values.out}`);
}
if (import.meta.main) {
  try { main(); } catch (error) { console.error(`error: ${(error as Error).message}`); process.exitCode = 2; }
}
