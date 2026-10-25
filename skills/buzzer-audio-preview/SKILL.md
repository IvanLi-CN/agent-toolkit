---
name: buzzer-audio-preview
description: "Preview buzzer tones as MIDI and WAV."
---

# Buzzer Audio Preview

## Prerequisites and boundary

Use installed Bun on Linux or macOS; no Python or third-party MIDI/audio library is required. The helper reads one regular UTF-8 JSON score no larger than 1,048,576 bytes and accepts at most 65,536 events, including zero-duration events. These limits are checked before JSON parsing or event mapping/encoding. It writes `.mid`/`.wav` files in the selected output directory, performs no playback, network access or device writes, and replaces existing matching output files; choose a fresh output directory when keeping prior previews.

## Overview

把“蜂鸣器音效/旋律”从一个可编辑的 `score.json` 生成两份输出：
- `*.mid`：便于 DAW / MIDI 工具里查看与继续编辑
- `*.wav`：便于直接试听预览（默认方波，贴近常见 PWM 驱动的无源蜂鸣器）

## Quick start

1) 复制示例输入：

```bash
SKILL_DIR=/path/to/agent-toolkit/skills/buzzer-audio-preview
cp "$SKILL_DIR/assets/score.example.json" ./score.json
```

2) 生成 `MIDI + WAV`：

```bash
bun "$SKILL_DIR/scripts/buzzer_preview.ts" \
  --in ./score.json \
  --out-dir ./out
```

输出示例：
- `out/score.mid`
- `out/score.wav`

## `score.json` format

只保留最常用字段；其它字段可留空用默认值。

- 顶层参数（可选）
  - `tempo_bpm`：默认 `120`
  - `ppqn`：MIDI 分辨率（ticks/quarter），默认 `480`
  - `sample_rate_hz`：WAV 采样率，默认 `44100`
  - `waveform`：`"square"`(默认) / `"sine"`
  - `volume`：`0.0..1.0`，默认 `0.7`
  - `fade_ms`：每个音的淡入淡出（减少 click），默认 `2`

- `events`：事件数组（按顺序播放）
  - 音符：`{ "note": "C5", "beats": 0.5 }` 或 `{ "note": 72, "ms": 200 }`
  - 休止：`{ "rest_beats": 0.25 }` 或 `{ "rest_ms": 100 }`
  - 频率（WAV 预览用）：`{ "freq_hz": 1000, "ms": 150 }`
    - 生成 MIDI 时会近似到最接近的音高（不做 pitch bend）

## Notes / guardrails

- WAV 是“电子合成预览”，不模拟蜂鸣器腔体/谐振/音量曲线；用来确认旋律、节奏、时长是否符合预期。
- 若你要“跟固件的毫秒级时序一致”，优先用 `ms/rest_ms` 描述事件（而不是 `beats`）。

The supported score schema, numeric limits, rounding and behavior-test command are in [the media contract](references/media-contract.md). Run the helper from a checkout or a directory symlink; no repository installation step is required for generation.
