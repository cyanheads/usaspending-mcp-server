/**
 * @fileoverview Effective input filters through the production tool contract.
 * @module tests/tools/effective-filters.test
 */
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';
import { spendingByCategoryTool } from '@/mcp-server/tools/definitions/spending-by-category.tool.js';
import { spendingByGeographyTool } from '@/mcp-server/tools/definitions/spending-by-geography.tool.js';
import { spendingOverTimeTool } from '@/mcp-server/tools/definitions/spending-over-time.tool.js';
import { USASpendingService } from '@/services/usaspending/usaspending-service.js';

const upstream = vi.hoisted(() => ({ service: undefined as USASpendingService | undefined }));
vi.mock('@/services/usaspending/usaspending-service.js', async (original) => ({
  ...(await original<typeof import('@/services/usaspending/usaspending-service.js')>()),
  getUSASpendingService: () => upstream.service,
}));
const http = createFetchMock();
beforeEach(() => {
  http.reset();
  http.route({
    match: () => true,
    respond: () => Response.json({ results: [], page_metadata: { page: 3, hasNext: false } }),
  });
  http.install();
  upstream.service = new USASpendingService({} as AppConfig, {} as StorageService, {
    baseUrl: 'https://api.usaspending.gov/api/v2/',
    timeoutMs: 1000,
    retryBudgetMs: 1000,
  });
});
afterEach(() => {
  http.restore();
  upstream.service = undefined;
});

const analytics = [
  { definition: spendingByCategoryTool, args: { category: 'naics', page: 3 } },
  {
    definition: spendingByGeographyTool,
    args: { scope: 'place_of_performance', geo_layer: 'state' },
  },
  { definition: spendingOverTimeTool, args: { group: 'fiscal_year' } },
] as const;

for (const { definition, args } of analytics) {
  it(`${definition.name} rejects an active malformed recipient before I/O on both surfaces`, async () => {
    const result = await runToolContract(definition, {
      ...args,
      filters: { recipient_id: 'not-a-hash' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_recipient_id' } },
    });
    expect(JSON.stringify(result.content)).toContain('usaspending_search_recipients');
    expect(http.calls).toHaveLength(0);
  });
  it(`${definition.name} sends normalized effective filters and echoes an empty result`, async () => {
    const result = await runToolContract(definition, {
      ...args,
      filters: {
        recipient_id: 'ABCDEF12-1234-0000-0000-ABCDEF123456-P',
        naics_codes: ['054'],
        keywords: [' AI'],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      applied_recipient_id: 'abcdef12-1234-0000-0000-abcdef123456-P',
      applied_naics_codes: '54',
    });
    expect(JSON.stringify(result.content)).toContain('abcdef12-1234-0000-0000-abcdef123456-P');
    expect(await http.calls[0]!.request.clone().json()).toMatchObject({
      filters: { naics_codes: { require: ['54'] } },
    });
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining('recipient_id='),
    });
  });
  it(`${definition.name} rejects short effective keywords and invalid normalized NAICS`, async () => {
    for (const filters of [{ keywords: ['AI'] }, { naics_codes: ['541'] }]) {
      const result = await runToolContract(definition, { ...args, filters });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('Effective');
    }
    expect(http.calls).toHaveLength(0);
  });
  it(`${definition.name} keeps a blank recipient unset on both surfaces`, async () => {
    const result = await runToolContract(definition, { ...args, filters: { recipient_id: '' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('applied_recipient_id');
    expect(JSON.stringify(result.content)).not.toContain('applied_recipient_id');
    expect(await http.calls[0]!.request.clone().json()).not.toHaveProperty('filters.recipient_id');
  });
}

it('award search validates only merged active values and echoes normalized NAICS', async () => {
  const result = await runToolContract(searchAwardsTool, {
    keyword: 'AI',
    naics_codes: ['abc'],
    filters: { keywords: [' AI'], naics_codes: ['00541512'] },
  });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ applied_naics_codes: '541512' });
  expect(JSON.stringify(result.content)).toContain('541512');
  expect(await http.calls[0]!.request.clone().json()).toMatchObject({
    filters: { naics_codes: { require: ['541512'] } },
  });
});

it('award search rejects invalid effective values before I/O', async () => {
  for (const input of [{ keyword: 'AI' }, { naics_codes: ['54151'] }]) {
    const result = await runToolContract(searchAwardsTool, input);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Effective');
  }
  expect(http.calls).toHaveLength(0);
});
