#!/usr/bin/env bun

import { constants } from "node:fs";
import { lstat, mkdtemp, open, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { deflateSync } from "node:zlib";
import { basename, dirname, join, resolve } from "node:path";

export type FramebufferFormat = "ssd1306" | "mono1" | "gray8" | "rgb565" | "rgb888";
export type PngMode = "L" | "RGB";

export const MAX_FRAMEBUFFER_PIXELS = 16_777_216;
export const MAX_FRAMEBUFFER_INPUT_BYTES = 128 * 1024 * 1024;

function validateDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("width/height must be > 0");
  }
  if (width > 0xffff_ffff || height > 0xffff_ffff || width * height > MAX_FRAMEBUFFER_PIXELS) {
    throw new Error(`framebuffer dimensions exceed the ${MAX_FRAMEBUFFER_PIXELS}-pixel limit`);
  }
}

export interface ConvertOptions {
  width: number;
  height: number;
  strideBytes?: number;
  endian: "le" | "be";
  bitOrder: "msb" | "lsb";
  ssd1306BitOrder: "lsb" | "msb";
  invert: boolean;
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
  CRC_TABLE[index] = value >>> 0;
}

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
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

function pngChunk(kind: string, data: Uint8Array): Uint8Array {
  const kindBytes = new TextEncoder().encode(kind);
  const body = concatBytes(kindBytes, data);
  const result = new Uint8Array(12 + data.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.byteLength, false);
  result.set(body, 4);
  view.setUint32(8 + data.byteLength, crc32(body), false);
  return result;
}

export function encodePng(width: number, height: number, mode: PngMode, rows: Uint8Array[]): Uint8Array {
  validateDimensions(width, height);
  const channels = mode === "L" ? 1 : 3;
  if (rows.length !== height) throw new Error(`expected ${height} rows, got ${rows.length}`);
  for (const [index, row] of rows.entries()) {
    if (row.byteLength !== width * channels) throw new Error(`row ${index} has ${row.byteLength} bytes, expected ${width * channels}`);
  }

  const raw = new Uint8Array(height * (1 + width * channels));
  let offset = 0;
  for (const row of rows) {
    raw[offset] = 0;
    offset += 1;
    raw.set(row, offset);
    offset += row.byteLength;
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = mode === "L" ? 0 : 2;
  return concatBytes(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    pngChunk("IEND", new Uint8Array()),
  );
}

function strideFor(defaultStride: number, requested: number | undefined): number {
  if (requested === undefined) return defaultStride;
  if (!Number.isSafeInteger(requested) || requested < defaultStride) throw new Error(`stride_bytes too small: ${requested} (need >= ${defaultStride})`);
  return requested;
}

function inputBounds(format: FramebufferFormat, options: ConvertOptions): { minimum: number; maximum: number } {
  validateDimensions(options.width, options.height);
  let rowBytes: number;
  if (format === "ssd1306") {
    const pages = Math.ceil(options.height / 8);
    const bytes = options.width * pages;
    if (!Number.isSafeInteger(bytes) || bytes > MAX_FRAMEBUFFER_INPUT_BYTES) throw new Error("framebuffer input exceeds the byte limit");
    return { minimum: bytes, maximum: MAX_FRAMEBUFFER_INPUT_BYTES };
  }
  if (format === "mono1") rowBytes = Math.ceil(options.width / 8);
  else if (format === "gray8") rowBytes = options.width;
  else if (format === "rgb565") rowBytes = options.width * 2;
  else rowBytes = options.width * 3;
  const stride = strideFor(rowBytes, options.strideBytes);
  const minimum = (options.height - 1) * stride + rowBytes;
  if (!Number.isSafeInteger(minimum) || minimum > MAX_FRAMEBUFFER_INPUT_BYTES) {
    throw new Error("framebuffer input exceeds the byte limit");
  }
  return { minimum, maximum: MAX_FRAMEBUFFER_INPUT_BYTES };
}

async function readFramebufferInput(path: string, bounds: { minimum: number; maximum: number }): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("framebuffer input must be a regular file");
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size > bounds.maximum) throw new Error(`framebuffer input exceeds the ${bounds.maximum}-byte limit`);
    const data = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(data, offset, size - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const finalMetadata = await handle.stat();
    if (offset !== size || finalMetadata.size !== metadata.size) throw new Error("framebuffer input changed while reading");
    return data;
  } finally {
    await handle.close();
  }
}

function requireBytes(data: Uint8Array, need: number): void {
  if (data.byteLength < need) throw new Error(`input too short: ${data.byteLength} bytes (need >= ${need})`);
}

function rowsGray8(data: Uint8Array, options: ConvertOptions): Uint8Array[] {
  const stride = strideFor(options.width, options.strideBytes);
  requireBytes(data, (options.height - 1) * stride + options.width);
  return Array.from({ length: options.height }, (_, y) => {
    const row = data.slice(y * stride, y * stride + options.width);
    if (options.invert) for (let index = 0; index < row.length; index += 1) row[index] ^= 0xff;
    return row;
  });
}

function rowsRgb888(data: Uint8Array, options: ConvertOptions): Uint8Array[] {
  const rowBytes = options.width * 3;
  const stride = strideFor(rowBytes, options.strideBytes);
  requireBytes(data, (options.height - 1) * stride + rowBytes);
  return Array.from({ length: options.height }, (_, y) => {
    const row = data.slice(y * stride, y * stride + rowBytes);
    if (options.invert) for (let index = 0; index < row.length; index += 1) row[index] ^= 0xff;
    return row;
  });
}

function rowsRgb565(data: Uint8Array, options: ConvertOptions): Uint8Array[] {
  const rowBytes = options.width * 2;
  const stride = strideFor(rowBytes, options.strideBytes);
  requireBytes(data, (options.height - 1) * stride + rowBytes);
  return Array.from({ length: options.height }, (_, y) => {
    const row = data.slice(y * stride, y * stride + rowBytes);
    const output = new Uint8Array(options.width * 3);
    for (let x = 0; x < options.width; x += 1) {
      const byteIndex = x * 2;
      const value = options.endian === "le"
        ? row[byteIndex]! | (row[byteIndex + 1]! << 8)
        : (row[byteIndex]! << 8) | row[byteIndex + 1]!;
      let red = Math.floor((((value >>> 11) & 0x1f) * 255 + 15) / 31);
      let green = Math.floor((((value >>> 5) & 0x3f) * 255 + 31) / 63);
      let blue = Math.floor(((value & 0x1f) * 255 + 15) / 31);
      if (options.invert) {
        red ^= 0xff;
        green ^= 0xff;
        blue ^= 0xff;
      }
      output[x * 3] = red;
      output[x * 3 + 1] = green;
      output[x * 3 + 2] = blue;
    }
    return output;
  });
}

function rowsMono1(data: Uint8Array, options: ConvertOptions): Uint8Array[] {
  const rowBytes = Math.ceil(options.width / 8);
  const stride = strideFor(rowBytes, options.strideBytes);
  requireBytes(data, (options.height - 1) * stride + rowBytes);
  return Array.from({ length: options.height }, (_, y) => {
    const input = data.slice(y * stride, y * stride + rowBytes);
    const output = new Uint8Array(options.width);
    for (let x = 0; x < options.width; x += 1) {
      const byte = input[Math.floor(x / 8)]!;
      const bit = options.bitOrder === "msb" ? (byte >>> (7 - (x % 8))) & 1 : (byte >>> (x % 8)) & 1;
      let value = bit === 1 ? 255 : 0;
      if (options.invert) value ^= 0xff;
      output[x] = value;
    }
    return output;
  });
}

function rowsSsd1306(data: Uint8Array, options: ConvertOptions): Uint8Array[] {
  const pages = Math.ceil(options.height / 8);
  requireBytes(data, options.width * pages);
  const rows = Array.from({ length: options.height }, () => new Uint8Array(options.width));
  for (let y = 0; y < options.height; y += 1) {
    const page = Math.floor(y / 8);
    const bitIndex = options.ssd1306BitOrder === "lsb" ? y % 8 : 7 - (y % 8);
    const mask = 1 << bitIndex;
    for (let x = 0; x < options.width; x += 1) {
      let value = (data[x + page * options.width]! & mask) === 0 ? 0 : 255;
      if (options.invert) value ^= 0xff;
      rows[y]![x] = value;
    }
  }
  return rows;
}

export function convertFramebuffer(data: Uint8Array, format: FramebufferFormat, options: ConvertOptions): { mode: PngMode; rows: Uint8Array[] } {
  validateDimensions(options.width, options.height);
  switch (format) {
    case "gray8": return { mode: "L", rows: rowsGray8(data, options) };
    case "rgb888": return { mode: "RGB", rows: rowsRgb888(data, options) };
    case "rgb565": return { mode: "RGB", rows: rowsRgb565(data, options) };
    case "mono1": return { mode: "L", rows: rowsMono1(data, options) };
    case "ssd1306": return { mode: "L", rows: rowsSsd1306(data, options) };
  }
}

export function expandUser(path: string): string {
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

function integerOption(value: string, option: string): number {
  if (!/^-?\d+$/.test(value)) throw new CliError(`${option} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliError(`${option} must be a safe integer`);
  return parsed;
}

export interface CliOptions {
  format: FramebufferFormat;
  width: number;
  height: number;
  input: string;
  output: string;
  strideBytes?: number;
  endian: "le" | "be";
  bitOrder: "msb" | "lsb";
  ssd1306BitOrder: "lsb" | "msb";
  invert: boolean;
}

export function parseArgs(args: string[]): CliOptions | "help" {
  let format: FramebufferFormat | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let input: string | undefined;
  let output: string | undefined;
  let strideBytes: number | undefined;
  let endian: "le" | "be" = "le";
  let bitOrder: "msb" | "lsb" = "msb";
  let ssd1306BitOrder: "lsb" | "msb" = "lsb";
  let invert = false;
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--invert") {
      invert = true;
      index += 1;
      continue;
    }
    if (["--format", "--width", "--height", "--in", "--out", "--stride-bytes", "--endian", "--bit-order", "--ssd1306-bit-order"].includes(arg)) {
      const [value, next] = optionValue(args, index, arg);
      if (arg === "--format") {
        if (!["ssd1306", "mono1", "gray8", "rgb565", "rgb888"].includes(value)) throw new CliError(`invalid --format: ${value}`);
        format = value as FramebufferFormat;
      } else if (arg === "--width") width = integerOption(value, arg);
      else if (arg === "--height") height = integerOption(value, arg);
      else if (arg === "--in") input = value;
      else if (arg === "--out") output = value;
      else if (arg === "--stride-bytes") strideBytes = integerOption(value, arg);
      else if (arg === "--endian") {
        if (value !== "le" && value !== "be") throw new CliError(`invalid --endian: ${value}`);
        endian = value;
      } else if (arg === "--bit-order") {
        if (value !== "msb" && value !== "lsb") throw new CliError(`invalid --bit-order: ${value}`);
        bitOrder = value;
      } else {
        if (value !== "lsb" && value !== "msb") throw new CliError(`invalid --ssd1306-bit-order: ${value}`);
        ssd1306BitOrder = value;
      }
      index = next;
      continue;
    }
    throw new CliError(`Unknown arg: ${arg}`);
  }
  if (format === undefined || width === undefined || height === undefined || input === undefined || output === undefined) {
    throw new CliError("--format, --width, --height, --in, and --out are required");
  }
  return { format, width, height, input, output, strideBytes, endian, bitOrder, ssd1306BitOrder, invert };
}

async function writePngAtomically(outputPath: string, data: Uint8Array): Promise<void> {
  const parent = dirname(outputPath);
  const temporaryDirectory = await mkdtemp(join(parent, ".fb-to-png-tmp-"));
  const temporaryPath = join(temporaryDirectory, basename(outputPath));
  try {
    const handle = await open(temporaryPath, "w", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, outputPath);
    try {
      const directoryHandle = await open(parent, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EBADF" && code !== "EISDIR") throw error;
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function main(args: string[] = Bun.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if (parsed === "help") {
      console.log("Convert raw embedded framebuffers to a preview PNG.\n\nUsage: fb_to_png.ts --format <format> --width <n> --height <n> --in <file> --out <file>");
      return 0;
    }
    validateDimensions(parsed.width, parsed.height);
    const options = {
      width: parsed.width,
      height: parsed.height,
      strideBytes: parsed.strideBytes,
      endian: parsed.endian,
      bitOrder: parsed.bitOrder,
      ssd1306BitOrder: parsed.ssd1306BitOrder,
      invert: parsed.invert,
    };
    const data = await readFramebufferInput(resolve(expandUser(parsed.input)), inputBounds(parsed.format, options));
    const converted = convertFramebuffer(data, parsed.format, options);
    const outputPath = resolve(expandUser(parsed.output));
    const parentStat = await lstat(dirname(outputPath));
    if (!parentStat.isDirectory()) throw new CliError("--out parent must be a directory");
    await writePngAtomically(outputPath, encodePng(parsed.width, parsed.height, converted.mode, converted.rows));
    console.log("[OK] Wrote PNG preview");
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof CliError ? error.message : "framebuffer conversion failed"}`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}

if (import.meta.main) process.exitCode = await main();
