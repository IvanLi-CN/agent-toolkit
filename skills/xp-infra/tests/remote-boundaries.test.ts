import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";

const SCRIPT_DIR = join(import.meta.dir, "../scripts");

async function projectXrayApi(scriptName: string, input: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const source = await readFile(join(SCRIPT_DIR, scriptName), "utf8");
  const start = source.indexOf("project_xray_api() {");
  const end = source.indexOf("\nbounded_projected_command", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const child = Bun.spawn({
    cmd: ["sh", "-c", `${source.slice(start, end)}\nproject_xray_api`],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(input);
  child.stdin.end();
  await child.exited;
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode: child.exitCode ?? 1, stdout, stderr };
}

test("remote Xray projection keeps only inbound tag and receiver-port metadata", async () => {
  const privateField = ["pass", "word"].join("");
  const privateCanary = ["SECRET", "PASSWORD", "CANARY"].join("-");
  const input = JSON.stringify({
    inbounds: [
      {
        tag: "vless-vision-endpoint-1",
        settings: { clients: [{ id: "SECRET-CLIENT-CANARY", tag: "SECRET-TAG-CANARY" }] },
        receiverSettings: { type: "xray.app.proxyman.ReceiverConfig", portList: 443 },
      },
      { tag: "bootstrap", settings: { [privateField]: privateCanary } },
    ],
    outbounds: [{ tag: "SECRET-OUTBOUND-CANARY" }],
  });
  for (const scriptName of ["xp-infra-audit-remote", "xp-infra-port-preflight-remote"]) {
    const result = await projectXrayApi(scriptName, input);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("SECRET-");
    expect(JSON.parse(result.stdout)).toEqual({
      inbounds: [
        { tag: "vless-vision-endpoint-1", receiverSettings: { type: "xray.app.proxyman.ReceiverConfig", portList: 443 } },
        { tag: "bootstrap" },
      ],
    });
  }
});

test("remote probes keep private path and configuration boundaries explicit", async () => {
  const audit = await readFile(join(SCRIPT_DIR, "xp-infra-audit-remote"), "utf8");
  const preflight = await readFile(join(SCRIPT_DIR, "xp-infra-port-preflight-remote"), "utf8");
  for (const source of [audit, preflight]) {
    expect(source).toContain('while [ "$path" != "/" ]');
    expect(source).toContain('[ ! -L "$path" ]');
    expect(source).not.toContain('[ -e "$path" ] || break');
    expect(source).toContain("project_xray_api");
    expect(source).toContain("xray_api_required");
    expect(source).not.toContain('cat "$env_file"');
  }
  expect(audit).toContain("validate_xray_api_addr");
});
