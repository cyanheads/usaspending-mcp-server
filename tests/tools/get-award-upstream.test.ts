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
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAwardTool } from '@/mcp-server/tools/definitions/get-award.tool.js';
import { initUSASpendingService } from '@/services/usaspending/usaspending-service.js';

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

describe('usaspending_get_award — fields read from current paths', () => {
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
    expect(structured.place_of_performance).toEqual({ state_code: 'CA', country_code: 'USA' });
    expect(structured.recipient).not.toHaveProperty('business_types');
    // Upstream nulls the parent identifiers on a standalone recipient.
    expect(structured.recipient).not.toHaveProperty('parent_uei');
    expect(structured.recipient).not.toHaveProperty('parent_recipient_id');
    expect(text).toContain('**UEI:** LK3EXNEPLMD9');
    expect(text).toContain('**Business Categories:** Government, U.S. Local Government');
    expect(text).toContain('**Location:** TURLOCK, CA, USA');
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
