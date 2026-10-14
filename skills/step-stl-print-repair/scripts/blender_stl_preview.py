#!/usr/bin/env python3
import argparse
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def blender_args():
    argv = sys.argv
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def vec3(text):
    return Vector([float(part) for part in text.split(",")])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--size", type=int, default=1200)
    parser.add_argument("--target", default="")
    parser.add_argument("--camera", default="")
    parser.add_argument("--ortho-scale", type=float, default=0)
    args = parser.parse_args(blender_args())

    in_path = Path(args.input).resolve()
    out_path = Path(args.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.ops.wm.stl_import(filepath=str(in_path))
    obj = bpy.context.object

    material = bpy.data.materials.new("preview_gray")
    material.diffuse_color = (0.62, 0.66, 0.67, 1.0)
    obj.data.materials.append(material)

    bpy.context.scene.render.engine = "BLENDER_WORKBENCH"
    bpy.context.scene.display.shading.light = "STUDIO"
    bpy.context.scene.display.shading.color_type = "MATERIAL"
    bpy.context.scene.display.shading.show_object_outline = True
    bpy.context.scene.render.resolution_x = args.size
    bpy.context.scene.render.resolution_y = args.size
    bpy.context.scene.world.color = (0.92, 0.94, 0.95)

    camera_data = bpy.data.cameras.new("Camera")
    camera = bpy.data.objects.new("Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    center = sum(corners, Vector()) / 8
    extent = max((corner - center).length for corner in corners)
    target = vec3(args.target) if args.target else center
    camera.location = vec3(args.camera) if args.camera else center + Vector((75, -85, 55))
    direction = target - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = args.ortho_scale if args.ortho_scale else extent * 2.35

    bpy.context.scene.render.filepath = str(out_path)
    bpy.ops.render.render(write_still=True)
    print(f"RENDERED {out_path}")


if __name__ == "__main__":
    main()
