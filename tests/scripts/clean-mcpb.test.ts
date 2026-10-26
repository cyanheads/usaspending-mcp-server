/**
 * @fileoverview Preserve dependency runtime modules while stripping package-root agent docs.
 * @module tests/scripts/clean-mcpb.test
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

describe('bundle agent-document removal', () => {
  it('preserves runtime skill modules and the published guide', () => {
    expect(
      filterAgentDocEntries([
        'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
        'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
        'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
        'node_modules/other/dist/skills/runtime.js',
        'skills/usaspending-guide/SKILL.md',
      ]),
    ).toEqual([]);
  });

  it('strips agent documentation at scoped, unscoped, and nested package roots', () => {
    expect(
      filterAgentDocEntries([
        'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
        'node_modules/example/skills/guide/SKILL.md',
        'node_modules/outer/node_modules/@scope/inner/skills/guide/reference.md',
        'node_modules/example/.claude/settings.json',
        'node_modules/@scope/example/.agents/skills/guide/SKILL.md',
        'node_modules/example/SKILL.md',
      ]),
    ).toEqual([
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/example/skills/guide/SKILL.md',
      'node_modules/outer/node_modules/@scope/inner/skills/guide/reference.md',
      'node_modules/example/.claude/settings.json',
      'node_modules/@scope/example/.agents/skills/guide/SKILL.md',
      'node_modules/example/SKILL.md',
    ]);
  });

  it('keeps the post-bundle linter aligned with the cleaner', () => {
    const linter = readFileSync(
      new URL('../../scripts/lint-packaging.ts', import.meta.url),
      'utf8',
    );
    expect(linter).toContain(`export const AGENT_DOC_ENTRY =\n  ${AGENT_DOC_ENTRY.toString()};`);
  });
});
