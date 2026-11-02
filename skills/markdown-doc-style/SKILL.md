---
name: markdown-doc-style
description: "Apply when creating, editing, or reviewing Markdown and similar document source text; keep prose paragraphs on one physical line while preserving Markdown- and format-required line breaks. Do not use for rendered layout, project writing policy, or code formatting alone."
---

# Markdown document style

## Purpose and scope

Use this Skill for Markdown documents, document fragments, README files, specifications, guides, Skill files, and similar source-text artifacts. It governs source layout only: keep semantic units easy to diff and preserve the syntax needed to render them correctly. It does not decide what the document should say, which project conventions apply, how a renderer lays out a page, or how code should be formatted.

## Core contract

- Keep each ordinary prose paragraph on one physical line.
- Separate adjacent prose paragraphs with one blank line.
- Do not insert mechanical line breaks inside a semantic unit. Do not wrap to a fixed column or to a formatter's `lineWidth` setting.
- Preserve line breaks that express Markdown structure, syntax, or an intentional rendered break.
- Reflow only the affected prose paragraph when editing; do not reformat unrelated blocks just because they are nearby.

## What counts as an exception

The one-line rule applies to ordinary prose paragraphs. Keep these structures on the lines their syntax requires:

- Headings, list items, nested list structure, and continuation lines whose indentation carries meaning.
- Tables, where each row and delimiter must remain a separate line.
- Block quotes, where each quoted line needs its quote marker or introduces another block. Within a quoted prose paragraph, do not add width-based wrapping.
- Fenced code blocks, indented code blocks, YAML frontmatter, directives, raw HTML, and other structured blocks whose grammar is line-oriented.
- Reference definitions, footnotes, task-list markers, and deliberate hard breaks such as two trailing spaces or `<br>` when the break is part of the intended output.
- A repository or document-format contract that explicitly requires wrapped prose. Follow that contract and treat the required wrapping as a local exception rather than inventing a second style.

Do not use an exception to justify arbitrary wrapping. A line break is allowed because it carries syntax or meaning, not because the line looks long.

## Examples

### Good

```markdown
This is one ordinary paragraph even when its source line is longer than a typical editor guide would recommend.

This is a second paragraph, separated from the first by a blank line.

- Each list item starts on its own line.
- A long list item may continue on an indented line when the list structure requires it.

| Name | Meaning |
| --- | --- |
| `one-line` | A prose paragraph stays on one physical line. |
```

### Bad

```markdown
This paragraph is wrapped only because the source line reached a preferred
column width, so the semantic unit is split across mechanical line breaks.

This paragraph is also wrapped by a formatter even though Markdown does not
require the break.
```

The bad example should be reflowed into one physical line per paragraph. Do not apply that rewrite to a list, table, quote, code block, frontmatter block, or another structure listed as an exception.

## Editing workflow

1. Identify ordinary prose paragraphs and syntax-bearing blocks before changing line breaks.
2. Join mechanically wrapped lines within each affected prose paragraph, keeping one blank line between paragraphs.
3. Leave headings, lists, tables, quotes, code, frontmatter, definitions, and intentional hard breaks structurally intact.
4. Inspect the diff for accidental content changes, lost blank lines, broken indentation, altered links, or newly introduced hard breaks.

## Review checklist

- [ ] Every ordinary prose paragraph is one physical line.
- [ ] Adjacent paragraphs remain separated by a blank line.
- [ ] No mechanical wrapping follows a fixed column or `lineWidth` value.
- [ ] Headings, lists, tables, block quotes, code blocks, frontmatter, and other syntax-bearing blocks retain required line breaks.
- [ ] Intentional hard breaks remain intentional and are not introduced for visual width.
- [ ] Links, reference definitions, footnotes, indentation, and content meaning are unchanged unless the request requires them to change.
- [ ] The change does not add project engineering, technical-selection, CI, release, architecture, or business-copy rules to this source-layout Skill.
