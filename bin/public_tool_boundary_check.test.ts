import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, main, publicToolFiles } from "./public_tool_boundary_check.ts";

test("rejects private runtime coupling and broken local references", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-"));
  const outsideName = `${root.split(/[\\/]/).at(-1)}-outside.ts`;
  const outsidePath = join(root, "..", outsideName);
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(outsidePath, "export const outside = 1;\n");
    writeFileSync(join(root, "bin", "safe.ts"), 'import "./present.ts";\n');
    writeFileSync(join(root, "bin", "present.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "bin", "unsafe.ts"), `const root = process.env.CODEX_HOME;\nimport "../../${outsideName}";\nimport "./missing.ts";\n`);
    expect(publicToolFiles(root).map((path) => path.split("/").at(-1))).toEqual(["present.ts", "safe.ts", "unsafe.ts"]);
    expect(check(root)).toEqual([
      "bin/unsafe.ts: forbidden public tool coupling codex-runtime-marker",
      `bin/unsafe.ts: local reference outside public repository ../../${outsideName}`,
      "bin/unsafe.ts: missing local reference ./missing.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test("does not inspect test fixtures as production tools", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-test-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "example.test.ts"), 'const value = "$CODEX_HOME";\n');
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspects the production test runner and rejects escaping tool links", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-links-"));
  const outsideName = `${root.split(/[\\/]/).at(-1)}-outside.ts`;
  const outsidePath = join(root, "..", outsideName);
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(outsidePath, "export const value = 1;\n");
    writeFileSync(join(root, "bin", "test_runner.ts"), 'const marker = "$CODEX_HOME";\n');
    symlinkSync(outsidePath, join(root, "bin", "escape.ts"));
    expect(publicToolFiles(root).map((path) => path.split("/").at(-1))).toEqual(["test_runner.ts"]);
    expect(check(root)).toEqual([
      "bin/escape.ts: symbolic link escapes public tool boundary",
      "bin/test_runner.ts: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test("rejects absolute and file URL imports outside the public repository", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-absolute-"));
  const outsidePath = join(root, "..", `${root.split(/[\\/]/).at(-1)}-outside.ts`);
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(outsidePath, "export const outside = 1;\n");
    writeFileSync(join(root, "bin", "absolute.ts"), `import "${outsidePath}";\nimport "file://${outsidePath}";\n`);
    expect(check(root)).toEqual([
      `bin/absolute.ts: local reference outside public repository ${outsidePath}`,
      `bin/absolute.ts: local reference outside public repository file://${outsidePath}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test("rejects imports with comments between the keyword and path", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-comments-"));
  const outsideName = `${root.split(/[\\/]/).at(-1)}-outside.ts`;
  const outsidePath = join(root, "..", outsideName);
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(outsidePath, "export const outside = 1;\n");
    writeFileSync(join(root, "bin", "commented.ts"), `import /* comment */ "../../${outsideName}";\n`);
    expect(check(root)).toEqual([
      `bin/commented.ts: local reference outside public repository ../../${outsideName}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test("ignores bare modules and rejects Windows-style relative imports", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-relative-"));
  const outsideName = `${root.split(/[\\/]/).at(-1)}-outside.ts`;
  const outsidePath = join(root, "..", outsideName);
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(outsidePath, "export const outside = 1;\n");
    writeFileSync(join(root, "bin", "bare.ts"), 'import "fs/promises";\n');
    writeFileSync(join(root, "bin", "windows-relative.ts"), `import "..\\\\..\\\\${outsideName}";\n`);
    writeFileSync(join(root, "bin", "escaped.ts"), `import "\\x2e\\x2e/\\x2e\\x2e/${outsideName}";\n`);
    writeFileSync(join(root, "bin", "template.ts"), "import(`../../" + outsideName + "`);\n");
    writeFileSync(join(root, "bin", "dynamic.ts"), 'const specifier = "../../' + outsideName + '"; import(specifier);\n');
    writeFileSync(join(root, "bin", "create-require.ts"), 'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("../../outside.ts");\n');
    expect(check(root)).toEqual([
      "bin/create-require.ts: dynamic import or require cannot be verified",
      "bin/dynamic.ts: dynamic import or require cannot be verified",
      `bin/escaped.ts: local reference outside public repository ../../${outsideName}`,
      `bin/template.ts: local reference outside public repository ../../${outsideName}`,
      `bin/windows-relative.ts: local reference outside public repository ..\\..\\${outsideName}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test("rejects Windows-style external imports on every host platform", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-windows-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "windows.ts"), 'import "C:\\\\Users\\\\ivan\\\\outside.ts";\nimport "\\\\server\\\\share\\\\outside.ts";\n');
    expect(check(root)).toEqual([
      "bin/windows.ts: local reference outside public repository C:\\Users\\ivan\\outside.ts",
      "bin/windows.ts: local reference outside public repository \\server\\share\\outside.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported public-tool-boundary CLI options", () => {
  expect(main(["--unknown"])).toBe(2);
});
