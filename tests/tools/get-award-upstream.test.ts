/**
 * @fileoverview `usaspending_get_award` run through its public contract against
 * the real USAspending service, with `globalThis.fetch` serving award-detail
 * records captured from the live API (`tests/fixtures/award-detail/`, long prose
 * fields trimmed). Covers the variable record shape across grant, multi-listing
 * grant, loan, contract, and IDV awards, plus records with null or absent blocks.
 * @module tests/tools/get-award-upstream.test
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAwardTool } from '@/mcp-server/tools/definitions/get-award.tool.js';
import { getAwardSubawardsTool } from '@/mcp-server/tools/definitions/get-award-subawards.tool.js';
import { getAwardTransactionsTool } from '@/mcp-server/tools/definitions/get-award-transactions.tool.js';
import { initUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { markdownText } from '../helpers/markdown-text.js';

const BASE = 'https://api.usaspending.gov/api/v2/';

const GRANT = 'ASST_NON_R24AP00702_014';
const MULTI_LISTING_GRANT = 'ASST_NON_UM1AI068636_075';
const LOAN = 'ASST_NON_P268K155150_091';
const CONTRACT = 'CONT_AWD_36C10B22F0089_3600_47QTCA22D003G_4732';
const IDV = 'CONT_IDV_47QTCA22D003G_4732';

const fixture = (id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve('tests/fixtures/award-detail', `${id}.json`), 'utf-8'));

/** Serves each award record at its detail path; any other request fails the test. */
const serveAwards = (records: Record<string, unknown>[]) => {
  const byPath = new Map(
    records.map((r) => [`/api/v2/awards/${String(r.generated_unique_award_id)}/`, r]),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const record = byPath.get(new URL(url).pathname);
      if (!record) throw new Error(`Unmocked fetch in get-award-upstream.test: ${url}`);
      return new Response(JSON.stringify(record), { status: 200 });
    }),
  );
};

const run = async (record: Record<string, unknown>) => {
  serveAwards([record]);
  const result = await runToolContract(getAwardTool, {
    award_id: String(record.generated_unique_award_id),
  });
  expect(result.isError).toBeFalsy();
  const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
  return { structured: result.structuredContent as Record<string, unknown>, text };
};

beforeEach(() => {
  initUSASpendingService({} as AppConfig, {} as StorageService, {
    baseUrl: BASE,
    timeoutMs: 30_000,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('award child records through the real service', () => {
  const runChild = (
    endpoint: 'transactions' | 'subawards',
    input: { award_id: string; page?: number; limit?: number },
  ) =>
    endpoint === 'transactions'
      ? runToolContract(getAwardTransactionsTool, input)
      : runToolContract(getAwardSubawardsTool, input);
  const servePage = (endpoint: string, payload: unknown) => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}${endpoint}/`);
      expect(init?.method).toBe('POST');
      return Response.json(payload);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it.each(['transactions-contract', 'transactions-loan'])(
    'preserves captured string IDs and supported transaction values: %s (#90)',
    async (name) => {
      const payload = fixture(name);
      const fetch = servePage('transactions', payload);
      const result = await runToolContract(getAwardTransactionsTool, {
        award_id: LOAN,
        order: 'asc',
        limit: 2,
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
        award_id: LOAN,
        order: 'asc',
        sort: 'action_date',
        limit: 2,
        page: 1,
      });
      const structured = result.structuredContent as { results: Record<string, unknown>[] };
      const text = markdownText(result.content.map((b) => ('text' in b ? b.text : '')).join('\n'));
      if (name === 'transactions-loan') {
        expect(structured.results[0]).toMatchObject({
          id: 'ASST_TX_9100_P268K155150_-NONE-_84.268_0001',
          federal_action_obligation: 0,
          face_value_loan_guarantee: 10770988,
          original_loan_subsidy_cost: 0,
          cfda_number: '84.268',
        });
        for (const value of ['ASST_TX_9100_P268K155150_', '10,770,988', '84.268'])
          expect(text).toContain(value);
        expect(text).toMatch(/Original Loan Subsidy Cost:\s+\$0/);
      } else {
        expect(structured.results[0]).toMatchObject({
          id: 'CONT_TX_9700_-NONE-_N0001917C0015_0_-NONE-_0',
        });
        expect(text).toContain('CONT_TX_9700_');
        for (const row of structured.results) {
          for (const key of [
            'face_value_loan_guarantee',
            'original_loan_subsidy_cost',
            'cfda_number',
            'recipient_name',
            'awarding_agency_name',
          ])
            expect(row).not.toHaveProperty(key);
        }
      }
    },
  );

  it.each(['07', '08', 'F003', 'F004', '02'])(
    'gates loan values by shared type membership and retains assistance CFDA: %s (#90)',
    async (type) => {
      servePage('transactions', {
        results: [
          {
            id: 'ASST_TX_TEST',
            type,
            face_value_loan_guarantee: 0,
            original_loan_subsidy_cost: null,
            cfda_number: '01.001',
          },
        ],
        page_metadata: { page: 1, hasNext: false },
      });
      const result = await runToolContract(getAwardTransactionsTool, { award_id: LOAN });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { results: Record<string, unknown>[] };
      expect(structured.results[0]).toEqual({
        id: 'ASST_TX_TEST',
        type,
        cfda_number: '01.001',
        ...(type === '02' ? {} : { face_value_loan_guarantee: 0 }),
      });
      const text = markdownText(result.content.map((b) => ('text' in b ? b.text : '')).join('\n'));
      expect(text).toContain('01.001');
      expect(/Face Value Loan Guarantee:\s+\$0/.test(text)).toBe(type !== '02');
      expect(text).not.toContain('Original Loan Subsidy Cost');
    },
  );

  it('advertises only the six source-supported subaward keys (#96)', () => {
    const row = getAwardSubawardsTool.output.shape.results.element;
    expect(Object.keys(row.shape).sort()).toEqual([
      'action_date',
      'amount',
      'description',
      'id',
      'recipient_name',
      'subaward_number',
    ]);
  });

  it('preserves captured subawards, including zero amounts, on both surfaces (#96)', async () => {
    const payload = fixture('subawards');
    servePage('subawards', payload);
    const result = await runToolContract(getAwardSubawardsTool, { award_id: CONTRACT, limit: 2 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          id: 2106468,
          subaward_number: '1423526',
          description: 'PURCHASED OUTSIDE PRODUCTION',
          action_date: '2017-06-20',
          amount: 76419.2,
          recipient_name: 'A & G MACHINE, INC.',
        },
        { id: 2108182 },
      ],
    });
    const text = markdownText(result.content.map((b) => ('text' in b ? b.text : '')).join('\n'));
    for (const value of [
      '2106468',
      '1423526',
      'PURCHASED OUTSIDE PRODUCTION',
      '2017-06-20',
      '76,419.2',
      'A & G MACHINE, INC.',
    ])
      expect(text).toContain(value);
    servePage('subawards', {
      results: [{ id: 1, amount: 0 }],
      page_metadata: { page: 1, hasNext: false },
    });
    const zero = await runToolContract(getAwardSubawardsTool, { award_id: CONTRACT });
    expect(zero.structuredContent).toMatchObject({ results: [{ id: 1, amount: 0 }] });
    expect(zero.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('**Amount:** $0') }),
      ]),
    );
  });

  for (const endpoint of ['transactions', 'subawards'] as const) {
    it(`preserves a full 100-row ${endpoint} page and its continuation signal`, async () => {
      const rows = Array.from({ length: 100 }, (_, index) =>
        endpoint === 'transactions'
          ? { id: `ASST_TX_${index}`, federal_action_obligation: 0 }
          : { id: index, amount: 0 },
      );
      servePage(endpoint, { results: rows, page_metadata: { page: 2, hasNext: true } });
      const result = await runChild(endpoint, { award_id: CONTRACT, page: 2, limit: 100 });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        results: rows,
        page_metadata: { page: 2, has_next: true, limit: 100 },
        has_next_page: true,
      });
      const text = markdownText(result.content.map((b) => ('text' in b ? b.text : '')).join('\n'));
      expect(text).toContain(endpoint === 'transactions' ? 'ASST_TX_99' : '99');
    });

    it(`omits absent, null and blank optional ${endpoint} values without inventing zeros`, async () => {
      servePage(endpoint, {
        results: [{}, { id: null, description: null, action_date: '' }],
        page_metadata: { page: 1, hasNext: false },
      });
      const result = await runChild(endpoint, { award_id: CONTRACT });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ results: [{}, {}] });
      const text = markdownText(result.content.map((b) => ('text' in b ? b.text : '')).join('\n'));
      expect(text).not.toContain('$0');
    });

    it.each([1, 2, 5])(
      `retains empty and past-end notices for ${endpoint}, page %i`,
      async (page) => {
        const fetch = servePage(endpoint, { results: [], page_metadata: { page, hasNext: false } });
        const result = await runChild(endpoint, { award_id: CONTRACT, page, limit: 100 });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          results: [],
          page_metadata: { page, has_next: false, limit: 100 },
          current_page: page,
          has_next_page: false,
          notice: expect.stringContaining(
            endpoint === 'transactions' ? 'generated_internal_id' : 'subaward_count',
          ),
        });
        const text = markdownText(
          result.content.map((b) => ('text' in b ? b.text : '')).join('\n'),
        );
        expect(text).toContain(
          endpoint === 'transactions' ? 'generated_internal_id' : 'subaward_count',
        );
        expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
          page,
          limit: 100,
        });
      },
    );

    it.each([
      { award_id: '' },
      { award_id: CONTRACT, page: 0 },
      { award_id: CONTRACT, limit: 101 },
    ])(`rejects invalid ${endpoint} inputs before upstream I/O`, async (input) => {
      const fetch = servePage(endpoint, {});
      const result = await runChild(endpoint, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('Invalid arguments') }),
        ]),
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each(['api_timeout', 'api_unavailable'] as const)(
      `keeps the ${endpoint} service error and recovery on both surfaces: %s`,
      async (reason) => {
        const fetch = vi.fn(async () => {
          if (reason === 'api_timeout')
            throw new McpError(JsonRpcErrorCode.Timeout, 'Attempt timed out', {
              errorSource: 'FetchTimeout',
            });
          return new Response('Unavailable', { status: 501 });
        });
        vi.stubGlobal('fetch', fetch);
        const result = await runChild(endpoint, { award_id: CONTRACT });
        expect(result.isError).toBe(true);
        const definition =
          endpoint === 'transactions' ? getAwardTransactionsTool : getAwardSubawardsTool;
        const recovery = definition.errors?.find((entry) => entry.reason === reason)?.recovery;
        expect(recovery).toBeDefined();
        expect(result.structuredContent).toMatchObject({
          error: { data: { reason, recovery: { hint: recovery } } },
        });
        const text = markdownText(
          result.content.map((b) => ('text' in b ? b.text : '')).join('\n'),
        );
        expect(text).toContain(reason);
        expect(text).toContain(recovery!);
        expect(fetch).toHaveBeenCalledTimes(1);
      },
    );
  }
});

describe('usaspending_get_award — fields read from current paths', () => {
  it('preserves populated geography, account totals, outlays and exercised options (#87)', async () => {
    const { structured, text } = await run(fixture(CONTRACT));
    expect(structured).toMatchObject({
      place_of_performance: { congressional_code: '17', county_name: 'WILLIAMSON' },
      recipient: {
        location: { congressional_code: '17', county_name: 'WILLIAMSON', zip5: '78682' },
      },
      total_account_obligation: 648463028.11,
      total_account_outlay: 727245982.37,
      base_exercised_options: 1590242856.86,
      account_outlays_by_defc: [
        { code: 'Q', amount: 711500406.36 },
        { code: 'V', amount: 15745576.01 },
      ],
    });
    for (const value of [
      '17',
      'WILLIAMSON',
      '78682',
      '648,463,028.11',
      '727,245,982.37',
      '1,590,242,856.86',
      '711,500,406.36',
      '15,745,576.01',
    ])
      expect(text).toContain(value);
    const idv = await run(fixture(IDV));
    expect(idv.structured).toMatchObject({
      total_account_obligation: 198497.56,
      total_account_outlay: 678240.02,
    });
    expect(idv.structured).not.toHaveProperty('base_exercised_options');
    expect(idv.text).toContain('198,497.56');
    expect(idv.text).toContain('678,240.02');
  });

  it('keeps new-only locations, leading zeros and ordered sparse outlay rows (#87)', async () => {
    const { structured, text } = await run({
      generated_unique_award_id: CONTRACT,
      place_of_performance: { congressional_code: '01' },
      recipient: { location: { county_name: 'COUNTY', zip5: '00123' } },
      total_account_obligation: 0,
      total_account_outlay: 0,
      base_exercised_options: 0,
      account_outlays_by_defc: [
        { code: 'Q', amount: null },
        { code: null, amount: 0 },
        { code: '', amount: null },
        { code: 'V', amount: 2 },
      ],
    });
    expect(structured).toMatchObject({
      place_of_performance: { congressional_code: '01' },
      recipient: { location: { county_name: 'COUNTY', zip5: '00123' } },
      total_account_obligation: 0,
      total_account_outlay: 0,
      base_exercised_options: 0,
      account_outlays_by_defc: [{ code: 'Q' }, { amount: 0 }, { code: 'V', amount: 2 }],
    });
    for (const value of ['01', 'COUNTY', '00123', '$0', '**Q:** N/A', '**N/A:** $0', '**V:** $2'])
      expect(text).toContain(value);
  });

  it.each([undefined, null, [], [{ code: null, amount: null }]])(
    'omits an unpopulated outlay array %j (#87)',
    async (rows) => {
      const { structured, text } = await run({
        generated_unique_award_id: CONTRACT,
        account_outlays_by_defc: rows,
      });
      expect(structured).not.toHaveProperty('account_outlays_by_defc');
      expect(text).not.toContain('Account Outlays by DEF Code');
    },
  );

  it.each([
    ['congressional_code', '01'],
    ['county_name', 'COUNTY'],
    ['zip5', '00123'],
  ])('keeps a recipient location populated only by %s (#87)', async (field, value) => {
    const { structured, text } = await run({
      generated_unique_award_id: CONTRACT,
      recipient: { location: { [field]: value } },
    });
    expect(structured.recipient).toEqual({ location: { [field]: value } });
    expect(markdownText(text)).toContain(value);
    expect(text).not.toContain('**Location:** \n');
  });
  it('maps the contract record onto the existing output fields', async () => {
    const { structured, text } = await run(fixture(CONTRACT));

    expect(structured).toMatchObject({
      generated_unique_award_id: CONTRACT,
      piid: '36C10B22F0089',
      type: 'C',
      type_description: 'DELIVERY ORDER',
      category: 'contract',
      description: 'VA MICROSOFT ENTERPRISE LICENSE AGREEMENT.',
      total_obligation: 1_590_136_261.87,
      total_outlays: 727_245_982.37,
      base_and_all_options_value: 1_637_215_100,
      subaward_count: 0,
      date_signed: '2022-03-29',
      period_of_performance: {
        start_date: '2022-04-01',
        end_date: '2026-03-31',
        potential_end_date: '2026-03-31',
      },
      place_of_performance: { city_name: 'ROUND ROCK', state_code: 'TX', zip5: '78682' },
      recipient: {
        recipient_name: 'DELL FEDERAL SYSTEMS L.P',
        recipient_id: '3612de0a-9635-3846-a5a1-7f555fba52df-C',
        parent_recipient_name: 'FRANCISCO PARTNERS MANAGEMENT, L.P.',
        location: { city_name: 'ROUND ROCK', state_code: 'TX' },
      },
      awarding_agency: {
        toptier_name: 'Department of Veterans Affairs',
        toptier_code: '036',
        toptier_slug: 'department-of-veterans-affairs',
        subtier_name: 'Department of Veterans Affairs',
      },
      funding_agency: {
        toptier_name: 'Department of Veterans Affairs',
        toptier_code: '036',
        subtier_name: 'Department of Veterans Affairs',
      },
      parent_award: {
        award_id: '47QTCA22D003G',
        generated_unique_award_id: IDV,
        agency_name: 'General Services Administration',
        type_description: 'FSS',
      },
      naics: { code: '511210', description: 'SOFTWARE PUBLISHERS' },
      product_or_service_code: { code: 'DA01' },
      account_obligations_by_defc: [
        { code: 'Q', amount: 648_463_028.11 },
        { code: 'V', amount: 0 },
      ],
    });
    expect(text).toContain('**Recipient ID (for get_recipient):** 3612de0a-');
    expect(text).toContain('**Chain ID (for get_award):** CONT_IDV_47QTCA22D003G_4732');
    expect(text).toContain('**NAICS:** 511210 — SOFTWARE PUBLISHERS');
  });

  it('maps an IDV with a null parent_award and no assistance data', async () => {
    const { structured } = await run(fixture(IDV));

    expect(structured).toMatchObject({ category: 'idv', type: 'IDV_C', total_obligation: 0 });
    expect(structured).not.toHaveProperty('parent_award');
    expect(structured).not.toHaveProperty('fain');
  });

  it('maps a grant without contract data', async () => {
    const { structured } = await run(fixture(GRANT));

    expect(structured).toMatchObject({
      fain: 'R24AP00702',
      category: 'grant',
      total_obligation: 5_000_000,
      recipient: { recipient_id: '8bbcbc66-94d6-bba8-7169-6930c70d6167-R' },
    });
    expect(structured).not.toHaveProperty('naics');
    expect(structured).not.toHaveProperty('piid');
  });
});

describe('usaspending_get_award — assistance listings (#68)', () => {
  it('returns the single listing of a grant with its obligation', async () => {
    const { structured, text } = await run(fixture(GRANT));

    expect(structured.assistance_listings).toEqual([
      {
        number: '15.507',
        title: 'WaterSMART (Sustain and Manage America’s Resources for Tomorrow)',
        obligation: 5_000_000,
      },
    ]);
    expect(structured).not.toHaveProperty('cfda');
    expect(text).toContain('### Assistance Listings');
    expect(text).toContain(
      '- **15.507** — WaterSMART (Sustain and Manage America’s Resources for Tomorrow): $5,000,000',
    );
  });

  it('keeps every listing of a multi-listing grant in upstream order, summing to the award total', async () => {
    const { structured, text } = await run(fixture(MULTI_LISTING_GRANT));
    const listings = structured.assistance_listings as {
      number: string;
      title: string;
      obligation: number;
    }[];

    expect(listings.map((l) => l.number)).toEqual([
      '93.855',
      '93.279',
      '93.853',
      '93.242',
      '93.866',
      '93.310',
    ]);
    expect(listings[3]).toEqual({
      number: '93.242',
      title: 'Mental Health Research Grants',
      obligation: 2_241_243,
    });
    const sum = listings.reduce((acc, l) => acc + l.obligation, 0);
    expect(sum).toBeCloseTo(structured.total_obligation as number, 2);
    for (const l of listings) expect(text).toContain(`- **${l.number}** — ${l.title}`);
  });

  it('returns a zero-obligation listing on a loan rather than dropping it', async () => {
    const { structured } = await run(fixture(LOAN));

    expect(structured.assistance_listings).toEqual([
      { number: '84.268', title: 'Federal Direct Student Loans', obligation: 0 },
    ]);
  });

  it('emits no listings for a contract, which carries no cfda_info', async () => {
    const { structured, text } = await run(fixture(CONTRACT));

    expect(structured).not.toHaveProperty('assistance_listings');
    expect(text).not.toContain('Assistance Listings');
  });
});

describe('usaspending_get_award — recipient identity and location (#68)', () => {
  it('returns the grant recipient UEI, business categories, and both country codes', async () => {
    const { structured, text } = await run(fixture(GRANT));

    expect(structured.recipient).toMatchObject({
      uei: 'LK3EXNEPLMD9',
      business_categories: ['Government', 'U.S. Local Government'],
      location: { city_name: 'TURLOCK', state_code: 'CA', country_code: 'USA' },
    });
    expect(structured.place_of_performance).toEqual({
      state_code: 'CA',
      country_code: 'USA',
      congressional_code: '90',
      county_name: 'STANISLAUS',
    });
    expect(structured.recipient).not.toHaveProperty('business_types');
    // Upstream nulls the parent identifiers on a standalone recipient.
    expect(structured.recipient).not.toHaveProperty('parent_uei');
    expect(structured.recipient).not.toHaveProperty('parent_recipient_id');
    expect(text).toContain('**UEI:** LK3EXNEPLMD9');
    expect(text).toContain('**Business Categories:** Government, U.S. Local Government');
    expect(text).toContain('**Location:** TURLOCK, CA, 95380, USA');
    expect(text).toContain('**Place of Performance:** CA, USA');
  });

  it('returns the contract parent UEI and a parent recipient_id that chains to get_recipient', async () => {
    const { structured, text } = await run(fixture(CONTRACT));

    expect(structured.recipient).toMatchObject({
      uei: 'N1C5QLNPJLS4',
      parent_recipient_name: 'FRANCISCO PARTNERS MANAGEMENT, L.P.',
      parent_uei: 'JGSNSER23GR6',
      parent_recipient_id: 'f96a8de9-a2b2-cc9d-cc9f-ec5976fb4c3b-P',
    });
    expect(text).toContain('**Parent UEI:** JGSNSER23GR6');
    expect(text).toContain(
      '**Parent Recipient ID (for get_recipient):** f96a8de9-a2b2-cc9d-cc9f-ec5976fb4c3b-P',
    );
  });

  it('returns the parent name alone when upstream has no parent identifiers', async () => {
    const { structured } = await run(fixture(LOAN));

    expect(structured.recipient).toMatchObject({
      uei: 'FJ4QL9QR39Z8',
      parent_recipient_name: 'PURDUE UNIVERSITY GLOBAL, INC.',
    });
    expect(structured.recipient).not.toHaveProperty('parent_uei');
    expect(structured.recipient).not.toHaveProperty('parent_recipient_id');
  });

  it('emits no place_of_performance key when every location field is null', async () => {
    const { structured, text } = await run(fixture(IDV));

    expect(structured).not.toHaveProperty('place_of_performance');
    expect(text).not.toContain('Place of Performance');
    expect(structured.recipient).toMatchObject({
      location: { city_name: 'ROUND ROCK', state_code: 'TX', country_code: 'USA' },
    });
  });
});

describe('usaspending_get_award — loan values (#68)', () => {
  it('returns the loan face value and subsidy cost of a direct loan', async () => {
    const { structured, text } = await run(fixture(LOAN));

    expect(structured).toMatchObject({
      category: 'loans',
      total_obligation: 0,
      total_loan_value: 46_402_867_113,
      total_subsidy_cost: 0,
    });
    expect(text).toContain('**Total Loan Value:** $46,402,867,113');
    expect(text).toContain('**Total Subsidy Cost:** $0');
  });

  it('omits the loan fields on non-loan awards, where upstream reports placeholder zeros', async () => {
    const grant = await run(fixture(GRANT));
    expect(grant.structured).not.toHaveProperty('total_loan_value');
    expect(grant.structured).not.toHaveProperty('total_subsidy_cost');
    expect(grant.text).not.toContain('Loan Value');

    const contract = await run(fixture(CONTRACT));
    expect(contract.structured).not.toHaveProperty('total_loan_value');
  });
});

describe('usaspending_get_award — null and absent blocks (#68)', () => {
  it('drops a recipient whose fields are all null or empty', async () => {
    const record = {
      ...fixture(GRANT),
      recipient: {
        recipient_hash: null,
        recipient_name: null,
        recipient_uei: null,
        parent_recipient_hash: null,
        parent_recipient_name: null,
        parent_recipient_uei: null,
        business_categories: [],
        location: { location_country_code: null, city_name: null, state_code: null },
      },
      place_of_performance: null,
      cfda_info: [],
    };
    const { structured, text } = await run(record);

    expect(structured).not.toHaveProperty('recipient');
    expect(structured).not.toHaveProperty('place_of_performance');
    expect(structured).not.toHaveProperty('assistance_listings');
    expect(text).not.toContain('### Recipient');
  });

  it('keeps the populated fields of a partial recipient and listing', async () => {
    const record: Record<string, unknown> = {
      ...fixture(GRANT),
      recipient: {
        recipient_name: 'PARTIAL RECIPIENT',
        recipient_uei: 'PARTIALUEI12',
        business_categories: null,
        location: { location_country_code: 'CAN', city_name: null, state_code: null },
      },
      cfda_info: [
        { cfda_number: null, cfda_title: null, federal_action_obligation_amount: null },
        { cfda_number: '10.001', cfda_title: null, federal_action_obligation_amount: 12.5 },
      ],
    };
    delete record.place_of_performance;
    const { structured, text } = await run(record);

    expect(structured.recipient).toEqual({
      recipient_name: 'PARTIAL RECIPIENT',
      uei: 'PARTIALUEI12',
      location: { country_code: 'CAN' },
    });
    expect(structured.assistance_listings).toEqual([{ number: '10.001', obligation: 12.5 }]);
    expect(text).toContain('- **10.001**: $12.5');
    expect(text).toContain('**Location:** CAN');
  });
});
