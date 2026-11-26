/**
 * @fileoverview `usaspending_search_awards` behavior keyed to the award-type
 * group: sort resolution and validation, the loan fields, the
 * `assistance_listings` filter, and the two count requests: the total (one
 * bucket) and the matches per award-type group.
 * Runs through the tool's public contract on a real `USASpendingService`
 * beneath a strict fetch fake, so every assertion reads the request body that
 * actually left the process — and a pre-request rejection is proven by an empty
 * call log.
 * @module tests/tools/search-awards-award-types.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';
import { initUSASpendingService } from '@/services/usaspending/usaspending-service.js';

const BASE = 'https://api.usaspending.gov/api/v2/';
const ENDPOINT = `${BASE}search/spending_by_award/`;
const COUNT_ENDPOINT = `${BASE}search/spending_by_award_count/`;

/** Unrouted requests reject, so nothing in this file can reach the live API. */
const http = createFetchMock();

const contractRow = {
  'Award ID': 'W91-CONTRACT',
  generated_internal_id: 'CONT_AWD_W91',
  'Recipient Name': 'Acme Corp',
  'Award Amount': 1_000_000,
};

/** Count buckets with no matches in any award-type group. */
const NO_MATCHES = { contracts: 0, idvs: 0, grants: 0, direct_payments: 0, loans: 0, other: 0 };

/** Routes the count endpoint's answer carrying `buckets`. */
const answerCount = (buckets: Record<string, number>) =>
  http.route({
    method: 'POST',
    match: COUNT_ENDPOINT,
    respond: Response.json({ results: buckets, spending_level: 'awards', messages: [] }),
  });

/** Routes one spending_by_award answer carrying `rows`, and a count matching them. */
const answer = (rows: Record<string, unknown>[] = [contractRow]) => {
  answerCount(Object.fromEntries(Object.keys(NO_MATCHES).map((key) => [key, rows.length])));
  return http.route({
    method: 'POST',
    match: ENDPOINT,
    respond: Response.json({
      results: rows,
      page_metadata: { page: 1, hasNext: false },
      messages: [],
    }),
  });
};

/** The calls sent to one endpoint, in order. */
const callsTo = (url: string) => http.calls.filter((call) => call.request.url === url);

/** The JSON body of the `n`th search request sent upstream. */
const sentBody = async (n = 0) =>
  JSON.parse(await callsTo(ENDPOINT)[n]!.request.text()) as {
    sort: string;
    fields: string[];
    filters: Record<string, unknown>;
  };

const run = (input: Record<string, unknown>) =>
  runToolContract(searchAwardsTool, { limit: 5, ...input } as never);

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

const CONTRACT_SORTS = [
  'Award Amount',
  'Total Outlays',
  'Start Date',
  'End Date',
  'Recipient Name',
  'Awarding Agency',
] as const;

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

describe('usaspending_search_awards — current sort shape', () => {
  it('sends contracts sorted by Award Amount when both sort and award types are omitted', async () => {
    answer();
    const result = await run({ keyword: 'bridge' });

    expect(result.isError).toBeFalsy();
    const body = await sentBody();
    expect(body.sort).toBe('Award Amount');
    expect(body.filters.award_type_codes).toEqual(['A', 'B', 'C', 'D']);
    expect(body.fields).not.toContain('Loan Value');
  });

  it.each(CONTRACT_SORTS)('sends contract sort %s unchanged', async (sort) => {
    answer();
    const result = await run({ sort });

    expect(result.isError).toBeFalsy();
    expect((await sentBody()).sort).toBe(sort);
  });
});

const LOAN_SORTS = [
  'Loan Value',
  'Subsidy Cost',
  'Issued Date',
  'Recipient Name',
  'Awarding Agency',
] as const;
const ALL_SORTS = [...new Set([...CONTRACT_SORTS, ...LOAN_SORTS])];

/**
 * The #60 sort table: one row per award-type group, with upstream's full
 * partition as its mixed-group 422 lists it (F-codes and -1 included).
 */
const GROUPS = [
  { label: 'contracts', codes: ['A', 'B', 'C', 'D'], sorts: CONTRACT_SORTS },
  {
    label: 'IDVs',
    codes: ['IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E'],
    sorts: CONTRACT_SORTS.filter((s) => s !== 'End Date'),
  },
  { label: 'grants', codes: ['02', '03', '04', '05', 'F001', 'F002'], sorts: CONTRACT_SORTS },
  { label: 'direct payments', codes: ['06', '10', 'F006', 'F007'], sorts: CONTRACT_SORTS },
  { label: 'loans', codes: ['07', '08', 'F003', 'F004'], sorts: LOAN_SORTS },
  {
    label: 'other',
    codes: ['09', '11', '-1', 'F005', 'F008', 'F009', 'F010'],
    sorts: CONTRACT_SORTS,
  },
] as const;

const allowedCases = GROUPS.flatMap((g) =>
  g.sorts.map((sort) => [g.label, sort, g.codes] as const),
);
const rejectedCases = GROUPS.flatMap((g) =>
  ALL_SORTS.filter((sort) => !(g.sorts as readonly string[]).includes(sort)).map(
    (sort) => [g.label, sort, g.codes, g.sorts] as const,
  ),
);

const recoveryOf = (reason: string) =>
  searchAwardsTool.errors?.find((e) => e.reason === reason)?.recovery;

describe('usaspending_search_awards — award-type-aware sort (#60)', () => {
  it('defaults a loan search to Loan Value and requests the loan fields', async () => {
    answer([
      {
        'Award ID': 'P268K155150',
        generated_internal_id: 'ASST_NON_P268K155150_091',
        'Recipient Name': 'PURDUE UNIVERSITY GLOBAL, INC.',
        'Award Amount': null,
        'Loan Value': 46_402_867_113,
        'Subsidy Cost': 0,
        'Issued Date': '2025-09-19',
      },
    ]);
    const result = await run({
      award_type_codes: ['07', '08'],
      time_period: { start_date: '2024-01-01', end_date: '2024-12-31' },
    });

    expect(result.isError).toBeFalsy();
    const body = await sentBody();
    expect(body.sort).toBe('Loan Value');
    expect(body.fields).toEqual(
      expect.arrayContaining(['Loan Value', 'Subsidy Cost', 'Issued Date']),
    );

    // A real zero subsidy is a value, not an absence.
    expect(result.structuredContent).toMatchObject({
      results: [{ loan_value: 46_402_867_113, subsidy_cost: 0, issued_date: '2025-09-19' }],
    });
    expect(
      (result.structuredContent as { results: Record<string, unknown>[] }).results[0],
    ).not.toHaveProperty('award_amount');
    const text = textOf(result);
    expect(text).toContain('**Loan Value:** $46,402,867,113');
    expect(text).toContain('**Subsidy Cost:** $0');
    expect(text).toContain('**Issued:** 2025-09-19');
  });

  it('reads the group from nested filters.award_type_codes over the flat field', async () => {
    answer();
    await run({ award_type_codes: ['A', 'B'], filters: { award_type_codes: ['07'] } });

    const body = await sentBody();
    expect(body.filters.award_type_codes).toEqual(['07']);
    expect(body.sort).toBe('Loan Value');
  });

  it.each(GROUPS.filter((g) => g.label !== 'loans'))(
    'defaults $label to Award Amount without the loan fields',
    async ({ codes }) => {
      answer();
      await run({ award_type_codes: [...codes] });

      const body = await sentBody();
      expect(body.sort).toBe('Award Amount');
      expect(body.fields).not.toContain('Loan Value');
      expect(body.fields).not.toContain('Subsidy Cost');
      expect(body.fields).not.toContain('Issued Date');
    },
  );

  it.each(allowedCases)('sends %s sort %s unchanged', async (_label, sort, codes) => {
    answer();
    const result = await run({ award_type_codes: [...codes], sort });

    expect(result.isError).toBeFalsy();
    expect((await sentBody()).sort).toBe(sort);
  });

  it.each(rejectedCases)(
    'rejects %s sort %s before any request, listing the supported sorts',
    async (label, sort, codes, supported) => {
      const result = await run({ award_type_codes: [...codes], sort });

      expect(result.isError).toBe(true);
      expect(http.calls).toHaveLength(0);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: -32007,
          data: { reason: 'unsupported_sort', recovery: { hint: recoveryOf('unsupported_sort') } },
        },
      });
      const text = textOf(result);
      expect(text).toContain(`"${sort}"`);
      expect(text).toContain(label);
      expect(text).toContain(supported.join(', '));
      expect(text).toContain('(reason unsupported_sort · not retryable)');
    },
  );

  it('rejects a disallowed sort chosen through the nested codes, too', async () => {
    const result = await run({ filters: { award_type_codes: ['IDV_A'] }, sort: 'End Date' });

    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'unsupported_sort' } },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('skips the check for codes spanning groups and lets the upstream 422 stand', async () => {
    // The live body for a mixed-group request.
    http.route({
      method: 'POST',
      match: ENDPOINT,
      respond: Response.json(
        {
          message: "'award_type_codes' must only contain types from one group.",
          award_type_groups: { contracts: { A: 'BPA Call' }, loans: { '07': 'Direct Loan' } },
        },
        { status: 422 },
      ),
    });
    const result = await run({ award_type_codes: ['A', '07'], sort: 'Loan Value' });

    expect(http.calls).toHaveLength(1);
    expect((await sentBody()).sort).toBe('Loan Value');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32007, data: { status: 422 } },
    });
    expect(textOf(result)).toContain(
      "USAspending rejected POST search/spending_by_award/ (HTTP 422): 'award_type_codes' must only contain types from one group.",
    );
    expect(JSON.stringify(result.structuredContent)).not.toContain('unsupported_sort');
  });

  it('defaults an F003-only loan search to Loan Value with the loan fields', async () => {
    answer();
    const result = await run({ award_type_codes: ['F003'] });

    expect(result.isError).toBeFalsy();
    const body = await sentBody();
    expect(body.sort).toBe('Loan Value');
    expect(body.fields).toEqual(
      expect.arrayContaining(['Loan Value', 'Subsidy Cost', 'Issued Date']),
    );
  });

  it('rejects Award Amount on an F-code loan search before any request', async () => {
    const result = await run({ award_type_codes: ['F004'], sort: 'Award Amount' });

    expect(http.calls).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'unsupported_sort' } },
    });
    expect(textOf(result)).toContain('Supported sorts for loans: Loan Value');
  });

  it('rejects Loan Value on -1 as the other group before any request', async () => {
    const result = await run({ award_type_codes: ['-1'], sort: 'Loan Value' });

    expect(http.calls).toHaveLength(0);
    expect(textOf(result)).toContain('is not available for other');
  });

  it('defaults codes spanning groups to Award Amount', async () => {
    answer();
    await run({ award_type_codes: ['02', '06'] });
    expect((await sentBody()).sort).toBe('Award Amount');
  });

  it('rejects an empty flat award_type_codes at argument validation', async () => {
    const result = await run({ award_type_codes: [] });

    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(textOf(result)).toContain('award_type_codes');
    expect(http.calls).toHaveLength(0);
  });

  it('treats an empty nested award_type_codes as unset, falling back to the flat codes', async () => {
    answer();
    await run({ award_type_codes: ['07', '08'], filters: { award_type_codes: [] } });

    const body = await sentBody();
    expect(body.filters.award_type_codes).toEqual(['07', '08']);
    expect(body.sort).toBe('Loan Value');
  });

  it('treats an empty nested award_type_codes as unset under the contract default', async () => {
    answer();
    await run({ filters: { award_type_codes: [] } });

    expect((await sentBody()).filters.award_type_codes).toEqual(['A', 'B', 'C', 'D']);
  });

  it('discloses a capped loan page and keeps the loan fields on every row', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      generated_internal_id: `ASST_NON_LOAN_${i}`,
      'Loan Value': 1_000 * (5 - i),
      'Subsidy Cost': 10,
      'Issued Date': '2024-06-01',
    }));
    // Capped means rows are known past the page (#76); a full page alone is not enough.
    answerCount({ ...NO_MATCHES, loans: 12 });
    http.route({
      method: 'POST',
      match: ENDPOINT,
      respond: Response.json({ results: rows, page_metadata: { page: 1, hasNext: true } }),
    });
    const result = await run({ award_type_codes: ['07'] });

    const sc = result.structuredContent as {
      results: Record<string, unknown>[];
      truncated?: boolean;
    };
    expect(sc.truncated).toBe(true);
    expect(sc.results).toHaveLength(5);
    for (const row of sc.results) expect(row).toHaveProperty('loan_value');
  });

  it('reports the end of a loan search on an empty page past the last result', async () => {
    answer([]);
    const result = await run({ award_type_codes: ['07', '08'], page: 40 });

    const sc = result.structuredContent as {
      results: unknown[];
      has_next: boolean;
      notice?: string;
    };
    expect(sc.results).toEqual([]);
    expect(sc.has_next).toBe(false);
    expect(sc.notice).toContain('types=07,08');
    expect((await sentBody()).sort).toBe('Loan Value');
  });
});

describe('usaspending_search_awards — assistance_listings filter (#61)', () => {
  it('sends the listing as program_numbers and echoes it on both surfaces', async () => {
    answer();
    const result = await run({
      assistance_listings: ['93.866'],
      award_type_codes: ['02', '03', '04', '05'],
    });

    expect(result.isError).toBeFalsy();
    expect((await sentBody()).filters.program_numbers).toEqual(['93.866']);
    expect(result.structuredContent).toMatchObject({ applied_assistance_listings: '93.866' });
    expect(textOf(result)).toContain('93.866');
  });

  it('sends several listings together and comma-joins the echo', async () => {
    answer();
    const result = await run({
      assistance_listings: ['93.866', '93.778'],
      award_type_codes: ['02'],
    });

    expect((await sentBody()).filters.program_numbers).toEqual(['93.866', '93.778']);
    expect(result.structuredContent).toMatchObject({
      applied_assistance_listings: '93.866, 93.778',
    });
  });

  it.each([['11.67A'], ['93.LM2']])('accepts the non-numeric listing %s', async (listing) => {
    answer();
    const result = await run({ assistance_listings: [listing], award_type_codes: ['02'] });

    expect(result.isError).toBeFalsy();
    expect((await sentBody()).filters.program_numbers).toEqual([listing]);
  });

  it.each([['93.86'], ['93.8660'], ['93.*'], ['93.lm2'], ['9.866']])(
    'rejects the malformed listing %s at argument validation',
    async (listing) => {
      const result = await run({ assistance_listings: [listing], award_type_codes: ['02'] });

      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
      const text = textOf(result);
      expect(text).toContain('assistance_listings');
      expect(text).toContain('Expected an Assistance Listing number as NN.NNN');
      expect(http.calls).toHaveLength(0);
    },
  );

  it('sends no program_numbers and no echo without the filter', async () => {
    answer();
    const result = await run({ award_type_codes: ['02'] });

    expect((await sentBody()).filters).not.toHaveProperty('program_numbers');
    expect(result.structuredContent).not.toHaveProperty('applied_assistance_listings');
  });

  it('treats an empty list as no filter, even with the default contract codes', async () => {
    answer();
    const result = await run({ assistance_listings: [] });

    expect(result.isError).toBeFalsy();
    expect((await sentBody()).filters).not.toHaveProperty('program_numbers');
    expect(result.structuredContent).not.toHaveProperty('applied_assistance_listings');
  });

  it('allows an F-code assistance group and rejects it mixed with an IDV code', async () => {
    answer();
    const ok = await run({ assistance_listings: ['93.866'], award_type_codes: ['F001', 'F002'] });
    expect(ok.isError).toBeFalsy();
    const body = await sentBody();
    expect(body.filters.program_numbers).toEqual(['93.866']);
    expect(body.sort).toBe('Award Amount');

    const mixed = await run({
      assistance_listings: ['93.866'],
      award_type_codes: ['F001', 'IDV_A'],
    });
    expect(mixed.structuredContent).toMatchObject({
      error: { data: { reason: 'assistance_listings_type_mismatch' } },
    });
    // Only the first call reached upstream: its search, total count, and group count (#125).
    expect(callsTo(ENDPOINT)).toHaveLength(1);
    expect(callsTo(COUNT_ENDPOINT)).toHaveLength(2);
  });

  it('allows loans, which carry listings, and keeps the loan sort', async () => {
    answer();
    const result = await run({ assistance_listings: ['10.410'], award_type_codes: ['07', '08'] });

    expect(result.isError).toBeFalsy();
    const body = await sentBody();
    expect(body.filters.program_numbers).toEqual(['10.410']);
    expect(body.sort).toBe('Loan Value');
  });

  it.each([
    ['omitted codes (defaults to contracts)', {}],
    ['contract codes', { award_type_codes: ['A', 'B'] }],
    ['IDV codes', { award_type_codes: ['IDV_A'] }],
    ['codes mixing a contract code in', { award_type_codes: ['02', 'A'] }],
    [
      'nested contract codes over flat grants',
      {
        award_type_codes: ['02'],
        filters: { award_type_codes: ['C'] },
      },
    ],
  ])('rejects the filter with %s before any request', async (_label, codes) => {
    const result = await run({ assistance_listings: ['93.866'], ...codes });

    expect(result.isError).toBe(true);
    expect(http.calls).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        data: {
          reason: 'assistance_listings_type_mismatch',
          recovery: { hint: recoveryOf('assistance_listings_type_mismatch') },
        },
      },
    });
    const text = textOf(result);
    expect(text).toContain('assistance_listings');
    expect(text).toContain('(reason assistance_listings_type_mismatch · not retryable)');
  });

  it('names the listings in the empty-result notice', async () => {
    answer([]);
    const result = await run({ assistance_listings: ['99.999'], award_type_codes: ['02'] });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('No awards match');
    expect(notice).toContain('assistance_listings=99.999');
  });
});

describe('usaspending_search_awards — contract filters by award-type group (#119)', () => {
  const CONTRACT_FILTERS = {
    extent_competed_type_codes: ['f'],
    set_aside_type_codes: ['sba'],
    contract_pricing_type_codes: ['j'],
  };
  const SENT = {
    extent_competed_type_codes: ['F'],
    set_aside_type_codes: ['SBA'],
    contract_pricing_type_codes: ['J'],
  };
  /** The total count's body: the count request carrying the award type codes the search sent. */
  const totalCountFilters = async () => {
    const bodies = await Promise.all(
      callsTo(COUNT_ENDPOINT).map(
        async (call) =>
          JSON.parse(await call.request.clone().text()) as { filters: Record<string, unknown> },
      ),
    );
    return bodies.find((body) => 'award_type_codes' in body.filters)?.filters;
  };
  const isProcurement = (g: (typeof GROUPS)[number]) =>
    g.label === 'contracts' || g.label === 'IDVs';
  const PROCUREMENT = GROUPS.filter(isProcurement);
  const ASSISTANCE = GROUPS.filter((g) => !isProcurement(g));

  it.each(PROCUREMENT)(
    'sends the codes uppercased with $label to the search and the total count',
    async ({ codes }) => {
      answer();
      const result = await run({ award_type_codes: [...codes], ...CONTRACT_FILTERS });

      expect(result.isError).toBeFalsy();
      const { filters } = await sentBody();
      expect(filters).toMatchObject({ award_type_codes: [...codes], ...SENT });
      expect(await totalCountFilters()).toEqual(filters);
    },
  );

  it.each(ASSISTANCE)('rejects any of them with $label before any request', async ({ codes }) => {
    const result = await run({ award_type_codes: [...codes], set_aside_type_codes: ['SBA'] });

    expect(result.isError).toBe(true);
    expect(http.calls).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32007,
        message: `set_aside_type_codes match only contracts and IDVs, but award_type_codes [${codes.join(', ')}] include assistance codes, which carry no competition, set-aside, or pricing codes.`,
        data: {
          reason: 'contract_filters_type_mismatch',
          recovery: { hint: recoveryOf('contract_filters_type_mismatch') },
        },
      },
    });
    expect(textOf(result)).toContain('(reason contract_filters_type_mismatch · not retryable)');
  });

  it('names every contract filter given, flat or nested, under nested assistance codes', async () => {
    const result = await run({
      extent_competed_type_codes: ['C'],
      filters: {
        award_type_codes: ['02', 'A'],
        set_aside_type_codes: [],
        contract_pricing_type_codes: ['Y'],
      },
    });

    expect(http.calls).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      error: {
        message:
          'extent_competed_type_codes, contract_pricing_type_codes match only contracts and IDVs, but award_type_codes [02, A] include assistance codes, which carry no competition, set-aside, or pricing codes.',
        data: { reason: 'contract_filters_type_mismatch' },
      },
    });
  });

  it('keeps psc_codes_type_mismatch, unchanged, when psc_codes rides along', async () => {
    const result = await run({
      award_type_codes: ['02'],
      psc_codes: ['Y1NE'],
      ...CONTRACT_FILTERS,
    });

    expect(http.calls).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      error: {
        message:
          'psc_codes match only contracts and IDVs, but award_type_codes [02] include assistance codes, which carry no PSC.',
        data: {
          reason: 'psc_codes_type_mismatch',
          recovery: { hint: recoveryOf('psc_codes_type_mismatch') },
        },
      },
    });
  });

  it('leaves an assistance group without the contract filters to run as before', async () => {
    answer();
    const result = await run({
      award_type_codes: ['02'],
      ...Object.fromEntries(Object.keys(CONTRACT_FILTERS).map((key) => [key, []])),
    });

    expect(result.isError).toBeFalsy();
    expect((await sentBody()).filters).toEqual({ award_type_codes: ['02'] });
  });
});

/** The count bucket each group's award type codes select. */
const BUCKETS = { contracts: 11, idvs: 22, grants: 33, direct_payments: 44, loans: 55, other: 66 };

type CountKind = 'total' | 'group';

/** Which count a request is: the total count carries award_type_codes, the group count (#125) does not. */
const countKind = async (request: Request): Promise<CountKind> => {
  const { filters } = (await request.clone().json()) as { filters: Record<string, unknown> };
  return 'award_type_codes' in filters ? 'total' : 'group';
};

/** Routes the count endpoint, answering each count by its kind. */
const routeCounts = (
  respond: (kind: CountKind, request: Request) => Response | Promise<Response>,
) =>
  http.route({
    method: 'POST',
    match: COUNT_ENDPOINT,
    respond: async (request) => respond(await countKind(request), request),
  });

/** The count requests sent, by kind, in order. */
const countCalls = async () => {
  const calls = callsTo(COUNT_ENDPOINT);
  const kinds = await Promise.all(calls.map((call) => countKind(call.request)));
  return {
    total: calls.filter((_, i) => kinds[i] === 'total'),
    group: calls.filter((_, i) => kinds[i] === 'group'),
  };
};

/** A count answer carrying {@link BUCKETS}. */
const bucketsResponse = () =>
  Response.json({ results: BUCKETS, spending_level: 'awards', messages: [] });

describe('usaspending_search_awards — the total and group counts (#114, #125)', () => {
  type Content = Record<string, unknown> & { page_metadata: Record<string, unknown> };
  const contentOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.structuredContent as Content;
  const answerSearch = () =>
    http.route({
      method: 'POST',
      match: ENDPOINT,
      respond: Response.json({ results: [contractRow], page_metadata: { page: 1 } }),
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['contracts', ['A', 'B', 'C', 'D']],
    ['contracts', ['A', 'B']],
    ['idvs', ['IDV_A', 'IDV_B_C', 'IDV_E']],
    ['grants', ['02', 'F002']],
    ['direct_payments', ['06', '10', 'F006', 'F007']],
    ['loans', ['07', 'F004']],
    ['other', ['-1', 'F010']],
  ] as const)('reads the %s bucket for codes %j', async (bucket, codes) => {
    answerCount(BUCKETS);
    answerSearch();

    const result = await run({ award_type_codes: [...codes], keyword: 'bridge' });

    expect(result.isError).toBeFalsy();
    expect(contentOf(result)).toMatchObject({
      totalCount: BUCKETS[bucket],
      page_metadata: { total: BUCKETS[bucket] },
      matches_by_group: BUCKETS,
    });
    // The total count carries exactly the filters the search sent and nothing else; the
    // group count, the same filters without award_type_codes.
    const { total, group } = await countCalls();
    expect(total).toHaveLength(1);
    expect(group).toHaveLength(1);
    const { filters } = await sentBody();
    const { award_type_codes: _codes, ...withoutCodes } = filters;
    expect(await total[0]!.request.clone().json()).toEqual({ filters });
    expect(await group[0]!.request.clone().json()).toEqual({ filters: withoutCodes });
  });

  it('sends only the total count when award_type_codes is the only filter', async () => {
    answerCount(BUCKETS);
    answerSearch();

    const result = await run({ award_type_codes: ['02'] });

    expect(contentOf(result)).toMatchObject({ page_metadata: { total: BUCKETS.grants } });
    expect(contentOf(result)).not.toHaveProperty('matches_by_group');
    expect(contentOf(result)).not.toHaveProperty('unavailable_sections');
    const { total, group } = await countCalls();
    expect(total).toHaveLength(1);
    expect(group).toHaveLength(0);
  });

  it.each([
    {
      label: 'the total count fails with a 4xx',
      failing: 'total',
      section: 'total',
      status: 422,
      body: { detail: 'Field filters|keywords must be a list' },
      reason: 'upstream_error',
      retryable: false,
    },
    {
      label: 'the total count fails with a 5xx',
      failing: 'total',
      section: 'total',
      status: 503,
      body: { detail: 'Service Unavailable' },
      reason: 'api_unavailable',
      retryable: true,
    },
    {
      label: 'the group count fails with a 5xx',
      failing: 'group',
      section: 'matches_by_group',
      status: 503,
      body: { detail: 'Service Unavailable' },
      reason: 'api_unavailable',
      retryable: true,
    },
  ] as const)('answers with the rows when $label, sending each count once', async (c) => {
    routeCounts((kind) =>
      kind === c.failing ? Response.json(c.body, { status: c.status }) : bucketsResponse(),
    );
    answerSearch();

    const result = await run({ keyword: 'bridge' });

    expect(result.isError).toBeFalsy();
    const sc = contentOf(result);
    expect(sc.results).toHaveLength(1);
    if (c.failing === 'total') {
      expect(sc).not.toHaveProperty('totalCount');
      expect(sc.page_metadata).not.toHaveProperty('total');
      expect(sc.matches_by_group).toEqual(BUCKETS);
    } else {
      expect(sc).toMatchObject({ totalCount: 11, page_metadata: { total: 11 } });
      expect(sc).not.toHaveProperty('matches_by_group');
    }
    expect(sc.unavailable_sections).toEqual([
      expect.objectContaining({ section: c.section, reason: c.reason, retryable: c.retryable }),
    ]);
    expect(sc.notice).toContain(`Partial result: ${c.section} (${c.reason})`);
    expect(textOf(result)).toContain('**Unavailable sections:**');
    const { total, group } = await countCalls();
    expect(total).toHaveLength(1);
    expect(group).toHaveLength(1);
  });

  it.each([
    { hanging: ['total'], sections: ['total'] },
    { hanging: ['group'], sections: ['matches_by_group'] },
    { hanging: ['total', 'group'], sections: ['total', 'matches_by_group'] },
  ] as const)(
    'aborts the counts that outrun the shared 10 s deadline ($hanging) and answers by then',
    async (c) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const hangs = (kind: CountKind) => (c.hanging as readonly CountKind[]).includes(kind);
      routeCounts((kind, request) =>
        hangs(kind)
          ? new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener('abort', () => reject(request.signal.reason));
            })
          : bucketsResponse(),
      );
      answerSearch();

      let settled = false;
      const pending = run({ keyword: 'bridge' }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(settled).toBe(true);
      const sc = contentOf(await pending);
      expect(sc.results).toHaveLength(1);
      expect(sc.unavailable_sections).toEqual(
        c.sections.map((section) =>
          expect.objectContaining({ section, reason: 'api_timeout', retryable: true }),
        ),
      );
      if (hangs('total')) expect(sc).not.toHaveProperty('totalCount');
      else expect(sc).toMatchObject({ totalCount: 11 });
      if (hangs('group')) expect(sc).not.toHaveProperty('matches_by_group');
      else expect(sc.matches_by_group).toEqual(BUCKETS);
      const calls = await countCalls();
      for (const kind of c.hanging) expect(calls[kind][0]!.request.signal.aborted).toBe(true);
    },
  );
});
