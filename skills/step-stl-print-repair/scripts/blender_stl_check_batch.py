#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

import bpy


def blender_args():
    argv = sys.argv
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def load_print3d_analyzer():
    support = Path.home() / "Library/Application Support/Blender"
    candidates = sorted(support.glob("*/extensions/blender_org/print3d_toolbox"))
    if candidates:
        package_root = candidates[-1].parent
        if str(package_root) not in sys.path:
            sys.path.insert(0, str(package_root))
        import print3d_toolbox

        if not hasattr(bpy.types.Scene, "print3d_toolbox"):
            print3d_toolbox.register()
        from print3d_toolbox.operators import analyze

        return analyze

    try:
        import object_print3d_utils

        object_print3d_utils.register()
        from object_print3d_utils.operators import analyze

        return analyze
    except Exception as exc:
        raise RuntimeError(
            "Blender 3D Print Toolbox is required. Install/enable the official "
            "print3d_toolbox extension, or use a Blender version that provides "
            "object_print3d_utils."
        ) from exc


def check_file(analyze, path):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.ops.wm.stl_import(filepath=str(path))
    obj = bpy.context.object
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    data = []
    for cls in analyze.MESH_OT_check_all.check_cls:
        cls.main_check(obj, data)
    dims = obj.dimensions
    return {
        "file": str(path),
        "dimensions": [dims.x, dims.y, dims.z],
        "vertices": len(obj.data.vertices),
        "edges": len(obj.data.edges),
        "faces": len(obj.data.polygons),
        "checks": {item.name: item.value for item in data},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("inputs", nargs="+")
    args = parser.parse_args(blender_args())

    analyze = load_print3d_analyzer()
    results = [check_file(analyze, Path(input_path).resolve()) for input_path in args.inputs]
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, indent=2), encoding="utf-8")

    print("BATCH_CHECK_START")
    for result in results:
        checks = result["checks"]
        print(
            f"{Path(result['file']).name}\t"
            f"NM={checks.get('Non-manifold Edges')}\t"
            f"INTER={checks.get('Intersect Faces')}\t"
            f"ZERO={checks.get('Zero Faces')}\t"
            f"THIN={checks.get('Thin Faces')}\t"
            f"SHELLS={checks.get('Shells')}"
        )
    print(f"REPORT {out_path}")
    print("BATCH_CHECK_END")


if __name__ == "__main__":
    main()
