import { defineConfig } from '@rspress/core';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { base, siteRoot, type Inventory } from './scripts/content';

if (!process.versions.bun) throw new Error('Rspress must run under Bun');
const generated = process.env.SITE_GENERATED_DIR || path.join(siteRoot, '.generated');
writeFileSync(path.join(generated, 'runtime.json'), JSON.stringify({
  bun: process.versions.bun, executable: path.basename(process.execPath), command: process.argv[2],
}));
const index: Inventory = JSON.parse(readFileSync(path.join(generated, 'inventory.json'), 'utf8'));
const link = (route: string) => route;
const pages = (prefix: string) => index.pages.filter(page => page.route.startsWith(prefix))
  .map(page => ({ text: page.title, link: link(page.route) }));

export default defineConfig({
  root: path.join(generated, 'content'),
  outDir: process.env.SITE_OUT_DIR || path.join(siteRoot, 'dist'),
  base,
  title: 'Agent Toolkit',
  icon: new URL('./favicon.svg', import.meta.url),
  description: 'Reusable public Skills, canonical guides and contracts for coding and automation agents.',
  lang: 'zh',
  route: { cleanUrls: true },
  markdown: {
    link: { checkDeadLinks: true, checkAnchors: true },
    shiki: { fallbackLanguage: 'text' },
  },
  search: { codeBlocks: true },
  globalStyles: path.join(siteRoot, 'theme.css'),
  // Source maps and persistent compilation caches are not publication content.
  builderConfig: {
    output: { sourceMap: false },
    performance: { buildCache: false },
    resolve: { alias: {
      // The built-in provider uses Document on the main thread. The compact
      // distribution omits unused workers whose import.meta.url embeds a host path.
      'flexsearch$': path.join(siteRoot, 'node_modules/flexsearch/dist/flexsearch.compact.module.min.js'),
    } },
  },
  themeConfig: {
    nav: [
      { text: '概览', link: '/' },
      { text: 'Skills', link: '/skills/' },
      { text: '使用指南', link: '/guides/' },
      { text: 'Contracts', link: '/contracts/project-foundation/' },
    ],
    sidebar: { '/': [
      { text: '开始使用', items: [
        { text: 'Agent Toolkit', link: '/' },
        { text: '公共目录', link: '/skills/' },
        { text: '安装与更新', link: '/guides/installation/' },
        { text: 'Protected configuration', link: '/guides/configuration/' },
      ] },
      { text: '能力指南', items: pages('/guides/').filter(page => !['/guides/installation/', '/guides/configuration/'].includes(page.link)) },
      { text: 'Public Skills', items: index.skills.map(name => ({
        text: name, link: `/skills/${name}/`,
      })) },
      { text: '架构与契约', collapsed: true, items: [...pages('/architecture/'), ...pages('/contracts/'), ...pages('/skills/').filter(page => page.link.includes('/references/'))] },
    ] },
    socialLinks: [{ icon: 'github', mode: 'link', content: 'https://github.com/IvanLi-CN/agent-toolkit' }],
    footer: { message: 'MIT · Canonical Markdown from the public source repository.' },
  },
});
