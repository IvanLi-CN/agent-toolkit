# Documentation site

This independent Bun/Rspress project presents the canonical repository Markdown. It does not install Skills, generate a consumer tree, or maintain a second behavior specification. The framework's documentation theme supplies responsive navigation, local search and readable code blocks. `theme.css` only adjusts presentation and keyboard focus.

From `site/`, use the installed Bun:

```bash
bun --version
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run check
bun run dev --port <leased-port>
bun run preview --port <leased-port>
```

Replace `<leased-port>` with an available port reserved for this checkout before starting a server. Preview binds loopback only and serves real static files under `/agent-toolkit/`; unknown routes return 404, not an SPA shell. Development, the Rspress build CLI, type checking, fixture builds and production preview all execute through Bun. Rspress's log label `(node)` denotes its server compilation target, not a required Node process. Native Rspack bindings must be available for the build OS/architecture. No Bun version is selected or downloaded locally; `bun.lock` locks package dependencies independently of the root package.

`scripts/content.ts` defines the exact page allowlist. It reads `PUBLIC_SKILLS.txt` for membership, filters removed Skill catalog rows, and renders `README.md`, the canonical catalog, explicitly named guides, architecture documents and contracts into ignored `.generated/content/`. Selected `SKILL.md` frontmatter and fenced code values are retained. Only generated link destinations change: selected Markdown targets become site routes; other repository resources become canonical source links. Unavailable references already present in a canonical document receive a visible source-reference notice and open that containing source document. These notices do not assert the missing file exists. No source-only script, template, private configuration, test or unrelated Markdown becomes a page or search entry.

`bun run check` inspects `dist/`, verifies exact route/search membership, local HTML `href`, `src`, and `srcset` targets, CSS `url(...)` references in style attributes, style elements and emitted stylesheets, canonical source/edit links, frontmatter descriptions and code values, then scans text artifacts for concrete credential, personal-path and private runtime/task signatures. Resource paths resolve relative to the containing HTML or CSS file, retain the repository base, and separate queries and fragments from file lookup; external schemes and protocol-relative URLs are skipped. Regression controls reject missing targets and HTML anchors, escaped base paths and malformed CSS URLs. Public source reads reject symlinks in every component below the checkout root, including symlinks pointing elsewhere inside the checkout; an isolated negative fixture verifies generation fails closed for a redirected allowlisted directory. It rebuilds a disposable fixture twice with a failing Node executable and no other commands on PATH. The second build removes one manifest Skill without deleting its source directory; its route, catalog row, navigation and local search entry must disappear. Synthetic excluded files in configuration, inventory, unrelated guides and an unlisted Skill must never appear in output. Signature checks are regression controls, not a general proof that arbitrary secrets can be recognized. Generated content, caches, fixtures and `dist/` are not committed.

For source/edit links use `SITE_SOURCE_REF=<source-commit-or-branch>` when building; otherwise the current Git HEAD is used. CI uses the immutable PR head SHA (or dispatch SHA). This changes presentation links only and does not change Git configuration.

## Pages publication boundary

`.github/workflows/site.yml` builds/checks PRs and manual runs with read-only content permission. It uses latest stable Bun and the site lockfile. Only a manual run with `publish=true` against the repository's actual default branch packages `site/dist/` and enables the separate Pages job with `pages: write` / `id-token: write`. A PR or a manual validation run never deploys, including a non-default-branch run with the publish input enabled. There are no deployment secrets or configured production addresses in this project.

To reproduce a candidate, check out its exact source revision, run the commands above, and inspect `site/dist/`. An authorized operator must separately enable the repository's GitHub Pages Actions source/environment and explicitly request the publication path. After a real deployment, verify the reported Pages URL plus `/agent-toolkit/`, inspect base-prefixed assets, local search, mobile navigation and canonical source/edit links. Check the deployed revision against the requested source SHA. A local build, static workflow inspection or PR CI success does not establish production publication; no publication is performed by this change.

See [implementation evidence](../docs/specs/project-foundation/IMPLEMENTATION.md) for observed runtime, scenarios and limits.
