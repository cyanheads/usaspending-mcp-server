/**
 * @fileoverview Disaster request filtering and recovery through the real service.
 * @module tests/tools/disaster-contract.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
const referenceMock = vi.fn<typeof fetch>();
const reply = (body: unknown) => fetchMock.mockResolvedValueOnce(Response.json(body));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('Unexpected fetch'));
  referenceMock.mockReset();
  referenceMock.mockImplementation(async () =>
    Response.json({
      codes: [
        ...['L', 'M', 'N', 'O', 'P', 'U', 'V'].map((code) => ({ code, disaster: 'covid_19' })),
        { code: 'Z', disaster: 'infrastructure' },
      ],
    }),
  );
  vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
    String(url).includes('/references/def_codes/')
      ? referenceMock(url, init)
      : fetchMock(url, init),
  );
  upstream.service = new USASpendingService({} as AppConfig, {} as StorageService, {
    baseUrl: BASE,
    timeoutMs: 30_000,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  upstream.service = undefined;
});

describe('disaster monetary scope and reference failures', () => {
  it.each(['agency', 'cfda', 'recipient', 'geography'] as const)(
    'mirrors all known amount scopes on %s without changing raw numbers/counts',
    async (dimension) => {
      for (const [codes, status, supported, unsupported] of [
        [['L', 'M', 'N', 'O', 'P', 'U', 'V'], 'complete', ['L', 'M', 'N', 'O', 'P', 'U', 'V'], []],
        [['Z'], 'unavailable', [], ['Z']],
        [['L', 'Z'], 'partial', ['L'], ['Z']],
      ] as const) {
        reply({
          results: [
            {
              id: 'raw',
              code: '001',
              obligation: 0,
              outlay: -2,
              amount: 0,
              per_capita: 0,
              award_count: 4,
            },
          ],
          totals: { obligation: 0, outlay: -2, award_count: 4 },
          page_metadata: { total: 1, hasNext: false },
        });
        const result = await runToolContract(disasterSpendingTool, {
          dimension,
          filters: { def_codes: [...codes] },
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          amount_coverage: {
            status,
            supported_def_codes: [...supported],
            unsupported_def_codes: [...unsupported],
          },
          results: [
            {
              award_count: 4,
              ...(dimension === 'geography'
                ? { aggregated_amount: 0, per_capita: 0 }
                : { obligation: 0, outlay: -2 }),
            },
          ],
        });
        const text = textOf(result);
        expect(text).toContain(`**Amount coverage:** ${status}`);
        for (const code of codes) expect(text).toContain(code);
        if (status !== 'complete') {
          expect(text).toContain('Row membership and award counts');
          expect(text).toContain('not DEF-funded shares');
          if (status === 'unavailable')
            expect(text).toContain('not evidence of zero actual spending');
          else expect(text).toContain('only the supported COVID DEF codes');
        }
      }
    },
  );

  it.each(['overview', 'agency'] as const)(
    'keeps %s full-code coverage independent of reference availability',
    async (dimension) => {
      reply({ results: [], page_metadata: { total: 0, hasNext: false } });
      const result = await runToolContract(disasterSpendingTool, {
        dimension,
        spending_type: 'total',
        filters: { def_codes: ['Z'] },
      });
      expect(result.structuredContent).toHaveProperty('amount_coverage', {
        status: 'complete',
        supported_def_codes: ['Z'],
        unsupported_def_codes: [],
      });
      expect(referenceMock).not.toHaveBeenCalled();
      expect(textOf(result)).toContain('complete');
    },
  );

  it('derives grouping from the reference rather than a fixed COVID code set', async () => {
    referenceMock.mockResolvedValueOnce(
      Response.json({
        codes: [
          { code: 'AAA', disaster: 'covid_19' },
          { code: 'L', disaster: null },
        ],
      }),
    );
    reply({ results: [{ obligation: 12 }] });
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'cfda',
      filters: { def_codes: ['AAA', 'L'] },
    });
    expect(result.structuredContent).toHaveProperty('amount_coverage', {
      status: 'partial',
      supported_def_codes: ['AAA'],
      unsupported_def_codes: ['L'],
    });
    expect(textOf(result)).toContain('**Supported DEF codes:** AAA');
    expect(textOf(result)).toContain('**Unsupported DEF codes:** L');
  });

  it.each([403, 404, 429, 500, 503])(
    'preserves primary data when the official reference returns HTTP %i',
    async (status) => {
      vi.useFakeTimers();
      referenceMock.mockImplementation(async () =>
        Response.json({ detail: 'Reference unavailable' }, { status }),
      );
      reply({
        results: [{ id: 'raw', obligation: -12, award_count: 4 }],
        totals: { obligation: 999 },
      });
      const pending = runToolContract(disasterSpendingTool, {
        dimension: 'recipient',
        filters: { def_codes: ['Z'], geo_layer: 'county' },
      });
      await vi.advanceTimersByTimeAsync(2_001);
      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        amount_coverage: { status: 'unknown' },
        totals: { obligation: 999 },
        results: [{ obligation: -12, award_count: 4 }],
      });
      expect(result.structuredContent).not.toHaveProperty('amount_coverage.supported_def_codes');
      expect(result.structuredContent).not.toHaveProperty('amount_coverage.unsupported_def_codes');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(referenceMock).toHaveBeenCalledTimes(status < 429 ? 1 : 2);
      expect(textOf(result)).toContain('unknown');
      expect(textOf(result)).toContain('filters.geo_layer');
      expect(textOf(result)).toContain('-$12');
      expect(textOf(result)).toContain('$999');
    },
  );

  it.each(['headers', 'body'] as const)(
    'bounds a reference timeout during %s without losing the primary result',
    async (phase) => {
      vi.useFakeTimers();
      referenceMock.mockImplementation(async (_url, init) => {
        const signal = init?.signal;
        if (phase === 'headers')
          return new Promise<Response>((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(signal.reason)),
          );
        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener('abort', () => controller.error(signal.reason));
            },
          }),
        );
      });
      reply({ results: [{ id: 'kept', obligation: 2 }] });
      const pending = runToolContract(disasterSpendingTool, {
        dimension: 'cfda',
        filters: { def_codes: ['Z'] },
      });
      await vi.advanceTimersByTimeAsync(2_001);
      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        amount_coverage: { status: 'unknown' },
        results: [{ id: 'kept', obligation: 2 }],
      });
      expect(referenceMock).toHaveBeenCalledTimes(1);
      expect(textOf(result)).toContain('unknown');
      expect(textOf(result)).toContain('kept');
    },
  );

  it.each([
    {},
    { codes: [] },
    { codes: [{ code: 'L' }] },
    { codes: [{ code: 1, disaster: 'covid_19' }] },
  ])('does not invent supported-code lists from malformed reference %j', async (body) => {
    referenceMock.mockResolvedValueOnce(Response.json(body));
    reply({ results: [] });
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'cfda',
      filters: { def_codes: ['L'] },
    });
    expect(result.structuredContent).toHaveProperty('amount_coverage', { status: 'unknown' });
    expect(textOf(result)).toContain('unknown');
    expect(textOf(result)).not.toContain('**Supported DEF codes:**');
  });

  it('composes unavailable geography coverage with zero-valued ranking and ignored filters', async () => {
    reply({
      results: [
        { shape_code: 'WA', amount: 0 },
        { shape_code: 'CA', amount: 0 },
      ],
    });
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'geography',
      filters: { def_codes: ['Z'], query: 'ignored' },
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      amount_coverage: { status: 'unavailable' },
      truncated: true,
      truncationCeiling: 0,
    });
    const text = textOf(result);
    expect(text).toContain('not evidence of zero actual spending');
    expect(text).toContain('in the reported amount scope');
    expect(text).toContain('filters.query');
    expect(text).toContain('Request page 2');
  });

  it('propagates caller cancellation from the direct handler during reference lookup', async () => {
    const caller = new AbortController();
    referenceMock.mockImplementation(async (_url, init) => {
      caller.abort();
      throw init?.signal?.reason;
    });
    reply({ results: [{ id: 'primary' }] });
    await expect(
      disasterSpendingTool.handler(
        disasterSpendingTool.input.parse({ dimension: 'cfda', filters: { def_codes: ['L'] } }),
        createMockContext({ signal: caller.signal, errors: disasterSpendingTool.errors }),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(caller.signal.aborted).toBe(true);
    expect(referenceMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates direct-handler cancellation during a later agency page without returning partial rows', async () => {
    const caller = new AbortController();
    reply({ results: [{ id: 'partial' }], page_metadata: { hasNext: true } });
    fetchMock.mockImplementationOnce(async (_url, init) => {
      caller.abort();
      throw init?.signal?.reason;
    });
    await expect(
      disasterSpendingTool.handler(
        disasterSpendingTool.input.parse({ dimension: 'agency', filters: { def_codes: ['L'] } }),
        createMockContext({ signal: caller.signal, errors: disasterSpendingTool.errors }),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(referenceMock).not.toHaveBeenCalled();
  });

  it('shares the primary call deadline with metadata without losing an otherwise complete result', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 44_900));
      return Response.json({ results: [{ id: 'kept' }] });
    });
    referenceMock.mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );
    upstream.service = new USASpendingService({} as AppConfig, {} as StorageService, {
      baseUrl: BASE,
      timeoutMs: 60_000,
      retryBudgetMs: 60_000,
    });
    let settled = false;
    const pending = runToolContract(disasterSpendingTool, {
      dimension: 'cfda',
      filters: { def_codes: ['L'] },
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(45_001);
    expect(settled).toBe(true);
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      amount_coverage: { status: 'unknown' },
      results: [{ id: 'kept' }],
    });
    expect(textOf(result)).toContain('unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(referenceMock).toHaveBeenCalledTimes(1);
  });

  it('returns a page-walk deadline failure with declared recovery on both surfaces', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      return Response.json({ results: [{ id: 'partial' }], page_metadata: { hasNext: true } });
    });
    fetchMock.mockImplementationOnce(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );
    upstream.service = new USASpendingService({} as AppConfig, {} as StorageService, {
      baseUrl: BASE,
      timeoutMs: 60_000,
      retryBudgetMs: 60_000,
    });
    const pending = runToolContract(disasterSpendingTool, {
      dimension: 'agency',
      filters: { def_codes: ['L'] },
    });
    await vi.advanceTimersByTimeAsync(45_001);
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'api_timeout',
          recovery: { hint: expect.stringContaining('all provider pages') },
        },
      },
    });
    expect(result.structuredContent).not.toHaveProperty('results');
    expect(textOf(result)).toContain('api_timeout');
    expect(textOf(result)).toContain('all provider pages');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(referenceMock).not.toHaveBeenCalled();
  });

  it('rejects malformed DEF shapes locally while retaining upstream unknown-code detail', async () => {
    const invalid = await runToolContract(disasterSpendingTool, {
      dimension: 'cfda',
      filters: { def_codes: ['not-a-code'] },
    });
    expect(invalid.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(textOf(invalid)).toContain('DEF code');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(referenceMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(
      Response.json({ detail: 'Choose accepted DEF codes: L, Z' }, { status: 400 }),
    );
    const unknown = await runToolContract(disasterSpendingTool, {
      dimension: 'cfda',
      filters: { def_codes: ['ZZZ'] },
    });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('Choose accepted DEF codes: L, Z');
    expect(referenceMock).not.toHaveBeenCalled();
  });
});

describe('disaster contract characterization', () => {
  it('preserves sparse signed totals independently of row sums', async () => {
    reply({
      results: [{ id: '1', obligation: 4 }],
      totals: { obligation: -12, outlay: null },
      page_metadata: { hasNext: false },
    });
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'cfda',
      filters: { def_codes: ['L'] },
    });
    expect(result.structuredContent).toMatchObject({
      totals: { obligation: -12 },
      results: [{ obligation: 4 }],
    });
    expect(result.structuredContent).not.toHaveProperty('totals.outlay');
    expect(textOf(result)).toContain('-$12');
  });
  it('keeps exact final-page continuation and nested pagination without overfetch', async () => {
    reply({
      results: [{ id: '1', description: 'Agency' }],
      page_metadata: { total: 2, page: 2, hasNext: false },
    });
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'agency',
      spending_type: 'total',
      filters: { def_codes: ['L'] },
      limit: 1,
      page: 2,
    });
    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      filter: { def_codes: ['L'] },
      pagination: { page: 2, limit: 1, sort: 'obligation', order: 'desc' },
      spending_type: 'total',
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
  it('normalizes disaster DEF codes before sending and echoing', async () => {
    reply({ results: [], page_metadata: { total: 0, hasNext: false } });
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'cfda',
      filters: { def_codes: ['z'] },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).filter.def_codes).toEqual(['Z']);
    expect(result.structuredContent).toHaveProperty('applied_def_codes', 'Z');
    expect(codeValues(result)).toContain('Z');
  });

  it('requests global obligation ordering for recipient selection', async () => {
    reply({ results: [], page_metadata: { total: 0, hasNext: false } });
    await runToolContract(disasterSpendingTool, {
      dimension: 'recipient',
      filters: { def_codes: ['L'] },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).pagination).toMatchObject({
      sort: 'obligation',
      order: 'desc',
    });
  });

  it('collects three agency award pages before ranking and slicing', async () => {
    reply({
      results: [{ id: 'dfc', code: '003', obligation: 1 }],
      totals: { obligation: 60 },
      page_metadata: { total: 3, hasNext: true },
    });
    reply({
      results: [{ id: 'hhs', code: '001', obligation: 30 }],
      totals: { obligation: 60 },
      page_metadata: { total: 3, hasNext: true },
    });
    reply({
      results: [{ id: 'usaid', code: '002', obligation: 29 }],
      totals: { obligation: 60 },
      page_metadata: { total: 3, hasNext: false },
    });
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'agency',
      filters: { def_codes: ['L'] },
      limit: 2,
    });
    expect(result.structuredContent).toMatchObject({
      results: [{ id: 'hhs' }, { id: 'usaid' }],
      totals: { obligation: 60 },
      page_metadata: { has_next: true, total: 3 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(textOf(result)).toContain('usaid');
  });

  it('discloses unknown amount coverage when the reference is malformed', async () => {
    reply({ results: [{ id: '1', obligation: 0, award_count: 4 }], totals: { obligation: 0 } });
    referenceMock.mockResolvedValueOnce(Response.json({ codes: 'malformed' }));
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'cfda',
      filters: { def_codes: ['Z'] },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      amount_coverage: { status: 'unknown' },
      results: [{ obligation: 0, award_count: 4 }],
    });
    expect(textOf(result)).toContain('unknown');
    expect(textOf(result)).toContain('reference');
  });
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
        ...(dimension === 'agency' ? { spending_type: 'total' } : {}),
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
        spending_type: 'total',
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
      spending_type: 'total',
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
      expect(referenceMock).not.toHaveBeenCalled();
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
    expect(referenceMock).not.toHaveBeenCalled();
  });
});
