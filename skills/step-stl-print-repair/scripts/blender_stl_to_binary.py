#!/usr/bin/env python3
import argparse
import sys
from pathlib import Path

import bpy


def blender_args():
    argv = sys.argv
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args(blender_args())

    in_path = Path(args.input).resolve()
    out_path = Path(args.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.ops.wm.stl_import(filepath=str(in_path))
    obj = bpy.context.object
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.wm.stl_export(filepath=str(out_path), export_selected_objects=True, ascii_format=False)
    print(f"WROTE {out_path}")


if __name__ == "__main__":
    main()
