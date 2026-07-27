/**
 * @fileoverview Tests for the changelog rollup builder's entry-body guard.
 * @module tests/scripts/build-changelog.test
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateBody } from '../../scripts/build-changelog.js';

const FRONTMATTER = `---
summary: "One-line headline."
---
`;

describe('validateBody', () => {
  it('rejects a trailing tool-call tag, naming the file and line', () => {
    const entry = `${FRONTMATTER}
# 0.2.9 — 2026-07-20

## Fixed

- **A real bullet** describing a real change.
</content>
</invoke>
`;

    expect(() => validateBody(entry, 'changelog/0.2.x/0.2.9.md')).toThrow(
      /changelog\/0\.2\.x\/0\.2\.9\.md:10:.*<\/content>/,
    );
  });

  it('rejects an opening tag with attributes on its own line', () => {
    const entry = `${FRONTMATTER}
# 0.3.1 — 2026-07-27

<invoke name="str_replace_editor">
`;

    expect(() => validateBody(entry, 'changelog/0.3.x/0.3.1.md')).toThrow(/stray control markup/);
  });

  it('accepts inline generics and bracketed placeholders', () => {
    // Both shapes ship in real entries: `post<T>()` (0.2.9) and `["<code>"]` (0.2.0).
    const entry = `${FRONTMATTER}
# 0.2.0 — 2026-05-01

## Changed

- **The unreachable guard in \`USASpendingService.post<T>()\`** and its now-unused
  import — a private \`getEntity<T>()\` helper now resolves \`undefined\` instead.
- Callers passing \`naics_code\` as a string must update to \`naics_codes: ["<code>"]\`.
`;

    expect(() => validateBody(entry, 'changelog/0.2.x/0.2.0.md')).not.toThrow();
  });

  it('accepts standalone HTML that markdown renders', () => {
    const entry = `${FRONTMATTER}
# 0.3.1 — 2026-07-27

## Changed

<details>
<summary>Full field mapping</summary>

- One row per field.

</details>
`;

    expect(() => validateBody(entry, 'changelog/0.3.x/0.3.1.md')).not.toThrow();
  });

  it('accepts every per-version entry currently in changelog/', () => {
    const changelogDir = resolve('changelog');
    const seriesDirs = readdirSync(changelogDir, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && /^\d+\.\d+\.x$/.test(e.name),
    );
    expect(seriesDirs.length).toBeGreaterThan(0);

    for (const series of seriesDirs) {
      const seriesDir = resolve(changelogDir, series.name);
      for (const file of readdirSync(seriesDir).filter((f) => f.endsWith('.md'))) {
        const label = `changelog/${series.name}/${file}`;
        expect(() =>
          validateBody(readFileSync(resolve(seriesDir, file), 'utf-8'), label),
        ).not.toThrow();
      }
    }
  });
});
