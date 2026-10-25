import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkStringify from 'remark-stringify';
import { visit } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';

export const siteRoot = path.resolve(import.meta.dir, '..');
export const repoRoot = path.resolve(siteRoot, '..');
export const base = '/agent-toolkit/';
export const repository = 'https://github.com/IvanLi-CN/agent-toolkit';
// Presentation links are pinned to the source being built, never a generated file.
function currentRevision() {
  const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot });
  if (revision.exitCode !== 0) throw new Error('A source revision or Git checkout is required');
  return revision.stdout.toString().trim();
}
export const sourceRef = process.env.SITE_SOURCE_REF || currentRevision();
export const sourceUrl = (source: string, edit = false) =>
  `${repository}/${edit ? 'edit' : 'blob'}/${sourceRef}/${source}`;

// Exact paths, not a recursive docs/ or skills/ glob. Adding a file requires review.
export const documents: [string, string][] = [
  ['README.md', '/'],
  ['skills/README.md', '/skills/'],
  ['AGENTS.md', '/architecture/repository/'],
  ['GLOSSARY.md', '/architecture/glossary/'],
  ['CONTRIBUTING.md', '/architecture/contributing/'],
  ['docs/guides/README.md', '/guides/'],
  ...['installation', 'configuration', 'isolated-execution', 'service-operations',
    'git-and-docs', 'media-previews', 'cad-repair'].map(name =>
    [`docs/guides/${name}.md`, `/guides/${name}/`] as [string, string]),
  ['docs/specs/project-foundation/SPEC.md', '/contracts/project-foundation/'],
  ['docs/specs/project-foundation/IMPLEMENTATION.md', '/contracts/project-foundation/implementation/'],
  ['docs/specs/project-foundation/SCRIPT-LANGUAGE-MATRIX.md', '/contracts/languages/'],
  ['docs/adr/0032-project-foundation-rebaseline.md', '/architecture/foundation/'],
  ['docs/specs/agent-vm/SPEC.md', '/contracts/agent-vm/'],
  ['docs/specs/agent-vm/OPERATIONS.md', '/contracts/agent-vm/operations/'],
  ...['cli', 'release', 'observability'].map(name =>
    [`docs/specs/agent-vm/contracts/${name}.md`, `/contracts/agent-vm/${name}/`] as [string, string]),
];

export const references: Record<string, string[]> = {
  'agent-vm': ['observability/README'],
  'agent-vm-ops': ['control-runtime', 'deployment'],
  'buzzer-audio-preview': ['media-contract'],
  'cvm-imagegen': ['cli', 'image-api'],
  'dst-dedicated-server': ['environment', 'dst-paths', 'helper-contract'],
  'firmware-display-preview': ['framebuffer-contract'],
  'tavily-hikari-infra': ['runbook'],
  'xp-infra': ['README', 'cli', 'runbook'],
};

export async function readPublic(root: string, name: string): Promise<string> {
  const target = path.resolve(root, name);
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Public source must be a regular file within the checkout: ${name}`);
  }
  // Resolve the checkout itself, then inspect every source component. An in-checkout
  // symlink must not redirect an allowlisted path into an excluded directory.
  let current = await realpath(root);
  const components = relative.split(path.sep);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`Symlink in public source path: ${name}`);
    if (index < components.length - 1 ? !entry.isDirectory() : !entry.isFile()) {
      throw new Error(`Not a regular public source path: ${name}`);
    }
  }
  return readFile(current, 'utf8');
}

export async function membership(root: string): Promise<string[]> {
  const names = (await readPublic(root, 'PUBLIC_SKILLS.txt')).split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!names.length || names.some(name => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) || new Set(names).size !== names.length) {
    throw new Error('Public membership must contain unique, safe Skill names');
  }
  return names;
}

export type Page = { source: string; route: string; title: string; sha256: string; description?: string };
export type Inventory = { skills: string[]; pages: Page[] };
const markdown = () => unified().use(remarkParse).use(remarkGfm)
  .use(remarkFrontmatter, ['yaml']).use(remarkStringify, { fences: true, bullet: '-' });

export async function inventory(root = repoRoot): Promise<Inventory> {
  const skills = await membership(root);
  const entries: [string, string][] = [...documents, ['PUBLIC_SKILLS.txt', '/membership/']];
  for (const name of skills) {
    entries.push([`skills/${name}/SKILL.md`, `/skills/${name}/`]);
    for (const ref of references[name] || []) {
      entries.push([`skills/${name}/references/${ref}.md`, `/skills/${name}/references/${ref.replace(/\/README$/, '')}/`]);
    }
  }
  const pages: Page[] = [];
  for (const [source, route] of entries) {
    const text = await readPublic(root, source);
    const metadata = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const fm = metadata ? parseYaml(metadata[1]) : {};
    const title = source === 'PUBLIC_SKILLS.txt' ? 'Public membership'
      : text.match(/^# (.+)$/m)?.[1] || fm?.name || source;
    const sha256 = new Bun.CryptoHasher('sha256').update(text).digest('hex');
    pages.push({ source, route, title, sha256, ...(fm?.description ? { description: fm.description } : {}) });
  }
  if (new Set(pages.map(page => page.route)).size !== pages.length) throw new Error('Duplicate site route');
  return { skills, pages };
}

export async function generate(root = repoRoot, destination = path.join(siteRoot, '.generated')) {
  const index = await inventory(root);
  const bySource = new Map(index.pages.map(page => [page.source, page.route]));
  // destination is always the caller-owned generation directory, never source.
  if (!destination.startsWith(`${siteRoot}${path.sep}`) || path.resolve(destination) === path.resolve(root)) {
    throw new Error('Generation destination must be inside site and separate from canonical source');
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const linkEvidence: { source: string; target: string; href: string; kind: string }[] = [];
  for (const page of index.pages) {
    let original = await readPublic(root, page.source);
    if (page.source === 'PUBLIC_SKILLS.txt') original = `# Public membership\n\n\`\`\`text\n${original}\n\`\`\`\n`;
    const processor = markdown();
    const tree = processor.parse(original);
    // Canonical catalogs may lag an isolated manifest mutation. Never publish a removed row.
    visit(tree, 'table', table => {
      table.children = table.children.filter(row => {
        let removed = false;
        visit(row, 'link', node => {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(page.source), node.url));
          const skill = target.match(/^skills\/([^/]+)\/SKILL\.md$/)?.[1];
          if (skill && !index.skills.includes(skill)) removed = true;
        });
        return !removed;
      });
    });
    const links: { url: string }[] = [];
    visit(tree, node => {
      if (node.type === 'link' || node.type === 'image' || node.type === 'definition') links.push(node);
    });
    const unavailable: string[] = [];
    for (const node of links) {
      const url = node.url;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) continue;
      const [file, fragment] = url.split('#', 2);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(page.source), decodeURIComponent(file)));
      if (target.startsWith('../') || path.posix.isAbsolute(target)) throw new Error(`Escaped public link in ${page.source}`);
      const route = bySource.get(target);
      let available = true;
      if (!route) {
        try { await lstat(path.join(root, target)); } catch { available = false; }
      }
      // Stale references in canonical source are explicit, never invented pages or broken site links.
      if (!available) unavailable.push(target);
      const href = `${route ? base.slice(0, -1) + route : sourceUrl(available ? target : page.source)}${fragment && (route || available) ? `#${fragment}` : ''}`;
      // Rspress adds base after validating its logical route table.
      node.url = route ? `${route}${fragment ? `#${fragment}` : ''}` : href;
      linkEvidence.push({ source: page.source, target, href, kind: route ? 'route' : available ? 'source' : 'unavailable-source-reference' });
    }
    let rendered = processor.stringify(tree);
    if (unavailable.length) rendered += `\n> Source reference notice: the canonical document references unavailable paths: ${[...new Set(unavailable)].map(name => `\`${name}\``).join(', ')}. These links open the containing canonical document for inspection.\n`;
    rendered += `\n---\n\n[Canonical source](${sourceUrl(page.source)}) · [Edit this page](${sourceUrl(page.source, true)})\n`;
    // Keep each Markdown page independent; the source remains ordinary Markdown.
    const output = path.join(destination, 'content', page.route, 'index.md');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, rendered);
  }
  await writeFile(path.join(destination, 'inventory.json'), JSON.stringify(index, null, 2));
  await writeFile(path.join(destination, 'links.json'), JSON.stringify(linkEvidence, null, 2));
  return index;
}
