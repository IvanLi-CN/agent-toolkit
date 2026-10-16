import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("enumerates and parses public MTS and CTS tools while excluding their fixtures", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-modern-module-extensions-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "safe.mts"), 'import "./safe.cts";\n');
    writeFileSync(join(root, "bin", "safe.cts"), "export const value: number = 1;\n");
    writeFileSync(join(root, "bin", "fixture.test.mts"), 'const value = "$CODEX_HOME";\n');
    writeFileSync(join(root, "bin", "test-fixture.cts"), 'const value = "$CODEX_HOME";\n');
    writeFileSync(join(root, "bin", "fixture_test.mts"), 'const value = "$CODEX_HOME";\n');
    expect(publicToolFiles(root).map((path) => path.split(/[\\/]/).at(-1)).sort()).toEqual(["safe.cts", "safe.mts"]);
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
    writeFileSync(join(root, "bin", "meta-nested-assignment.ts"), `let holder; const meta = (holder = import.meta); const key = "require"; meta[key]("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-object.ts"), `const loaders = { load: import.meta.require }; loaders.load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-bracket-object.ts"), `const loaders = { load: import.meta["require"] }; loaders.load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "meta-alias-object.ts"), `const meta = import.meta; const loaders = { load: meta.require }; loaders.load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "module-alias-destructure.ts"), `const m = module; const { require: load } = m; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "module-assignment-destructure.ts"), `let load; ({ require: load } = module); load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "module-computed-destructure.ts"), `const key = "require"; const { [key]: load } = module; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "module-computed-call.ts"), `const key = "require"; module[key]("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "module-constructor-alias.ts"), `const load = module.constructor._load; load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "module-constructor-class-alias.ts"), `const loaderClass = module.constructor; loaderClass._load("../../${outsideName}");\n`);
    writeFileSync(join(root, "bin", "module-constructor-load.ts"), `module.constructor._load("../../${outsideName}");\n`);
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
      "bin/meta-nested-assignment.ts: dynamic import or require cannot be verified",
      "bin/meta-object.ts: dynamic import or require cannot be verified",
      `bin/meta-parenthesized-computed.ts: local reference outside public repository ../../${outsideName}`,
      `bin/module-alias-destructure.ts: local reference outside public repository ../../${outsideName}`,
      `bin/module-assignment-destructure.ts: local reference outside public repository ../../${outsideName}`,
      "bin/module-computed-call.ts: dynamic import or require cannot be verified",
      "bin/module-computed-destructure.ts: dynamic import or require cannot be verified",
      `bin/module-constructor-alias.ts: local reference outside public repository ../../${outsideName}`,
      `bin/module-constructor-class-alias.ts: local reference outside public repository ../../${outsideName}`,
      `bin/module-constructor-load.ts: local reference outside public repository ../../${outsideName}`,
      `bin/module-destructure.ts: local reference outside public repository ../../${outsideName}`,
      `bin/module.ts: local reference outside public repository ../../${outsideName}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test("fails closed for process loader aliases from globals, promises, rest bindings, and call wrappers", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-process-loader-aliases-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "call.ts"), 'process["getBuiltinModule"].call(process, "module")._load("/outside/private.cjs");\n');
    writeFileSync(join(root, "bin", "global.ts"), 'const { process: p } = globalThis; p.getBuiltinModule("module")._load("/outside/private.cjs");\n');
    writeFileSync(join(root, "bin", "promise.ts"), 'const promise = import("node:process"); promise.then((p) => p.getBuiltinModule("module")._load("/outside/private.cjs"));\n');
    writeFileSync(join(root, "bin", "rest.ts"), 'const { ...p } = process; p.getBuiltinModule("module")._load("/outside/private.cjs");\n');
    expect(check(root)).toEqual([
      "bin/call.ts: dynamic import or require cannot be verified",
      "bin/global.ts: dynamic import or require cannot be verified",
      "bin/promise.ts: dynamic import or require cannot be verified",
      "bin/rest.ts: dynamic import or require cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
    writeFileSync(join(root, "bin", "function-computed-call.ts"), 'const key = "Function"; globalThis[key]("return 7")();\n');
    writeFileSync(join(root, "bin", "function-global-destructure.ts"), 'const { globalThis: g } = globalThis; const key = "Function"; g[key]("return 7")();\n');
    writeFileSync(join(root, "bin", "function-global-self.ts"), 'const g = globalThis.globalThis; const key = "Function"; g[key]("return 7")();\n');
    writeFileSync(join(root, "bin", "function-object.ts"), 'const loaders = { load: globalThis.Function }; new loaders.load("return require(\\"./hidden.ts\\")")();\n');
    writeFileSync(join(root, "bin", "function-bracket-object.ts"), 'const loaders = { load: globalThis["Function"] }; new loaders.load("return require(\\"./hidden.ts\\")")();\n');
    expect(check(root)).toEqual([
      "bin/eval.ts: dynamic import or require cannot be verified",
      "bin/function-alias.ts: dynamic import or require cannot be verified",
      "bin/function-assigned-global.ts: dynamic import or require cannot be verified",
      "bin/function-assignment-destructure.ts: dynamic import or require cannot be verified",
      "bin/function-bracket-object.ts: dynamic import or require cannot be verified",
      "bin/function-computed-call.ts: dynamic import or require cannot be verified",
      "bin/function-computed-destructure.ts: dynamic import or require cannot be verified",
      "bin/function-computed-global.ts: dynamic import or require cannot be verified",
      "bin/function-destructure.ts: dynamic import or require cannot be verified",
      "bin/function-global-destructure.ts: dynamic import or require cannot be verified",
      "bin/function-global-self.ts: dynamic import or require cannot be verified",
      "bin/function-object.ts: dynamic import or require cannot be verified",
      "bin/function.ts: dynamic import or require cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parses TypeScript syntax before checking local imports", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-typescript-parser-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.ts"), 'const value = <string>"runtime";\nimport "../support/runtime_test.ts";\n');
    writeFileSync(join(root, "support", "runtime_test.ts"), "export const marker = 'fixture-only';\n");
    expect(check(root)).toEqual([
      "bin/entry.ts: local reference targets excluded test file ../support/runtime_test.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves local package import aliases", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-imports-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ imports: { "#runtime": "./support/runtime_test.ts", "#runtime/*": "./support/*_test.ts" } }));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "#runtime";\nimport "#runtime/pattern";\n');
    writeFileSync(join(root, "support", "runtime_test.ts"), "export const marker = 'fixture-only';\n");
    writeFileSync(join(root, "support", "pattern_test.ts"), "export const marker = 'fixture-only';\n");
    expect(check(root)).toEqual([
      "bin/entry.ts: local reference targets excluded test file #runtime",
      "bin/entry.ts: local reference targets excluded test file #runtime/pattern",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checks all package import conditions and selects the most specific pattern", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-conditions-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({
      imports: {
        "#conditional": { browser: "./support/safe.ts", default: "./support/runtime_test.ts" },
        "#*time": "./support/safe.ts",
        "#run*": "./support/runtime_test.ts",
      },
    }));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "#conditional";\nimport "#runtime";\n');
    writeFileSync(join(root, "support", "safe.ts"), "export const marker = 'safe';\n");
    writeFileSync(join(root, "support", "runtime_test.ts"), "export const marker = 'fixture-only';\n");
    expect(check(root)).toEqual([
      "bin/entry.ts: local reference targets excluded test file #conditional",
      "bin/entry.ts: local reference targets excluded test file #runtime",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("follows in-repository package manifest symlinks for import aliases", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-symlink-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "meta.json"), JSON.stringify({ imports: { "#runtime": "./support/runtime_test.ts" } }));
    symlinkSync("meta.json", join(root, "package.json"));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "#runtime";\n');
    writeFileSync(join(root, "support", "runtime_test.ts"), "export const marker = 'fixture-only';\n");
    expect(check(root)).toEqual([
      "bin/entry.ts: local reference targets excluded test file #runtime",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves package self imports, TypeScript paths, encoded targets, package mains, and JavaScript substitutions", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-resolution-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support", "package"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "fixture-package",
      imports: { "#fs": "node:fs", "#encoded": "./support/%72untime_test.ts" },
      exports: { "./self": "./support/self_test.ts" },
    }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["support/*_test"] } } }));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "#fs";\nimport "#encoded";\nimport "fixture-package/self";\nimport "@/path";\nimport "../support/helper";\nimport "../support/js-helper.js";\nimport "../support/package";\n');
    writeFileSync(join(root, "support", "runtime_test.ts"), "export const marker = 'fixture-only';\n");
    writeFileSync(join(root, "support", "self_test.ts"), "export const marker = 'fixture-only';\n");
    writeFileSync(join(root, "support", "path_test.ts"), "export const marker = 'fixture-only';\n");
    writeFileSync(join(root, "support", "helper.tsx"), "export const marker = \"$CODEX_HOME\";\n");
    writeFileSync(join(root, "support", "helper.ts"), "export const safe = true;\n");
    writeFileSync(join(root, "support", "js-helper.ts"), "export const safe = true;\n");
    writeFileSync(join(root, "support", "js-helper.tsx"), "export const marker = \"$CODEX_HOME\";\n");
    writeFileSync(join(root, "support", "package", "package.json"), JSON.stringify({ main: "./runtime_test" }));
    writeFileSync(join(root, "support", "package", "runtime_test.ts"), "export const marker = 'fixture-only';\n");
    expect(check(root)).toEqual([
      "bin/entry.ts: local reference targets excluded test file #encoded",
      "bin/entry.ts: local reference targets excluded test file fixture-package/self",
      "bin/entry.ts: local reference targets excluded test file @/path",
      "bin/entry.ts: local reference targets excluded test file ../support/package",
      "support/helper.tsx: forbidden public tool coupling codex-runtime-marker",
      "support/js-helper.tsx: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves literal percent escapes for CommonJS paths", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-commonjs-percent-path-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.cjs"), 'require("../support/helper%23private.cjs");\n');
    writeFileSync(join(root, "support", "helper%23private.cjs"), 'require("/outside/private.cjs");\n');
    writeFileSync(join(root, "support", "helper#private.cjs"), "export const safe = true;\n");
    expect(check(root)).toEqual([
      "bin/entry.cjs: dynamic import or require cannot be verified",
      "support/helper%23private.cjs: dynamic import or require cannot be verified",
      "support/helper%23private.cjs: local reference outside public repository /outside/private.cjs",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves package metadata file paths and rejects indirect loader gaps", () => {
  const packageRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-percent-path-"));
  const processRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-process-member-assignment-"));
  const pythonRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-indirect-loaders-"));
  const allRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-complex-all-"));
  try {
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    mkdirSync(join(packageRoot, "support"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ imports: { "#helper": "./support/helper.mjs%23private.mjs" } }));
    writeFileSync(join(packageRoot, "bin", "entry.ts"), 'import "#helper";\n');
    writeFileSync(join(packageRoot, "support", "helper.mjs"), "export const safe = true;\n");
    writeFileSync(join(packageRoot, "support", "helper.mjs#private.mjs"), 'import "/outside/private.mjs";\n');
    expect(check(packageRoot)).toEqual([
      "support/helper.mjs#private.mjs: local reference outside public repository /outside/private.mjs",
    ]);

    mkdirSync(join(processRoot, "bin"), { recursive: true });
    writeFileSync(join(processRoot, "bin", "entry.cjs"), "const h = {}; ({ process: h.p } = globalThis); const m = h.p.getBuiltinModule('module'); m._load('/outside/private.cjs', module, false)\n");
    expect(check(processRoot)).toEqual([
      "bin/entry.cjs: dynamic import or require cannot be verified",
    ]);

    mkdirSync(join(pythonRoot, "bin"), { recursive: true });
    writeFileSync(join(pythonRoot, "bin", "entry.py"), "# getattr(builtins, 'exec')('safe')\nimport builtins\ngetattr(builtins, 'exec')('import runtime_test')\n");
    writeFileSync(join(pythonRoot, "bin", "dict-import.py"), "import builtins\nb = vars(builtins)\nb['__import__']('runtime_test')\n");
    writeFileSync(join(pythonRoot, "bin", "continued-loader.py"), "import importlib\nloader = importlib \\\n    .import_module\nloader('runtime_test')\n");
    writeFileSync(join(pythonRoot, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(pythonRoot)).toEqual([
      "bin/continued-loader.py: local reference targets excluded test file ./runtime_test",
      "bin/dict-import.py: local reference targets excluded test file ./runtime_test",
      "bin/entry.py: dynamic Python import cannot be verified",
    ]);

    mkdirSync(join(allRoot, "bin", "parenthesized"), { recursive: true });
    mkdirSync(join(allRoot, "bin", "unpacked"), { recursive: true });
    writeFileSync(join(allRoot, "bin", "entry-parenthesized.py"), "from parenthesized import *\n");
    writeFileSync(join(allRoot, "bin", "entry-unpacked.py"), "from unpacked import *\n");
    writeFileSync(join(allRoot, "bin", "parenthesized", "__init__.py"), "(__all__) = ['runtime_test']\n");
    writeFileSync(join(allRoot, "bin", "unpacked", "__init__.py"), "__all__, other = ['runtime_test'], None\n");
    expect(check(allRoot)).toEqual([
      "bin/entry-parenthesized.py: wildcard Python import cannot be verified",
      "bin/entry-unpacked.py: wildcard Python import cannot be verified",
    ]);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(processRoot, { recursive: true, force: true });
    rmSync(pythonRoot, { recursive: true, force: true });
    rmSync(allRoot, { recursive: true, force: true });
  }
});

test("resolves TypeScript JSONC extends layers and exact paths before wildcards", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-tsconfig-layers-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), `{
  // Child config uses an exact match before the wildcard below.
  "extends": "./config/base",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@feature/*": ["support/*_test"],
      "@feature/runtime": ["support/safe"]
    }
  },
}
`);
    writeFileSync(join(root, "config", "base.json"), `{
  "compilerOptions": {
    "baseUrl": "..",
    "paths": {
      "@base/*": ["support/*_test"],
    },
  },
}
`);
    writeFileSync(join(root, "bin", "entry.ts"), 'import "@feature/runtime";\nimport "@feature/other";\nimport "@base/runtime";\nimport "ordinary-package";\n');
    writeFileSync(join(root, "support", "safe.ts"), "export const safe = true;\n");
    writeFileSync(join(root, "support", "other_test.ts"), "export const marker = 'fixture-only';\n");
    writeFileSync(join(root, "support", "runtime_test.ts"), "export const marker = 'fixture-only';\n");
    expect(check(root)).toEqual([
      "bin/entry.ts: local reference targets excluded test file @feature/other",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves punctuation inside JSONC string values", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-jsonc-string-values-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), `{
  // The comma and brace belong to the path string.
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@literal": ["support/a,}.ts",],
    },
  },
}
`);
    writeFileSync(join(root, "bin", "entry.ts"), 'import "@literal";\n');
    writeFileSync(join(root, "support", "a,}.ts"), "export const safe = true;\n");
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for metadata symlinks that resolve outside the repository", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-metadata-boundary-"));
  const outside = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-metadata-outside-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support", "package"), { recursive: true });
    writeFileSync(join(outside, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@runtime": ["./runtime_test"] } } }));
    writeFileSync(join(outside, "package.json"), JSON.stringify({ main: "./runtime_test" }));
    writeFileSync(join(outside, "runtime_test.ts"), "export const marker = 'fixture-only';\n");
    symlinkSync(join(outside, "tsconfig.json"), join(root, "tsconfig.json"));
    symlinkSync(join(outside, "package.json"), join(root, "support", "package", "package.json"));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "@runtime";\nimport "../support/package";\n');
    expect(check(root)).toEqual([
      "bin/entry.ts: local path import cannot be verified @runtime",
      "bin/entry.ts: local reference outside public repository ../support/package",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("rejects package import aliases that resolve to Node module builtins", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-builtin-alias-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ imports: { "#module": "node:module" } }));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "#module";\n');
    expect(check(root)).toEqual([
      "bin/entry.ts: dynamic import or require cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("follows package import aliases through package self exports", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-self-alias-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "fixture-package",
      imports: { "#run": "fixture-package/run" },
      exports: { "./run": "./support/runtime_test.ts" },
    }));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "#run";\n');
    writeFileSync(join(root, "support", "runtime_test.ts"), "export const marker = 'fixture-only';\n");
    expect(check(root)).toEqual([
      "bin/entry.ts: local reference targets excluded test file #run",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for package self manifests that resolve outside the repository", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-self-outside-"));
  const outside = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-self-outside-target-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "fixture-package", exports: { "./run": "./run.ts" } }));
    writeFileSync(join(outside, "run.ts"), "export const safe = true;\n");
    symlinkSync(join(outside, "package.json"), join(root, "package.json"));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "fixture-package/run";\n');
    expect(check(root)).toEqual([
      "bin/entry.ts: local package import cannot be verified fixture-package/run",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("inherits TypeScript baseUrl through config layers and rejects array extends", () => {
  const inheritedRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-tsconfig-inherited-baseurl-"));
  const invalidRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-tsconfig-array-extends-"));
  try {
    mkdirSync(join(inheritedRoot, "bin"), { recursive: true });
    mkdirSync(join(inheritedRoot, "config", "support"), { recursive: true });
    writeFileSync(join(inheritedRoot, "tsconfig.json"), JSON.stringify({ extends: "./config/base", compilerOptions: { paths: { "@runtime": ["runtime_test"] } } }));
    writeFileSync(join(inheritedRoot, "config", "base.json"), JSON.stringify({ compilerOptions: { baseUrl: "support" } }));
    writeFileSync(join(inheritedRoot, "bin", "entry.ts"), 'import "@runtime";\n');
    writeFileSync(join(inheritedRoot, "config", "support", "runtime_test.ts"), "export const marker = 'fixture-only';\n");
    expect(check(inheritedRoot)).toEqual([
      "bin/entry.ts: local reference targets excluded test file @runtime",
    ]);

    mkdirSync(join(invalidRoot, "bin"), { recursive: true });
    mkdirSync(join(invalidRoot, "support"), { recursive: true });
    writeFileSync(join(invalidRoot, "tsconfig.json"), JSON.stringify({ extends: ["./config/base"], compilerOptions: { paths: { "@runtime": ["support/runtime_test"] } } }));
    writeFileSync(join(invalidRoot, "bin", "entry.ts"), 'import "@runtime";\n');
    writeFileSync(join(invalidRoot, "support", "runtime_test.ts"), "export const marker = 'fixture-only';\n");
    expect(check(invalidRoot)).toEqual([
      "bin/entry.ts: local path import cannot be verified @runtime",
      "bin/entry.ts: local reference targets excluded test file @runtime",
    ]);
  } finally {
    rmSync(inheritedRoot, { recursive: true, force: true });
    rmSync(invalidRoot, { recursive: true, force: true });
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

test("recursively checks Shell source commands in subshells", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-subshell-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), "( . ../support/private.sh )\n");
    writeFileSync(join(root, "support", "private.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    expect(check(root)).toEqual([
      "support/private.sh: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parses Shell source commands without string or extension false positives", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-parser-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), "printf '%s\\n' '( . ./missing.sh )'\ncat <<'EOF'\n. ./missing.sh\nEOF\nif . ../support/private.sh; then :; fi\nFLAG=1 . ../support/assigned.sh\ntime source ../support/timed.sh\nvalue=\"$(. ../support/nested.sh)\"\ncat <<< \"fixture\"\n. ../support/herestring.sh\n. ../support/helper\n");
    writeFileSync(join(root, "support", "helper.py"), "os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "private.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "assigned.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "timed.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "nested.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "herestring.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    expect(check(root)).toEqual([
      "bin/entry.sh: missing local reference ../support/helper",
      "support/private.sh: forbidden public tool coupling codex-runtime-marker",
      "support/assigned.sh: forbidden public tool coupling codex-runtime-marker",
      "support/timed.sh: forbidden public tool coupling codex-runtime-marker",
      "support/nested.sh: forbidden public tool coupling codex-runtime-marker",
      "support/herestring.sh: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for Shell source wrappers and dynamic evaluation", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-wrappers-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), "FLAG=\"1\" . ../support/quoted.sh\nbuiltin source ../support/builtin.sh\neval '. ../support/eval.sh'\n");
    writeFileSync(join(root, "support", "quoted.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "builtin.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "eval.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    expect(check(root)).toEqual([
      "bin/entry.sh: dynamic Shell source cannot be verified",
      "support/quoted.sh: forbidden public tool coupling codex-runtime-marker",
      "support/builtin.sh: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checks quoted Shell commands and expandable heredocs", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-quoted-heredoc-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), [
      '"source" ../support/quoted.sh',
      "\\source ../support/escaped.sh",
      "cat <<EOF",
      'value="$(. ../support/heredoc.sh)"',
      "EOF",
      "cat <<'EOF'",
      'value="$(. ../support/quoted-heredoc.sh)"',
      "EOF",
      "",
    ].join("\n"));
    writeFileSync(join(root, "support", "quoted.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "escaped.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "heredoc.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "quoted-heredoc.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    expect(check(root)).toEqual([
      "support/quoted.sh: forbidden public tool coupling codex-runtime-marker",
      "support/escaped.sh: forbidden public tool coupling codex-runtime-marker",
      "support/heredoc.sh: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checks multiline Shell substitutions, backticks, wrappers, and redirections", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-stateful-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), [
      "cat <<EOF",
      "$(",
      ". ../support/multiline.sh",
      ")",
      "EOF",
      "value=\"\`source ../support/backtick.sh\`\"",
      "command -- source ../support/command.sh",
      ">/dev/null source ../support/redirection.sh",
      "command -- eval '. ../support/eval.sh'",
      "",
    ].join("\n"));
    for (const name of ["multiline", "backtick", "command", "redirection", "eval"]) {
      writeFileSync(join(root, "support", `${name}.sh`), "echo os.environ[\"CODEX_HOME\"]\n");
    }
    expect(check(root)).toEqual([
      "bin/entry.sh: dynamic Shell source cannot be verified",
      "support/multiline.sh: forbidden public tool coupling codex-runtime-marker",
      "support/backtick.sh: forbidden public tool coupling codex-runtime-marker",
      "support/command.sh: forbidden public tool coupling codex-runtime-marker",
      "support/redirection.sh: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves Shell command boundaries around negation and here documents", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-boundaries-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), [
      "! source ../support/negated.sh",
      "cat 0<<<EOF",
      "fixture",
      "EOF",
      "source ../support/after-herestring.sh",
      "cat <<EOF",
      "$(printf okay)",
      "EOF",
      "source ../support/after-heredoc-substitution.sh",
      "",
    ].join("\n"));
    for (const name of ["negated", "after-herestring", "after-heredoc-substitution"]) {
      writeFileSync(join(root, "support", `${name}.sh`), "echo os.environ[\"CODEX_HOME\"]\n");
    }
    expect(check(root)).toEqual([
      "support/negated.sh: forbidden public tool coupling codex-runtime-marker",
      "support/after-herestring.sh: forbidden public tool coupling codex-runtime-marker",
      "support/after-heredoc-substitution.sh: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves Shell source detection across file-descriptor redirections, continuations, and escaped heredoc substitutions", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-escaped-boundaries-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), [
      "2>/dev/null source ../support/fd.sh",
      "so\\",
      "urce ../support/continued.sh",
      "cat <<EOF",
      "\\$(source ../support/escaped.sh)",
      "EOF",
      "source ../support/after.sh",
      "",
    ].join("\n"));
    for (const name of ["fd", "continued", "escaped", "after"]) {
      writeFileSync(join(root, "support", `${name}.sh`), "echo os.environ[\"CODEX_HOME\"]\n");
    }
    expect(check(root)).toEqual([
      "support/fd.sh: forbidden public tool coupling codex-runtime-marker",
      "support/continued.sh: forbidden public tool coupling codex-runtime-marker",
      "support/after.sh: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves Shell source paths from the repository directory and handles dynamic forms", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-source-resolution-"));
  try {
    mkdirSync(join(root, "bin", "support"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), [
      "source ./support/root.sh",
      "source <(printf dynamic)",
      "value=\"$(case \"$1\" in foo) source ../support/case.sh;; *) :;; esac)\"",
      "source $'../support/ansi.sh'",
      "source $'\\x2e\\x2e/support/ansi-hex.sh'",
      "value=\"$(",
      "  # a closing parenthesis inside this comment is not syntax",
      "  source ../support/comment.sh",
      ")\"",
      "",
    ].join("\n"));
    writeFileSync(join(root, "bin", "support", "root.sh"), "echo safe\n");
    writeFileSync(join(root, "support", "root.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "case.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "ansi.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "ansi-hex.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    writeFileSync(join(root, "support", "comment.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    expect(check(root)).toEqual([
      "bin/entry.sh: dynamic Shell source cannot be verified",
      "support/root.sh: forbidden public tool coupling codex-runtime-marker",
      "support/case.sh: forbidden public tool coupling codex-runtime-marker",
      "support/ansi.sh: forbidden public tool coupling codex-runtime-marker",
      "support/ansi-hex.sh: forbidden public tool coupling codex-runtime-marker",
      "support/comment.sh: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps literal percent escapes in absolute Shell source paths", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-encoded-absolute-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), `source ${join(root, "support", "helper%23private.sh")}\n`);
    writeFileSync(join(root, "support", "helper%23private.sh"), ". /outside/private.sh\n");
    writeFileSync(join(root, "support", "helper#private.sh"), "echo safe\n");
    expect(check(root)).toEqual([
      "support/helper%23private.sh: local reference outside public repository /outside/private.sh",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for Shell home expansion and preserves literal backslashes", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-path-expansion-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "~"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), "source ~/helper.sh\nsource ~/'helper.sh'\nsource \"../support\\\\helper.sh\"\n");
    writeFileSync(join(root, "~", "helper.sh"), "echo safe\n");
    writeFileSync(join(root, "support", "helper.sh"), "echo safe\n");
    writeFileSync(join(root, "support\\helper.sh"), "echo $CODEX_HOME\n");
    expect(check(root)).toEqual([
      "bin/entry.sh: dynamic Shell source cannot be verified",
      "support/helper.sh: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for unquoted Shell pathname expansion in sources", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-glob-source-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), ". ./support/[h]elper.sh\n");
    writeFileSync(join(root, "support", "[h]elper.sh"), "echo safe\n");
    writeFileSync(join(root, "support", "helper.sh"), ". /outside/private.sh\n");
    expect(check(root)).toEqual([
      "bin/entry.sh: dynamic Shell source cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not resolve Shell sources after a working-directory change", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-working-directory-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), "cd ../support\n. ./helper.sh\n");
    writeFileSync(join(root, "support", "helper.sh"), "echo os.environ[\"CODEX_HOME\"]\n");
    expect(check(root)).toEqual([
      "bin/entry.sh: dynamic Shell source cannot be verified",
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
    writeFileSync(join(root, "bin", "entry.py"), "# from .missing import helper\ntext = 'from .missing import helper'\nfrom . import (helper,  # keep this import\n                 runtime_test,\n)\n");
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

test("recognizes Python function and class exports from package initializers", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-package-exports-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from .package import helper, Widget\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "def helper():\n    return 1\n\nclass Widget:\n    pass\n");
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recognizes Python multiline re-exports and module exports under control flow", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-export-forms-"));
  try {
    mkdirSync(join(root, "bin", "conditional"), { recursive: true });
    mkdirSync(join(root, "bin", "reexport"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from .conditional import runtime_test\nfrom .reexport import runtime_test\n");
    writeFileSync(join(root, "bin", "conditional", "__init__.py"), "if 1:\n    runtime_test = 1\n");
    writeFileSync(join(root, "bin", "conditional", "runtime_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(root, "bin", "reexport", "__init__.py"), "from .safe import (\n    runtime_test,\n)\n");
    writeFileSync(join(root, "bin", "reexport", "safe.py"), "runtime_test = 1\n");
    writeFileSync(join(root, "bin", "reexport", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects missing Python submodules under known packages", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-missing-submodule-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry_from.py"), "from package.missing import helper\n");
    writeFileSync(join(root, "bin", "entry_import.py"), "import package.missing\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "\n");
    expect(check(root)).toEqual([
      "bin/entry_from.py: missing local reference ./package/missing",
      "bin/entry_import.py: missing local reference ./package/missing",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scans Python absolute imports from the entry search root", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-search-root-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from package import helper\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "\n");
    writeFileSync(join(root, "bin", "package", "helper.py"), "import runtime_test\n");
    writeFileSync(join(root, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/package/helper.py: local reference targets excluded test file ../runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not duplicate Python findings when a dependency is scanned under multiple search roots", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-duplicate-scan-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "package", "entry.py"), "from ...support import helper\n");
    writeFileSync(join(root, "support", "helper.py"), "import os\nos.environ[\"CODEX_HOME\"]\n");
    expect(check(root)).toEqual([
      "support/helper.py: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scans local modules listed by Python package __all__", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-all-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from package import *\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "__all__ = [\"runtime_test\"]\n");
    writeFileSync(join(root, "bin", "package", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for dynamic Python package __all__", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-dynamic-all-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from package import *\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "__all__ = get_names()\n");
    expect(check(root)).toEqual([
      "bin/entry.py: wildcard Python import cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for Python __all__ concatenation and mutation", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-all-dynamic-forms-"));
  try {
    mkdirSync(join(root, "bin", "concat"), { recursive: true });
    mkdirSync(join(root, "bin", "mutated"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from concat import *\nfrom mutated import *\n");
    writeFileSync(join(root, "bin", "concat", "__init__.py"), "__all__ = [\"safe\"] + [\"runtime_test\"]\n");
    writeFileSync(join(root, "bin", "mutated", "__init__.py"), "__all__ = [\"safe\"]\n__all__.append(\"runtime_test\")\n");
    expect(check(root)).toEqual([
      "bin/entry.py: wildcard Python import cannot be verified",
      "bin/entry.py: wildcard Python import cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scans pure-dot Python package initializers", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-pure-dot-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from .. import value\n");
    writeFileSync(join(root, "__init__.py"), "value = 1\nos.environ[\"CODEX_HOME\"]\n");
    expect(check(root)).toEqual([
      "__init__.py: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounds Python absolute package initializer scans at the search root", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-initializer-boundary-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from package import helper\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "\n");
    writeFileSync(join(root, "bin", "package", "helper.py"), "value = 1\n");
    writeFileSync(join(root, "__init__.py"), "os.environ[\"CODEX_HOME\"]\n");
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handles Python explicit line continuations", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-continuation-"));
  try {
    mkdirSync(join(root, "bin", "lib"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from .lib \\\n    import runtime_test\n");
    writeFileSync(join(root, "bin", "lib", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./lib/runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handles Python inline imports and ignores string references", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-inline-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "if True: from .package import runtime_test\nimport \\\n    runtime_test\ntext = 'from .package import missing'\n");
    writeFileSync(join(root, "bin", "package", "runtime_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(root, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handles Python explicit import continuations and package attribute precedence", () => {
  const continuationRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-import-continuation-alias-"));
  const packageRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-package-attributes-"));
  try {
    mkdirSync(join(continuationRoot, "bin"), { recursive: true });
    writeFileSync(join(continuationRoot, "bin", "entry.py"), "import os, \\\n    runtime_test\n");
    writeFileSync(join(continuationRoot, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(continuationRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);

    mkdirSync(join(packageRoot, "bin", "package"), { recursive: true });
    writeFileSync(join(packageRoot, "bin", "entry.py"), "from package import runtime_test\nfrom annotated import value\nfrom all_only import missing\nfrom app import import_module\nimport_module(\"runtime_test\")\n");
    writeFileSync(join(packageRoot, "bin", "package", "__init__.py"), "runtime_test = 42\n");
    writeFileSync(join(packageRoot, "bin", "package", "runtime_test.py"), "marker = 'fixture-only'\n");
    mkdirSync(join(packageRoot, "bin", "annotated"), { recursive: true });
    writeFileSync(join(packageRoot, "bin", "annotated", "__init__.py"), "value: int = 1\n");
    mkdirSync(join(packageRoot, "bin", "all_only"), { recursive: true });
    writeFileSync(join(packageRoot, "bin", "all_only", "__init__.py"), "__all__ = [\"missing\"]\n");
    writeFileSync(join(packageRoot, "bin", "app.py"), "def import_module(value):\n    return value\n");
    expect(check(packageRoot)).toEqual([
      "bin/entry.py: missing local reference ./all_only/missing",
    ]);
  } finally {
    rmSync(continuationRoot, { recursive: true, force: true });
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("handles Python dotted import gaps and keyword boundaries", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-dotted-gaps-"));
  try {
    mkdirSync(join(root, "bin", "package", "sub"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "import package . runtime_test\nfrom package . \\\n    sub import runtime_test\nimportant_test = 1\n");
    writeFileSync(join(root, "bin", "package", "runtime_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(root, "bin", "package", "sub", "runtime_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(root, "bin", "ant_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./package/sub/runtime_test",
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("converges Python dynamic import aliases and builtin member aliases", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-alias-fixed-point-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "load = __import__\nimp = load(\"importlib\")\nimp.import_module(\"runtime_test\")\nimport builtins\nbuiltin_load = builtins.__import__\nbuiltin_load(\"package\", fromlist=[\"runtime_test\"])\n");
    writeFileSync(join(root, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "\n");
    writeFileSync(join(root, "bin", "package", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checks Python static dynamic imports and rejects unknown dynamic imports", () => {
  const staticRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-static-dynamic-import-"));
  const unknownRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-unknown-dynamic-import-"));
  try {
    mkdirSync(join(staticRoot, "bin"), { recursive: true });
    writeFileSync(join(staticRoot, "bin", "entry.py"), "from importlib import import_module as load\nimport importlib as imp\nfrom builtins import __import__ as builtin_import\nimport builtins as b\nimport runpy\nload(\"runtime_test\")\nimp.import_module(\"other_test\")\nbuiltin_import(\"third_test\")\nb.__import__(\"fourth_test\")\nload = imp.import_module\nload(\"fifth_test\")\ndirect = __import__\ndirect(\"sixth_test\")\nloader_module = importlib\nloader_module.import_module(\"seventh_test\")\n(__import__)(\"eighth_test\")\nvalue = rf\"\\{__import__('ninth_test')}\"\nrunpy.run_path(\"private.py\")\n");
    writeFileSync(join(staticRoot, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(staticRoot, "bin", "other_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(staticRoot, "bin", "third_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(staticRoot, "bin", "fourth_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(staticRoot, "bin", "fifth_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(staticRoot, "bin", "sixth_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(staticRoot, "bin", "seventh_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(staticRoot, "bin", "eighth_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(staticRoot, "bin", "ninth_test.py"), "marker = 'fixture-only'\n");
    expect(check(staticRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
      "bin/entry.py: local reference targets excluded test file ./other_test",
      "bin/entry.py: local reference targets excluded test file ./third_test",
      "bin/entry.py: local reference targets excluded test file ./fourth_test",
      "bin/entry.py: local reference targets excluded test file ./fifth_test",
      "bin/entry.py: local reference targets excluded test file ./sixth_test",
      "bin/entry.py: local reference targets excluded test file ./seventh_test",
      "bin/entry.py: local reference targets excluded test file ./eighth_test",
      "bin/entry.py: local reference targets excluded test file ./ninth_test",
      "bin/entry.py: dynamic Python import cannot be verified",
    ]);

    mkdirSync(join(unknownRoot, "bin"), { recursive: true });
    writeFileSync(join(unknownRoot, "bin", "entry.py"), "import importlib\nimportlib.import_module(module_name)\n");
    expect(check(unknownRoot)).toEqual([
      "bin/entry.py: dynamic Python import cannot be verified",
    ]);
  } finally {
    rmSync(staticRoot, { recursive: true, force: true });
    rmSync(unknownRoot, { recursive: true, force: true });
  }
});

test("checks Python fromlists and returned importlib module aliases", () => {
  const staticRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-fromlist-"));
  const unknownRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-fromlist-unknown-"));
  const kwargsRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-fromlist-kwargs-"));
  try {
    mkdirSync(join(staticRoot, "bin", "package"), { recursive: true });
    writeFileSync(join(staticRoot, "bin", "entry.py"), "__import__(\"package\", fromlist=[\"runtime_test\"])\nimp = __import__(\"importlib\")\nimp.import_module(\"runtime_test\")\n");
    writeFileSync(join(staticRoot, "bin", "package", "__init__.py"), "\n");
    writeFileSync(join(staticRoot, "bin", "package", "runtime_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(staticRoot, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(staticRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);

    mkdirSync(join(unknownRoot, "bin", "package"), { recursive: true });
    writeFileSync(join(unknownRoot, "bin", "entry.py"), "names = get_names()\n__import__(\"package\", fromlist=names)\n");
    writeFileSync(join(unknownRoot, "bin", "package", "__init__.py"), "\n");
    expect(check(unknownRoot)).toEqual([
      "bin/entry.py: dynamic Python import cannot be verified",
    ]);

    mkdirSync(join(kwargsRoot, "bin"), { recursive: true });
    writeFileSync(join(kwargsRoot, "bin", "entry.py"), "__import__('package', **options)\n");
    expect(check(kwargsRoot)).toEqual([
      "bin/entry.py: dynamic Python import cannot be verified",
    ]);
  } finally {
    rmSync(staticRoot, { recursive: true, force: true });
    rmSync(unknownRoot, { recursive: true, force: true });
    rmSync(kwargsRoot, { recursive: true, force: true });
  }
});

test("checks Python f-string imports and fails closed for dynamic import expressions", () => {
  const fStringRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-fstring-import-"));
  const expressionRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-expression-import-"));
  const loaderRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-file-loader-"));
  try {
    mkdirSync(join(fStringRoot, "bin"), { recursive: true });
    writeFileSync(join(fStringRoot, "bin", "entry.py"), "literal = f\"{'__import__(module_name)'}\"\nformatted = f\"{value:__import__(module_name)}\"\nvalue = f\"{__import__('runtime_test')}\"\n");
    writeFileSync(join(fStringRoot, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(fStringRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);

    mkdirSync(join(expressionRoot, "bin"), { recursive: true });
    writeFileSync(join(expressionRoot, "bin", "entry.py"), "__import__(\"runtime\" + \"_test\")\n");
    expect(check(expressionRoot)).toEqual([
      "bin/entry.py: dynamic Python import cannot be verified",
    ]);

    mkdirSync(join(loaderRoot, "bin"), { recursive: true });
    writeFileSync(join(loaderRoot, "bin", "entry.py"), "import importlib.util\nimport runpy\nfrom importlib.machinery import SourceFileLoader\nspec = importlib.util.spec_from_file_location(\"runtime\", \"../../private.py\")\nmodule = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nrunpy.run_module(\"runtime\")\nSourceFileLoader(\"runtime\", \"private.py\").load_module()\n");
    expect(check(loaderRoot)).toEqual([
      "bin/entry.py: dynamic Python import cannot be verified",
    ]);
  } finally {
    rmSync(fStringRoot, { recursive: true, force: true });
    rmSync(expressionRoot, { recursive: true, force: true });
    rmSync(loaderRoot, { recursive: true, force: true });
  }
});

test("checks nested Python f-strings, annotated __all__, and loader instances", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-nested-expressions-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "formatted = f\"{1:{__import__('runtime_test')}}\"\nnested = f\"{f'{__import__(module_name)}'}\"\nfrom package import *\nfrom importlib.machinery import SourceFileLoader\nloader = SourceFileLoader(\"runtime\", \"../../private.py\")\nloader.load_module()\nloader.exec_module(None)\n");
    writeFileSync(join(root, "bin", "runtime_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "__all__: list[str] = [\"runtime_test\"]\n");
    writeFileSync(join(root, "bin", "package", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
      "bin/entry.py: dynamic Python import cannot be verified",
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("distinguishes module-scope Python exports from local variables and aliases", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-export-scope-"));
  try {
    mkdirSync(join(root, "bin", "local"), { recursive: true });
    mkdirSync(join(root, "bin", "alias"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from local import runtime_test\nfrom alias import runtime_test\n");
    writeFileSync(join(root, "bin", "local", "__init__.py"), "def factory():\n    runtime_test = 1\n");
    writeFileSync(join(root, "bin", "local", "runtime_test.py"), "marker = 'fixture-only'\n");
    writeFileSync(join(root, "bin", "alias", "__init__.py"), "from .safe import runtime_test as other\n");
    writeFileSync(join(root, "bin", "alias", "safe.py"), "runtime_test = 1\n");
    writeFileSync(join(root, "bin", "alias", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./local/runtime_test",
      "bin/entry.py: local reference targets excluded test file ./alias/runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefers Python package attributes for dynamic fromlists", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-fromlist-attributes-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "__import__(\"package\", fromlist=[\"value\"])\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "value = 1\n");
    writeFileSync(join(root, "bin", "package", "runtime_test.py"), "marker = 'fixture-only'\n");
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checks parenthesized Python loaders and imported file-loader aliases", () => {
  const wrappedRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-wrapped-loaders-"));
  const aliasRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-file-loader-aliases-"));
  try {
    mkdirSync(join(wrappedRoot, "bin"), { recursive: true });
    writeFileSync(join(wrappedRoot, "bin", "entry.py"), "import importlib\n(importlib.import_module)(\"runtime_test\")\n((__import__))(\"other_test\")\nwrapped = (__import__)\nwrapped(\"third_test\")\n");
    for (const name of ["runtime_test", "other_test", "third_test"]) {
      writeFileSync(join(wrappedRoot, "bin", `${name}.py`), "marker = 'fixture-only'\n");
    }
    expect(check(wrappedRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
      "bin/entry.py: local reference targets excluded test file ./other_test",
      "bin/entry.py: local reference targets excluded test file ./third_test",
    ]);

    mkdirSync(join(aliasRoot, "bin"), { recursive: true });
    writeFileSync(join(aliasRoot, "bin", "entry.py"), "from runpy import run_path as execute\nfrom importlib.util import spec_from_file_location as make_spec\ndef run_path(value):\n    return value\nrun_path(\"safe\")\nexecute(\"../../private.py\")\nmake_spec(\"runtime\", \"../../private.py\")\n");
    expect(check(aliasRoot)).toEqual([
      "bin/entry.py: dynamic Python import cannot be verified",
    ]);
  } finally {
    rmSync(wrappedRoot, { recursive: true, force: true });
    rmSync(aliasRoot, { recursive: true, force: true });
  }
});

test("checks Python file-loader identities through module aliases", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-file-loader-identities-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from importlib import util\nfrom importlib import machinery\nimport runpy\nr = runpy\nspec = util.spec_from_file_location(\"runtime\", \"../../private.py\")\nmodule = util.module_from_spec(spec)\nspec.loader.exec_module(module)\nmachinery.SourceFileLoader(\"runtime\", \"../../private.py\").load_module()\nr.run_path(\"../../private.py\")\n");
    expect(check(root)).toEqual([
      "bin/entry.py: dynamic Python import cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores Python f-string examples and unrelated methods with loader-like names", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-loader-name-collisions-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "class Service:\n    def run_path(self, value):\n        return value\n\n# Example: f\"{__import__(module_name)}\"\nService().run_path(\"safe\")\nfrom app import run_path\nrun_path(\"safe\")\n");
    writeFileSync(join(root, "bin", "app.py"), "def run_path(value):\n    return value\n");
    expect(check(root)).toEqual([]);
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

test("scans executable public tools without file extensions", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-extensionless-tool-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    const tool = join(root, "bin", "tool");
    writeFileSync(tool, "echo $CODEX_HOME\n");
    chmodSync(tool, 0o755);
    expect(publicToolFiles(root)).toEqual([tool]);
    expect(check(root)).toEqual([
      "bin/tool: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("follows directory package main entries before the package root index", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-main-directory-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support", "package", "src"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.ts"), 'import "../support/package";\n');
    writeFileSync(join(root, "support", "package", "package.json"), JSON.stringify({ main: "./src" }));
    writeFileSync(join(root, "support", "package", "index.ts"), "export const safe = true;\n");
    writeFileSync(join(root, "support", "package", "src", "index.ts"), 'import "../runtime_test.ts";\n');
    writeFileSync(join(root, "support", "package", "runtime_test.ts"), "export const fixture = true;\n");
    expect(check(root)).toEqual([
      "support/package/src/index.ts: local reference targets excluded test file ../runtime_test.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checks package imports even when a tsconfig path mapping also matches", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-import-path-conflict-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ imports: { "#run": "./runtime_test.ts" } }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "#run": ["./safe.ts"] } } }));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "#run";\n');
    writeFileSync(join(root, "safe.ts"), "export const safe = true;\n");
    writeFileSync(join(root, "runtime_test.ts"), "export const fixture = true;\n");
    expect(check(root)).toEqual([
      "bin/entry.ts: local reference targets excluded test file #run",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not substitute TypeScript sources for an explicit CJS import", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-cjs-extension-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.ts"), 'import "../support/helper.cjs";\n');
    writeFileSync(join(root, "support", "helper.ts"), "export const safe = true;\n");
    writeFileSync(join(root, "support", "helper.cjs.ts"), "export const alsoSafe = true;\n");
    writeFileSync(join(root, "support", "helper.cjs.py"), "value = 1\n");
    expect(check(root)).toEqual([
      "bin/entry.ts: missing local reference ../support/helper.cjs",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not parse JSON import payloads as source", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-json-import-payload-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.ts"), 'import "./data.json";\n');
    writeFileSync(join(root, "bin", "data.json"), JSON.stringify("import './runtime_test.ts'"));
    writeFileSync(join(root, "bin", "runtime_test.ts"), "export const fixture = true;\n");
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("follows jsconfig path mappings", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-jsconfig-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@runtime": ["./runtime_test"] } } }));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "@runtime";\n');
    writeFileSync(join(root, "runtime_test.ts"), "export const fixture = true;\n");
    expect(check(root)).toEqual([
      "bin/entry.ts: local reference targets excluded test file @runtime",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handles Python SourceFileLoader bound method aliases", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-bound-loader-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from importlib.machinery import SourceFileLoader\nloader = SourceFileLoader('runtime', '../../private.py')\nexecute = loader.exec_module\nexecute(module)\n");
    expect(check(root)).toEqual([
      "bin/entry.py: dynamic Python import cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recognizes dotted Python imports exported by package initializers", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-dotted-export-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    mkdirSync(join(root, "bin", "runtime_test"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from .package import runtime_test\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "import runtime_test.helper\n");
    writeFileSync(join(root, "bin", "runtime_test", "helper.py"), "value = 1\n");
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("respects Python function parameter and local assignment shadowing", () => {
  const parameterRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-shadow-parameter-"));
  const assignmentRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-shadow-assignment-"));
  const laterAssignmentRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-shadow-later-assignment-"));
  const conditionalAssignmentRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-shadow-conditional-assignment-"));
  try {
    mkdirSync(join(parameterRoot, "bin"), { recursive: true });
    writeFileSync(join(parameterRoot, "bin", "entry.py"), "from importlib import import_module\ndef dispatch(import_module):\n    import_module('runtime_test')\n    def nested():\n        import_module('runtime_test')\n    nested()\ndispatch(import_module)\n");
    writeFileSync(join(parameterRoot, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(parameterRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);

    mkdirSync(join(assignmentRoot, "bin"), { recursive: true });
    writeFileSync(join(assignmentRoot, "bin", "entry.py"), "from importlib import import_module\ndef dispatch():\n    import_module = lambda value: value\n    import_module('runtime_test')\ndispatch()\n");
    writeFileSync(join(assignmentRoot, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(assignmentRoot)).toEqual([]);

    mkdirSync(join(laterAssignmentRoot, "bin"), { recursive: true });
    writeFileSync(join(laterAssignmentRoot, "bin", "entry.py"), "from importlib import import_module\ndef dispatch():\n    import_module('runtime_test')\n    import_module = lambda value: value\ndispatch()\n");
    writeFileSync(join(laterAssignmentRoot, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(laterAssignmentRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);

    mkdirSync(join(conditionalAssignmentRoot, "bin"), { recursive: true });
    writeFileSync(join(conditionalAssignmentRoot, "bin", "entry.py"), "from importlib import import_module\ndef dispatch():\n    if False:\n        import_module = lambda value: value\n    import_module('runtime_test')\ndispatch()\n");
    writeFileSync(join(conditionalAssignmentRoot, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(conditionalAssignmentRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);
  } finally {
    rmSync(parameterRoot, { recursive: true, force: true });
    rmSync(assignmentRoot, { recursive: true, force: true });
    rmSync(laterAssignmentRoot, { recursive: true, force: true });
    rmSync(conditionalAssignmentRoot, { recursive: true, force: true });
  }
});

test("does not treat Shell arithmetic shifts as heredoc declarations", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-arithmetic-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), "(( 1 << 1 ))\nsource ../support/after-arithmetic.sh\n");
    writeFileSync(join(root, "support", "after-arithmetic.sh"), "echo $CODEX_HOME\n");
    expect(check(root)).toEqual([
      "support/after-arithmetic.sh: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("converges Unicode and builtin member Python import aliases", () => {
  const unicodeRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-unicode-alias-"));
  const accessRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-builtin-access-"));
  try {
    mkdirSync(join(unicodeRoot, "bin"), { recursive: true });
    writeFileSync(join(unicodeRoot, "bin", "entry.py"), "模块 = __import__\n模块('runtime_test')\n");
    writeFileSync(join(unicodeRoot, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(unicodeRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);

    mkdirSync(join(accessRoot, "bin", "package"), { recursive: true });
    writeFileSync(join(accessRoot, "bin", "entry.py"), "loader = getattr(__builtins__, '__import__')\nloader('runtime_test')\nother = __builtins__['__import__']\nother('runtime_test')\n__builtins__.__import__('runtime_test')\ngetattr(__builtins__, '__import__')('package', ')', ')', ['runtime_test'])\n");
    writeFileSync(join(accessRoot, "bin", "runtime_test.py"), "value = 1\n");
    writeFileSync(join(accessRoot, "bin", "package", "__init__.py"), "value = 1\n");
    writeFileSync(join(accessRoot, "bin", "package", "runtime_test.py"), "value = 1\n");
    expect(check(accessRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);
  } finally {
    rmSync(unicodeRoot, { recursive: true, force: true });
    rmSync(accessRoot, { recursive: true, force: true });
  }
});

test("checks indirect builtin imports, masks examples, and rejects external package initializers", () => {
  const accessRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-builtin-fromlist-"));
  const maskedRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-builtin-masked-"));
  const packageRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-external-package-"));
  const outside = join(packageRoot, "..", `${packageRoot.split(/[\\/]/).at(-1)}-outside`);
  try {
    mkdirSync(join(accessRoot, "bin", "package"), { recursive: true });
    writeFileSync(join(accessRoot, "bin", "entry.py"), "import builtins\ngetattr(builtins, '__import__')('package', fromlist=['runtime_test'])\n");
    writeFileSync(join(accessRoot, "bin", "package", "__init__.py"), "value = 1\n");
    writeFileSync(join(accessRoot, "bin", "package", "runtime_test.py"), "value = 1\n");
    expect(check(accessRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
    ]);

    mkdirSync(join(maskedRoot, "bin"), { recursive: true });
    writeFileSync(join(maskedRoot, "bin", "entry.py"), "message = \"getattr(__builtins__, '__import__')('runtime_test')\"\n# getattr(__builtins__, '__import__')('runtime_test')\n");
    writeFileSync(join(maskedRoot, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(maskedRoot)).toEqual([]);

    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(packageRoot, "bin", "entry.py"), "from pkg import *\n");
    writeFileSync(join(outside, "__init__.py"), "__all__ = ['outside_canary']\n");
    symlinkSync(outside, join(packageRoot, "bin", "pkg"), "dir");
    expect(check(packageRoot)).toEqual([
      "bin/pkg: symbolic link escapes public tool boundary",
      "bin/entry.py: local reference resolves outside public repository ./pkg",
    ]);
  } finally {
    rmSync(accessRoot, { recursive: true, force: true });
    rmSync(maskedRoot, { recursive: true, force: true });
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("accepts TypeScript paths that resolve through an in-repository parent directory", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-tsconfig-parent-path-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@shared/*": ["../support/*"] } } }));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "@shared/value";\n');
    writeFileSync(join(root, "support", "value.ts"), "export const value = 1;\n");
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selects the dependency parser from executable-tool shebangs", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shebang-tools-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    const pythonTool = join(root, "bin", "python-tool");
    const shellTool = join(root, "bin", "shell-tool");
    const nodeTool = join(root, "bin", "node-tool");
    const nodeParameterTool = join(root, "bin", "node-parameter-tool");
    const quotedPythonTool = join(root, "bin", "quoted-python-tool.py");
    const assignedPythonTool = join(root, "bin", "assigned-python-tool.py");
    const unsetPythonTool = join(root, "bin", "unset-python-tool.py");
    const compactPythonTool = join(root, "bin", "compact-python-tool.py");
    const clusteredPythonTool = join(root, "bin", "clustered-python-tool.py");
    const independentVerbosePythonTool = join(root, "bin", "independent-verbose-python-tool.py");
    const pathPythonTool = join(root, "bin", "path-python-tool.py");
    const splitDelimiterPythonTool = join(root, "bin", "split-delimiter-python-tool.py");
    const clusteredShellTool = join(root, "bin", "clustered-shell-tool");
    const chdirShellTool = join(root, "bin", "chdir-shell-tool");
    writeFileSync(pythonTool, "#!/usr/bin/env python3\n__import__('runtime_test')\n");
    writeFileSync(shellTool, "#!/bin/sh\n. ../support/private.sh\n");
    writeFileSync(nodeTool, "#!/usr/bin/env node\nrequire('../support/runtime_test.js')\n");
    writeFileSync(nodeParameterTool, "#!/usr/bin/env -S node --title=python\nimport '../support/parameter_runtime_test.js';\n");
    writeFileSync(quotedPythonTool, "#!/usr/bin/env -S 'python3'\n__import__('runtime_test')\n");
    writeFileSync(assignedPythonTool, "#!/usr/bin/env -S PYTHONUNBUFFERED=1 python3\n__import__('runtime_test')\n");
    writeFileSync(unsetPythonTool, "#!/usr/bin/env -u REVIEW_FLAG python3\n__import__('runtime_test')\n");
    writeFileSync(compactPythonTool, "#!/usr/bin/env -Spython3\n__import__('runtime_test')\n");
    writeFileSync(clusteredPythonTool, "#!/usr/bin/env -vS python3\n__import__('runtime_test')\n");
    writeFileSync(independentVerbosePythonTool, "#!/usr/bin/env -S -v python3\n__import__('runtime_test')\n");
    writeFileSync(pathPythonTool, "#!/usr/bin/env -S -P /usr/bin python3\n__import__('runtime_test')\n");
    writeFileSync(splitDelimiterPythonTool, "#!/usr/bin/env -S - python3\n__import__('runtime_test')\n");
    writeFileSync(clusteredShellTool, "#!/usr/bin/env -iSbash\n. ../support/clustered-private.sh\n");
    writeFileSync(chdirShellTool, "#!/usr/bin/env -S -C /outside bash\n. ./helper.sh\n");
    chmodSync(pythonTool, 0o755);
    chmodSync(shellTool, 0o755);
    chmodSync(nodeTool, 0o755);
    chmodSync(nodeParameterTool, 0o755);
    chmodSync(clusteredShellTool, 0o755);
    chmodSync(chdirShellTool, 0o755);
    writeFileSync(join(root, "bin", "runtime_test.py"), "value = 1\n");
    writeFileSync(join(root, "support", "private.sh"), "echo $CODEX_HOME\n");
    writeFileSync(join(root, "support", "clustered-private.sh"), "echo $CODEX_HOME\n");
    writeFileSync(join(root, "support", "runtime_test.js"), "export const value = 1;\n");
    writeFileSync(join(root, "support", "parameter_runtime_test.js"), "export const value = 1;\n");
    expect(check(root)).toEqual([
      "bin/assigned-python-tool.py: local reference targets excluded test file ./runtime_test",
      "bin/chdir-shell-tool: dynamic Shell source cannot be verified",
      "bin/clustered-python-tool.py: local reference targets excluded test file ./runtime_test",
      "bin/compact-python-tool.py: local reference targets excluded test file ./runtime_test",
      "bin/independent-verbose-python-tool.py: local reference targets excluded test file ./runtime_test",
      "bin/node-parameter-tool: local reference targets excluded test file ../support/parameter_runtime_test.js",
      "bin/node-tool: dynamic import or require cannot be verified",
      "bin/node-tool: local reference targets excluded test file ../support/runtime_test.js",
      "bin/path-python-tool.py: local reference targets excluded test file ./runtime_test",
      "bin/python-tool: local reference targets excluded test file ./runtime_test",
      "bin/quoted-python-tool.py: local reference targets excluded test file ./runtime_test",
      "bin/split-delimiter-python-tool.py: local reference targets excluded test file ./runtime_test",
      "bin/unset-python-tool.py: local reference targets excluded test file ./runtime_test",
      "support/clustered-private.sh: forbidden public tool coupling codex-runtime-marker",
      "support/private.sh: forbidden public tool coupling codex-runtime-marker",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps Python loader detection for local imports and separated function scopes", () => {
  const localImportRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-local-import-"));
  const separatedScopeRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-separated-scope-"));
  try {
    mkdirSync(join(localImportRoot, "bin"), { recursive: true });
    writeFileSync(join(localImportRoot, "bin", "entry.py"), "def run():\n    from importlib import import_module\n    import_module('runtime_test')\nrun()\n");
    writeFileSync(join(localImportRoot, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(localImportRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);

    mkdirSync(join(separatedScopeRoot, "bin"), { recursive: true });
    writeFileSync(join(separatedScopeRoot, "bin", "entry.py"), "def unrelated(__import__):\n    pass\n\ndef run():\n    __import__('runtime_test')\n\nrun()\n");
    writeFileSync(join(separatedScopeRoot, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(separatedScopeRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);
  } finally {
    rmSync(localImportRoot, { recursive: true, force: true });
    rmSync(separatedScopeRoot, { recursive: true, force: true });
  }
});

test("does not let nested Python scopes shadow their outer loader", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-nested-scope-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "import importlib\ndef outer():\n    def inner():\n        importlib = object()\n    return importlib.import_module('runtime_test')\nouter()\n");
    writeFileSync(join(root, "bin", "restored.py"), "import importlib\ndef outer():\n    loader = None\n    def inner():\n        loader = importlib.import_module\n        loader('runtime_test')\n    inner()\nouter()\n");
    writeFileSync(join(root, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
      "bin/restored.py: local reference targets excluded test file ./runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects Unicode runpy file-loader aliases", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-unicode-file-loader-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from runpy import run_path as 执行\n执行('../../private.py')\n");
    expect(check(root)).toEqual([
      "bin/entry.py: dynamic Python import cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("treats Shell parameter-expanded sources as dynamic", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-parameter-expansion-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), "DIR=support\n. \"$DIR/helper.sh\"\n");
    writeFileSync(join(root, "support", "helper.sh"), "echo $CODEX_HOME\n");
    expect(check(root)).toEqual([
      "bin/entry.sh: dynamic Shell source cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects package self subpaths hidden by a root-only exports entry", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-root-exports-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-package", exports: "./safe.ts" }));
    writeFileSync(join(root, "safe.ts"), "export const safe = true;\n");
    writeFileSync(join(root, "bin", "entry.ts"), 'import "fixture-package/missing";\n');
    expect(check(root)).toEqual([
      "bin/entry.ts: local package import cannot be verified fixture-package/missing",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not inherit a parent paths table after a child replaces it", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-tsconfig-paths-replaced-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "./base.json", compilerOptions: { paths: {} } }));
    writeFileSync(join(root, "base.json"), JSON.stringify({ compilerOptions: { paths: { "@run": ["./runtime_test.ts"] } } }));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "@run";\n');
    writeFileSync(join(root, "runtime_test.ts"), "export const fixture = true;\n");
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not treat conditional Python package exports as definite", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-conditional-exports-"));
  try {
    mkdirSync(join(root, "bin", "false_export"), { recursive: true });
    mkdirSync(join(root, "bin", "false_all"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from .false_export import runtime_test\nfrom .false_all import *\n");
    writeFileSync(join(root, "bin", "false_export", "__init__.py"), "if False:\n    runtime_test = 1\n");
    writeFileSync(join(root, "bin", "false_all", "__init__.py"), "if False:\n    __all__ = ['runtime_test']\n");
    writeFileSync(join(root, "bin", "false_all", "runtime_test.py"), "value = 1\n");
    expect(check(root)).toEqual([
      "bin/entry.py: missing local reference ./false_export/runtime_test",
      "bin/entry.py: wildcard Python import cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not report shared package-import branches as cycles", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-import-shared-branch-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ imports: {
      "#a": "./a.ts",
      "#b": "./b.ts",
      "#shared": "./shared.ts",
    } }));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "#a";\nimport "#b";\n');
    writeFileSync(join(root, "a.ts"), 'import "#shared";\n');
    writeFileSync(join(root, "b.ts"), 'import "#shared";\n');
    writeFileSync(join(root, "shared.ts"), "export const safe = true;\n");
    expect(check(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for cyclic package import aliases", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-package-import-cycle-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ imports: { "#a": "#b", "#b": "#a" } }));
    writeFileSync(join(root, "bin", "entry.ts"), 'import "#a";\n');
    expect(check(root)).toEqual([
      "bin/entry.ts: local package import cannot be verified #a",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects case-insensitive and single-slash file URLs", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-file-url-"));
  const outside = join(root, "..", `${root.split(/[\\/]/).at(-1)}-outside.mjs`);
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.mjs"), `import "FILE://${outside}";\nimport "file:${outside}";\n`);
    expect(check(root)).toEqual([
      `bin/entry.mjs: local reference outside public repository FILE://${outside}`,
      `bin/entry.mjs: local reference outside public repository file:${outside}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("resolves JavaScript module URLs before applying repository boundaries", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-module-url-resolution-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "%2e%2e"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.mjs"), 'import "./safe.mjs?fixture=1#fragment";\nimport "../%2e%2e/private.mjs";\n');
    writeFileSync(join(root, "bin", "safe.mjs"), "export const safe = true;\n");
    writeFileSync(join(root, "%2e%2e", "private.mjs"), "export const safe = true;\n");
    const encodedFileTarget = join(root, "support", "helper.mjs#private.mjs");
    writeFileSync(join(root, "bin", "file-url-entry.mjs"), `import "file://${encodedFileTarget.replaceAll("#", "%23")}";\n`);
    writeFileSync(join(root, "support", "helper.mjs"), "export const safe = true;\n");
    writeFileSync(encodedFileTarget, 'import "/outside/private.mjs";\n');
    const absoluteEntry = join(root, "bin", "absolute-entry.mjs");
    const encodedAbsoluteTarget = join(root, "support", "absolute%23private.mjs");
    const decodedAbsoluteTarget = join(root, "support", "absolute#private.mjs");
    writeFileSync(absoluteEntry, `import "${encodedAbsoluteTarget}";\n`);
    writeFileSync(encodedAbsoluteTarget, "export const safe = true;\n");
    writeFileSync(decodedAbsoluteTarget, 'import "/outside/absolute-private.mjs";\n');
    expect(check(root)).toEqual([
      "bin/entry.mjs: local reference outside public repository ../%2e%2e/private.mjs",
      "support/absolute#private.mjs: local reference outside public repository /outside/absolute-private.mjs",
      "support/helper.mjs#private.mjs: local reference outside public repository /outside/private.mjs",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps JavaScript extension and language resolution boundaries", () => {
  const extensionRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-mjs-extension-"));
  const languageRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-language-candidates-"));
  const shebangRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shebang-extension-"));
  try {
    mkdirSync(join(extensionRoot, "bin"), { recursive: true });
    writeFileSync(join(extensionRoot, "bin", "entry.mjs"), 'import "./helper.mjs";\n');
    writeFileSync(join(extensionRoot, "bin", "helper.ts"), "export const safe = true;\n");
    expect(check(extensionRoot)).toEqual([
      "bin/entry.mjs: missing local reference ./helper.mjs",
    ]);

    mkdirSync(join(languageRoot, "bin"), { recursive: true });
    mkdirSync(join(languageRoot, "support", "helper"), { recursive: true });
    writeFileSync(join(languageRoot, "bin", "entry.ts"), 'import "../support/helper";\n');
    writeFileSync(join(languageRoot, "support", "helper.py"), "value = 1\n");
    writeFileSync(join(languageRoot, "support", "helper", "index.ts"), 'export const marker = "$CODEX_HOME";\n');
    expect(check(languageRoot)).toEqual([
      "support/helper/index.ts: forbidden public tool coupling codex-runtime-marker",
    ]);

    mkdirSync(join(shebangRoot, "bin"), { recursive: true });
    mkdirSync(join(shebangRoot, "support"), { recursive: true });
    const tool = join(shebangRoot, "bin", "entry.cli");
    writeFileSync(tool, "#!/usr/bin/env node\nimport '../support/runtime_test.js';\n");
    chmodSync(tool, 0o755);
    writeFileSync(join(shebangRoot, "support", "runtime_test.js"), "export const fixture = true;\n");
    expect(check(shebangRoot)).toEqual([
      "bin/entry.cli: local reference targets excluded test file ../support/runtime_test.js",
    ]);
  } finally {
    rmSync(extensionRoot, { recursive: true, force: true });
    rmSync(languageRoot, { recursive: true, force: true });
    rmSync(shebangRoot, { recursive: true, force: true });
  }
});

test("fails closed for Node builtin module loaders and invalid package exports", () => {
  const loaderRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-builtin-module-loader-"));
  const exportsRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-invalid-package-exports-"));
  try {
    mkdirSync(join(loaderRoot, "bin"), { recursive: true });
    writeFileSync(join(loaderRoot, "bin", "entry.cjs"), "process.getBuiltinModule('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "alias.cjs"), "const p = process; p.getBuiltinModule('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "imported.cjs"), "import p from 'node:process'; p.getBuiltinModule('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "destructured.cjs"), "const p = process; const { getBuiltinModule: load } = p; load('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "named.cjs"), "import { getBuiltinModule as load } from 'node:process'; load('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "dynamic-import.cjs"), "async function run() { const { default: p } = await import('node:process'); p.getBuiltinModule('module')._load('../../private.cjs', module, false) }\nrun()\n");
    writeFileSync(join(loaderRoot, "bin", "assignment.cjs"), "let load; ({ getBuiltinModule: load } = process); load('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "global.cjs"), "globalThis.process.getBuiltinModule('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "global-alias.cjs"), "const g = globalThis; g.process.getBuiltinModule('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "namespace-default.cjs"), "import * as p from 'node:process'; p.default.getBuiltinModule('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "then.cjs"), "import('node:process').then(p => p.getBuiltinModule('module')._load('../../private.cjs', module, false))\n");
    writeFileSync(join(loaderRoot, "bin", "named-then.cjs"), "const callback = p => p.getBuiltinModule('module')._load('../../private.cjs', module, false); const promise = import('node:process'); promise.then(callback)\n");
    writeFileSync(join(loaderRoot, "bin", "computed.cjs"), "const { ['get' + 'BuiltinModule']: load } = process; load('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "unknown-computed.cjs"), "const key = 'getBuiltinModule'; const { [key]: load } = process; load('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "assignment-global.cjs"), "let p; ({ process: p } = globalThis); p.getBuiltinModule('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "computed-call.cjs"), "(0, process['getBuiltinModule'])('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "computed-object.cjs"), "const box = { load: process['getBuiltinModule'] }; box.load('module')._load('../../private.cjs', module, false)\n");
    writeFileSync(join(loaderRoot, "bin", "spread.cjs"), "const p = { ...process }; p.getBuiltinModule('module')._load('../../private.cjs', module, false)\n");
    expect(check(loaderRoot)).toEqual([
      "bin/alias.cjs: dynamic import or require cannot be verified",
      "bin/assignment-global.cjs: dynamic import or require cannot be verified",
      "bin/assignment.cjs: dynamic import or require cannot be verified",
      "bin/computed-call.cjs: dynamic import or require cannot be verified",
      "bin/computed-object.cjs: dynamic import or require cannot be verified",
      "bin/computed.cjs: dynamic import or require cannot be verified",
      "bin/destructured.cjs: dynamic import or require cannot be verified",
      "bin/dynamic-import.cjs: dynamic import or require cannot be verified",
      "bin/entry.cjs: dynamic import or require cannot be verified",
      "bin/global-alias.cjs: dynamic import or require cannot be verified",
      "bin/global.cjs: dynamic import or require cannot be verified",
      "bin/imported.cjs: dynamic import or require cannot be verified",
      "bin/named-then.cjs: dynamic import or require cannot be verified",
      "bin/named.cjs: dynamic import or require cannot be verified",
      "bin/namespace-default.cjs: dynamic import or require cannot be verified",
      "bin/spread.cjs: dynamic import or require cannot be verified",
      "bin/then.cjs: dynamic import or require cannot be verified",
      "bin/unknown-computed.cjs: dynamic import or require cannot be verified",
    ]);

    mkdirSync(join(exportsRoot, "bin"), { recursive: true });
    writeFileSync(join(exportsRoot, "package.json"), JSON.stringify({ name: "fixture-package", exports: "node:fs" }));
    writeFileSync(join(exportsRoot, "bin", "entry.ts"), 'import "fixture-package";\n');
    expect(check(exportsRoot)).toEqual([
      "bin/entry.ts: local package import cannot be verified fixture-package",
    ]);
  } finally {
    rmSync(loaderRoot, { recursive: true, force: true });
    rmSync(exportsRoot, { recursive: true, force: true });
  }
});

test("handles Python loader rebinding, relative levels, and wildcard failures", () => {
  const reboundRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-loader-rebound-"));
  const levelRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-import-level-"));
  const wildcardRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-wildcard-missing-"));
  const deletedRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-deleted-export-"));
  const deletedImportRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-deleted-import-export-"));
  try {
    mkdirSync(join(reboundRoot, "bin"), { recursive: true });
    writeFileSync(join(reboundRoot, "bin", "entry.py"), "import importlib\ndef run():\n    loader = None\n    loader = importlib.import_module\n    loader('runtime_test')\nrun()\n");
    writeFileSync(join(reboundRoot, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(reboundRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
    ]);

    mkdirSync(join(levelRoot, "bin", "pkg", "child"), { recursive: true });
    writeFileSync(join(levelRoot, "bin", "pkg", "__init__.py"), "\n");
    writeFileSync(join(levelRoot, "bin", "pkg", "entry.py"), "__import__('child', globals(), locals(), ['runtime_test'], 1)\n");
    writeFileSync(join(levelRoot, "bin", "pkg", "child", "__init__.py"), "\n");
    writeFileSync(join(levelRoot, "bin", "pkg", "child", "runtime_test.py"), "value = 1\n");
    expect(check(levelRoot)).toEqual([
      "bin/pkg/entry.py: local reference targets excluded test file ./child/runtime_test",
    ]);

    mkdirSync(join(wildcardRoot, "bin", "package"), { recursive: true });
    writeFileSync(join(wildcardRoot, "bin", "entry.py"), "from package import *\n");
    writeFileSync(join(wildcardRoot, "bin", "package", "__init__.py"), "__all__ = ['missing']\n");
    expect(check(wildcardRoot)).toEqual([
      "bin/entry.py: missing local reference ./package/missing",
    ]);

    mkdirSync(join(deletedRoot, "bin", "package"), { recursive: true });
    writeFileSync(join(deletedRoot, "bin", "entry.py"), "from package import runtime_test\n");
    writeFileSync(join(deletedRoot, "bin", "package", "__init__.py"), "runtime_test = None\ndel runtime_test\n");
    writeFileSync(join(deletedRoot, "bin", "package", "runtime_test.py"), "value = 1\n");
    expect(check(deletedRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
    ]);

    mkdirSync(join(deletedImportRoot, "bin", "package"), { recursive: true });
    writeFileSync(join(deletedImportRoot, "bin", "entry.py"), "from package import runtime_test\n");
    writeFileSync(join(deletedImportRoot, "bin", "package", "__init__.py"), "from math import pi as runtime_test\ndel runtime_test\n");
    writeFileSync(join(deletedImportRoot, "bin", "package", "runtime_test.py"), "value = 1\n");
    expect(check(deletedImportRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
    ]);
  } finally {
    rmSync(reboundRoot, { recursive: true, force: true });
    rmSync(levelRoot, { recursive: true, force: true });
    rmSync(wildcardRoot, { recursive: true, force: true });
    rmSync(deletedRoot, { recursive: true, force: true });
    rmSync(deletedImportRoot, { recursive: true, force: true });
  }
});

test("fails closed for uncertain Python loader state and export deletion", () => {
  const loaderRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-uncertain-loader-"));
  const exportRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-uncertain-export-"));
  const allRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-uncertain-all-"));
  const semicolonRoot = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-semicolon-delete-"));
  try {
    mkdirSync(join(loaderRoot, "bin"), { recursive: true });
    writeFileSync(join(loaderRoot, "bin", "entry.py"), "import importlib\ndef run(flag):\n    loader = None\n    if flag:\n        loader = importlib.import_module\n    loader('runtime_test')\nrun(True)\n");
    writeFileSync(join(loaderRoot, "bin", "inline-entry.py"), "import importlib\ndef run(flag):\n    loader = None\n    if flag: loader = importlib.import_module\n    loader('runtime_test')\nrun(True)\n");
    writeFileSync(join(loaderRoot, "bin", "inline-order.py"), "import importlib\ndef run():\n    loader = None\n    if True: loader = importlib.import_module; loader('runtime_test')\nrun()\n");
    writeFileSync(join(loaderRoot, "bin", "runtime_test.py"), "value = 1\n");
    expect(check(loaderRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./runtime_test",
      "bin/inline-entry.py: local reference targets excluded test file ./runtime_test",
      "bin/inline-order.py: local reference targets excluded test file ./runtime_test",
    ]);

    mkdirSync(join(exportRoot, "bin", "package"), { recursive: true });
    writeFileSync(join(exportRoot, "bin", "entry.py"), "from package import runtime_test\n");
    writeFileSync(join(exportRoot, "bin", "package", "__init__.py"), "runtime_test = 1\nif flag:\n    del runtime_test\n");
    writeFileSync(join(exportRoot, "bin", "package", "runtime_test.py"), "value = 1\n");
    expect(check(exportRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
    ]);

    mkdirSync(join(allRoot, "bin", "imported"), { recursive: true });
    mkdirSync(join(allRoot, "bin", "aliased"), { recursive: true });
    mkdirSync(join(allRoot, "bin", "deleted"), { recursive: true });
    writeFileSync(join(allRoot, "bin", "entry-imported.py"), "from imported import *\n");
    writeFileSync(join(allRoot, "bin", "entry-aliased.py"), "from aliased import *\n");
    writeFileSync(join(allRoot, "bin", "entry-deleted.py"), "from deleted import *\n");
    writeFileSync(join(allRoot, "bin", "imported", "__init__.py"), "from other import __all__\n");
    writeFileSync(join(allRoot, "bin", "aliased", "__init__.py"), "__all__ = ['runtime_test']\nnames = __all__\n");
    writeFileSync(join(allRoot, "bin", "deleted", "__init__.py"), "__all__ = ['runtime_test']\ndel __all__\n");
    expect(check(allRoot)).toEqual([
      "bin/entry-aliased.py: wildcard Python import cannot be verified",
      "bin/entry-deleted.py: wildcard Python import cannot be verified",
      "bin/entry-imported.py: wildcard Python import cannot be verified",
    ]);

    mkdirSync(join(semicolonRoot, "bin", "package"), { recursive: true });
    writeFileSync(join(semicolonRoot, "bin", "entry.py"), "from package import runtime_test\n");
    writeFileSync(join(semicolonRoot, "bin", "package", "__init__.py"), "from math import pi as runtime_test; del runtime_test\nruntime_test = 1\nif True: del runtime_test\n");
    writeFileSync(join(semicolonRoot, "bin", "package", "runtime_test.py"), "value = 1\n");
    expect(check(semicolonRoot)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
    ]);
  } finally {
    rmSync(loaderRoot, { recursive: true, force: true });
    rmSync(exportRoot, { recursive: true, force: true });
    rmSync(allRoot, { recursive: true, force: true });
    rmSync(semicolonRoot, { recursive: true, force: true });
  }
});

test("fails closed for Python exec calls and aliases", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-exec-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "alias.py"), "alias = exec\nalias(\"import runpy; runpy.run_path('../../private.py')\")\n");
    writeFileSync(join(root, "bin", "direct.py"), "exec(\"import runpy; runpy.run_path('../../private.py')\")\n");
    writeFileSync(join(root, "bin", "eval.py"), "eval(\"__import__('runpy').run_path('../../private.py')\")\n");
    writeFileSync(join(root, "bin", "imported.py"), "from builtins import exec as run\nrun(\"import runpy; runpy.run_path('../../private.py')\")\n");
    writeFileSync(join(root, "bin", "wrapped.py"), "(exec)(\"import runpy; runpy.run_path('../../private.py')\")\n");
    writeFileSync(join(root, "bin", "parenthesized-alias.py"), "execute = (exec)\nexecute(\"import runpy; runpy.run_path('../../private.py')\")\n");
    writeFileSync(join(root, "bin", "parenthesized-member.py"), "import builtins\n(builtins.exec)(\"import runpy; runpy.run_path('../../private.py')\")\n");
    expect(check(root)).toEqual([
      "bin/alias.py: dynamic Python import cannot be verified",
      "bin/direct.py: dynamic Python import cannot be verified",
      "bin/eval.py: dynamic Python import cannot be verified",
      "bin/imported.py: dynamic Python import cannot be verified",
      "bin/parenthesized-alias.py: dynamic Python import cannot be verified",
      "bin/parenthesized-member.py: dynamic Python import cannot be verified",
      "bin/wrapped.py: dynamic Python import cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for converged Python builtins exec aliases and indirect access", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-exec-alias-convergence-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "module-alias.py"), "import builtins\nb = builtins\nb.exec(\"hidden\")\n");
    writeFileSync(join(root, "bin", "import-alias.py"), "b = __import__(\"builtins\")\nb.exec(\"hidden\")\n");
    writeFileSync(join(root, "bin", "getattr.py"), "import builtins\ngetattr(builtins, \"exec\")('hidden')\n");
    writeFileSync(join(root, "bin", "saved-getattr.py"), "import builtins\nexecute = getattr(builtins, \"exec\")\nexecute('hidden')\n");
    writeFileSync(join(root, "bin", "builtins-dict.py"), "import builtins\nb = vars(builtins)\nb[\"exec\"]('hidden')\n");
    writeFileSync(join(root, "bin", "continued.py"), "import builtins\nbuiltins \\\n    .exec('hidden')\n");
    expect(check(root)).toEqual([
      "bin/builtins-dict.py: dynamic Python import cannot be verified",
      "bin/continued.py: dynamic Python import cannot be verified",
      "bin/getattr.py: dynamic Python import cannot be verified",
      "bin/import-alias.py: dynamic Python import cannot be verified",
      "bin/module-alias.py: dynamic Python import cannot be verified",
      "bin/saved-getattr.py: dynamic Python import cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scans Python wildcard exports assigned in deterministic inline suites", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-python-inline-all-"));
  try {
    mkdirSync(join(root, "bin", "package"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.py"), "from package import *\n");
    writeFileSync(join(root, "bin", "package", "__init__.py"), "if True: __all__ = ['runtime_test']\n");
    writeFileSync(join(root, "bin", "package", "runtime_test.py"), "value = 1\n");
    expect(check(root)).toEqual([
      "bin/entry.py: local reference targets excluded test file ./package/runtime_test",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("propagates shell working-directory changes through sourced files", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "agent-toolkit-tool-boundary-shell-sourced-cwd-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "support"), { recursive: true });
    writeFileSync(join(root, "bin", "entry.sh"), ". ../support/setup.sh\n. ../helper.sh\n");
    writeFileSync(join(root, "support", "setup.sh"), "cd support\n");
    writeFileSync(join(root, "helper.sh"), "echo $CODEX_HOME\n");
    writeFileSync(join(root, "support", "helper.sh"), "echo safe\n");
    expect(check(root)).toEqual([
      "bin/entry.sh: dynamic Shell source cannot be verified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
