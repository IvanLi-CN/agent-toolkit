import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { visit } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';
import { base, generate, inventory, readPublic, repoRoot, siteRoot, sourceUrl, type Inventory } from './content';
import { cssUrls, localTarget, srcsetUrls } from './resources';

type Node = DefaultTreeAdapterTypes.Node;
function elements(node: Node): DefaultTreeAdapterTypes.Element[] {
  return [...('tagName' in node ? [node] : []),
    ...('childNodes' in node ? node.childNodes.flatMap(elements) : [])];
}
function text(node: Node): string {
  return 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(text).join('') : '';
}
function attribute(node: DefaultTreeAdapterTypes.Element, name: string) {
  return node.attrs.find(attr => attr.name === name)?.value;
}
async function files(root: string) {
  return Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: root, onlyFiles: true, dot: true }));
}

async function checkResources(output: string, paths: string[], parsed: Map<string, DefaultTreeAdapterTypes.Document>) {
  const available = new Set(paths);
  let checked = 0;
  const check = (url: string, from: string) => {
    const target = localTarget(url, from, base);
    if (!target) return;
    assert(available.has(target.file), `Missing built target: ${from}: ${url}`);
    if (target.hash && target.file.endsWith('.html')) {
      const id = decodeURIComponent(target.hash.slice(1));
      assert(elements(parsed.get(target.file)!).some(node => attribute(node, 'id') === id), `Missing built anchor: ${from}: ${url}`);
    }
    checked++;
  };
  for (const [name, document] of parsed) {
    for (const element of elements(document)) {
      for (const key of ['href', 'src']) {
        const url = attribute(element, key);
        if (url !== undefined) check(url, name);
      }
      for (const url of srcsetUrls(attribute(element, 'srcset') || '')) check(url, name);
      for (const url of cssUrls(attribute(element, 'style') || '')) check(url, name);
      if (element.tagName === 'style') for (const url of cssUrls(text(element))) check(url, name);
    }
  }
  for (const name of paths.filter(name => name.endsWith('.css'))) {
    for (const url of cssUrls(await readFile(path.join(output, name), 'utf8'))) check(url, name);
  }
  return checked;
}

// Recognize concrete secrets and private integration signatures, not words such as
// "credential" or neutral env keys in canonical configuration guidance.
export function assertPublic(text: string, label: string) {
  const forbidden = [
    /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/,
    /https?:\/\/[^\s/]+:[^\s/@]+@/,
    /\/(?:Users|home)\/[A-Za-z0-9._-]+\//,
    // Assemble the thread marker so the repository scanner does not flag this detector.
    new RegExp(String.raw`(?:[A-Z]:\\Users\\|\.codex(?:\/|$)|\.claude\/|mcp__codex_app|codex:\/\/threads|CODEX_` +
      String.raw`THREAD_ID|CODEX_HOME|wave-thread\/v2)`),
    /SITE_EXCLUDED_SENTINEL_[A-Z_]+/,
  ];
  for (const pattern of forbidden) assert(!pattern.test(text), `Private content signature ${pattern.source} in ${label}`);
}

async function checkOutput(root: string, generated: string, output: string) {
  const expected = await inventory(root);
  const built: Inventory = JSON.parse(await readFile(path.join(generated, 'inventory.json'), 'utf8'));
  assert.deepEqual(built, expected, 'Build inventory is stale');
  const runtime = JSON.parse(await readFile(path.join(generated, 'runtime.json'), 'utf8'));
  assert(runtime.bun && runtime.executable === path.basename(process.execPath), 'Rspress did not execute under Bun');
  const paths = await files(output);
  const htmlFiles = paths.filter(name => name.endsWith('.html'));
  assert.deepEqual(new Set(htmlFiles), new Set([...expected.pages.map(page => `${page.route.slice(1)}index.html`), '404.html']), 'Unexpected or missing public page');
  const searchFiles = paths.filter(name => /^static\/search_index[^/]*\.json$/.test(name));
  assert.equal(searchFiles.length, 1, 'One local search index must be emitted');
  const search: { routePath: string; title: string; content: string; frontmatter: Record<string, string> }[] = JSON.parse(await readFile(path.join(output, searchFiles[0]), 'utf8'));
  assert.deepEqual(new Set(search.map(page => page.routePath)), new Set(expected.pages.map(page => page.route)), 'Search membership differs from public pages');
  assert.equal(search.length, expected.pages.length, 'Duplicate search entry');
  const parsed = new Map<string, DefaultTreeAdapterTypes.Document>();
  for (const name of htmlFiles) parsed.set(name, parse(await readFile(path.join(output, name), 'utf8')));
  const checkedLinks = await checkResources(output, paths, parsed);
  for (const page of expected.pages) {
    const document = parsed.get(`${page.route.slice(1)}index.html`)!;
    const nodes = elements(document);
    assert(nodes.some(node => node.tagName === 'h1' && text(node).trim()), `Empty page: ${page.route}`);
    for (const edit of [false, true]) assert(nodes.some(node => attribute(node, 'href') === sourceUrl(page.source, edit)), `Missing canonical ${edit ? 'edit' : 'source'} link: ${page.route}`);
    if (page.source.endsWith('.md')) {
      const original = await readFile(path.join(root, page.source), 'utf8');
      const tree = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']).parse(original);
      const code: string[] = [];
      visit(tree, 'code', node => { code.push(node.value); });
      const rendered = nodes.filter(node => node.tagName === 'pre').map(text);
      for (const block of code) assert(rendered.some(value => value.trimEnd() === block.trimEnd()), `Code/literal placeholder changed: ${page.source}`);
    }
    if (page.description) {
      const indexed = search.find(item => item.routePath === page.route)!;
      assert.equal(indexed.frontmatter.description, page.description, `Frontmatter changed: ${page.source}`);
    }
  }
  for (const name of paths) {
    assert(!/(?:^|\/)(?:\.env|\.git|node_modules|scripts|tests|private)(?:\/|$)/.test(name), `Excluded artifact path: ${name}`);
    assert(!name.endsWith('.map'), `Source map must not be published: ${name}`);
    if (/\.(?:html|js|json|css|txt|md|svg)$/.test(name)) assertPublic(await readFile(path.join(output, name), 'utf8'), name);
  }
  return { skills: expected.skills.length, pages: expected.pages.length, checkedLinks, runtime, search };
}

// Fail closed if a later workflow edit grants publication to PRs or ordinary builds.
const workflowText = await readFile(path.join(repoRoot, '.github/workflows/site.yml'), 'utf8');
const workflow = parseYaml(workflowText);
assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'workflow_dispatch']);
assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
assert.deepEqual(workflow.permissions, { contents: 'read' });
assert.deepEqual(workflow.jobs.build.permissions, { contents: 'read' });
const publicationCondition = "github.event_name == 'workflow_dispatch' && inputs.publish && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
assert.equal(workflow.jobs.publish.if, publicationCondition);
assert.equal(workflow.jobs.publish.needs, 'build');
assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'read', pages: 'write', 'id-token': 'write' });
const packaging = workflow.jobs.build.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/upload-pages-artifact@'));
assert.equal(packaging.if, publicationCondition);
assert.equal(packaging.with.path, 'site/dist');
assert(workflow.jobs.build.steps.some((step: { uses?: string; with?: Record<string, string> }) => step.uses === 'oven-sh/setup-bun@v2' && step.with?.['bun-version'] === 'latest'));
for (const command of ['bun install --frozen-lockfile', 'bun run typecheck', 'bun run build', 'bun run check']) {
  assert(workflow.jobs.build.steps.some((step: { run?: string; 'working-directory'?: string }) => step.run === command && step['working-directory'] === 'site'));
}
assert(!/\bsecrets\s*\.|setup-node|pull_request_target/.test(workflowText));
console.log('Workflow boundary: PR/manual checks read-only; Pages packaging/deploy requires explicit default-branch dispatch; no secrets');

const main = await checkOutput(repoRoot, path.join(siteRoot, '.generated'), path.join(siteRoot, 'dist'));
assert.equal(main.skills, 13, 'Foundation membership requires 13 public Skills');
console.log(`Public output: ${main.skills} Skills, ${main.pages} routes/search entries, ${main.checkedLinks} links/assets/anchors; Bun ${main.runtime.bun}`);

// Regression controls must fail, including a private path injected into a built file.
for (const bad of [
  'mcp__codex_app', 'CODEX_' + 'THREAD_ID', 'CODEX_HOME', 'wave-thread/v2',
  ['', 'Users', 'test', 'private', 'key'].join('/'), '.codex', '.codex/',
  '-----BEGIN PRIVATE KEY-----', 'SITE_EXCLUDED_SENTINEL_PRIVATE',
]) {
  assert.throws(() => assertPublic(bad, 'negative control'));
}
const runtimePath = process.execPath;
const cache = path.join(siteRoot, '.cache');
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, 'content-check-'));
try {
  const resources = path.join(fixture, 'resources');
  await mkdir(path.join(resources, 'static'), { recursive: true });
  const resourcePaths = ['index.html', 'static/style.css', 'static/image.svg', 'static/image two.svg'];
  const validHtml = `<h1 id="anchor">Resources</h1>
    <a href="?version=1#anchor">Anchor</a>
    <img href="static/image.svg" src="static/image.svg?size=2#icon"
      srcset="data:image/svg+xml,%3Csvg%3E 1x, static/image.svg?size=2 2x"
      style="background: url('static/image%20two.svg?size=2#icon')">
    <style>/* url(missing-comment.svg) */ p::before { content: "url(missing-string.svg)" }
      p { background: u\\72l(static/image.svg) }</style>
    <img src="https://example.invalid/image.svg" srcset="//example.invalid/a.svg 1x, blob:example 2x"
      style="background: url(data:image/svg+xml;base64,PHN2Zz4=)">`;
  const validCss = `a { background: url('../static/image\\20 two.svg?size=2#icon') }
    b { mask: url(${base}static/image.svg#icon) } c { mask: url(//example.invalid/icon.svg) }`;
  for (const name of resourcePaths.filter(name => name.endsWith('.svg'))) await writeFile(path.join(resources, name), '<svg/>');
  const resourceCheck = async (html = validHtml, css = validCss) => {
    await writeFile(path.join(resources, 'static/style.css'), css);
    return checkResources(resources, resourcePaths, new Map([['index.html', parse(html)]]));
  };
  assert.equal(await resourceCheck(), 8, 'Resource positive controls were not all checked');
  for (const html of [
    '<img href="static/image.svg" src="missing.svg">',
    '<img srcset="static/image.svg 1x, missing.svg 2x">',
    '<img style="background:url(missing.svg)">',
    '<style>a { background:url(missing.svg) }</style>',
    '<img src="/outside.svg">', '<a href="#missing">Missing anchor</a>',
  ]) await assert.rejects(() => resourceCheck(html), /Missing built|escapes repository base/);
  for (const css of [
    'a { background:url(missing.svg) }',
    'a { background:url(../../outside.svg) }',
    'a { background:url("../static/missing.svg?size=2#icon") }',
    'a { background:url("unterminated.svg) }',
  ]) await assert.rejects(() => resourceCheck(validHtml, css), /Missing built|escapes repository base|Unterminated CSS/);
  console.log('Resource controls: href/src independently, srcset, inline/style-sheet CSS, escaped URLs, relative/base/query/fragment, external schemes, missing targets and anchors');
  const source = path.join(fixture, 'source');
  const generated = path.join(fixture, 'generated');
  const output = path.join(fixture, 'dist');
  const bin = path.join(fixture, 'bin');
  await mkdir(bin);
  await symlink(runtimePath, path.join(bin, 'bun'));
  // Source-link revisions are resolved before the restricted-PATH subprocess.
  const sourceRef = process.env.SITE_SOURCE_REF || Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.toString().trim();
  // A PATH-resolved Node invocation fails the build instead of silently proving Bun.
  await writeFile(path.join(bin, 'node'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  const selection = Bun.spawn(['git', 'ls-files', '-z'], { cwd: repoRoot, stdout: 'pipe' });
  const tracked = (await new Response(selection.stdout).text()).split('\0').filter(Boolean);
  assert.equal(await selection.exited, 0);
  for (const name of tracked.filter(name => !name.startsWith('site/'))) {
    const original = path.join(repoRoot, name);
    if (!(await lstat(original)).isFile()) continue;
    const target = path.join(source, name);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(original, target);
  }
  for (const [name, marker] of [
    ['.env', 'CONFIG'], ['private/notes.md', 'PRIVATE'],
    ['docs/guides/not-public.md', 'GUIDE'], ['skills/not-public/SKILL.md', 'SKILL'],
    ['skills/agent-vm/references/hosts.txt', 'INVENTORY'],
  ]) {
    const target = path.join(source, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `# SITE_EXCLUDED_SENTINEL_${marker}\n`);
  }
  const run = async () => {
    const child = Bun.spawn([runtimePath, 'scripts/run.ts', 'build'], {
      cwd: siteRoot,
      env: { ...process.env, PATH: bin, SITE_SOURCE_REF: sourceRef, SITE_SOURCE_ROOT: source, SITE_GENERATED_DIR: generated, SITE_OUT_DIR: output },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    assert.equal(code, 0, `Isolated build failed (Node disabled):\n${stdout}\n${stderr}`);
    return checkOutput(source, generated, output);
  };
  const before = await run();
  assert.equal(before.skills, 13);
  const guides = path.join(source, 'docs/guides');
  const excludedGuides = path.join(source, 'private/redirected-guides');
  await rename(guides, excludedGuides);
  await symlink(excludedGuides, guides, 'dir');
  try {
    await assert.rejects(() => readPublic(source, 'docs/guides/README.md'), /Symlink in public source path/);
    await assert.rejects(() => generate(source, generated), /Symlink in public source path/);
  } finally {
    await rm(guides);
    await rename(excludedGuides, guides);
  }
  const linkedFile = path.join(source, 'linked-source.md');
  await symlink(path.join(source, 'README.md'), linkedFile);
  await assert.rejects(() => readPublic(source, 'linked-source.md'), /Symlink in public source path/);
  await assert.rejects(() => readPublic(source, '../outside.md'), /within the checkout/);
  console.log('Source controls: in-checkout symlink ancestor and final symlink rejected; generation fails closed; checkout escape rejected');
  const removed = 'docs-no-revision-markers';
  const manifest = path.join(source, 'PUBLIC_SKILLS.txt');
  await writeFile(manifest, (await readFile(manifest, 'utf8')).split('\n').filter(line => line.trim() !== removed).join('\n'));
  const after = await run();
  assert.equal(after.skills, 12);
  assert(!after.search.some(page => page.routePath.startsWith(`/skills/${removed}/`)), 'Removed Skill remains searchable');
  assert(!(await files(output)).some(name => name.startsWith(`skills/${removed}/`)), 'Removed Skill route remains');
  const catalog = parse(await readFile(path.join(output, 'skills/index.html'), 'utf8'));
  assert(!elements(catalog).some(node => node.tagName === 'td' && text(node) === removed), 'Removed Skill catalog row remains');
  assert(!elements(catalog).some(node => attribute(node, 'href') === `${base}skills/${removed}/`), 'Removed Skill navigation remains');
  console.log(`Isolated rebuild: 13 → 12 Skills; removed route/catalog/search/navigation; excluded sentinels absent; both builds with Node disabled (Bun ${after.runtime.bun})`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
