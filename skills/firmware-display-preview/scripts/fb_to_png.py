#!/usr/bin/env python3
"""
Convert raw embedded framebuffers to a preview PNG without external dependencies.

Supported formats:
- ssd1306  : 1bpp, page layout (width * ceil(height/8) bytes), bit-order selectable
- mono1    : 1bpp, row-major packed bits, stride selectable, bit-order selectable
- gray8    : 8bpp grayscale, row-major, stride selectable
- rgb565   : 16bpp RGB565, row-major, stride selectable, endianness selectable
- rgb888   : 24bpp RGB888, row-major, stride selectable
"""

from __future__ import annotations

import argparse
import struct
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


def _crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", _crc32(kind + data))


def write_png(*, out_path: Path, width: int, height: int, mode: Literal["L", "RGB"], rows: list[bytes]) -> None:
    if mode == "L":
        color_type = 0  # grayscale
        channels = 1
    else:
        color_type = 2  # truecolor
        channels = 3

    if len(rows) != height:
        raise ValueError(f"expected {height} rows, got {len(rows)}")
    for y, row in enumerate(rows):
        if len(row) != width * channels:
            raise ValueError(f"row {y} has {len(row)} bytes, expected {width * channels}")

    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0
        raw.extend(row)

    png = bytearray()
    png.extend(b"\x89PNG\r\n\x1a\n")

    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    png.extend(_png_chunk(b"IHDR", ihdr))

    compressed = zlib.compress(bytes(raw), level=9)
    png.extend(_png_chunk(b"IDAT", compressed))
    png.extend(_png_chunk(b"IEND", b""))

    out_path.write_bytes(bytes(png))


@dataclass(frozen=True)
class ConvertOpts:
    width: int
    height: int
    stride_bytes: int | None
    endian: Literal["le", "be"]
    bit_order: Literal["msb", "lsb"]
    ssd1306_bit_order: Literal["lsb", "msb"]
    invert: bool


def _get_stride(default_stride: int, stride_bytes: int | None) -> int:
    if stride_bytes is None:
        return default_stride
    if stride_bytes < default_stride:
        raise ValueError(f"stride_bytes too small: {stride_bytes} (need >= {default_stride})")
    return stride_bytes


def _rows_gray8(data: bytes, opts: ConvertOpts) -> list[bytes]:
    stride = _get_stride(opts.width, opts.stride_bytes)
    need = (opts.height - 1) * stride + opts.width
    if len(data) < need:
        raise ValueError(f"input too short: {len(data)} bytes (need >= {need})")
    rows = []
    for y in range(opts.height):
        row = bytearray(data[y * stride : y * stride + opts.width])
        if opts.invert:
            for i in range(len(row)):
                row[i] ^= 0xFF
        rows.append(bytes(row))
    return rows


def _rows_rgb888(data: bytes, opts: ConvertOpts) -> list[bytes]:
    row_bytes = opts.width * 3
    stride = _get_stride(row_bytes, opts.stride_bytes)
    need = (opts.height - 1) * stride + row_bytes
    if len(data) < need:
        raise ValueError(f"input too short: {len(data)} bytes (need >= {need})")
    rows = []
    for y in range(opts.height):
        row = bytes(data[y * stride : y * stride + row_bytes])
        if opts.invert:
            row = bytes((b ^ 0xFF) for b in row)
        rows.append(row)
    return rows


def _rows_rgb565(data: bytes, opts: ConvertOpts) -> list[bytes]:
    row_bytes = opts.width * 2
    stride = _get_stride(row_bytes, opts.stride_bytes)
    need = (opts.height - 1) * stride + row_bytes
    if len(data) < need:
        raise ValueError(f"input too short: {len(data)} bytes (need >= {need})")

    byteorder = "little" if opts.endian == "le" else "big"
    rows: list[bytes] = []
    for y in range(opts.height):
        row_in = data[y * stride : y * stride + row_bytes]
        row_out = bytearray(opts.width * 3)
        for x in range(opts.width):
            px = row_in[x * 2 : x * 2 + 2]
            v = int.from_bytes(px, byteorder=byteorder, signed=False)
            r5 = (v >> 11) & 0x1F
            g6 = (v >> 5) & 0x3F
            b5 = v & 0x1F
            r8 = (r5 * 255 + 15) // 31
            g8 = (g6 * 255 + 31) // 63
            b8 = (b5 * 255 + 15) // 31
            if opts.invert:
                r8 ^= 0xFF
                g8 ^= 0xFF
                b8 ^= 0xFF
            base = x * 3
            row_out[base + 0] = r8
            row_out[base + 1] = g8
            row_out[base + 2] = b8
        rows.append(bytes(row_out))
    return rows


def _rows_mono1(data: bytes, opts: ConvertOpts) -> list[bytes]:
    row_bytes = (opts.width + 7) // 8
    stride = _get_stride(row_bytes, opts.stride_bytes)
    need = (opts.height - 1) * stride + row_bytes
    if len(data) < need:
        raise ValueError(f"input too short: {len(data)} bytes (need >= {need})")

    rows: list[bytes] = []
    for y in range(opts.height):
        row_in = data[y * stride : y * stride + row_bytes]
        row_out = bytearray(opts.width)
        for x in range(opts.width):
            b = row_in[x // 8]
            bit = (b >> (7 - (x % 8))) & 1 if opts.bit_order == "msb" else (b >> (x % 8)) & 1
            v = 255 if bit else 0
            if opts.invert:
                v ^= 0xFF
            row_out[x] = v
        rows.append(bytes(row_out))
    return rows


def _rows_ssd1306(data: bytes, opts: ConvertOpts) -> list[bytes]:
    pages = (opts.height + 7) // 8
    need = opts.width * pages
    if len(data) < need:
        raise ValueError(f"input too short: {len(data)} bytes (need >= {need})")

    rows: list[bytearray] = [bytearray(opts.width) for _ in range(opts.height)]
    for y in range(opts.height):
        page = y // 8
        bit_index = y % 8 if opts.ssd1306_bit_order == "lsb" else 7 - (y % 8)
        mask = 1 << bit_index
        for x in range(opts.width):
            byte = data[x + page * opts.width]
            bit = 1 if (byte & mask) else 0
            v = 255 if bit else 0
            if opts.invert:
                v ^= 0xFF
            rows[y][x] = v
    return [bytes(r) for r in rows]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Convert raw embedded framebuffers to PNG.")
    ap.add_argument("--format", required=True, choices=["ssd1306", "mono1", "gray8", "rgb565", "rgb888"])
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--in", dest="in_path", required=True, help="Input raw framebuffer file")
    ap.add_argument("--out", dest="out_path", required=True, help="Output PNG path")

    ap.add_argument("--stride-bytes", type=int, default=None, help="Bytes per row (optional, for padded row-major formats)")
    ap.add_argument("--endian", choices=["le", "be"], default="le", help="For rgb565 only (default: le)")
    ap.add_argument("--bit-order", choices=["msb", "lsb"], default="msb", help="For mono1 row-major (default: msb)")
    ap.add_argument("--ssd1306-bit-order", choices=["lsb", "msb"], default="lsb", help="For ssd1306 page layout (default: lsb)")
    ap.add_argument("--invert", action="store_true", help="Invert colors (useful for some displays)")
    args = ap.parse_args(argv)

    if args.width <= 0 or args.height <= 0:
        raise SystemExit("width/height must be > 0")

    opts = ConvertOpts(
        width=args.width,
        height=args.height,
        stride_bytes=args.stride_bytes,
        endian=args.endian,
        bit_order=args.bit_order,
        ssd1306_bit_order=args.ssd1306_bit_order,
        invert=bool(args.invert),
    )

    data = Path(args.in_path).expanduser().read_bytes()

    fmt = args.format
    if fmt == "gray8":
        rows = _rows_gray8(data, opts)
        mode = "L"
    elif fmt == "rgb888":
        rows = _rows_rgb888(data, opts)
        mode = "RGB"
    elif fmt == "rgb565":
        rows = _rows_rgb565(data, opts)
        mode = "RGB"
    elif fmt == "mono1":
        rows = _rows_mono1(data, opts)
        mode = "L"
    elif fmt == "ssd1306":
        rows = _rows_ssd1306(data, opts)
        mode = "L"
    else:
        raise AssertionError("unreachable")

    out_path = Path(args.out_path).expanduser()
    write_png(out_path=out_path, width=opts.width, height=opts.height, mode=mode, rows=rows)
    print(f"[OK] Wrote: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
