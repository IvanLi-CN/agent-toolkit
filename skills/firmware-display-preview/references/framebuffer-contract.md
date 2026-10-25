# Framebuffer conversion contract

Run `bun scripts/fb_to_png.ts --format FORMAT --width W --height H --in framebuffer.bin --out preview.png` from this Skill, or pass the absolute source entrypoint from any working directory. `--help` prints all switches. Invalid input exits 2 with `error:` on stderr before a PNG write. The output parent directory must already exist. Width and height are positive safe integers with at most 50000000 pixels. Extra trailing input bytes are ignored; short input fails. Allocation limits and invalid enum values fail with a diagnostic.

| Format | Input layout | Output |
| --- | --- | --- |
| `ssd1306` | Page-major: `x + floor(y/8)*width`, requiring `width*ceil(height/8)` bytes. Vertical bit `y%8` by default; `--ssd1306-bit-order msb` uses `7-y%8`. | 8-bit grayscale, unset/set = 0/255. |
| `mono1` | Packed row-major, `ceil(width/8)` bytes per row. Default horizontal bit `7-x%8`; `--bit-order lsb` uses `x%8`. | 8-bit grayscale, unset/set = 0/255. |
| `gray8` | One byte per pixel, row-major. | 8-bit grayscale. |
| `rgb565` | Two bytes per pixel, default `--endian le`; `be` selects big endian. Bits 15..11 red, 10..5 green, 4..0 blue. | RGB888 rounded as `(r5*255+15)//31`, `(g6*255+31)//63`, `(b5*255+15)//31`. |
| `rgb888` | Three bytes R,G,B per pixel, row-major. | RGB888. |

`--stride-bytes N` is the byte distance between row starts for row-major formats; it must be a safe integer at least the packed row size. Only the last row's pixels are required, not its final padding. SSD1306 is page-major and ignores row stride. `--invert` XORs every output channel with 255. Rows remain top-to-bottom and columns left-to-right with no transformations; firmware coordinate/rotation choices belong in the C renderer. PNG uses standard signature, one IHDR, one zlib-compressed IDAT, IEND, CRC32, 8-bit depth and filter 0 for every row. It does not add alpha, palette or interlace.

Run `bun test ./tests/fb_to_png.test.ts` from this Skill. Tiny fixtures cover all five formats, both bit orders, both RGB565 endiannesses, padding, partial pages/bytes, inversion, errors, independently checked PNG chunks/CRCs and inflated pixels. A native `cc` smoke compiles the unchanged C harness and verifies its explicit unimplemented-accessor exit 2. This proves native resource retention and the stub boundary; it does not claim a physical display or real firmware render has been observed.
