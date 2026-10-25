# CAD 网格与打印检查

[返回指南](README.md) · [Validation](../../README.md#validation)

## step-stl-print-repair

**何时使用：**从用户给定 STEP/STL 重新生成或修复可打印网格，尤其是 fillet、圆角槽、薄壁与可见表面问题。[Skill source](../../skills/step-stl-print-repair/SKILL.md)定义候选生成、拓扑检查、视觉比较与最终交付；优先原始 CAD，不用全局 remesh 掩盖细节损失。

**平台与前置条件：**支持的 Linux/macOS 应用环境。五个脚本直接使用 FreeCAD/Blender/Gmsh Python API，Bun 不是 production prerequisite。FreeCAD 需要 `FreeCAD`、`Import`、`Part`、`Mesh`、`MeshPart`；Gmsh 需要 `gmsh` binding/native library；Blender 使用内置 `bpy`/`mathutils`，批量打印检查另需 3D Print Toolbox 扩展。普通系统 Python 或源码 import smoke 不等于具备这些应用。

**配置：**明确当前输入文件、尺寸/单位、打印公差、新输出目录；`CAD_PYTHON` 是此示例选定的、已可加载 Gmsh 的 Python executable，不是仓库安装器。FreeCAD 的 library/Python 路径与 Blender executable 由 operator 的真实安装提供，参考 canonical invocation notes，不猜个人路径或自动安装插件。

**最小例子：**确认 Gmsh 环境和本地几何处理授权后执行：

```bash
CAD_PYTHON=/path/to/gmsh-python
"$CAD_PYTHON" /path/to/agent-toolkit/skills/step-stl-print-repair/scripts/gmsh_step_to_stl.py \
  /path/to/model.step /path/to/fresh-output/model.stl \
  --mesh-size 0.25 --report /path/to/fresh-output/report.json
```

后续使用 canonical Blender batch checker 与 preview scripts，必须经 `blender --background --factory-startup --python ... -- ...` 独立进程运行，避免重置用户未保存的交互场景。命令参数以对应 [script source](../../skills/step-stl-print-repair/scripts/blender_stl_check_batch.py)为准。

**输出：**候选 STL、JSON 报告、预览图，以及 mesher/参数、尺寸、vertex/face/shell counts。最小 meshing 命令只产生候选，不足以宣告 print-ready；仍需拓扑检查、目标区域视觉比较与拒绝失败候选。

**读写边界：**脚本读取选定 CAD，写 STL/JSON/图像，已有 matching outputs 可被替换；源 CAD 不修改，不自动上传模型、打印或购买。Native headless render 是生成图，不是实际应用截图；真实 GUI 截图另需目标与范围确认。缺少应用或插件时明确报告 not_run，不能用 root checks 或 binding 源码检查替代几何正确性，也不能把合成预览当 vendor 接受或实物打印结果。
