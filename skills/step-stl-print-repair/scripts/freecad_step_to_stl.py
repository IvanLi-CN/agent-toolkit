#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import FreeCAD
import Import
import Mesh
import MeshPart
import Part


def finite_shape(shape):
    if shape is None or shape.isNull() or len(shape.Faces) == 0:
        return False
    bbox = shape.BoundBox
    return all(0 <= dim < 10000 for dim in (bbox.XLength, bbox.YLength, bbox.ZLength))


def summarize(shape):
    bbox = shape.BoundBox
    return {
        "is_valid": bool(shape.isValid()),
        "solids": len(shape.Solids),
        "shells": len(shape.Shells),
        "faces": len(shape.Faces),
        "edges": len(shape.Edges),
        "vertices": len(shape.Vertexes),
        "dimensions": [bbox.XLength, bbox.YLength, bbox.ZLength],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("step")
    parser.add_argument("out")
    parser.add_argument("--linear", type=float, default=0.10)
    parser.add_argument("--angular", type=float, default=0.70)
    parser.add_argument("--report")
    args = parser.parse_args()

    step_path = Path(args.step).resolve()
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    doc = FreeCAD.newDocument(step_path.stem)
    Import.insert(str(step_path), doc.Name)
    doc.recompute()

    shapes = []
    objects = []
    for obj in doc.Objects:
        shape = getattr(obj, "Shape", None)
        if not finite_shape(shape):
            continue
        copied = shape.copy()
        shapes.append(copied)
        objects.append({"name": obj.Name, "label": obj.Label, "summary": summarize(copied)})

    if not shapes:
        raise RuntimeError(f"No finite face-bearing shapes found in {step_path}")

    shape = shapes[0] if len(shapes) == 1 else Part.makeCompound(shapes)
    mesh = MeshPart.meshFromShape(
        Shape=shape,
        LinearDeflection=args.linear,
        AngularDeflection=args.angular,
        Relative=False,
    )
    mesh.write(str(out_path))

    report = {
        "input": str(step_path),
        "output": str(out_path),
        "linear_deflection": args.linear,
        "angular_deflection": args.angular,
        "objects": objects,
        "compound": summarize(shape),
        "facets": mesh.CountFacets,
    }
    if args.report:
        Path(args.report).resolve().write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))

    FreeCAD.closeDocument(doc.Name)


if __name__ == "__main__":
    main()
