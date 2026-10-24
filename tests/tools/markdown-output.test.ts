/**
 * @fileoverview Upstream text survives client Markdown parsing in tool output.
 * @module tests/tools/markdown-output
 */
import { describe, expect, it } from 'vitest';
import { getRecipientTool } from '@/mcp-server/tools/definitions/get-recipient.tool.js';
import { spendingByGeographyTool } from '@/mcp-server/tools/definitions/spending-by-geography.tool.js';
import { markdownText } from '../helpers/markdown-text.js';

describe('upstream text rendered as data', () => {
  it('preserves a heading, free text, and an address through CommonMark', () => {
    const name = 'A*p* [recipient](https://example.com)';
    const address = '123 <b>Main</b> `Street`';
    const result = getRecipientTool.output.parse({
      name,
      period: 'FY2024',
      location: { address_line1: address },
      alternate_names: ['*Alias*'],
    });
    const text = getRecipientTool.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    const rendered = markdownText(text);
    expect(rendered).toContain(name);
    expect(rendered).toContain(address);
    expect(rendered).toContain('*Alias*');
    expect(result.name).toBe(name);
  });

  it('preserves a table value with markup punctuation', () => {
    const name = 'A | *B* [C](https://example.com)';
    const result = spendingByGeographyTool.output.parse({
      scope: 'place_of_performance',
      geo_layer: 'state',
      total: 1,
      total_areas_available: 1,
      results: [{ display_name: name, shape_code: 'WA' }],
    });
    const text = spendingByGeographyTool.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(markdownText(text)).toContain(name);
    expect(result.results[0]!.display_name).toBe(name);
  });
});
