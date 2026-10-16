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
    writeFileSync(join(root, "bin", "create-require-alias.ts"), 'import { createRequire as makeRequire } from "node:module"; const load = makeRequire(import.meta.url); load("../../outside.ts");\n');
    writeFileSync(join(root, "bin", "create-require-module.ts"), 'import { createRequire as makeRequire } from "module"; const load = makeRequire(import.meta.url); load("../../outside.ts");\n');
    writeFileSync(join(root, "bin", "dynamic-module.ts"), 'import("module").then((module) => module["createRequire"](import.meta.url));\n');
    expect(check(root)).toEqual([
      "bin/create-require-alias.ts: dynamic import or require cannot be verified",
      "bin/create-require-module.ts: dynamic import or require cannot be verified",
      "bin/create-require.ts: dynamic import or require cannot be verified",
      "bin/dynamic-module.ts: dynamic import or require cannot be verified",
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
    writeFileSync(join(root, "bin", "windows.ts"), 'import "C:\\\\Users\\\\fixture-user\\\\outside.ts";\nimport "\\\\server\\\\share\\\\outside.ts";\n');
    expect(check(root)).toEqual([
      "bin/windows.ts: local reference outside public repository C:\\Users\\fixture-user\\outside.ts",
      "bin/windows.ts: local reference outside public repository \\server\\share\\outside.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects loader aliases, module re-exports, and Bun import.meta.require", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-loaders-"));
  const outsideName = `${root.split(/[\\/]/).at(-1)}-outside.ts`;
  const outsidePath = join(root, "..", outsideName);
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(outsidePath, "export const outside = 1;\n");
    writeFileSync(join(root, "bin", "alias.ts"), `const load = require; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "export-module.ts"), 'export { createRequire as makeRequire } from "module";\n');
    writeFileSync(join(root, "bin", "import-meta.ts"), `import.meta.require("../../${outsideName}");\n`);
    expect(check(root)).toEqual([
      "bin/alias.ts: dynamic import or require cannot be verified",
      `bin/alias.ts: local reference outside public repository ../../${outsideName}`,
      "bin/export-module.ts: dynamic import or require cannot be verified",
      `bin/import-meta.ts: local reference outside public repository ../../${outsideName}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test("rejects bracketed and reassigned Bun loaders and import-equals module loaders", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-loader-forms-"));
  const outsideName = `${root.split(/[\\/]/).at(-1)}-outside.ts`;
  const outsidePath = join(root, "..", outsideName);
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(outsidePath, "export const outside = 1;\n");
    writeFileSync(join(root, "bin", "assignment.ts"), `let load; load = import.meta.require; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "bun-alias.ts"), `const load = import.meta.require; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "bun-bracket.ts"), `import.meta["require"]("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "import-equals.tsx"), 'import moduleLoader = require("module"); moduleLoader["createRequire"](import.meta.url);\n');
    expect(check(root)).toEqual([
      "bin/assignment.ts: dynamic import or require cannot be verified",
      `bin/assignment.ts: local reference outside public repository ../../${outsideName}`,
      "bin/bun-alias.ts: dynamic import or require cannot be verified",
      `bin/bun-alias.ts: local reference outside public repository ../../${outsideName}`,
      `bin/bun-bracket.ts: local reference outside public repository ../../${outsideName}`,
      "bin/import-equals.tsx: dynamic import or require cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test("rejects wrapped, destructured, late-bound, and bound loaders", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-loader-wrapped-"));
  const outsideName = `${root.split(/[\\/]/).at(-1)}-outside.ts`;
  const outsidePath = join(root, "..", outsideName);
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(outsidePath, "export const outside = 1;\n");
    writeFileSync(join(root, "bin", "bind.ts"), `const load = require.bind(null); load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "destructure.ts"), `const { require: load } = import.meta; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "late.ts"), `function run() { load("../../${outsideName}"); } const load = require; run();\n`);
    writeFileSync(join(root, "bin", "wrapped.ts"), `(require)("../../${outsideName}");\n`);
    expect(check(root)).toEqual([
      "bin/bind.ts: dynamic import or require cannot be verified",
      `bin/bind.ts: local reference outside public repository ../../${outsideName}`,
      `bin/destructure.ts: local reference outside public repository ../../${outsideName}`,
      "bin/late.ts: dynamic import or require cannot be verified",
      `bin/late.ts: local reference outside public repository ../../${outsideName}`,
      "bin/wrapped.ts: dynamic import or require cannot be verified",
      `bin/wrapped.ts: local reference outside public repository ../../${outsideName}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test("rejects propagated, computed, and indirect loader calls", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-loader-propagation-"));
  const outsideName = `${root.split(/[\\/]/).at(-1)}-outside.ts`;
  const outsidePath = join(root, "..", outsideName);
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(outsidePath, "export const outside = 1;\n");
    writeFileSync(join(root, "bin", "apply.ts"), `require.apply(null, ["../../${outsideName}"]);\n`);
    writeFileSync(join(root, "bin", "call.ts"), `require.call(null, "../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "comma.ts"), `(0, require)("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "computed.ts"), `const name = "require"; import.meta[name]("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "container.ts"), `const loaders = { load: require }; loaders.load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-destructure.ts"), `const meta = import.meta; const { require: load } = meta; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-assignment-destructure.ts"), `let meta; meta = import.meta; const { require: load } = meta; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-default-destructure.ts"), `let load; ({ require: load = null } = import.meta); load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-computed-destructure.ts"), `const { ["require"]: load } = import.meta; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-parenthesized-computed.ts"), `const { [("require")]: load } = import.meta; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-as-computed.ts"), `const { ["require" as const]: load } = import.meta; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-assignment-expression.ts"), `let meta; const { ["require"]: load } = (meta = import.meta); load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-dynamic-destructure.ts"), `const key = "require"; const { [key]: load } = import.meta; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-default-parameter.ts"), `function run(meta = import.meta) { meta.require("../../${outsideName}"); } run();\n`);
    writeFileSync(join(root, "bin", "meta-comma-alias.ts"), `const meta = (0, import.meta); meta.require("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-object.ts"), `const loaders = { load: import.meta.require }; loaders.load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-bracket-object.ts"), `const loaders = { load: import.meta["require"] }; loaders.load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-alias-object.ts"), `const meta = import.meta; const loaders = { load: meta.require }; loaders.load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "module-alias-destructure.ts"), `const m = module; const { require: load } = m; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "module-assignment-destructure.ts"), `let load; ({ require: load } = module); load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "module-destructure.ts"), `const { require: load } = module; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "module.ts"), `module.require("../../${outsideName}");\n`);
    expect(check(root)).toEqual([
      "bin/apply.ts: dynamic import or require cannot be verified",
      "bin/call.ts: dynamic import or require cannot be verified",
      "bin/comma.ts: dynamic import or require cannot be verified",
      `bin/comma.ts: local reference outside public repository ../../${outsideName}`,
      "bin/computed.ts: dynamic import or require cannot be verified",
      "bin/container.ts: dynamic import or require cannot be verified",
      "bin/meta-alias-object.ts: dynamic import or require cannot be verified",
      `bin/meta-as-computed.ts: local reference outside public repository ../../${outsideName}`,
      `bin/meta-assignment-destructure.ts: local reference outside public repository ../../${outsideName}`,
      `bin/meta-assignment-expression.ts: local reference outside public repository ../../${outsideName}`,
      "bin/meta-bracket-object.ts: dynamic import or require cannot be verified",
      `bin/meta-comma-alias.ts: local reference outside public repository ../../${outsideName}`,
      `bin/meta-computed-destructure.ts: local reference outside public repository ../../${outsideName}`,
      `bin/meta-default-destructure.ts: local reference outside public repository ../../${outsideName}`,
      `bin/meta-default-parameter.ts: local reference outside public repository ../../${outsideName}`,
      `bin/meta-destructure.ts: local reference outside public repository ../../${outsideName}`,
      "bin/meta-dynamic-destructure.ts: dynamic import or require cannot be verified",
      "bin/meta-object.ts: dynamic import or require cannot be verified",
      `bin/meta-parenthesized-computed.ts: local reference outside public repository ../../${outsideName}`,
      `bin/module-alias-destructure.ts: local reference outside public repository ../../${outsideName}`,
      `bin/module-assignment-destructure.ts: local reference outside public repository ../../${outsideName}`,
      `bin/module-destructure.ts: local reference outside public repository ../../${outsideName}`,
      `bin/module.ts: local reference outside public repository ../../${outsideName}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test("rejects executable module URLs", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-data-url-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "data.ts"), 'import "data:text/javascript,export%20default%201";\n');
    expect(check(root)).toEqual([
      "bin/data.ts: executable module URL cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects evaluated JavaScript loaders", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-eval-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "eval.ts"), 'eval("require(\\"./hidden.ts\\")");\n');
    writeFileSync(join(root, "bin", "function.ts"), 'new Function("return require(\\"./hidden.ts\\")")();\n');
    writeFileSync(join(root, "bin", "function-alias.ts"), 'const F = globalThis.Function; new F("return require(\\"./hidden.ts\\")")();\n');
    writeFileSync(join(root, "bin", "function-destructure.ts"), 'const { Function: F } = globalThis; new F("return require(\\"./hidden.ts\\")")();\n');
    writeFileSync(join(root, "bin", "function-assignment-destructure.ts"), 'let F; ({ Function: F } = globalThis); new F("return require(\\"./hidden.ts\\")")();\n');
    writeFileSync(join(root, "bin", "function-computed-destructure.ts"), 'const { ["Function"]: F } = globalThis; new F("return require(\\"./hidden.ts\\")")();\n');
    writeFileSync(join(root, "bin", "function-computed-global.ts"), 'const key = "Function"; const { [key]: F } = globalThis; new F("return require(\\"./hidden.ts\\")")();\n');
    writeFileSync(join(root, "bin", "function-assigned-global.ts"), 'let globalObject; const { Function: F } = (globalObject = globalThis); new F("return require(\\"./hidden.ts\\")")();\n');
    writeFileSync(join(root, "bin", "function-object.ts"), 'const loaders = { load: globalThis.Function }; new loaders.load("return require(\\"./hidden.ts\\")")();\n');
    writeFileSync(join(root, "bin", "function-bracket-object.ts"), 'const loaders = { load: globalThis["Function"] }; new loaders.load("return require(\\"./hidden.ts\\")")();\n');
    expect(check(root)).toEqual([
      "bin/eval.ts: dynamic import or require cannot be verified",
      "bin/function-alias.ts: dynamic import or require cannot be verified",
      "bin/function-assigned-global.ts: dynamic import or require cannot be verified",
      "bin/function-assignment-destructure.ts: dynamic import or require cannot be verified",
      "bin/function-bracket-object.ts: dynamic import or require cannot be verified",
      "bin/function-computed-destructure.ts: dynamic import or require cannot be verified",
      "bin/function-computed-global.ts: dynamic import or require cannot be verified",
      "bin/function-destructure.ts: dynamic import or require cannot be verified",
      "bin/function-object.ts: dynamic import or require cannot be verified",
      "bin/function.ts: dynamic import or require cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects production tools that import excluded test files", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-test-import-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.ts"), 'import "./runtime.test.ts";\n');
    writeFileSync(join(root, "bin", "runtime.test.ts"), 'const marker = "fixture-only";\n');
    expect(publicToolFiles(root).map((path) => path.split(/[\\/]/).at(-1))).toEqual(["entry.ts"]);
    expect(check(root)).toEqual([
      "bin/entry.ts: local reference targets excluded test file ./runtime.test.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recursively checks local JavaScript dependencies for excluded test imports", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-dependency-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.ts"), 'import "../support/helper.cjs";\n');
    writeFileSync(join(root, "support", "helper.cjs"), 'require("../bin/runtime.test.ts");\n');
    writeFileSync(join(root, "bin", "runtime.test.ts"), 'const marker = "fixture-only";\n');
    expect(publicToolFiles(root).map((path) => path.split(/[\\/]/).at(-1))).toEqual(["entry.ts"]);
    expect(check(root)).toEqual([
      "support/helper.cjs: dynamic import or require cannot be verified",
      "support/helper.cjs: local reference targets excluded test file ../bin/runtime.test.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recursively checks Python and Shell local dependencies", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-script-dependency-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from . import helper\nfrom . import (runtime_test)\n");
    writeFileSync(join(root, "bin", "entry_direct.py"), "import runtime_test\n");
    writeFileSync(join(root, "bin", "entry_conditional.py"), "if True: import runtime_test\n");
    writeFileSync(join(root, "bin", "entry_star.py"), "from runtime_test import *\n");
    writeFileSync(join(root, "bin", "helper.py"), "from . import runtime_test\n");
    writeFileSync(join(root, "bin", "entry_from.py"), "from support import helper\n");
    writeFileSync(join(root, "bin", "support.py"), "import runtime_test\n");
    writeFileSync(join(root, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(root, "bin", "entry.sh"), "  source ./helper.sh\n");
    writeFileSync(join(root, "bin", "helper.sh"), "if true; then\n  . ./runtime.test.sh\nfi\n");
    writeFileSync(join(root, "bin", "runtime.test.sh"), "echo fixture-only\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
      "bin/entry_conditional.py: local reference targets excluded test file ./runtime_test",
      "bin/entry_direct.py: local reference targets excluded test file ./runtime_test",
      "bin/entry_star.py: local reference targets excluded test file ./runtime_test",
      "bin/helper.py: local reference targets excluded test file ./runtime_test",
      "bin/helper.sh: local reference targets excluded test file ./runtime.test.sh",
      "bin/support.py: local reference targets excluded test file ./runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recursively checks Python package initializers", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-package-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from package import helper\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "import runtime_test\n");
    writeFileSync(join(root, "bin", "package", "helper.py"), "value = 1\n");
    writeFileSync(join(root, "bin", "package", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/package/__init__.py: local reference targets excluded test file ./runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects missing members from named Python packages", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-package-missing-member-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "relative.py"), "from .package import missing\n");
    writeFileSync(join(root, "bin", "absolute.py"), "from package import missing\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "\n");
    expect(check(root)).toEqual([
      "bin/absolute.py: missing local reference ./package/missing",
      "bin/relative.py: missing local reference ./package/missing",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recursively checks parent initializers across namespace packages", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-namespace-parent-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    mkdirSync(join(root, "support", "pkg", "ns"), { recursive: true });
    writeFileSync(join(root, "bin", "package", "entry.py"), "from ...support.pkg.ns.helper import value\n");
    writeFileSync(join(root, "support", "pkg", "__init__.py"), "import os\nos.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "pkg", "ns", "helper.py"), "value = 1\n");
    expect(check(root)).toEqual([
      "support/pkg/__init__.py: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recursively checks dotted and aliased Python imports", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-import-forms-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "dotted.py"), "import package.runtime_test\n");
    writeFileSync(join(root, "bin", "aliased.py"), "from . import runtime_test as rt\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "\n");
    writeFileSync(join(root, "bin", "package", "runtime_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(root, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/aliased.py: local reference targets excluded test file ./runtime_test",
      "bin/dotted.py: local reference targets excluded test file ./package/runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handles Python relative exports and trailing commas", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-trailing-comma-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from .helper import value\nfrom . import (runtime_test,)\n");
    writeFileSync(join(root, "bin", "helper.py"), "value = 1\n");
    writeFileSync(join(root, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handles Python multiline import comments", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-comments-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from . import (helper,  # keep this import\n                 runtime_test,\n)\n");
    writeFileSync(join(root, "bin", "helper.py"), "value = 1\n");
    writeFileSync(join(root, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not treat Python relative wildcards as literal modules", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-wildcard-"));
  try {
    mkdirSync(join(root, "bin", "child"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from .child import *\n");
    writeFileSync(join(root, "bin", "child", "__init__.py"), "value = 1\n");
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves Python namespace packages without masking missing members", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-namespace-"));
  try {
    mkdirSync(join(root, "bin", "namespace"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from .namespace import value\nfrom .namespace import missing\n");
    writeFileSync(join(root, "bin", "namespace", "value.py"), "value = 1\n");
    expect(check(root)).toEqual([
      "bin/entry.py: missing local reference ./namespace/missing",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects missing Python relative modules", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-missing-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from .missing import value\n");
    expect(check(root)).toEqual([
      "bin/entry.py: missing local reference ./missing",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses Python-only resolution for missing relative modules", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-only-resolution-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from .missing import value\n");
    writeFileSync(join(root, "bin", "missing.ts"), "export const value = 1;\n");
    expect(check(root)).toEqual([
      "bin/entry.py: missing local reference ./missing",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects missing Python package members when the initializer does not export them", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-package-member-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from . import missing\n");
    writeFileSync(join(root, "bin", "__init__.py"), "\n");
    expect(check(root)).toEqual([
      "bin/entry.py: missing local reference ./missing",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recursively checks Python parent package initializers", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-parent-packages-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    mkdirSync(join(root, "support", "pkg"), { recursive: true });
    writeFileSync(join(root, "bin", "package", "entry.py"), "from ...support.pkg.helper import value\n");
    writeFileSync(join(root, "support", "__init__.py"), "\n");
    writeFileSync(join(root, "support", "pkg", "__init__.py"), "import os\nos.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "pkg", "helper.py"), "value = 1\n");
    expect(check(root)).toEqual([
      "support/pkg/__init__.py: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported public-tool-boundary CLI options", () => {
  expect(main(["--unknown"])).toBe(2);
});
