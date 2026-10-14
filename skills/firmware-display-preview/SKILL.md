---
name: firmware-display-preview
description: "Render firmware-driven displays to preview PNGs."
---

# Firmware Display Preview

## Overview

在主机侧复用固件的“画屏幕”代码（含字体/位图资产），生成与设备 **1:1 一致** 的预览图：
- 产物 1：可二次修改的“场景/渲染入口”源码文件（例如 `scene.c` / `render_preview.rs`）
- 产物 2：固件真实 framebuffer dump（例如 `framebuffer.bin`）
- 产物 3：便于快速预览的 `preview.png`

## Hard requirements（确保一致）

- 不要在 Python 里“重写一套渲染器”（尤其是字体光栅化、字距/换行、位图解码、透明/裁剪规则）；必须复用固件实现与资产。
- 使用与设备一致的：`width/height`、像素格式、内存布局（stride / page layout / endian）、旋转/镜像、坐标系原点与方向。

## Workflow（推荐）

### 1) 收集最小参数（先问清楚再动手）

- 显示尺寸：`width` / `height`
- 像素格式（至少一个）：`ssd1306`（1bpp page），`mono1`（1bpp 行优先），`gray8`，`rgb565`，`rgb888`
- endianness（RGB565 常见）：`le` / `be`
- stride / padding（如每行有 padding）
- 固件渲染入口：哪个函数“画完整屏幕 UI”
- 字体/位图资产位置：是否是 C 数组/资源表/自定义格式

### 2) 建 host-side render harness（复用固件渲染代码）

- 在项目里新建一个“小工具”目标（例如 `tools/display_preview/` 或 `host-tools/display_preview/`）：
  - 把“要画什么”的调用集中在一个独立文件（例如 `scene.c`），方便 Agent 二次修改。
  - 在 `main()` 里调用固件渲染入口，拿到 framebuffer 并 dump 到文件（例如 `framebuffer.bin`）。
- 若固件本来就有 framebuffer（RAM 里一块 buffer）：直接 dump 那块内存即可。
- 若固件是“直接写硬件”（immediate mode）：实现一个 mock/display backend，把底层 `drawPixel`/`setWindow+writePixels` 之类的调用转换成 host-side framebuffer。

可选：用本 skill 自带的 C stub 快速起步（需要按你的项目改 TODO）：

```bash
mkdir -p tools/display_preview
SKILL_DIR=/path/to/agent-toolkit/skills/firmware-display-preview
cp "$SKILL_DIR/assets/host_c/scene.c" tools/display_preview/scene.c
cp "$SKILL_DIR/assets/host_c/preview_main.c" tools/display_preview/main.c
```

### 3) 转成 `preview.png`

使用 `scripts/fb_to_png.py` 把 raw framebuffer 转 PNG：

#### SSD1306（1bpp，page layout）

```bash
python3 "$SKILL_DIR/scripts/fb_to_png.py" \
  --format ssd1306 \
  --width 128 \
  --height 64 \
  --in framebuffer.bin \
  --out preview.png
```

#### RGB565（16bpp，行优先）

```bash
python3 "$SKILL_DIR/scripts/fb_to_png.py" \
  --format rgb565 \
  --endian le \
  --width 240 \
  --height 240 \
  --in framebuffer.bin \
  --out preview.png
```

## Debug checklist（不一致就按这个查）

- 画面整体旋转/镜像：优先核对固件的坐标系与旋转配置（而不是在 PNG 转换阶段“强行旋转”掩盖问题）。
- 竖条/错行：`stride_bytes` 错了，或者你 dump 的 buffer 含 padding。
- 单色屏花屏（SSD1306 常见）：page layout / bit order 搞反了（用 `--ssd1306-bit-order` 试）。
- 颜色不对（RGB565）：endianness 搞反了（`--endian le/be`）。

## Output handling

- `preview.png` is a working artifact. Consumers that display local images should use their own immutable-artifact or attachment mechanism before presenting it to an owner.
- Keep the project output path separate from any consumer-specific presentation or chat attachment path.
