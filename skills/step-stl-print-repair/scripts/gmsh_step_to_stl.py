#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import gmsh


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("step")
    parser.add_argument("out")
    parser.add_argument("--mesh-size", type=float, default=0.25)
    parser.add_argument("--curvature", type=float, default=30)
    parser.add_argument("--report")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    step_path = Path(args.step).resolve()
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 1 if args.verbose else 0)
    gmsh.option.setNumber("Mesh.CharacteristicLengthMin", args.mesh_size)
    gmsh.option.setNumber("Mesh.CharacteristicLengthMax", args.mesh_size)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", args.curvature)
    gmsh.option.setNumber("Mesh.StlOneSolidPerSurface", 0)
    gmsh.model.add(step_path.stem)
    gmsh.model.occ.importShapes(str(step_path))
    gmsh.model.occ.synchronize()
    gmsh.model.mesh.generate(2)
    gmsh.write(str(out_path))

    node_tags = gmsh.model.mesh.getNodes()[0]
    element_nodes = gmsh.model.mesh.getElements(2)[2]
    triangles = sum(len(nodes) // 3 for nodes in element_nodes)
    report = {
        "input": str(step_path),
        "output": str(out_path),
        "mesh_size": args.mesh_size,
        "curvature": args.curvature,
        "nodes": len(node_tags),
        "triangles": triangles,
    }
    gmsh.finalize()

    if args.report:
        Path(args.report).resolve().write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
