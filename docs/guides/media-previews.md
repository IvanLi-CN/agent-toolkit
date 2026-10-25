# 媒体与固件预览

[返回指南](README.md) · [Protected configuration](configuration.md#imagegen)

## buzzer-audio-preview

**何时使用：**从可编辑 JSON score 确认蜂鸣器旋律、节奏和时长。[Skill source](../../skills/buzzer-audio-preview/SKILL.md)与 [media contract](../../skills/buzzer-audio-preview/references/media-contract.md)定义 schema、限额与取整规则。

**平台与前置条件：**Linux/macOS、已安装 Bun，无 Python 或第三方 MIDI/audio 库。

**配置：**无服务配置；选择 score 和新的输出目录。频率、时长、waveform 等写入 score，输入遵守 canonical 数值与大小限制。

**最小例子：**直接读取随 Skill 提供的 score，在工作目录生成产物：

```bash
SKILL_DIR=/path/to/agent-toolkit/skills/buzzer-audio-preview
bun "$SKILL_DIR/scripts/buzzer_preview.ts" \
  --in "$SKILL_DIR/assets/score.example.json" --out-dir ./fresh-audio
```

**输出：**按输入 basename 命名的 `.mid` 与 `.wav`。选择该路径会生成 `score.example.mid`、`score.example.wav`。

**读写边界：**读取一个 regular UTF-8 JSON，写输出目录且替换同名产物；不播放、不访问网络、不写设备。合成 WAV 不模拟物理蜂鸣器腔体、音量或谐振，离线波形验证不代表实机听感。

## firmware-display-preview

**何时使用：**复用真实固件 renderer 与字体/位图，生成 framebuffer/PNG 检查显示布局。[Skill source](../../skills/firmware-display-preview/SKILL.md)与 [framebuffer contract](../../skills/firmware-display-preview/references/framebuffer-contract.md)定义格式、stride、bit order 和尺寸。

**平台与前置条件：**Linux/macOS 的 Bun 用于字节转换；host rendering 另需项目 C 编译器、真实 firmware headers/assets 和完成 framebuffer accessor 的 harness。仓库 C stub 不是已完成的真实渲染器。

**配置：**无服务变量；显式确认 width/height、像素格式、endian、stride/page layout、方向与渲染入口。先由授权项目生成相应 raw framebuffer。

**最小例子：**对已知 128×64 SSD1306 page-layout 输入运行离线转换：

```bash
bun /path/to/agent-toolkit/skills/firmware-display-preview/scripts/fb_to_png.ts \
  --format ssd1306 --width 128 --height 64 \
  --in /path/to/framebuffer.bin --out /path/to/fresh-output/preview.png
```

**输出：**PNG；完整 native rendering 路径还产生场景源码与 raw framebuffer。converter 保持输入方向，不自动旋转/镜像。

**读写边界：**仅转换文件，不连接设备或网络，已有 PNG 可被替换。Synthetic framebuffer 的像素正确性不能证明真实 firmware renderer 或设备一致性。向主人展示生成图片用消费者自身的 immutable artifact 机制；真实应用截图需另行确认目标程序与范围，不属于转换验证。

## cvm-imagegen

**何时使用：**主人明确需要 CLI/API fallback 生成、编辑或批量图片时使用。[Skill source](../../skills/cvm-imagegen/SKILL.md)、[CLI](../../skills/cvm-imagegen/references/cli.md)和 [API reference](../../skills/cvm-imagegen/references/image-api.md)定义 wrapper/delegation 边界。

**平台与前置条件：**Python 和已配置的 fallback Python 模块及其依赖。Fallback 由 operator 提供，本仓库不提供第二个完整 image API client；系统 Python 本身不能替代模块。平台能力随该外部模块而定。

**配置：**`AGENT_IMAGEGEN_SYSTEM_PATH` 明确指定受信任 fallback 模块；在线额外要求 `CVM_BASE_URL`、`CVM_API_KEY`，按 [imagegen 配置](configuration.md#imagegen)保护。模块导入会执行 Python 代码，不能把未知文件当无副作用配置。

**最小例子：**已有可信 fallback 时以 dry-run 检查请求，无 endpoint/key 要求且不发网络请求：

```bash
AGENT_IMAGEGEN_SYSTEM_PATH=/path/to/trusted/image_gen.py \
  python3 /path/to/agent-toolkit/skills/cvm-imagegen/scripts/image_gen.py generate \
  --prompt 'A small mountain cabin' --out /path/to/fresh-output/cabin.png --dry-run
```

**输出：**dry-run 请求信息，或在真实调用成功后写入图片/批量结果；dry-run 不生成图片。后端拒绝是后端错误，不能声称本地验证证明后端接受。

**读写边界：**live 会上传 prompt/reference images，访问 endpoint 并可能计费，必须得到主人对目标、上传与生成的授权。编辑输出和覆盖遵循 fallback 的明确 force 保护；凭据不进入命令历史/日志。Fixture fallback 只证明 wrapper/module contract，不证明真实 endpoint；不新增代理、常驻服务或私有 runtime 集成。
