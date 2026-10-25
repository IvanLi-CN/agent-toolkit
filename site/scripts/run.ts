import { generate, repoRoot, siteRoot } from './content';
import path from 'node:path';

if (!process.versions.bun) throw new Error('Site commands require installed Bun');
const command = process.argv[2];
if (command !== 'build' && command !== 'dev') throw new Error('Usage: bun scripts/run.ts build|dev');
const sourceRoot = path.resolve(process.env.SITE_SOURCE_ROOT || repoRoot);
const generated = path.resolve(process.env.SITE_GENERATED_DIR || path.join(siteRoot, '.generated'));
const index = await generate(sourceRoot, generated);
console.log(`Site: Bun ${Bun.version}; ${index.skills.length} Skills; ${index.pages.length} public pages`);
// Explicit interpreter bypasses the dependency's #!/usr/bin/env node shebang.
const cli = path.join(siteRoot, 'node_modules/@rspress/core/bin/rspress.js');
const child = Bun.spawn([process.execPath, cli, command, ...process.argv.slice(3)], {
  cwd: siteRoot,
  env: { ...process.env, SITE_GENERATED_DIR: generated },
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
