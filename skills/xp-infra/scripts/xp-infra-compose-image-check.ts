#!/usr/bin/env bun

import { isExactComposeImage } from "./xp-infra-core.ts";

export function main(args: string[] = Bun.argv.slice(2), input = ""): number {
  if (args.length !== 1 || !args[0]) {
    console.error("usage: xp-infra-compose-image-check EXPECTED_IMAGE");
    return 2;
  }
  return isExactComposeImage(input, args[0] ?? "") ? 0 : 1;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  process.exitCode = main(args, args.length === 1 && Boolean(args[0]) ? await Bun.stdin.text() : "");
}
