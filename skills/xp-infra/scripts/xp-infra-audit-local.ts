#!/usr/bin/env bun

import { emitRecords, normalizeBasic, normalizePublicHealth, ValidationError } from "./xp-infra-core.ts";

export function main(args: string[] = Bun.argv.slice(2), input = ""): number {
  const mode = args[0] ?? "";
  try {
    if (mode === "basic") {
      process.stdout.write(`${emitRecords(normalizeBasic(input))}\n`);
      return 0;
    }
    if (mode === "public-health") {
      process.stdout.write(`${emitRecords(normalizePublicHealth(input))}\n`);
      return 0;
    }
    throw new ValidationError("usage: xp-infra-audit-local basic|public-health");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`audit response invalid: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  const input = await Bun.stdin.text();
  process.exitCode = main(Bun.argv.slice(2), input);
}
