/**
 * @fileoverview The program, product/service, and emergency-funding code
 * filters — `assistance_listings`, `psc_codes`, and `def_codes` — on
 * `usaspending_search_awards` and the three `usaspending_spending_*` analytics
 * tools. Every case runs through the tool's public contract on a real
 * `USASpendingService` beneath a strict fetch fake, so assertions read the
 * request body that actually left the process, a pre-request rejection is
 * proven by an empty call log, and an upstream 4xx reaches the caller through
 * the service's own classification.
 * @module tests/tools/spending-code-filters.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';
import { spendingByCategoryTool } from '@/mcp-server/tools/definitions/spending-by-category.tool.js';
import { spendingByGeographyTool } from '@/mcp-server/tools/definitions/spending-by-geography.tool.js';
import { spendingOverTimeTool } from '@/mcp-server/tools/definitions/spending-over-time.tool.js';
import { initUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { markdownText } from '../helpers/markdown-text.js';

const BASE = 'https://api.usaspending.gov/api/v2/';

/** Unrouted requests reject, so nothing in this file can reach the live API. */
const http = createFetchMock();

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

/** The JSON body of the `n`th request sent upstream. */
const sentFilters = async (n = 0) =>
  (JSON.parse(await http.calls[n]!.request.text()) as { filters: Record<string, unknown> }).filters;

const textOf = (result: ContractResult) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

/** One row per analytics tool: its endpoint, a successful and an empty answer, and how to call it. */
const ANALYTICS = [
  {
    name: 'usaspending_spending_by_category',
    tool: spendingByCategoryTool,
    endpoint: `${BASE}search/spending_by_category/naics/`,
    row: { results: [{ id: 1, code: 'X', name: 'Acme', amount: 10 }], page_metadata: {} },
    empty: { results: [], page_metadata: { hasNext: false, page: 1 } },
    run: (args: Record<string, unknown>) =>
      runToolContract(spendingByCategoryTool, { category: 'naics', ...args } as never),
  },
  {
    name: 'usaspending_spending_by_geography',
    tool: spendingByGeographyTool,
    endpoint: `${BASE}search/spending_by_geography/`,
    row: { results: [{ shape_code: 'WA', display_name: 'Washington', aggregated_amount: 10 }] },
    empty: { results: [] },
    run: (args: Record<string, unknown>) =>
      runToolContract(spendingByGeographyTool, {
        scope: 'place_of_performance',
        geo_layer: 'state',
        ...args,
      } as never),
  },
  {
    name: 'usaspending_spending_over_time',
    tool: spendingOverTimeTool,
    endpoint: `${BASE}search/spending_over_time/`,
    row: { results: [{ time_period: { fiscal_year: '2024' }, aggregated_amount: 10 }] },
    empty: { results: [] },
    run: (args: Record<string, unknown>) =>
      runToolContract(spendingOverTimeTool, { group: 'fiscal_year', ...args } as never),
  },
] as const;

type AnalyticsCase = (typeof ANALYTICS)[number];

const answer = (endpoint: string, body: unknown) =>
  http.route({ method: 'POST', match: endpoint, respond: Response.json(body) });

const SEARCH_ENDPOINT = `${BASE}search/spending_by_award/`;
const answerSearch = (rows: Record<string, unknown>[] = [{ 'Award ID': 'A1' }]) =>
  answer(SEARCH_ENDPOINT, { results: rows, page_metadata: { page: 1, hasNext: false } });
const runSearch = (args: Record<string, unknown>) =>
  runToolContract(searchAwardsTool, { limit: 5, ...args } as never);

beforeEach(() => {
  http.reset();
  http.install();
  initUSASpendingService({} as AppConfig, {} as StorageService, {
    baseUrl: BASE,
    timeoutMs: 60_000,
    retryBudgetMs: 60_000,
  });
});

afterEach(() => {
  http.restore();
});

describe('Behavior the code filters leave unchanged', () => {
  it.each(ANALYTICS)(
    '$name: a filters object without code keys sends none of them',
    async ({ endpoint, row, run }: AnalyticsCase) => {
      answer(endpoint, row);
      const result = await run({ filters: { keywords: ['bridge'] } });

      expect(result.isError).toBeFalsy();
      const filters = await sentFilters();
      expect(filters).not.toHaveProperty('program_numbers');
      expect(filters).not.toHaveProperty('psc_codes');
      expect(filters).not.toHaveProperty('def_codes');
    },
  );

  it('usaspending_spending_over_time: award types spanning groups are sent as given', async () => {
    answer(`${BASE}search/spending_over_time/`, ANALYTICS[2].row);
    const result = await ANALYTICS[2].run({ filters: { award_type_codes: ['A', 'B', '02'] } });

    expect(result.isError).toBeFalsy();
    expect((await sentFilters()).award_type_codes).toEqual(['A', 'B', '02']);
  });

  it('usaspending_search_awards: flat assistance_listings beside a nested filters object without them is sent', async () => {
    answerSearch();
    const result = await runSearch({
      assistance_listings: ['15.507'],
      award_type_codes: ['02', '03', '04', '05'],
      filters: { keywords: ['water'] },
    });

    expect(result.isError).toBeFalsy();
    const filters = await sentFilters();
    expect(filters.program_numbers).toEqual(['15.507']);
    expect(filters.keywords).toEqual(['water']);
  });

  it.each(ANALYTICS)(
    '$name: an upstream 400 detail reaches the caller as the error message',
    async ({ endpoint, run }: AnalyticsCase) => {
      const detail =
        "Field 'filters|def_codes' is outside valid values ['1', '2', 'A', 'L', 'M', 'N', 'O', 'P', 'Z']";
      http.route({
        method: 'POST',
        match: endpoint,
        respond: Response.json({ detail }, { status: 400 }),
      });
      const result = await run({ filters: { keywords: ['bridge'] } });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
      expect(markdownText(textOf(result))).toContain(detail);
      expect(http.calls).toHaveLength(1);
    },
  );
});

/** Award types every code filter can match on any of the four tools. */
const MIXED_TYPES = ['A', 'B', 'C', 'D', '02', '03', '04', '05'];

describe('Analytics tools send, echo, and name the code filters (#77)', () => {
  it.each(ANALYTICS)(
    '$name: maps the keys to program_numbers, psc_codes, and def_codes, uppercased',
    async ({ endpoint, row, run }: AnalyticsCase) => {
      answer(endpoint, row);
      const result = await run({
        filters: {
          award_type_codes: MIXED_TYPES,
          assistance_listings: ['15.507', '11.67A'],
          psc_codes: ['y1ne', 'R4'],
          def_codes: ['z', 'aab'],
        },
      });

      expect(result.isError).toBeFalsy();
      const filters = await sentFilters();
      expect(filters.program_numbers).toEqual(['15.507', '11.67A']);
      expect(filters.psc_codes).toEqual(['Y1NE', 'R4']);
      expect(filters.def_codes).toEqual(['Z', 'AAB']);
      expect(filters).not.toHaveProperty('assistance_listings');
      expect(result.structuredContent).toMatchObject({
        applied_assistance_listings: '15.507, 11.67A',
        applied_psc_codes: 'Y1NE, R4',
        applied_def_codes: 'Z, AAB',
      });
      const text = textOf(result);
      expect(text).toContain('15.507, 11.67A');
      expect(text).toContain('Y1NE, R4');
      expect(text).toContain('Z, AAB');
    },
  );

  it.each(ANALYTICS)(
    '$name: empty code lists send no key and echo nothing',
    async ({ endpoint, row, run }: AnalyticsCase) => {
      answer(endpoint, row);
      const result = await run({
        filters: { keywords: ['bridge'], assistance_listings: [], psc_codes: [], def_codes: [] },
      });

      expect(result.isError).toBeFalsy();
      const filters = await sentFilters();
      expect(filters).not.toHaveProperty('program_numbers');
      expect(filters).not.toHaveProperty('psc_codes');
      expect(filters).not.toHaveProperty('def_codes');
      expect(result.structuredContent).not.toHaveProperty('applied_assistance_listings');
      expect(result.structuredContent).not.toHaveProperty('applied_psc_codes');
      expect(result.structuredContent).not.toHaveProperty('applied_def_codes');
    },
  );

  it.each(ANALYTICS)(
    '$name: the empty-result notice names the codes sent',
    async ({ endpoint, empty, run }: AnalyticsCase) => {
      answer(endpoint, empty);
      const result = await run({
        filters: {
          award_type_codes: MIXED_TYPES,
          assistance_listings: ['99.999'],
          psc_codes: ['zz'],
          def_codes: ['q'],
        },
      });

      expect(result.isError).toBeFalsy();
      const notice = (result.structuredContent as { notice?: string }).notice;
      expect(notice).toContain('assistance_listings=99.999');
      expect(notice).toContain('psc_codes=ZZ');
      expect(notice).toContain('def_codes=Q');
      expect(textOf(result)).toContain('psc_codes=ZZ');
    },
  );

  it.each(
    ANALYTICS.flatMap((tool) => [
      { ...tool, field: 'assistance_listings', value: '15.5070' },
      { ...tool, field: 'assistance_listings', value: '15.50a' },
      { ...tool, field: 'psc_codes', value: 'Y1NE5' },
      { ...tool, field: 'psc_codes', value: 'Y1-N' },
      { ...tool, field: 'psc_codes', value: '' },
      { ...tool, field: 'def_codes', value: 'ABCD' },
      { ...tool, field: 'def_codes', value: 'L ' },
    ]),
  )(
    '$name: rejects $field "$value" at argument validation, before any request',
    async ({ run, field, value }) => {
      const result = await run({ filters: { [field]: [value] } });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_arguments' } },
      });
      expect(textOf(result)).toContain(`filters.${field}.0`);
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each(ANALYTICS)(
    "$name: an unknown well-formed DEF code is sent and upstream's 400 detail reaches the caller",
    async ({ endpoint, run }: AnalyticsCase) => {
      const detail =
        "Field 'filters|def_codes' is outside valid values ['1', '2', '3', 'A', 'AAA', 'L', 'M', 'N', 'O', 'P', 'Q', 'QQQ', 'Z']";
      http.route({
        method: 'POST',
        match: endpoint,
        respond: Response.json({ detail }, { status: 400 }),
      });
      const result = await run({ filters: { def_codes: ['zz9'] } });

      expect((await sentFilters()).def_codes).toEqual(['ZZ9']);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, message: expect.stringContaining(detail) },
      });
      expect(markdownText(textOf(result))).toContain(detail);
    },
  );
});

describe('Analytics tools reject a code filter no award type can carry (#77)', () => {
  const recoveryOf = (tool: AnalyticsCase['tool'], reason: string) =>
    tool.errors?.find((e) => e.reason === reason)?.recovery;

  it.each(ANALYTICS)(
    '$name: assistance_listings with only contract and IDV codes fails as assistance_listings_type_mismatch',
    async ({ tool, run }: AnalyticsCase) => {
      const result = await run({
        filters: { award_type_codes: ['A', 'IDV_B'], assistance_listings: ['15.507'] },
      });

      expect(result.isError).toBe(true);
      expect(http.calls).toHaveLength(0);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          message:
            'assistance_listings match only assistance awards, but filters.award_type_codes [A, IDV_B] holds only contract and IDV codes, which carry no listings.',
          data: {
            reason: 'assistance_listings_type_mismatch',
            recovery: { hint: recoveryOf(tool, 'assistance_listings_type_mismatch') },
          },
        },
      });
      expect(textOf(result)).toContain(
        '(reason assistance_listings_type_mismatch · not retryable)',
      );
    },
  );

  it.each(ANALYTICS)(
    '$name: psc_codes with only assistance codes fails as psc_codes_type_mismatch',
    async ({ tool, run }: AnalyticsCase) => {
      const result = await run({
        filters: { award_type_codes: ['02', '03', '04', '05'], psc_codes: ['Y1NE'] },
      });

      expect(result.isError).toBe(true);
      expect(http.calls).toHaveLength(0);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          message:
            'psc_codes match only contracts and IDVs, but filters.award_type_codes [02, 03, 04, 05] holds only assistance codes, which carry no PSC.',
          data: {
            reason: 'psc_codes_type_mismatch',
            recovery: { hint: recoveryOf(tool, 'psc_codes_type_mismatch') },
          },
        },
      });
      expect(textOf(result)).toContain('(reason psc_codes_type_mismatch · not retryable)');
    },
  );

  it.each(ANALYTICS)(
    '$name: def_codes runs under any award type',
    async ({ endpoint, row, run }: AnalyticsCase) => {
      answer(endpoint, row);
      const result = await run({ filters: { award_type_codes: ['02'], def_codes: ['Z'] } });

      expect(result.isError).toBeFalsy();
      expect((await sentFilters()).def_codes).toEqual(['Z']);
    },
  );

  it.each([ANALYTICS[0], ANALYTICS[1]])(
    '$name: with no award_type_codes, listings and PSC run together over every award type',
    async ({ endpoint, row, run }: AnalyticsCase) => {
      answer(endpoint, row);
      const result = await run({
        filters: { assistance_listings: ['15.507'], psc_codes: ['Y1NE'] },
      });

      expect(result.isError).toBeFalsy();
      const filters = await sentFilters();
      expect(filters.program_numbers).toEqual(['15.507']);
      expect(filters.psc_codes).toEqual(['Y1NE']);
      expect(filters).not.toHaveProperty('award_type_codes');
    },
  );

  it('usaspending_spending_by_geography: code filters alone keep the no-filter award type default off', async () => {
    answer(ANALYTICS[1].endpoint, ANALYTICS[1].row);
    const result = await ANALYTICS[1].run({ filters: { def_codes: ['Z'] } });

    expect(result.isError).toBeFalsy();
    expect(await sentFilters()).toEqual({ def_codes: ['Z'] });
    expect(result.structuredContent).not.toHaveProperty('applied_award_type_default');
  });

  it('usaspending_spending_over_time: assistance_listings with award types omitted fails on the contract default', async () => {
    const result = await ANALYTICS[2].run({ filters: { assistance_listings: ['15.507'] } });

    expect(result.isError).toBe(true);
    expect(http.calls).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      error: {
        message:
          'assistance_listings match only assistance awards, but filters.award_type_codes [A, B, C, D] holds only contract and IDV codes, which carry no listings. filters.award_type_codes defaults to contracts when omitted.',
        data: { reason: 'assistance_listings_type_mismatch' },
      },
    });
  });

  it('usaspending_spending_over_time: psc_codes with award types omitted runs on the contract default', async () => {
    answer(ANALYTICS[2].endpoint, ANALYTICS[2].row);
    const result = await ANALYTICS[2].run({ filters: { psc_codes: ['y1'] } });

    expect(result.isError).toBeFalsy();
    expect(await sentFilters()).toEqual({
      award_type_codes: ['A', 'B', 'C', 'D'],
      psc_codes: ['Y1'],
    });
  });

  it('usaspending_spending_over_time: listings and PSC run together when the award types span both', async () => {
    answer(ANALYTICS[2].endpoint, ANALYTICS[2].row);
    const result = await ANALYTICS[2].run({
      filters: {
        award_type_codes: MIXED_TYPES,
        assistance_listings: ['15.507'],
        psc_codes: ['Y1NE'],
      },
    });

    expect(result.isError).toBeFalsy();
    const filters = await sentFilters();
    expect(filters.award_type_codes).toEqual(MIXED_TYPES);
    expect(filters.program_numbers).toEqual(['15.507']);
    expect(filters.psc_codes).toEqual(['Y1NE']);
  });
});

describe('usaspending_search_awards code filters (#77)', () => {
  const recoveryOf = (reason: string) =>
    searchAwardsTool.errors?.find((e) => e.reason === reason)?.recovery;

  it('sends flat psc_codes and def_codes uppercased and echoes them on both surfaces', async () => {
    answerSearch();
    const result = await runSearch({ psc_codes: ['y1ne'], def_codes: ['z'] });

    expect(result.isError).toBeFalsy();
    const filters = await sentFilters();
    expect(filters.psc_codes).toEqual(['Y1NE']);
    expect(filters.def_codes).toEqual(['Z']);
    expect(filters.award_type_codes).toEqual(['A', 'B', 'C', 'D']);
    expect(result.structuredContent).toMatchObject({
      applied_psc_codes: 'Y1NE',
      applied_def_codes: 'Z',
    });
    const text = textOf(result);
    expect(text).toContain('Y1NE');
    expect(text).toContain('applied_def_codes');
  });

  it('nested code filters win over flat ones per field; an empty nested list falls back', async () => {
    answerSearch();
    const result = await runSearch({
      award_type_codes: ['02'],
      assistance_listings: ['93.866'],
      def_codes: ['L'],
      filters: { assistance_listings: ['15.507'], def_codes: [] },
    });

    expect(result.isError).toBeFalsy();
    const filters = await sentFilters();
    expect(filters.program_numbers).toEqual(['15.507']);
    expect(filters.def_codes).toEqual(['L']);
    expect(result.structuredContent).toMatchObject({
      applied_assistance_listings: '15.507',
      applied_def_codes: 'L',
    });
  });

  it('empty flat and nested code lists send no key', async () => {
    answerSearch();
    const result = await runSearch({
      psc_codes: [],
      def_codes: [],
      filters: { assistance_listings: [], psc_codes: [], def_codes: [] },
    });

    expect(result.isError).toBeFalsy();
    expect(await sentFilters()).toEqual({ award_type_codes: ['A', 'B', 'C', 'D'] });
  });

  it.each([
    ['grants', { award_type_codes: ['02', '03'] }],
    ['nested loans over flat contracts', { filters: { award_type_codes: ['07', '08'] } }],
    ['other assistance', { award_type_codes: ['-1'] }],
  ])('rejects psc_codes with %s before any request', async (_label, types) => {
    const result = await runSearch({ psc_codes: ['Y1NE'], ...types });

    expect(result.isError).toBe(true);
    expect(http.calls).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: {
          reason: 'psc_codes_type_mismatch',
          recovery: { hint: recoveryOf('psc_codes_type_mismatch') },
        },
      },
    });
    expect(textOf(result)).toContain('include assistance codes, which carry no PSC');
  });

  it('runs psc_codes with IDVs', async () => {
    answerSearch();
    const result = await runSearch({ psc_codes: ['R4'], award_type_codes: ['IDV_A', 'IDV_B'] });

    expect(result.isError).toBeFalsy();
    expect((await sentFilters()).psc_codes).toEqual(['R4']);
  });

  it('rejects nested assistance_listings with the default contract codes', async () => {
    const result = await runSearch({ filters: { assistance_listings: ['15.507'] } });

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'assistance_listings_type_mismatch' } },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('names the PSC and DEF codes in the empty-result notice', async () => {
    answerSearch([]);
    const result = await runSearch({ psc_codes: ['zz'], def_codes: ['q'] });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('Page 1 returned no awards');
    expect(notice).toContain('psc_codes=ZZ');
    expect(notice).toContain('def_codes=Q');
  });

  it('accepts an analytics filters object unchanged except recipient_id, and sends the same codes', async () => {
    const analyticsFilters = {
      keywords: ['water'],
      award_type_codes: ['02', '03', '04', '05'],
      agency_name: 'Department of the Interior',
      naics_codes: ['221310'],
      assistance_listings: ['15.507'],
      def_codes: ['z'],
      time_period_start: '2023-10-01',
      time_period_end: '2024-09-30',
    };
    answer(ANALYTICS[0].endpoint, ANALYTICS[0].row);
    answerSearch();

    const analytics = await ANALYTICS[0].run({ filters: analyticsFilters });
    const search = await runSearch({ filters: analyticsFilters });

    expect(analytics.isError).toBeFalsy();
    expect(search.isError).toBeFalsy();
    const [analyticsSent, searchSent] = [await sentFilters(0), await sentFilters(1)];
    for (const key of ['program_numbers', 'def_codes', 'award_type_codes', 'time_period']) {
      expect({ key, value: searchSent[key] }).toEqual({ key, value: analyticsSent[key] });
    }
    expect(searchSent.def_codes).toEqual(['Z']);
  });
});

describe('tools/list describes the code filters the same way on all four tools (#77)', () => {
  interface Node {
    description?: string;
    items?: { pattern?: string; description?: string };
    properties?: Record<string, Node>;
  }
  const inputSchema = (tool: { input: z.ZodType }) =>
    z.toJSONSchema(tool.input, { io: 'input' }) as Node & Record<string, unknown>;

  const KEYS = ['assistance_listings', 'psc_codes', 'def_codes'] as const;

  it('advertises one schema per key at every site, inline, with its pattern', () => {
    const search = inputSchema(searchAwardsTool);
    const sites: [string, Node][] = [
      ['usaspending_search_awards', search],
      ['usaspending_search_awards filters', search.properties!.filters!],
      ...ANALYTICS.map(
        ({ name, tool }) => [name, inputSchema(tool).properties!.filters!] as [string, Node],
      ),
    ];
    for (const key of KEYS) {
      const [first, ...rest] = sites.map(([site, node]) => ({ site, node: node.properties![key] }));
      expect(first!.node?.description).toEqual(expect.any(String));
      expect(first!.node?.items?.pattern).toEqual(expect.any(String));
      for (const other of rest) {
        expect({ site: other.site, node: other.node }).toEqual({
          site: other.site,
          node: first!.node,
        });
      }
    }
    for (const tool of [searchAwardsTool, ...ANALYTICS.map((a) => a.tool)]) {
      expect(JSON.stringify(inputSchema(tool))).not.toContain('$ref');
    }
  });
});
