/**
 * @fileoverview The place-of-performance and recipient location filters —
 * `filters.place_of_performance_location` and `filters.recipient_location` — on
 * the three `usaspending_spending_*` analytics tools. Every case runs through
 * the tool's public contract on a real `USASpendingService` beneath a strict
 * fetch fake, so assertions read the request body that left the process and a
 * pre-request rejection is proven by an empty call log. Normalization itself is
 * tabled once at its own seam (`tests/utils/filters.test.ts`); these cases prove
 * the wiring.
 * @module tests/tools/spending-location-filters.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spendingByCategoryTool } from '@/mcp-server/tools/definitions/spending-by-category.tool.js';
import { spendingByGeographyTool } from '@/mcp-server/tools/definitions/spending-by-geography.tool.js';
import { spendingOverTimeTool } from '@/mcp-server/tools/definitions/spending-over-time.tool.js';
import { initUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { markdownText } from '../helpers/markdown-text.js';

const BASE = 'https://api.usaspending.gov/api/v2/';

/** Unrouted requests reject, so nothing in this file can reach the live API. */
const http = createFetchMock();

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

/** The `filters` of the first request sent upstream. */
const sentFilters = async () =>
  (JSON.parse(await http.calls[0]!.request.text()) as { filters: Record<string, unknown> }).filters;

const textOf = (result: ContractResult) =>
  markdownText(result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'));

/** One row per analytics tool: its endpoint, a successful and an empty answer, and how to call it. */
const ANALYTICS = [
  {
    name: 'usaspending_spending_by_category',
    endpoint: `${BASE}search/spending_by_category/recipient_duns/`,
    row: { results: [{ code: '1', name: 'Acme', amount: 10 }], page_metadata: {} },
    empty: { results: [], page_metadata: { hasNext: false, page: 1 } },
    run: (args: Record<string, unknown>) =>
      runToolContract(spendingByCategoryTool, { category: 'recipient_duns', ...args } as never),
  },
  {
    name: 'usaspending_spending_by_geography',
    endpoint: `${BASE}search/spending_by_geography/`,
    row: { results: [{ shape_code: '35049', display_name: 'Santa Fe', aggregated_amount: 10 }] },
    empty: { results: [] },
    run: (args: Record<string, unknown>) =>
      runToolContract(spendingByGeographyTool, {
        scope: 'place_of_performance',
        geo_layer: 'county',
        ...args,
      } as never),
  },
  {
    name: 'usaspending_spending_over_time',
    endpoint: `${BASE}search/spending_over_time/`,
    row: { results: [{ time_period: { fiscal_year: '2025' }, aggregated_amount: 10 }] },
    empty: { results: [] },
    run: (args: Record<string, unknown>) =>
      runToolContract(spendingOverTimeTool, { group: 'fiscal_year', ...args } as never),
  },
] as const;

type AnalyticsCase = (typeof ANALYTICS)[number];

const answer = (endpoint: string, body: unknown) =>
  http.route({ method: 'POST', match: endpoint, respond: Response.json(body) });

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

describe('Behavior the location filters leave unchanged', () => {
  it.each(ANALYTICS)(
    '$name: a filters object without location keys sends neither upstream key',
    async ({ endpoint, row, run }: AnalyticsCase) => {
      answer(endpoint, row);
      const result = await run({ filters: { keywords: ['bridge'] } });

      expect(result.isError).toBeFalsy();
      const filters = await sentFilters();
      expect(filters).not.toHaveProperty('place_of_performance_locations');
      expect(filters).not.toHaveProperty('recipient_locations');
      expect(result.structuredContent).not.toHaveProperty('applied_location');
      expect(result.structuredContent).not.toHaveProperty('applied_recipient_location');
    },
  );
});

describe('Analytics tools send, echo, and name the location filters (#109)', () => {
  it.each(ANALYTICS)(
    '$name: sends each key normalized as a one-element upstream list, echoed on both surfaces',
    async ({ endpoint, row, run }: AnalyticsCase) => {
      answer(endpoint, row);
      const result = await run({
        filters: {
          award_type_codes: ['A', 'B', 'C', 'D'],
          place_of_performance_location: { county: '35049' },
          recipient_location: { country: 'PRI' },
        },
      });

      expect(result.isError).toBeFalsy();
      const filters = await sentFilters();
      expect(filters.place_of_performance_locations).toEqual([
        { country: 'USA', state: 'NM', county: '049' },
      ]);
      expect(filters.recipient_locations).toEqual([{ country: 'USA', state: 'PR' }]);
      expect(filters).not.toHaveProperty('place_of_performance_location');
      expect(filters).not.toHaveProperty('recipient_location');
      expect(result.structuredContent).toMatchObject({
        applied_location: 'country=USA, state=NM, county=049',
        applied_recipient_location: 'country=USA, state=PR',
      });
      const text = textOf(result);
      expect(text).toContain('country=USA, state=NM, county=049');
      expect(text).toContain('country=USA, state=PR');
    },
  );

  it.each(ANALYTICS)(
    '$name: the empty-result notice names both locations sent',
    async ({ endpoint, empty, run }: AnalyticsCase) => {
      answer(endpoint, empty);
      const result = await run({
        filters: {
          place_of_performance_location: { state: 'WA' },
          recipient_location: { state: 'NM', county: '049' },
        },
      });

      expect(result.isError).toBeFalsy();
      const notice = (result.structuredContent as { notice?: string }).notice;
      expect(notice).toContain('place_of_performance_location="country=USA, state=WA"');
      expect(notice).toContain('recipient_location="country=USA, state=NM, county=049"');
      expect(textOf(result)).toContain('recipient_location="country=USA, state=NM, county=049"');
    },
  );

  it.each(
    ANALYTICS.flatMap((tool) =>
      (['place_of_performance_location', 'recipient_location'] as const).map((key) => ({
        ...tool,
        key,
      })),
    ),
  )(
    '$name: a contradictory filters.$key fails as invalid_location before any request',
    async ({ run, key }) => {
      const result = await run({ filters: { [key]: { state: 'NM', county: '06037' } } });

      expect(result.isError).toBe(true);
      expect(http.calls).toHaveLength(0);
      const error = (
        result.structuredContent as {
          error: {
            code: number;
            message: string;
            data: { reason: string; recovery: { hint: string } };
          };
        }
      ).error;
      expect(error.code).toBe(-32007);
      expect(error.data.reason).toBe('invalid_location');
      expect(error.message).toContain(`filters.${key}.county "06037"`);
      expect(error.message).not.toContain('location_filter');
      expect(error.data.recovery.hint).not.toContain('location_filter');
      const text = textOf(result);
      expect(text).toContain(`filters.${key}.county "06037"`);
      expect(text).toContain('(reason invalid_location · not retryable)');
    },
  );
});

describe('usaspending_spending_by_geography: a location satisfies the non-empty filter rule', () => {
  it('sends a location-only filter set without the award type default', async () => {
    answer(`${BASE}search/spending_by_geography/`, ANALYTICS[1].row);
    const result = await ANALYTICS[1].run({
      filters: { place_of_performance_location: { state: 'WA' } },
    });

    expect(result.isError).toBeFalsy();
    expect(await sentFilters()).toEqual({
      place_of_performance_locations: [{ country: 'USA', state: 'WA' }],
    });
    expect(result.structuredContent).not.toHaveProperty('applied_award_type_default');
  });
});
