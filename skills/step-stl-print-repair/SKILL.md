---
name: step-stl-print-repair
description: "Repair and regenerate print-ready STL files from STEP/CAD sources, with FreeCAD/Gmsh tessellation sweeps, Blender 3D Print Toolbox validation, visual inspection, and explicit handling of smooth fillet/rounded-surface artifacts."
---

# STEP/STL Print Repair

Use this skill when the user provides STEP/STL files for 3D printing, asks to repair STL service errors, regenerate STL from STEP, improve mesh precision, or fix visible artifacts around fillets/rounded openings.

## Runtime and output boundary

All five domain scripts retain Python because they call FreeCAD/Blender application APIs or the official Gmsh binding directly. Run them in the matching application Python environment on a supported Linux/macOS installation; Bun is not a production prerequisite and no TS launcher is added. FreeCAD needs `FreeCAD`, `Import`, `Part`, `Mesh` and `MeshPart`; Gmsh needs its Python `gmsh` module/native library; Blender needs its bundled `bpy`/`mathutils`, with the 3D Print Toolbox extension for batch checks. A system Python installation alone does not provide these interfaces. See the application invocation notes below.

For the smallest meshing example, configure `CAD_PYTHON` as a Python executable with the Gmsh binding, then run `"$CAD_PYTHON" scripts/gmsh_step_to_stl.py model.step out/model.stl --mesh-size 0.25 --report out/report.json` from this Skill. The scripts read selected geometry and write STL, JSON or rendered image outputs; matching outputs may be replaced, so use a fresh output directory. They do not modify source CAD or upload models. Blender scripts reset the in-memory scene: launch the documented background/factory-startup process, not an unsaved interactive project. Native applications, plugins and rendering are explicit prerequisites, not automatically installed dependencies.

The helper source smoke under `../git-remote-troubleshoot/tests/helper_sources.test.ts` checks source links and retained binding imports only. It does not execute CAD or establish geometry/rendering correctness; application-level evidence is unavailable when those environments are absent.

## Core Lessons

- Prefer the original STEP/CAD source over repairing a bad STL.
- Automated mesh checks are necessary but not sufficient. A file can pass checks and still be visibly wrong.
- Never trust global remesh/MeshFix as a final answer without visual comparison. It can pass topology checks while damaging openings, slots, and thin details.
- Do not assume "finer is cleaner." Smaller tessellation parameters can introduce zero-area faces, intersections, or thin faces.
- STL cannot preserve mathematical curve continuity or smooth normals. If a previewer flat-shades triangles, some faceting may remain even with valid dense meshes.
- For true CAD surface continuity, prefer uploading STEP when the print vendor accepts it, or fix the source CAD fillet/tangent continuity.

## Default Workflow

1. **Confirm source freshness**
   - Check source paths, modification times, and existing output times.
   - Use exact files from the current user request; do not mix old similarly named models.

2. **Inspect STEP geometry**
   - Import STEP with FreeCAD.
   - Record validity, solid/shell counts, face/edge/vertex counts, and dimensions.
   - If STEP is invalid, report that the source CAD needs repair before STL work.

3. **Generate candidate STL meshes**
   - First try FreeCAD/OpenCascade tessellation for small/simple parts:
     - Linear deflection should usually be below the print tolerance.
     - Sweep a few linear/angular combinations instead of betting on one value.
   - For rounded slots, fillets, or visibly discontinuous surfaces, try Gmsh directly from STEP:
     - Gmsh often avoids FreeCAD tessellation slivers and local face deletion.
     - Use binary STL conversion to keep large Gmsh outputs manageable.

4. **Validate every candidate**
   - Use Blender 3D Print Toolbox batch checks.
   - Treat these as hard failures unless there is a documented reason:
     - Non-manifold edges
     - Intersect faces
     - Zero faces / zero edges
     - Thin faces
     - Multiple shells when one body is expected
   - `Overhang Faces` is not a mesh-validity failure; it is a print-orientation/support signal.

5. **Repair conservatively**
   - If FreeCAD output has a few obvious non-manifold sliver triangles:
     - Prefer local deletion of only the non-manifold sliver faces.
     - Recheck immediately.
     - Visually compare against the raw STEP-derived mesh.
   - Avoid MeshFix/global remesh unless the user accepts geometry reconstruction risk.
   - If local deletion causes visible discontinuity, reject that candidate and switch tessellation strategy.

6. **Visual inspection is mandatory for user-facing geometry**
   - Render or inspect the target feature, especially user-marked regions.
   - Compare raw candidate, repaired candidate, and alternate mesher candidate.
   - Reject candidates that are topologically valid but visibly damage or distort the design.

7. **Choose the final**
   - Pick the finest candidate that is both:
     - topologically clean, and
     - visually acceptable in the relevant region.
   - If a finer candidate fails checks, record that and use the next clean candidate.

8. **Deliver with proof**
   - Final output path(s).
   - Source STEP path(s) and modification time if relevant.
   - Mesher and parameters.
   - Whether any local repair was applied.
   - Blender check summary and machine-readable report path.
   - Dimensions, vertex count, face count, shell count.

## Tool Preference

Use bundled scripts when available:

- `scripts/freecad_step_to_stl.py`: STEP -> STL with FreeCAD tessellation.
- `scripts/gmsh_step_to_stl.py`: STEP -> STL with Gmsh surface mesh.
- `scripts/blender_stl_to_binary.py`: ASCII STL -> compact binary STL.
- `scripts/blender_stl_check_batch.py`: Blender 3D Print Toolbox validation report.
- `scripts/blender_stl_preview.py`: quick rendered preview for visual comparison.

Environment notes:

- FreeCAD scripts may need `PYTHONPATH=/Applications/FreeCAD.app/Contents/Resources/lib /Applications/FreeCAD.app/Contents/Resources/bin/python ...` on macOS.
- Gmsh scripts require a Python environment with the `gmsh` module, or use a project venv that already has it installed.
- Blender validation requires the official **3D Print Toolbox** add-on/extension to be installed or enabled. In Blender 5.x this is typically the `print3d_toolbox` extension; older Blender installs may expose `object_print3d_utils`. Do not assume a plain Blender install is enough.
- Blender scripts should be run through Blender, e.g. `blender --background --factory-startup --python <script> -- <args>`.

Do not depend on only one tool. FreeCAD, Gmsh, Blender, and the print vendor's preview can disagree; use the disagreement to identify whether the issue is topology, tessellation, shading, or source CAD continuity.

## Parameter Heuristics

- Start with print-tolerance-aware values, then sweep:
  - FreeCAD linear deflection: `0.08-0.15 mm` for small enclosure parts.
  - FreeCAD angular deflection: `0.50-0.70 rad`; smaller angles may improve curves but can introduce bad faces.
  - Gmsh mesh size: `0.40 -> 0.25 -> 0.15 -> 0.12 mm` for rounded enclosure features.
- Stop tightening when checks start failing or file size becomes impractical.
- If `0.10 mm` or finer creates zero/intersect faces, do not use it just because it looks smoother.

## Decision Rules From Experience

- **Clean but visibly wrong**: reject. Automated checks are not enough.
- **FreeCAD local sliver deletion breaks smoothness**: switch to Gmsh from STEP; do not keep deleting/patching.
- **Gmsh is clean but preview still shows triangle facets**: try a smaller mesh size, then explain STL limitations.
- **Very smooth preview required**: recommend STEP upload if accepted, or source CAD cleanup for tangent-continuous fillets.
- **Print service reports errors but Blender is clean**: still inspect visually and, if possible, test an alternate mesher. Services may run their own repair pipeline.

## Final Response Contract

Keep the final response short and concrete:

- Say whether the final STL was regenerated or repaired.
- Link the final file(s).
- Include a compact validation table.
- State the selected mesher and parameters.
- State any rejected option only if it explains a tradeoff, e.g. "`0.10 mm` was rejected because it produced zero-area faces."

Example validation table:

| File | Non-manifold | Intersections | Zero faces | Thin faces | Shells |
| --- | ---: | ---: | ---: | ---: | ---: |
| model.stl | 0 | 0 | 0 | 0 | 1 |
