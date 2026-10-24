/**
 * @fileoverview Search normalization and account-page recovery through the real service.
 * @module tests/tools/search-account-contract.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAwardFederalAccountsTool } from '@/mcp-server/tools/definitions/get-award-federal-accounts.tool.js';
import { getFederalAccountBreakdownTool } from '@/mcp-server/tools/definitions/get-federal-account-breakdown.tool.js';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';
import { searchRecipientsTool } from '@/mcp-server/tools/definitions/search-recipients.tool.js';
import { USASpendingService } from '@/services/usaspending/usaspending-service.js';

const upstream = vi.hoisted(() => ({ service: undefined as USASpendingService | undefined }));
vi.mock('@/services/usaspending/usaspending-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/usaspending/usaspending-service.js')>()),
  getUSASpendingService: () => {
    if (!upstream.service) throw new Error('Missing test service');
    return upstream.service;
  },
}));

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
const fetchMock = vi.fn<typeof fetch>();
const reply = (body: unknown) => fetchMock.mockResolvedValueOnce(Response.json(body));
const bodyOf = () => JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) => {
  expect(result.isError).toBeFalsy();
  const notice = (result.structuredContent as { notice: string }).notice;
  expect(typeof notice).toBe('string');
  expect(textOf(result).split(notice)).toHaveLength(2);
  return notice;
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('Unexpected fetch'));
  vi.stubGlobal('fetch', fetchMock);
  upstream.service = new USASpendingService({} as AppConfig, {} as StorageService, {
    baseUrl: 'https://api.usaspending.gov/api/v2/',
    timeoutMs: 30_000,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  upstream.service = undefined;
});

describe('search/account characterization', () => {
  it('retains recipient category, exact final-page flag and absent totals', async () => {
    reply({
      results: [{ id: 'recipient-R', name: 'UW' }],
      page_metadata: { page: 2, hasNext: false },
    });
    const result = await runToolContract(searchRecipientsTool, {
      keyword: 'UW',
      award_type: 'grants',
      page: 2,
      limit: 1,
    });
    expect(bodyOf()).toEqual({ keyword: 'UW', award_type: 'grants', page: 2, limit: 1 });
    expect(result.structuredContent).toMatchObject({
      results: [{ id: 'recipient-R' }],
      page_metadata: { page: 2, has_next: false },
    });
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    expect(result.structuredContent).not.toHaveProperty('page_metadata.total');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textOf(result)).toContain('UW');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('search/account regressions', () => {
  it.each(['award', 'program_activity', 'object_class'] as const)(
    'keeps %s zero-total and unknown-total guidance distinct on both surfaces',
    async (kind) => {
      for (const total of [0, undefined]) {
        reply({
          results: [],
          page_metadata: {
            ...(total !== undefined ? { count: total, total } : {}),
            page: 1,
            hasNext: false,
          },
        });
        const result =
          kind === 'award'
            ? await runToolContract(getAwardFederalAccountsTool, { award_id: 'AWARD' })
            : await runToolContract(getFederalAccountBreakdownTool, {
                account_code: '014-0680',
                dimension: kind,
              });
        const notice = noticeOf(result);
        if (total === 0) {
          expect(notice).toContain(
            kind === 'award' ? 'No federal accounts fund' : `No ${kind} obligations found`,
          );
          expect(result.structuredContent).toHaveProperty('totalCount', 0);
        } else {
          expect(notice).toContain('Page 1 returned no results');
          expect(notice).not.toMatch(/No federal accounts fund|No .* obligations found/);
          expect(result.structuredContent).not.toHaveProperty('totalCount');
          expect(result.structuredContent).not.toHaveProperty(
            `page_metadata.${kind === 'award' ? 'count' : 'total'}`,
          );
        }
      }
    },
  );

  it.each([0, undefined])(
    'composes blank keyword with an empty page and total %j',
    async (total) => {
      reply({
        results: [],
        page_metadata: { ...(total !== undefined ? { total } : {}), page: 2, hasNext: false },
      });
      const result = await runToolContract(searchRecipientsTool, {
        keyword: '\t',
        award_type: 'grants',
        page: 2,
      });
      expect(bodyOf()).toEqual({ award_type: 'grants', page: 2, limit: 10 });
      const notice = noticeOf(result);
      expect(notice).toContain('No keyword filter');
      expect(notice).toContain(
        total === 0 ? 'No recipients matched the selected filters' : 'Page 2 returned no results',
      );
      if (total === undefined) expect(result.structuredContent).not.toHaveProperty('totalCount');
    },
  );

  it.each([
    { page: 1, total: 0, fragment: 'No recipients matched' },
    { page: 2, total: 0, fragment: 'No recipients matched' },
    { page: 1, total: 3, fragment: 'Page 1 returned no results' },
    { page: 2, total: 3, fragment: 'Page 2 returned no results' },
    { page: 4, total: 3, fragment: 'earlier page' },
    { page: 1, total: undefined, fragment: 'Page 1 returned no results' },
    { page: 2, total: undefined, fragment: 'Page 2 returned no results' },
  ])('distinguishes empty-page evidence %j', async ({ page, total, fragment }) => {
    reply({
      results: [],
      page_metadata: { page, ...(total !== undefined ? { total } : {}), hasNext: false },
    });
    const result = await runToolContract(searchRecipientsTool, { keyword: 'test', page, limit: 1 });
    const notice = noticeOf(result);
    expect(notice).toContain(fragment);
    if (total !== 0) expect(notice).not.toContain('No recipients matched');
    if (page === 1 || (total !== undefined && page - 1 < total))
      expect(notice).not.toContain('earlier page');
    if (total === undefined) {
      expect(result.structuredContent).not.toHaveProperty('totalCount');
      expect(result.structuredContent).not.toHaveProperty('page_metadata.total');
    } else expect(result.structuredContent).toHaveProperty('totalCount', total);
  });

  it.each([' ', '\t'])(
    'omits blank recipient keyword %j and composes continuation',
    async (keyword) => {
      reply({
        results: [{ id: 'recipient-R' }],
        page_metadata: { page: 2, total: 3, hasNext: true },
      });
      const result = await runToolContract(searchRecipientsTool, {
        keyword,
        award_type: 'grants',
        limit: 1,
        page: 2,
      });
      expect(bodyOf()).toEqual({ award_type: 'grants', limit: 1, page: 2 });
      const notice = noticeOf(result);
      expect(notice).toContain('No keyword filter');
      expect(notice).toContain('page 3');
      expect(result.structuredContent).toMatchObject({ totalCount: 3, has_next: true });
    },
  );

  it('trims a nonblank recipient keyword', async () => {
    reply({ results: [{ name: 'UW' }], page_metadata: { total: 1, hasNext: false } });
    const result = await runToolContract(searchRecipientsTool, {
      keyword: '  university of washington  ',
    });
    expect(bodyOf().keyword).toBe('university of washington');
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('retains the required nonempty advertised keyword boundary without fetching', async () => {
    for (const input of [{}, { keyword: '' }]) {
      const result = await runToolContract(searchRecipientsTool, input as never);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ last_record_sort_value: '100' }, { last_record_unique_id: 1 }])(
    'declares lone cursor recovery %j without fetching',
    async (input) => {
      const result = await runToolContract(searchAwardsTool, input);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'incomplete_cursor',
            retryable: false,
            recovery: { hint: expect.stringContaining('both') },
          },
        },
      });
      const hint = searchAwardsTool.errors?.find(
        (entry) => entry.reason === 'incomplete_cursor',
      )?.recovery;
      expect(textOf(result)).toContain(`Recovery: ${hint}`);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { last_record_sort_value: '100', last_record_unique_id: 1 }])(
    'retains valid cursor boundary %j',
    async (input) => {
      reply({ results: [{ 'Award ID': 'A' }], page_metadata: { hasNext: false } });
      const result = await runToolContract(searchAwardsTool, input);
      expect(result.isError).toBeFalsy();
      expect(bodyOf()).toMatchObject(input);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      types: ['02'],
      code: 'PR76770',
      location: { city_name: 'JAYUYA' },
      expected: { city: 'JAYUYA' },
    },
    {
      types: ['A'],
      code: null,
      location: { city_name: 'LOUISVILLE' },
      expected: { city: 'LOUISVILLE' },
    },
    ...[undefined, null, {}, { city_name: null }, { city_name: '' }].map((location) => ({
      types: ['A'],
      code: '12345',
      location,
      expected: {},
    })),
  ])('uses only the city name for $location', async ({ types, code, location, expected }) => {
    reply({
      results: [
        {
          'Award ID': 'A',
          'Primary Place of Performance': location,
          'Place of Performance City Code': code,
        },
      ],
      page_metadata: { hasNext: false },
    });
    const result = await runToolContract(searchAwardsTool, { award_type_codes: types });
    expect(bodyOf().fields).toContain('Primary Place of Performance');
    expect(bodyOf().fields).not.toContain('Place of Performance City Code');
    const row = (result.structuredContent as { results: Array<{ place_of_performance?: unknown }> })
      .results[0];
    if ('city' in expected) {
      expect(row?.place_of_performance).toEqual(expected);
      expect(textOf(result)).toContain(`**Place of Performance:** ${expected.city}`);
    } else expect(row).not.toHaveProperty('place_of_performance');
    expect(textOf(result)).not.toContain('12345');
    expect(textOf(result)).not.toContain('PR76770');
  });

  it('keeps state and country from their existing fields', async () => {
    reply({
      results: [
        {
          'Primary Place of Performance': {
            city_name: 'Seattle',
            state_code: 'XX',
            country_code: 'XX',
          },
          'Place of Performance State Code': 'WA',
          'Place of Performance Country Code': 'USA',
        },
      ],
    });
    const result = await runToolContract(searchAwardsTool, {});
    expect(result.structuredContent).toMatchObject({
      results: [{ place_of_performance: { city: 'Seattle', state: 'WA', country: 'USA' } }],
    });
    expect(textOf(result)).toContain('Seattle, WA, USA');
  });

  it.each(['award', 'program_activity', 'object_class', 'recipient'] as const)(
    'wires %s past-end recovery to both surfaces',
    async (kind) => {
      reply({
        results: [],
        page_metadata: { count: 1, total: 1, page: 2, hasNext: false, hasPrevious: true },
      });
      const result =
        kind === 'award'
          ? await runToolContract(getAwardFederalAccountsTool, {
              award_id: 'AWARD',
              page: 2,
              limit: 1,
            })
          : kind === 'recipient'
            ? await runToolContract(searchRecipientsTool, { keyword: ' ', page: 2, limit: 1 })
            : await runToolContract(getFederalAccountBreakdownTool, {
                account_code: '014-0680',
                dimension: kind,
                page: 2,
                limit: 1,
              });
      const notice = noticeOf(result);
      expect(notice).toContain('earlier page');
      expect(notice).toContain('same filters');
      expect(notice).not.toMatch(
        /No federal accounts fund|No .* obligations found|No recipients matched/,
      );
      if (kind === 'recipient') expect(notice).toContain('No keyword filter');
      expect(result.structuredContent).toHaveProperty('totalCount', 1);
    },
  );

  it.each([1, 2])('keeps unknown award totals page-scoped on page %i', async (page) => {
    reply({ results: [], page_metadata: { page, hasNext: false } });
    const result = await runToolContract(searchAwardsTool, { keyword: 'test', page });
    expect(noticeOf(result)).toContain(`Page ${page}`);
    expect(noticeOf(result)).not.toContain('No awards matched');
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    expect(result.structuredContent).not.toHaveProperty('page_metadata.total');
  });
});
