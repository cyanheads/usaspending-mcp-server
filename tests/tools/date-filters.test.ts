/**
 * @fileoverview Date-filter behavior shared by the four tools that take a time
 * window: `usaspending_search_awards` (its nested `filters.time_period_*`) and
 * the three `usaspending_spending_*` analytics tools. Each case runs through the
 * tool's public contract — argument validation, handler, output schema,
 * `format()`, and enrichment — with the service stubbed so the request body the
 * tool builds can be read back.
 * @module tests/tools/date-filters.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';
import { spendingByCategoryTool } from '@/mcp-server/tools/definitions/spending-by-category.tool.js';
import { spendingByGeographyTool } from '@/mcp-server/tools/definitions/spending-by-geography.tool.js';
import { spendingOverTimeTool } from '@/mcp-server/tools/definitions/spending-over-time.tool.js';

const svc = vi.hoisted(() => ({
  searchAwards: vi.fn(),
  spendingByCategory: vi.fn(),
  spendingByGeography: vi.fn(),
  spendingOverTime: vi.fn(),
}));

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => svc,
}));

/** One row per tool: how to call it, and where its request body carries `filters`. */
const TOOLS = [
  {
    name: 'usaspending_search_awards',
    // A short page (1 row at limit 5) keeps the truncation notice out of the way.
    run: (filters: Record<string, unknown>) =>
      runToolContract(searchAwardsTool, { filters, limit: 5 }),
    sent: () => svc.searchAwards.mock.calls.at(-1)?.[0].filters as Record<string, unknown>,
    mock: svc.searchAwards,
    errors: searchAwardsTool.errors,
  },
  {
    name: 'usaspending_spending_by_category',
    run: (filters: Record<string, unknown>) =>
      runToolContract(spendingByCategoryTool, { category: 'naics', filters }),
    sent: () => svc.spendingByCategory.mock.calls.at(-1)?.[1].filters as Record<string, unknown>,
    mock: svc.spendingByCategory,
    errors: spendingByCategoryTool.errors,
  },
  {
    name: 'usaspending_spending_by_geography',
    run: (filters: Record<string, unknown>) =>
      runToolContract(spendingByGeographyTool, {
        scope: 'place_of_performance',
        geo_layer: 'state',
        filters,
      }),
    sent: () => svc.spendingByGeography.mock.calls.at(-1)?.[0].filters as Record<string, unknown>,
    mock: svc.spendingByGeography,
    errors: spendingByGeographyTool.errors,
  },
  {
    name: 'usaspending_spending_over_time',
    run: (filters: Record<string, unknown>) =>
      runToolContract(spendingOverTimeTool, { group: 'fiscal_year', filters }),
    sent: () => svc.spendingOverTime.mock.calls.at(-1)?.[0].filters as Record<string, unknown>,
    mock: svc.spendingOverTime,
    errors: spendingOverTimeTool.errors,
  },
] as const;

type ToolCase = (typeof TOOLS)[number];

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  svc.searchAwards.mockResolvedValue({
    results: [{ 'Award ID': 'A1', generated_internal_id: 'CONT_AWD_A1' }],
    page_metadata: { hasNext: false, page: 1 },
  });
  svc.spendingByCategory.mockResolvedValue({
    results: [{ id: 1, code: '237310', name: 'Bridges', amount: 10 }],
    page_metadata: { hasNext: false, page: 1 },
  });
  svc.spendingByGeography.mockResolvedValue({
    results: [{ shape_code: 'WA', display_name: 'Washington', aggregated_amount: 10 }],
  });
  svc.spendingOverTime.mockResolvedValue({
    results: [{ time_period: { fiscal_year: '2024' }, aggregated_amount: 10 }],
  });
});

describe.each(TOOLS)('$name — unchanged date behavior', (tool: ToolCase) => {
  it('sends both supplied ends and echoes them on both surfaces', async () => {
    const result = await tool.run({
      time_period_start: '2023-10-01',
      time_period_end: '2024-09-30',
    });

    expect(result.isError).toBeFalsy();
    expect(tool.sent().time_period).toEqual([{ start_date: '2023-10-01', end_date: '2024-09-30' }]);
    expect(result.structuredContent).toMatchObject({
      applied_time_period_start: '2023-10-01',
      applied_time_period_end: '2024-09-30',
    });
    const text = textOf(result);
    expect(text).toContain('2023-10-01');
    expect(text).toContain('2024-09-30');
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('sends no time_period and echoes none when neither end is supplied', async () => {
    const result = await tool.run({ keywords: ['bridge'] });

    expect(result.isError).toBeFalsy();
    expect(tool.sent()).not.toHaveProperty('time_period');
    expect(result.structuredContent).not.toHaveProperty('applied_time_period_start');
    expect(result.structuredContent).not.toHaveProperty('applied_time_period_end');
  });

  it('treats blank date strings from form clients as no date filter', async () => {
    const result = await tool.run({
      keywords: ['bridge'],
      time_period_start: '',
      time_period_end: '',
    });

    expect(result.isError).toBeFalsy();
    expect(tool.sent()).not.toHaveProperty('time_period');
    expect(result.structuredContent).not.toHaveProperty('applied_time_period_start');
  });

  it('treats a whitespace-only date as blank, not as a malformed date', async () => {
    const result = await tool.run({ keywords: ['bridge'], time_period_start: '  ' });

    expect(result.isError).toBeFalsy();
    expect(tool.sent()).not.toHaveProperty('time_period');
    expect(result.structuredContent).not.toHaveProperty('applied_time_period_start');
  });
});

/**
 * "Today" is taken in UTC. The clock below sits at 02:00 UTC on 2026-09-25 —
 * still 2026-09-24 anywhere in the US — so a filled end of 2026-09-25 shows the
 * UTC reading, and the upstream accepts a date that is ahead of US time.
 */
const NOW_UTC = new Date('2026-09-25T02:00:00Z');
const TODAY_UTC = '2026-09-25';

describe.each(TOOLS)('$name — date inputs (#58, #62)', (tool: ToolCase) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_UTC);
    return () => vi.useRealTimers();
  });

  it.each(['2024/01/01', '01/15/2024', '2024-01-01T00:00:00', 'yesterday'])(
    'rejects %s at argument validation, naming the field, with no upstream call',
    async (bad) => {
      const result = await tool.run({ time_period_start: bad, time_period_end: '2024-12-31' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
      expect(textOf(result)).toContain('time_period_start');
      expect(tool.mock).not.toHaveBeenCalled();
    },
  );

  it('zero-pads an unpadded month and day before sending and echoing', async () => {
    const result = await tool.run({ time_period_start: '2024-1-1', time_period_end: '2024-12-3' });

    expect(result.isError).toBeFalsy();
    expect(tool.sent().time_period).toEqual([{ start_date: '2024-01-01', end_date: '2024-12-03' }]);
    expect(result.structuredContent).toMatchObject({
      applied_time_period_start: '2024-01-01',
      applied_time_period_end: '2024-12-03',
    });
  });

  it('passes a well-shaped but impossible date through to upstream', async () => {
    await tool.run({ time_period_start: '2024-02-30', time_period_end: '2024-12-31' });
    expect(tool.sent().time_period).toEqual([{ start_date: '2024-02-30', end_date: '2024-12-31' }]);
  });

  it('closes a lone start at today (UTC), echoes it, and names the filled end', async () => {
    const result = await tool.run({ time_period_start: '2020-01-01' });

    expect(result.isError).toBeFalsy();
    expect(tool.sent().time_period).toEqual([{ start_date: '2020-01-01', end_date: TODAY_UTC }]);
    expect(result.structuredContent).toMatchObject({
      applied_time_period_start: '2020-01-01',
      applied_time_period_end: TODAY_UTC,
    });
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('filters.time_period_end');
    expect(notice).toContain(TODAY_UTC);
    expect(notice).toContain('UTC');
    expect(textOf(result)).toContain(notice);
  });

  it('opens a lone end at the 2007-10-01 floor, echoes it, and names the filled start', async () => {
    const result = await tool.run({ time_period_end: '2012-6-30' });

    expect(result.isError).toBeFalsy();
    expect(tool.sent().time_period).toEqual([{ start_date: '2007-10-01', end_date: '2012-06-30' }]);
    expect(result.structuredContent).toMatchObject({
      applied_time_period_start: '2007-10-01',
      applied_time_period_end: '2012-06-30',
    });
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('filters.time_period_start');
    expect(notice).toContain('2007-10-01');
    expect(textOf(result)).toContain(notice);
  });

  it('never inverts the range: a lone start after today closes on itself', async () => {
    const result = await tool.run({ time_period_start: '2027-03-01' });

    expect(result.isError).toBeFalsy();
    expect(tool.sent().time_period).toEqual([{ start_date: '2027-03-01', end_date: '2027-03-01' }]);
  });
});

describe('usaspending_spending_by_geography — half range and defaults (#62)', () => {
  it('does not report the no-filter award-type default for a lone date', async () => {
    const result = await runToolContract(spendingByGeographyTool, {
      scope: 'place_of_performance',
      geo_layer: 'state',
      filters: { time_period_start: '2024-01-01' },
    });

    expect(result.structuredContent).not.toHaveProperty('applied_award_type_default');
    const sent = svc.spendingByGeography.mock.calls.at(-1)?.[0].filters as Record<string, unknown>;
    expect(sent).not.toHaveProperty('award_type_codes');
  });

  it('keeps the truncation guidance alongside the filled-bound notice', async () => {
    svc.spendingByGeography.mockResolvedValueOnce({
      results: [
        { shape_code: 'WA', display_name: 'Washington', aggregated_amount: 30 },
        { shape_code: 'OR', display_name: 'Oregon', aggregated_amount: 20 },
      ],
    });
    const result = await runToolContract(spendingByGeographyTool, {
      scope: 'place_of_performance',
      geo_layer: 'state',
      filters: { time_period_end: '2020-12-31' },
      limit: 1,
    });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('highest-obligation areas');
    expect(notice).toContain('filters.time_period_start');
  });
});

describe('usaspending_search_awards — date specifics (#58, #62)', () => {
  it('rejects a malformed flat time_period date at argument validation', async () => {
    const result = await runToolContract(searchAwardsTool, {
      keyword: 'bridge',
      time_period: { start_date: '2024/01/01', end_date: '2024-12-31' },
    });

    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(textOf(result)).toContain('start_date');
    expect(svc.searchAwards).not.toHaveBeenCalled();
  });

  it('no longer reads a US-style date as preceding the floor', async () => {
    const result = await runToolContract(searchAwardsTool, {
      time_period: { start_date: '01/15/2024', end_date: '12/31/2024' },
    });

    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(JSON.stringify(result.structuredContent)).not.toContain('date_before_earliest');
  });

  it('reads a blank flat time_period pair from a form client as no date filter', async () => {
    const result = await runToolContract(searchAwardsTool, {
      limit: 5,
      time_period: { start_date: '', end_date: '' },
    });

    expect(result.isError).toBeFalsy();
    expect(svc.searchAwards.mock.calls.at(-1)?.[0].filters).not.toHaveProperty('time_period');
    expect(result.structuredContent).not.toHaveProperty('applied_time_period_start');
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('fills a half-blank flat pair as a lone end, naming time_period.start_date', async () => {
    const result = await runToolContract(searchAwardsTool, {
      limit: 5,
      time_period: { start_date: '', end_date: '2012-6-30' },
    });

    expect(result.isError).toBeFalsy();
    expect(svc.searchAwards.mock.calls.at(-1)?.[0].filters.time_period).toEqual([
      { start_date: '2007-10-01', end_date: '2012-06-30' },
    ]);
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('time_period.start_date was not supplied');
    expect(notice).not.toContain('filters.time_period_start');
    expect(textOf(result)).toContain(notice);
  });

  it('fills a half-blank flat pair as a lone start, naming time_period.end_date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_UTC);
    try {
      const result = await runToolContract(searchAwardsTool, {
        limit: 5,
        time_period: { start_date: '2020-01-01', end_date: '' },
      });

      expect(svc.searchAwards.mock.calls.at(-1)?.[0].filters.time_period).toEqual([
        { start_date: '2020-01-01', end_date: TODAY_UTC },
      ]);
      const notice = (result.structuredContent as { notice?: string }).notice;
      expect(notice).toContain('time_period.end_date was not supplied');
      expect(notice).not.toContain('filters.time_period_end');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still rejects a malformed non-blank flat date at argument validation', async () => {
    const result = await runToolContract(searchAwardsTool, {
      time_period: { start_date: ' 2024-01-01', end_date: '2024-12-31' },
    });

    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(svc.searchAwards).not.toHaveBeenCalled();
  });

  it('pads the flat time_period and compares the padded start against the floor', async () => {
    const ok = await runToolContract(searchAwardsTool, {
      time_period: { start_date: '2007-10-1', end_date: '2008-1-5' },
      limit: 5,
    });
    expect(ok.isError).toBeFalsy();
    expect(svc.searchAwards.mock.calls.at(-1)?.[0].filters.time_period).toEqual([
      { start_date: '2007-10-01', end_date: '2008-01-05' },
    ]);

    // Unpadded, '2007-9-30' sorts after '2007-10-01' as a string and slipped past the floor.
    const early = await runToolContract(searchAwardsTool, {
      time_period: { start_date: '2007-9-30', end_date: '2008-01-05' },
    });
    expect(early.structuredContent).toMatchObject({
      error: { data: { reason: 'date_before_earliest' } },
    });
  });

  it('rejects a lone end before the floor as date_before_earliest, naming the end date', async () => {
    const result = await runToolContract(searchAwardsTool, {
      filters: { time_period_end: '2005-06-30' },
    });

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'date_before_earliest' } },
    });
    expect(textOf(result)).toContain('End date 2005-06-30');
    expect(svc.searchAwards).not.toHaveBeenCalled();
  });

  it('keeps the empty-result notice alongside the filled-bound notice', async () => {
    svc.searchAwards.mockResolvedValueOnce({ results: [], page_metadata: { hasNext: false } });
    const result = await runToolContract(searchAwardsTool, {
      keyword: 'nothing-matches-this',
      filters: { time_period_start: '2024-01-01' },
    });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('No awards matched');
    expect(notice).toContain('filters.time_period_end');
  });
});

describe.each(TOOLS)('$name — range order (#64)', (tool: ToolCase) => {
  const recovery = tool.errors?.find((e) => e.reason === 'date_range_inverted')?.recovery;

  it('rejects a start after the end before any request, naming both fields', async () => {
    const result = await tool.run({
      time_period_start: '2024-12-31',
      time_period_end: '2024-01-01',
    });

    expect(result.isError).toBe(true);
    expect(tool.mock).not.toHaveBeenCalled();
    expect(recovery).toBeDefined();
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: { reason: 'date_range_inverted', recovery: { hint: recovery } },
      },
    });
    const text = textOf(result);
    expect(text).toContain('filters.time_period_start (2024-12-31)');
    expect(text).toContain('filters.time_period_end (2024-01-01)');
    expect(text).toContain('Swap');
    expect(text).toContain('(reason date_range_inverted · not retryable)');
  });

  it('compares after padding: 2024-10-1 → 2024-9-30 is inverted', async () => {
    const result = await tool.run({ time_period_start: '2024-10-1', time_period_end: '2024-9-30' });

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'date_range_inverted' } },
    });
    expect(textOf(result)).toContain('(2024-10-01)');
    expect(tool.mock).not.toHaveBeenCalled();
  });

  it('compares after padding: 2024-9-1 → 2024-10-1 is ordered and sent', async () => {
    const result = await tool.run({ time_period_start: '2024-9-1', time_period_end: '2024-10-1' });

    expect(result.isError).toBeFalsy();
    expect(tool.sent().time_period).toEqual([{ start_date: '2024-09-01', end_date: '2024-10-01' }]);
  });

  it('accepts a range whose start and end are the same day', async () => {
    const result = await tool.run({
      time_period_start: '2024-06-15',
      time_period_end: '2024-06-15',
    });

    expect(result.isError).toBeFalsy();
    expect(tool.sent().time_period).toEqual([{ start_date: '2024-06-15', end_date: '2024-06-15' }]);
  });
});

describe('usaspending_search_awards — range order on the flat time_period (#64)', () => {
  it('names the flat fields when the flat range is inverted', async () => {
    const result = await runToolContract(searchAwardsTool, {
      limit: 1,
      time_period: { start_date: '2024-12-31', end_date: '2024-01-01' },
    });

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'date_range_inverted' } },
    });
    const text = textOf(result);
    expect(text).toContain('time_period.start_date (2024-12-31)');
    expect(text).toContain('time_period.end_date (2024-01-01)');
    expect(svc.searchAwards).not.toHaveBeenCalled();
  });

  it('names each field by the path that supplied it when the paths mix', async () => {
    const result = await runToolContract(searchAwardsTool, {
      time_period: { start_date: '2023-01-01', end_date: '2023-06-30' },
      filters: { time_period_start: '2023-12-01' },
    });

    const text = textOf(result);
    expect(text).toContain('filters.time_period_start (2023-12-01)');
    expect(text).toContain('time_period.end_date (2023-06-30)');
    expect(svc.searchAwards).not.toHaveBeenCalled();
  });

  it('reports an inverted range before a start that precedes the floor', async () => {
    const result = await runToolContract(searchAwardsTool, {
      time_period: { start_date: '2006-12-31', end_date: '2006-01-01' },
    });

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'date_range_inverted' } },
    });
  });
});

describe.each(TOOLS)('$name — searchable floor (#62)', (tool: ToolCase) => {
  const recovery = tool.errors?.find((e) => e.reason === 'date_before_earliest')?.recovery;

  it('rejects a lone start before 2007-10-01 before any request', async () => {
    const result = await tool.run({ time_period_start: '2005-01-01' });

    expect(result.isError).toBe(true);
    expect(tool.mock).not.toHaveBeenCalled();
    expect(recovery).toBeDefined();
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: { reason: 'date_before_earliest', recovery: { hint: recovery } },
      },
    });
    expect(textOf(result)).toContain('Start date 2005-01-01 precedes 2007-10-01');
  });

  it('rejects a lone end before 2007-10-01, naming it as the end date', async () => {
    const result = await tool.run({ time_period_end: '2005-6-30' });

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'date_before_earliest' } },
    });
    expect(textOf(result)).toContain('End date 2005-06-30 precedes 2007-10-01');
    expect(tool.mock).not.toHaveBeenCalled();
  });

  it('accepts a start exactly on the floor', async () => {
    const result = await tool.run({
      time_period_start: '2007-10-01',
      time_period_end: '2008-09-30',
    });

    expect(result.isError).toBeFalsy();
    expect(tool.sent().time_period).toEqual([{ start_date: '2007-10-01', end_date: '2008-09-30' }]);
  });
});
