/** Consumer source-link smoke, not a production launcher or remote connectivity test. */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const skills = new URL("../../", import.meta.url).pathname;
test("VER-FOUNDATION-HELPERS-06: entrypoints work through consumer directory links from another cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "helper-source-link-"));
  try {
    for (const name of ["buzzer-audio-preview", "firmware-display-preview", "dst-dedicated-server", "git-sync", "git-remote-troubleshoot", "step-stl-print-repair"]) {
      symlinkSync(join(skills, name), join(root, name), "dir");
      expect(readFileSync(join(root, name, "SKILL.md"), "utf8")).toContain(`name: ${name}`);
    }
    const run = (name: string, script: string, args: string[]) => Bun.spawnSync([process.execPath, join(root, name, "scripts", script), ...args], { cwd: root, env: { ...process.env, DST_HOST: "", DST_USER: "", DST_CLUSTER: "", DST_LOCAL_DIR: "" } });
    const buzzer = run("buzzer-audio-preview", "buzzer_preview.ts", ["--in", join(root, "buzzer-audio-preview/assets/score.example.json"), "--out-dir", join(root, "audio")]);
    expect(buzzer.exitCode).toBe(0);
    expect(readFileSync(join(root, "audio/score.example.mid")).subarray(0, 4).toString()).toBe("MThd");
    expect(readFileSync(join(root, "audio/score.example.wav")).subarray(0, 4).toString()).toBe("RIFF");
    writeFileSync(join(root, "framebuffer.bin"), Buffer.from([0, 255]));
    const framebuffer = run("firmware-display-preview", "fb_to_png.ts", ["--format", "gray8", "--width", "2", "--height", "1", "--in", "framebuffer.bin", "--out", "preview.png"]);
    expect(framebuffer.exitCode).toBe(0); expect(readFileSync(join(root, "preview.png")).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const snapshot = run("dst-dedicated-server", "dst_snapshot.ts", ["--no-local", "--no-remote", "--out", "snapshot.md"]);
    expect(snapshot.exitCode).toBe(0); expect(readFileSync(join(root, "snapshot.md"), "utf8")).toContain("# DST snapshot");
    mkdirSync(join(root, "cluster/Master"), { recursive: true }); writeFileSync(join(root, "cluster/Master/modoverrides.lua"), 'return {["workshop-1"]={enabled=true}}');
    const mods = run("dst-dedicated-server", "dst_mods_from_modoverrides.ts", ["--cluster-dir", "cluster"]);
    expect(mods.exitCode).toBe(0); expect(mods.stdout.toString()).toContain("enabled_ids: 1");
    for (const [name, script] of [["buzzer-audio-preview", "buzzer_preview.ts"], ["firmware-display-preview", "fb_to_png.ts"], ["dst-dedicated-server", "dst_snapshot.ts"], ["dst-dedicated-server", "dst_mods_from_modoverrides.ts"]]) {
      const help = run(name, script, ["--help"]); expect(help.exitCode).toBe(0); expect(help.stdout.toString()).toContain("Usage:");
      const bad = run(name, script, ["--unsupported"]); expect(bad.exitCode).toBe(2); expect(bad.stderr.toString()).toContain("error:");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("replaced local implementations are retired; native and text-only boundaries remain", () => {
  for (const name of ["buzzer-audio-preview", "firmware-display-preview", "dst-dedicated-server", "git-sync"]) {
    const scripts = join(skills, name, "scripts");
    const files = existsSync(scripts) ? readdirSync(scripts) : [];
    expect(files.some(file => file.endsWith(".py"))).toBe(false);
    expect(files.filter(file => file.endsWith(".sh"))).toEqual(name === "dst-dedicated-server" ? ["dst_collect_remote.sh"] : []);
  }
  expect(existsSync(join(skills, "git-remote-troubleshoot/scripts"))).toBe(false);
  const bindings: Record<string, string[]> = {
    "freecad_step_to_stl.py": ["import FreeCAD", "import MeshPart", "import Part"],
    "gmsh_step_to_stl.py": ["import gmsh"],
    "blender_stl_to_binary.py": ["import bpy"],
    "blender_stl_check_batch.py": ["import bpy", "print3d_toolbox"],
    "blender_stl_preview.py": ["import bpy", "from mathutils import Vector"],
  };
  expect(readdirSync(join(skills, "step-stl-print-repair/scripts")).sort()).toEqual(Object.keys(bindings).sort());
  for (const [file, imports] of Object.entries(bindings)) for (const dependency of imports) expect(readFileSync(join(skills, "step-stl-print-repair/scripts", file), "utf8")).toContain(dependency);
  expect(readFileSync(join(skills, "firmware-display-preview/assets/host_c/scene.c"), "utf8")).toContain("void render_scene(void)");
});
