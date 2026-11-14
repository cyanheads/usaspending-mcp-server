/**
 * @fileoverview Effective input filters through the production tool contract.
 * @module tests/tools/effective-filters.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';
import { spendingByCategoryTool } from '@/mcp-server/tools/definitions/spending-by-category.tool.js';
import { spendingByGeographyTool } from '@/mcp-server/tools/definitions/spending-by-geography.tool.js';
import { spendingOverTimeTool } from '@/mcp-server/tools/definitions/spending-over-time.tool.js';
import { USASpendingService } from '@/services/usaspending/usaspending-service.js';
import { markdownText } from '../helpers/markdown-text.js';

const upstream = vi.hoisted(() => ({ service: undefined as USASpendingService | undefined }));
vi.mock('@/services/usaspending/usaspending-service.js', async (original) => ({
  ...(await original<typeof import('@/services/usaspending/usaspending-service.js')>()),
  getUSASpendingService: () => upstream.service,
}));
const http = createFetchMock();
const DIRECTORY = 'https://api.usaspending.gov/api/v2/autocomplete/awarding_agency_office/';
const NASA = 'National Aeronautics and Space Administration';
const GSA = 'General Services Administration';
const DOD = 'Department of Defense';
const DOE = 'Department of Energy';
const NAVY = 'Department of the Navy';
const PARENT_SCOPE = 'awards USAspending attributes to that parent';
const RequestBody = z.object({
  search_text: z.string().optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
});
const directory = vi.fn((request: Request): Response | Promise<Response> =>
  request
    .clone()
    .json()
    .then((raw) =>
      Response.json({
        results: {
          toptier_agency: [
            { name: NASA, abbreviation: 'NASA' },
            { name: GSA, abbreviation: 'GSA' },
            { name: DOD, abbreviation: 'DOD' },
            { name: DOE, abbreviation: 'DOE' },
          ],
          subtier_agency: [
            { name: NASA, abbreviation: 'NASA' },
            { name: NAVY, abbreviation: 'USN', toptier_agency: { name: DOD } },
            { name: 'Office of Inspector General', abbreviation: 'OIG' },
            { name: 'Office of Inspector General', abbreviation: 'OIG' },
            { name: 'Office of the Inspector General', abbreviation: 'OIG' },
            ...(RequestBody.parse(raw).search_text === 'FULL'
              ? Array.from({ length: 45 }, (_, index) => ({
                  name: `Agency ${index}`,
                  abbreviation: index ? undefined : 'FULL',
                }))
              : []),
          ],
        },
      }),
    ),
);

beforeEach(() => {
  directory.mockClear();
  http.reset();
  http.route(
    {
      match: DIRECTORY,
      respond: directory,
    },
    {
      match: 'https://api.usaspending.gov/api/v2/search/spending_by_award_count/',
      respond: () =>
        Response.json({
          results: { contracts: 0, idvs: 0, grants: 0, direct_payments: 0, loans: 0, other: 0 },
        }),
    },
    {
      match: () => true,
      respond: () => Response.json({ results: [], page_metadata: { page: 3, hasNext: false } }),
    },
  );
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

it('preserves both awarding tiers for a canonical agency', async () => {
  const result = await runToolContract(spendingOverTimeTool, {
    group: 'fiscal_year',
    filters: { agency_name: NASA },
  });
  expect(result.structuredContent).toMatchObject({ applied_agency_name: NASA });
  expect(await http.calls.at(-1)!.request.clone().json()).toMatchObject({
    filters: {
      agencies: [
        { type: 'awarding', tier: 'toptier', name: NASA },
        { type: 'awarding', tier: 'subtier', name: NASA },
      ],
    },
  });
});

it.each(['NASA', NASA.toLowerCase()])(
  'sends and echoes the canonical agency for %s',
  async (agency_name) => {
    const result = await runToolContract(spendingOverTimeTool, {
      group: 'fiscal_year',
      filters: { agency_name },
    });
    expect(await http.calls.at(-1)!.request.clone().json()).toMatchObject({
      filters: {
        agencies: [
          { type: 'awarding', tier: 'toptier', name: NASA },
          { type: 'awarding', tier: 'subtier', name: NASA },
        ],
      },
    });
    expect(result.structuredContent).toMatchObject({ applied_agency_name: NASA });
    expect(JSON.stringify(result.content)).toContain(NASA);
  },
);

it.each([
  [
    'OIG',
    'multiple distinct agency names matched',
    ['Office of Inspector General', 'Office of the Inspector General'],
  ],
  ['FULL', 'the agency directory result reached its limit', ['Agency 0']],
  ['Invented historical agency', 'no exact agency name or abbreviation matched', []],
] as const)(
  'preserves %s on an inconclusive directory result',
  async (agency_name, reason, candidates) => {
    const response = await runToolContract(spendingOverTimeTool, {
      group: 'fiscal_year',
      filters: { agency_name },
    });
    expect(response.isError).toBeFalsy();
    expect(response.structuredContent).toMatchObject({
      applied_agency_name: agency_name,
      notice: expect.stringContaining(reason),
    });
    expect(JSON.stringify(response.content)).toContain(reason);
    for (const candidate of candidates) {
      expect(response.structuredContent).toMatchObject({
        notice: expect.stringContaining(candidate),
      });
      expect(JSON.stringify(response.content)).toContain(candidate);
    }
    expect(await http.calls.at(-1)!.request.clone().json()).toMatchObject({
      filters: {
        agencies: [
          { type: 'awarding', tier: 'toptier', name: agency_name },
          { type: 'awarding', tier: 'subtier', name: agency_name },
        ],
      },
    });
  },
);

it('prefers an exact own name over abbreviation matches', async () => {
  directory.mockResolvedValueOnce(
    Response.json({
      results: {
        subtier_agency: [
          { name: 'Office of Inspector General', abbreviation: 'OIG' },
          { name: 'OIG' },
        ],
      },
    }),
  );
  const response = await runToolContract(spendingOverTimeTool, {
    group: 'fiscal_year',
    filters: { agency_name: 'oig' },
  });
  expect(response.structuredContent).toMatchObject({ applied_agency_name: 'OIG' });
  expect(JSON.stringify(response.content)).not.toContain('Could not verify');
});

it.each([
  ['a server error', () => new Response('Service unavailable', { status: 503 })],
  ['rate limiting', () => new Response('Too many requests', { status: 429 })],
  ['a malformed result bucket', () => Response.json({ results: { toptier_agency: {} } })],
  ['a malformed agency row', () => Response.json({ results: { subtier_agency: [null] } })],
] as const)('preserves an agency name on %s without retrying', async (_failure, respond) => {
  directory.mockResolvedValueOnce(respond());
  const response = await runToolContract(spendingOverTimeTool, {
    group: 'fiscal_year',
    filters: { agency_name: 'DoD' },
  });
  expect(response.isError).toBeFalsy();
  expect(response.structuredContent).toMatchObject({
    applied_agency_name: 'DoD',
    notice: expect.stringContaining('the agency directory was unavailable'),
  });
  const rendered = response.content
    .flatMap((block) => (block.type === 'text' ? [markdownText(block.text)] : []))
    .join('\n');
  expect(rendered).toContain('the agency directory was unavailable');
  expect(directory).toHaveBeenCalledTimes(1);
  expect(await http.calls.at(-1)!.request.clone().json()).toMatchObject({
    filters: {
      agencies: [
        { type: 'awarding', tier: 'toptier', name: 'DoD' },
        { type: 'awarding', tier: 'subtier', name: 'DoD' },
      ],
    },
  });
});

it('propagates a directory input failure and never queries spending', async () => {
  directory.mockResolvedValueOnce(Response.json({ detail: 'Rejected lookup' }, { status: 422 }));
  const result = await runToolContract(spendingOverTimeTool, {
    group: 'fiscal_year',
    filters: { agency_name: 'NASA' },
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain('Rejected lookup');
  expect(http.calls.map((call) => call.request.url)).toEqual([DIRECTORY]);
});

it('rejects an invalid funding filter before making a directory or spending request', async () => {
  const result = await runToolContract(searchAwardsTool, { funding_agency_name: {} } as never);
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.InvalidParams },
  });
  expect(JSON.stringify(result.content)).toContain('funding_agency_name');
  expect(http.calls).toHaveLength(0);
});

it('propagates caller cancellation during lookup and never queries spending', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<AbortSignal>();
  const body = Promise.withResolvers<Response>();
  directory.mockImplementationOnce((request) => {
    request.signal.addEventListener('abort', () => body.reject(request.signal.reason), {
      once: true,
    });
    started.resolve(request.signal);
    return body.promise;
  });
  const request = runToolContract(
    spendingOverTimeTool,
    { group: 'fiscal_year', filters: { agency_name: 'NASA' } },
    {
      context: { signal: controller.signal },
    },
  );
  const signal = await started.promise;
  const reason = new DOMException('Cancelled agency lookup', 'AbortError');
  expect(signal.aborted).toBe(false);
  controller.abort(reason);
  // Ensure the fake transport settles even if the signal is accidentally disconnected.
  body.resolve(Response.json({ results: {} }));
  const response = await request;
  expect(signal.reason).toBe(reason);
  expect(response.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RequestCancelled },
  });
  expect(JSON.stringify(response.content)).toContain('Cancelled agency lookup');
  expect(http.calls.map((call) => call.request.url)).toEqual([DIRECTORY]);
});

it('bounds both in-flight agency lookups to the same two-second deadline', async () => {
  vi.useFakeTimers();
  upstream.service = new USASpendingService({} as AppConfig, {} as StorageService, {
    baseUrl: 'https://api.usaspending.gov/api/v2/',
    timeoutMs: 10_000,
    retryBudgetMs: 10_000,
  });
  const signals: AbortSignal[] = [];
  const replies: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
  const stall = (request: Request) => {
    signals.push(request.signal);
    const reply = Promise.withResolvers<Response>();
    replies.push(reply);
    request.signal.addEventListener('abort', () => reply.reject(request.signal.reason), {
      once: true,
    });
    return reply.promise;
  };
  directory.mockImplementationOnce(stall).mockImplementationOnce(stall);
  const result = runToolContract(spendingOverTimeTool, {
    group: 'fiscal_year',
    filters: { agency_name: 'NASA', funding_agency_name: 'DoD' },
  });
  try {
    await vi.advanceTimersByTimeAsync(1_999);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    expect(http.calls.map((call) => call.request.url)).toEqual([DIRECTORY, DIRECTORY]);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    const response = await result;
    expect(response.structuredContent).toMatchObject({
      applied_agency_name: 'NASA',
      applied_funding_agency_name: 'DoD',
      notice: expect.stringContaining('the agency directory was unavailable'),
    });
    expect(directory).toHaveBeenCalledTimes(2);
  } finally {
    for (const reply of replies) reply.resolve(Response.json({ results: {} }));
    await result;
    vi.useRealTimers();
  }
});

it.each([
  { input: {}, expected: [], lookups: [] },
  {
    input: { funding_agency_name: 'DOE', filters: { funding_agency_name: '' } },
    expected: [['funding', DOE]],
    lookups: ['DOE'],
  },
  {
    input: {
      agency_name: 'GSA',
      funding_agency_name: 'DOE',
      filters: { funding_agency_name: 'DoD' },
    },
    expected: [
      ['awarding', GSA],
      ['funding', DOD],
    ],
    lookups: ['GSA', 'DoD'],
  },
  {
    input: { agency_name: 'GSA', filters: { funding_agency_name: 'USN' } },
    expected: [
      ['awarding', GSA],
      ['funding', NAVY],
    ],
    lookups: ['GSA', 'USN'],
  },
  {
    input: { agency_name: 'GSA', funding_agency_name: 'GSA' },
    expected: [
      ['awarding', GSA],
      ['funding', GSA],
    ],
    lookups: ['GSA'],
  },
  {
    input: { agency_name: 'GSA', funding_agency_name: 'Missing agency' },
    expected: [
      ['awarding', GSA],
      ['funding', 'Missing agency'],
    ],
    lookups: ['GSA', 'Missing agency'],
  },
])(
  'composes $expected into both award requests using only effective names',
  async ({ input, expected, lookups }) => {
    const response = await runToolContract(searchAwardsTool, input);
    const bodies = await Promise.all(
      http.calls.map(async ({ request }) => RequestBody.parse(await request.clone().json())),
    );
    expect(bodies.slice(0, -2).map((body) => body.search_text)).toEqual(lookups);
    const [rows, count] = bodies.slice(-2);
    expect(rows?.filters).toEqual(count?.filters);
    const agencies = expected.flatMap(([type, name]) =>
      ['toptier', 'subtier'].map((tier) => ({ type, tier, name })),
    );
    expect(rows?.filters).toBeDefined();
    if (agencies.length) expect(rows?.filters?.agencies).toEqual(agencies);
    else expect(rows?.filters).not.toHaveProperty('agencies');
    const funding = expected.find(([type]) => type === 'funding')?.[1];
    if (funding) {
      expect(response.structuredContent).toMatchObject({
        applied_funding_agency_name: funding,
        notice: expect.stringContaining(`funding_agency_name="${funding}"`),
      });
      expect(JSON.stringify(response.content)).toContain(funding);
    } else {
      expect(response.structuredContent).not.toHaveProperty('applied_funding_agency_name');
    }
  },
);

for (const { definition, args } of analytics) {
  it(`${definition.name} forwards funding and awarding pairs and echoes funding for an empty result`, async () => {
    const subawards = definition.name !== 'usaspending_spending_by_category';
    const result = await runToolContract(definition, {
      ...args,
      ...(subawards ? { subawards } : {}),
      filters: { agency_name: 'GSA', funding_agency_name: 'USN', time_period_end: '2025-09-30' },
    });
    expect(result.isError).toBeFalsy();
    expect(await http.calls.at(-1)!.request.clone().json()).toMatchObject({
      ...(subawards ? { subawards } : {}),
      filters: {
        agencies: [
          { type: 'awarding', tier: 'toptier', name: GSA },
          { type: 'awarding', tier: 'subtier', name: GSA },
          { type: 'funding', tier: 'toptier', name: NAVY },
          { type: 'funding', tier: 'subtier', name: NAVY },
        ],
      },
    });
    expect(result.structuredContent).toMatchObject({
      applied_funding_agency_name: NAVY,
      notice: expect.stringContaining(`funding_agency_name="${NAVY}"`),
    });
    expect(JSON.stringify(result.content)).toContain(NAVY);
  });
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
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining(PARENT_SCOPE),
    });
    expect(JSON.stringify(result.content)).toContain(PARENT_SCOPE);
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
    expect(JSON.stringify(result.content)).not.toContain(PARENT_SCOPE);
    expect(await http.calls[0]!.request.clone().json()).not.toHaveProperty('filters.recipient_id');
  });
  it.each(['C', 'R'])('%s recipient scope has no parent notice', async (role) => {
    const recipient_id = `abcdef12-1234-0000-0000-abcdef123456-${role}`;
    const result = await runToolContract(definition, { ...args, filters: { recipient_id } });
    expect(result.structuredContent).toMatchObject({ applied_recipient_id: recipient_id });
    expect(result.structuredContent).not.toMatchObject({
      notice: expect.stringContaining(PARENT_SCOPE),
    });
    expect(JSON.stringify(result.content)).not.toContain(PARENT_SCOPE);
  });
}

it.each([1, 3])(
  'award search preserves agency and recipient scope on an empty positive-total page %s',
  async (page) => {
    http.reset();
    http.route(
      { match: DIRECTORY, respond: directory },
      {
        match: 'https://api.usaspending.gov/api/v2/search/spending_by_award_count/',
        respond: () =>
          Response.json({
            results: { contracts: 10, idvs: 0, grants: 0, direct_payments: 0, loans: 0, other: 0 },
          }),
      },
      {
        match: () => true,
        respond: () => Response.json({ results: [], page_metadata: { page, hasNext: false } }),
      },
    );
    const result = await runToolContract(searchAwardsTool, {
      agency_name: 'GSA',
      funding_agency_name: 'DoD',
      recipient_name: 'Example recipient',
      page,
      limit: 5,
    });
    expect(result.isError).toBeFalsy();
    const notice = z.object({ notice: z.string() }).parse(result.structuredContent).notice;
    expect(notice).not.toContain('Could not verify');
    expect(notice).toContain('recipient_name="Example recipient"');
    expect(notice).toContain('agency_name="General Services Administration"');
    expect(notice).toContain('funding_agency_name="Department of Defense"');
    expect(result.structuredContent).toMatchObject({ page_metadata: { total: 10, page } });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(markdownText(text)).toContain(notice);
  },
);

it('award search echoes the effective recipient name and award codes on an empty page', async () => {
  const result = await runToolContract(searchAwardsTool, {
    recipient_name: 'flat name',
    filters: { recipient_name: 'nested *name*', award_type_codes: ['04', '05'] },
  });
  expect(result.structuredContent).toMatchObject({
    applied_recipient_name: 'nested *name*',
    applied_award_type_codes: '04, 05',
    notice: expect.stringContaining('recipient_name="nested *name*"'),
  });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  expect(text).toContain('**applied_recipient_name:** `nested *name*`');
  expect(text).toContain('**applied_award_type_codes:** `04, 05`');
  expect(await http.calls[0]!.request.clone().json()).toMatchObject({
    filters: { recipient_search_text: ['nested *name*'], award_type_codes: ['04', '05'] },
  });
});

it.each(analytics.slice(0, 2))(
  '$definition.name echoes explicitly sent award codes',
  async ({ definition, args }) => {
    const result = await runToolContract(definition, {
      ...args,
      filters: { award_type_codes: ['04', '05'] },
    });
    expect(result.structuredContent).toMatchObject({ applied_award_type_codes: '04, 05' });
    expect(JSON.stringify(result.content)).toContain('**applied_award_type_codes:** `04, 05`');
    expect(await http.calls[0]!.request.clone().json()).toMatchObject({
      filters: { award_type_codes: ['04', '05'] },
    });
  },
);

it('geography echoes the complete default sent on an unfiltered request', async () => {
  const result = await runToolContract(spendingByGeographyTool, {
    scope: 'place_of_performance',
    geo_layer: 'state',
  });
  const sent = RequestBody.parse(await http.calls[0]!.request.clone().json());
  const codes = z.array(z.string()).parse(sent.filters?.award_type_codes);
  expect(codes).toEqual([
    'A',
    'B',
    'C',
    'D',
    'IDV_A',
    'IDV_B',
    'IDV_B_A',
    'IDV_B_B',
    'IDV_B_C',
    'IDV_C',
    'IDV_D',
    'IDV_E',
    '02',
    '03',
    '04',
    '05',
    '06',
    '07',
    '08',
    '09',
    '10',
    '11',
    'F001',
    'F002',
    'F003',
    'F004',
    'F005',
    'F006',
    'F007',
    'F008',
    'F009',
    'F010',
    '-1',
  ]);
  expect(result.structuredContent).toHaveProperty('applied_award_type_codes', codes.join(', '));
  expect(JSON.stringify(result.content)).toContain(
    `**applied_award_type_codes:** \`${codes.join(', ')}\``,
  );
});

it('award search echoes the default contracts without an unapplied recipient name', async () => {
  const result = await runToolContract(searchAwardsTool, {});
  expect(result.structuredContent).toHaveProperty('applied_award_type_codes', 'A, B, C, D');
  expect(result.structuredContent).not.toHaveProperty('applied_recipient_name');
  expect(JSON.stringify(result.content)).toContain('**applied_award_type_codes:** `A, B, C, D`');
  expect(await http.calls[0]!.request.clone().json()).toMatchObject({
    filters: { award_type_codes: ['A', 'B', 'C', 'D'] },
  });
});

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
