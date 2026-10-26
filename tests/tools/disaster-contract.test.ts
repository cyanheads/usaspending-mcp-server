/**
 * @fileoverview Disaster request filtering and recovery through the real service.
 * @module tests/tools/disaster-contract.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disasterSpendingTool } from '@/mcp-server/tools/definitions/disaster-spending.tool.js';
import { USASpendingService } from '@/services/usaspending/usaspending-service.js';

const upstream = vi.hoisted(() => ({ service: undefined as USASpendingService | undefined }));
vi.mock('@/services/usaspending/usaspending-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/usaspending/usaspending-service.js')>()),
  getUSASpendingService: () => {
    if (!upstream.service) throw new Error('Missing test service');
    return upstream.service;
  },
}));

const BASE = 'https://api.usaspending.gov/api/v2/';
const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
const markdown = new MarkdownIt();
const codeValues = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  markdown
    .parse(textOf(result), {})
    .flatMap((token) => token.children ?? [])
    .filter((token) => token.type === 'code_inline')
    .map((token) => token.content);
const fetchMock = vi.fn<typeof fetch>();
const reply = (body: unknown) => fetchMock.mockResolvedValueOnce(Response.json(body));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('Unexpected fetch'));
  vi.stubGlobal('fetch', fetchMock);
  upstream.service = new USASpendingService({} as AppConfig, {} as StorageService, {
    baseUrl: BASE,
    timeoutMs: 30_000,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  upstream.service = undefined;
});

describe('disaster contract characterization', () => {
  it('keeps exact final-page continuation and nested pagination without overfetch', async () => {
    reply({
      results: [{ id: '1', description: 'Agency' }],
      page_metadata: { total: 2, page: 2, hasNext: false },
    });
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'agency',
      filters: { def_codes: ['L'] },
      limit: 1,
      page: 2,
    });
    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      filter: { def_codes: ['L'] },
      pagination: { page: 2, limit: 1 },
      spending_type: 'award',
    });
    expect(result.structuredContent).toMatchObject({
      results: [{ id: '1' }],
      page_metadata: { page: 2, has_next: false, total: 2 },
      has_next_page: false,
    });
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(textOf(result)).toContain('Agency');
  });
});

describe('disaster filters and notices', () => {
  it.each([{ codes: ['L'] }, { codes: ['L', 'M'] }, { codes: [] }])(
    'forwards overview DEF codes $codes as one query parameter',
    async ({ codes }) => {
      reply({
        total_budget_authority: 120,
        funding: [{ def_code: 'L', amount: 100 }],
        spending: { award_obligations: 80 },
      });
      const result = await runToolContract(disasterSpendingTool, {
        dimension: 'overview',
        filters: { def_codes: codes },
      });
      const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect([...url.searchParams]).toEqual(codes.length ? [['def_codes', codes.join(',')]] : []);
      expect(result.structuredContent).toMatchObject({
        overview: {
          total_budget_authority: 120,
          award_obligations: 80,
          funding_by_def_code: [{ def_code: 'L', amount: 100 }],
        },
      });
      expect(textOf(result)).toContain('$120');
      expect(textOf(result)).toContain('$80');
      if (codes.length) {
        expect(result.structuredContent).toHaveProperty('applied_def_codes', codes.join(', '));
        expect(codeValues(result)).toContain(codes.join(', '));
      } else {
        expect(result.structuredContent).not.toHaveProperty('applied_def_codes');
      }
      expect(result.structuredContent).not.toHaveProperty('notice');
    },
  );

  it('keeps unfiltered overview valid and discloses ignored overview filters once', async () => {
    reply({});
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'overview',
      filters: { award_type_codes: ['A'], geo_layer: 'county', query: ' UW ' },
    });
    expect(result.isError).toBeFalsy();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}disaster/overview/`);
    const notice = (result.structuredContent as { notice: string }).notice;
    for (const field of ['filters.award_type_codes', 'filters.geo_layer', 'filters.query'])
      expect(notice).toContain(field);
    expect(textOf(result).split(notice)).toHaveLength(2);
    expect(notice).not.toContain('No data');
  });

  it.each([undefined, '', '   ', ' UW '])(
    'normalizes recipient query %j only under filter',
    async (query) => {
      reply({
        results: [{ id: ['child-C', 'recipient-R'], description: 'UW' }],
        page_metadata: { total: 1, page: 1, hasNext: false },
      });
      const result = await runToolContract(disasterSpendingTool, {
        dimension: 'recipient',
        filters: { def_codes: ['N'], query },
      });
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.filter).toEqual({ def_codes: ['N'], ...(query?.trim() ? { query: 'UW' } : {}) });
      expect(body).not.toHaveProperty('query');
      expect(result.structuredContent).toMatchObject({ results: [{ id: 'recipient-R' }] });
      if (query?.trim()) {
        expect(result.structuredContent).toHaveProperty('applied_query', 'UW');
        expect(codeValues(result)).toContain('UW');
      } else expect(result.structuredContent).not.toHaveProperty('applied_query');
    },
  );

  it.each(['agency', 'cfda', 'geography'] as const)(
    'discloses query ignored by %s without forwarding it',
    async (dimension) => {
      reply({
        results: [{ id: '1', shape_code: 'WA', amount: 1 }],
        page_metadata: { total: 1, hasNext: false },
      });
      const result = await runToolContract(disasterSpendingTool, {
        dimension,
        filters: { def_codes: ['L'], query: 'UW' },
      });
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.filter).not.toHaveProperty('query');
      expect(result.structuredContent).not.toHaveProperty('applied_query');
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('filters.query');
      expect(textOf(result)).toContain(notice);
    },
  );

  it('composes recipient ceiling, provider messages, ignored fields and exhausted-page guidance', async () => {
    reply({
      results: [],
      messages: ['Use a query to narrow.', 'Sorted by description.'],
      page_metadata: { total: 10_000, page: 101, hasNext: false },
    });
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'recipient',
      filters: { def_codes: ['N'], geo_layer: 'county' },
      page: 101,
      limit: 100,
    });
    expect(result.structuredContent).toMatchObject({
      page_metadata: { total: 10_000, has_next: false },
      truncated: true,
      shown: 0,
      cap: 10_000,
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    for (const fragment of [
      'lower bound',
      'filters.query',
      'Use a query to narrow.',
      'Sorted by description.',
      'filters.geo_layer',
      'earlier page',
    ])
      expect(notice).toContain(fragment);
    expect(notice).not.toContain('upper bound');
    expect(textOf(result).split(notice)).toHaveLength(2);
    expect(textOf(result).match(/earlier page/g)).toHaveLength(1);
  });

  it('composes geography truncation and ignored-query notices', async () => {
    reply({
      results: [
        { shape_code: 'WA', amount: 2 },
        { shape_code: 'CA', amount: 1 },
      ],
    });
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'geography',
      filters: { def_codes: ['L'], query: 'UW' },
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      cap: 1,
      shown: 1,
      truncationCeiling: 2,
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('filters.query');
    expect(notice).toContain('Request page 2');
    expect(textOf(result)).toContain(notice);
  });

  it.each(['agency', 'cfda', 'recipient', 'geography'] as const)(
    'puts %s exhausted-page recovery on both surfaces',
    async (dimension) => {
      reply({
        results: dimension === 'geography' ? [{ shape_code: 'WA', amount: 1 }] : [],
        page_metadata: { total: 1, page: 2, hasNext: false },
      });
      const result = await runToolContract(disasterSpendingTool, {
        dimension,
        filters: { def_codes: ['L'] },
        page: 2,
        limit: 1,
      });
      expect(result.structuredContent).toMatchObject({
        results: [],
        page_metadata: { total: 1, page: 2, has_next: false },
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('earlier page');
      expect(notice).toContain('same filters');
      expect(textOf(result).split(notice)).toHaveLength(2);
      expect(textOf(result)).not.toContain('No data found');
    },
  );

  it.each([{ total: 0, page: 1 }, { total: 0, page: 2 }, { page: 1 }, { page: 2 }])(
    'qualifies an empty breakdown using only known total %j',
    async (meta) => {
      reply({ results: [], page_metadata: { ...meta, hasNext: false } });
      const result = await runToolContract(disasterSpendingTool, {
        dimension: 'agency',
        filters: { def_codes: ['L'] },
        page: meta.page,
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('total' in meta ? 'No data found' : `Page ${meta.page}`);
      if (!('total' in meta)) {
        expect(result.structuredContent).not.toHaveProperty('totalCount');
        expect(result.structuredContent).not.toHaveProperty('page_metadata.total');
        expect(notice).not.toContain('No data found');
      }
      expect(textOf(result).split(notice)).toHaveLength(2);
    },
  );

  it.each([1, 2])('does not call an empty interior agency page %i past the end', async (page) => {
    reply({ results: [], page_metadata: { total: 30, page, hasNext: false } });
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'agency',
      filters: { def_codes: ['L'] },
      page,
      limit: 10,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [],
      totalCount: 30,
      page_metadata: { page, total: 30, has_next: false, limit: 10 },
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain(`Page ${page} returned no results`);
    expect(notice).toContain('30 matching results across all pages');
    expect(notice).not.toMatch(/past the|earlier page|No data found/);
    expect(textOf(result).split(notice)).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['agency', 'cfda', 'recipient', 'geography'] as const)(
    'declares missing_def_codes for %s without fetching',
    async (dimension) => {
      for (const filters of [undefined, {}, { def_codes: [] }]) {
        const result = await runToolContract(disasterSpendingTool, { dimension, filters });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'missing_def_codes',
              retryable: false,
              recovery: { hint: expect.stringContaining('filters.def_codes') },
            },
          },
        });
        const hint = disasterSpendingTool.errors?.find(
          (entry) => entry.reason === 'missing_def_codes',
        )?.recovery;
        expect(textOf(result)).toContain(`Recovery: ${hint}`);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('keeps nested filter typo rejection and its no-fetch boundary', async () => {
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'recipient',
      filters: { def_codes: ['N'], qurey: 'UW' },
    } as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(textOf(result)).toContain('qurey');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
