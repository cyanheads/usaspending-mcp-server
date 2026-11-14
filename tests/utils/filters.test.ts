/**
 * @fileoverview Unit tests for the shared buildFilters utility.
 * @module tests/utils/filters.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyticsTypeMismatch,
  applyLocationFilters,
  buildFilters,
  CODE_FILTER_FIELDS,
  describeLocationFilters,
  LOCATION_FILTER_FIELDS,
  locationFilterEcho,
  normalizeCodeFilters,
  normalizeEffectiveFilters,
  resolveLocationFilters,
} from '@/mcp-server/tools/definitions/filters.js';
import { resolveLocation } from '@/mcp-server/tools/definitions/locations.js';

describe('effective filter validation', () => {
  it.each(['P', 'C', 'R'])('preserves recipient level %s', (level) => {
    expect(
      normalizeEffectiveFilters({ recipient_id: `00000000-0000-0000-0000-000000000000-${level}` }),
    ).toEqual({ recipient_id: `00000000-0000-0000-0000-000000000000-${level}` });
  });
  it.each([
    'ABCDEFGHIJKL',
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000000000-p',
    '00000000-0000-0000-0000-000000000000-X',
    '00000000-0000-0000-0000-00000000000Z-P',
  ])('rejects malformed recipient %s', (recipient_id) => {
    expect(normalizeEffectiveFilters({ recipient_id })).toMatchObject({
      reason: 'invalid_recipient_id',
    });
  });
  it('keeps scanner and reused code-filter paths within linear thread CPU bounds', () => {
    const guard = (small: number, large: number) => {
      if (large >= 1_000_000 || large / Math.max(small, 1) >= 256)
        throw new Error('CPU guard exceeded');
    };
    expect(() => guard(1, 257)).toThrow('CPU guard exceeded');
    expect(() => guard(100_000, 1_000_000)).toThrow('CPU guard exceeded');
    const shapes = [
      (n: number) => `${'0'.repeat(n)}54`,
      (n: number) => `${'5_'.repeat(n)}4`,
      (n: number) => `${'+('.repeat(n)}54`,
      (n: number) => `${'0'.repeat(n)}54\n`,
      (n: number) => `${'0\n'.repeat(n)}54`,
    ];
    for (const shape of shapes) {
      const readings: number[] = [];
      for (const size of [1250, 5000, 20000, 80000]) {
        const value = shape(size);
        const run = () => {
          normalizeEffectiveFilters({ naics_codes: [value], recipient_id: value });
          CODE_FILTER_FIELDS.def_codes.safeParse([value]);
          normalizeCodeFilters({ def_codes: [value] });
        };
        // Warm each size before samples so tier transitions cannot masquerade as growth.
        for (let i = 0; i < 30; i++) run();
        const samples = [];
        for (let sample = 0; sample < 3; sample++) {
          const start = process.threadCpuUsage();
          for (let i = 0; i < 20; i++) run();
          const usage = process.threadCpuUsage(start);
          samples.push(usage.user + usage.system);
        }
        readings.push(Math.min(...samples));
        expect(normalizeEffectiveFilters({ recipient_id: value })).toMatchObject({
          reason: 'invalid_recipient_id',
        });
        expect(CODE_FILTER_FIELDS.def_codes.safeParse([value]).success).toBe(false);
        expect(normalizeCodeFilters({ def_codes: [value] }).def_codes).toEqual([
          value.toUpperCase(),
        ]);
        const normalized = normalizeEffectiveFilters({ naics_codes: [value] });
        if (value.includes('_')) expect(normalized).toMatchObject({ reason: 'invalid_naics_code' });
        else if (value.includes('(') || value.slice(0, -1).includes('\n'))
          expect(normalized).toEqual({ naics_codes: [value] });
        else expect(normalized).toEqual({ naics_codes: ['54'] });
      }
      guard(readings[0]!, readings[3]!);
    }
  });
  it.each([
    ['054', '54'],
    ['+54', '54'],
    [' 54 ', '54'],
    ['00541512', '541512'],
    ['54_15', '5415'],
    ['５４', '５４'],
  ])('normalizes %s to %s', (value, expected) => {
    expect(normalizeEffectiveFilters({ naics_codes: [value] })).toEqual({
      naics_codes: [expected],
    });
  });
  it.each(['abc', '541', '54151', '00'])('rejects known invalid NAICS %s', (value) => {
    expect(normalizeEffectiveFilters({ naics_codes: [value] })).toMatchObject({
      reason: 'invalid_naics_code',
    });
  });
  it('preserves significant keyword whitespace and rejects short effective keywords', () => {
    expect(normalizeEffectiveFilters({ keywords: [' AI'] })).toEqual({ keywords: [' AI'] });
    expect(normalizeEffectiveFilters({ keywords: ['AI'] })).toMatchObject({
      reason: 'invalid_keyword',
    });
  });
  it('normalizes arbitrary recipient hash bits without UUID restrictions', () => {
    expect(
      normalizeEffectiveFilters({ recipient_id: 'ABCDEF12-1234-0000-0000-ABCDEF123456-R' }),
    ).toEqual({ recipient_id: 'abcdef12-1234-0000-0000-abcdef123456-R' });
    expect(normalizeEffectiveFilters({ recipient_id: '' })).toEqual({});
    expect(normalizeEffectiveFilters({ recipient_id: 'not-a-hash' })).toMatchObject({
      reason: 'invalid_recipient_id',
      message: expect.stringContaining('usaspending_search_recipients'),
    });
  });
});

describe('buildFilters', () => {
  it.each([
    'Department of the Interior',
    'U.S. Geological Survey',
    'Office of the Secretary',
    'ZZZ invented agency',
  ])('matches both tiers for %s without a parent restriction', (name) => {
    expect(buildFilters({ agency_name: name }).filters.agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name },
      { type: 'awarding', tier: 'subtier', name },
    ]);
  });
  it('returns empty filters and no time period for null input', () => {
    expect(buildFilters(null)).toEqual({ filters: {}, timePeriod: undefined, codes: {} });
  });

  it('returns empty filters and no time period for undefined input', () => {
    expect(buildFilters(undefined)).toEqual({ filters: {}, timePeriod: undefined, codes: {} });
  });

  it('returns empty filters when all fields are absent', () => {
    expect(buildFilters({})).toEqual({ filters: {}, timePeriod: undefined, codes: {} });
  });

  it('maps keywords array to filters.keywords', () => {
    const { filters } = buildFilters({ keywords: ['cloud', 'defense'] });
    expect(filters.keywords).toEqual(['cloud', 'defense']);
  });

  it('omits keywords when array is empty', () => {
    const { filters } = buildFilters({ keywords: [] });
    expect(filters.keywords).toBeUndefined();
  });

  it('maps award_type_codes to filters.award_type_codes', () => {
    const { filters } = buildFilters({ award_type_codes: ['A', 'B'] });
    expect(filters.award_type_codes).toEqual(['A', 'B']);
  });

  it('omits award_type_codes when array is empty', () => {
    const { filters } = buildFilters({ award_type_codes: [] });
    expect(filters.award_type_codes).toBeUndefined();
  });

  it('maps agency_name to both awarding tiers', () => {
    const { filters } = buildFilters({ agency_name: 'Department of Defense' });
    expect(filters.agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name: 'Department of Defense' },
      { type: 'awarding', tier: 'subtier', name: 'Department of Defense' },
    ]);
  });

  it('omits agencies when agency_name is absent', () => {
    const { filters } = buildFilters({ keywords: ['cloud'] });
    expect(filters.agencies).toBeUndefined();
  });

  it('pairs both funding tiers and composes them with both awarding tiers', () => {
    const funding_agency_name = 'Department of the Navy';
    const funding = [
      { type: 'funding', tier: 'toptier', name: funding_agency_name },
      { type: 'funding', tier: 'subtier', name: funding_agency_name },
    ];
    expect(buildFilters({ funding_agency_name }).filters.agencies).toEqual(funding);
    const agency_name = 'General Services Administration';
    expect(buildFilters({ agency_name, funding_agency_name }).filters.agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name: agency_name },
      { type: 'awarding', tier: 'subtier', name: agency_name },
      ...funding,
    ]);
  });

  it('maps recipient_id to filters.recipient_id', () => {
    const { filters } = buildFilters({ recipient_id: 'abc123-P' });
    expect(filters.recipient_id).toBe('abc123-P');
  });

  it('maps naics_codes array to naics_codes.require', () => {
    const { filters } = buildFilters({ naics_codes: ['541512', '541511'] });
    expect(filters.naics_codes).toEqual({ require: ['541512', '541511'] });
  });

  it('omits naics_codes when array is empty', () => {
    const { filters } = buildFilters({ naics_codes: [] });
    expect(filters.naics_codes).toBeUndefined();
  });

  it('maps time_period_start and time_period_end to time_period array', () => {
    const { filters, timePeriod } = buildFilters({
      time_period_start: '2023-01-01',
      time_period_end: '2023-12-31',
    });
    expect(filters.time_period).toEqual([{ start_date: '2023-01-01', end_date: '2023-12-31' }]);
    expect(timePeriod).toEqual({ start_date: '2023-01-01', end_date: '2023-12-31' });
  });

  it('zero-pads unpadded dates in the time_period it sends', () => {
    const { filters } = buildFilters({
      time_period_start: '2023-1-5',
      time_period_end: '2023-9-3',
    });
    expect(filters.time_period).toEqual([{ start_date: '2023-01-05', end_date: '2023-09-03' }]);
  });

  it('omits time_period when both dates are blank', () => {
    const { filters, timePeriod } = buildFilters({ time_period_start: '', time_period_end: '' });
    expect(filters.time_period).toBeUndefined();
    expect(timePeriod).toBeUndefined();
  });

  describe('half-open ranges (#62)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('closes a lone start at today (UTC) and reports the filled end', () => {
      const { filters, timePeriod } = buildFilters({ time_period_start: '2023-01-01' });
      expect(filters.time_period).toEqual([{ start_date: '2023-01-01', end_date: '2026-09-24' }]);
      expect(timePeriod?.filled).toBe('end_date');
    });

    it('opens a lone end at the 2007-10-01 floor and reports the filled start', () => {
      const { filters, timePeriod } = buildFilters({ time_period_end: '2023-12-31' });
      expect(filters.time_period).toEqual([{ start_date: '2007-10-01', end_date: '2023-12-31' }]);
      expect(timePeriod?.filled).toBe('start_date');
    });
  });

  it('combines multiple fields correctly', () => {
    const { filters } = buildFilters({
      keywords: ['AI'],
      award_type_codes: ['A'],
      agency_name: 'DoD',
      naics_codes: ['541512'],
      time_period_start: '2022-01-01',
      time_period_end: '2022-12-31',
    });
    expect(filters.keywords).toEqual(['AI']);
    expect(filters.award_type_codes).toEqual(['A']);
    expect(filters.agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name: 'DoD' },
      { type: 'awarding', tier: 'subtier', name: 'DoD' },
    ]);
    expect(filters.naics_codes).toEqual({ require: ['541512'] });
    expect(filters.time_period).toEqual([{ start_date: '2022-01-01', end_date: '2022-12-31' }]);
  });

  it('handles single-element keyword array', () => {
    const { filters } = buildFilters({ keywords: ['cybersecurity'] });
    expect(filters.keywords).toEqual(['cybersecurity']);
  });

  it('does not include undefined recipient_id', () => {
    const { filters } = buildFilters({ keywords: ['test'] });
    expect('recipient_id' in filters).toBe(false);
  });

  describe('code filters (#77)', () => {
    it('sends assistance_listings as program_numbers, psc_codes as a list, and def_codes', () => {
      const { filters, codes } = buildFilters({
        assistance_listings: ['15.507', '11.67A'],
        psc_codes: ['Y1NE', 'R4'],
        def_codes: ['Z', 'AAB'],
      });
      expect(filters.program_numbers).toEqual(['15.507', '11.67A']);
      expect(filters.psc_codes).toEqual(['Y1NE', 'R4']);
      expect(filters.def_codes).toEqual(['Z', 'AAB']);
      expect(filters).not.toHaveProperty('assistance_listings');
      expect(codes).toEqual({
        assistance_listings: ['15.507', '11.67A'],
        psc_codes: ['Y1NE', 'R4'],
        def_codes: ['Z', 'AAB'],
      });
    });

    it('uppercases PSC and DEF codes, the only case upstream accepts', () => {
      const { filters, codes } = buildFilters({
        psc_codes: ['y1ne', 'r4'],
        def_codes: ['z', 'aab'],
      });
      expect(filters.psc_codes).toEqual(['Y1NE', 'R4']);
      expect(filters.def_codes).toEqual(['Z', 'AAB']);
      expect(codes).toEqual({ psc_codes: ['Y1NE', 'R4'], def_codes: ['Z', 'AAB'] });
    });

    it('treats an empty list as unset, since upstream 422s on one', () => {
      const { filters, codes } = buildFilters({
        assistance_listings: [],
        psc_codes: [],
        def_codes: [],
      });
      expect(filters).toEqual({});
      expect(codes).toEqual({});
    });
  });
});

describe('analyticsTypeMismatch (#77)', () => {
  const FIELD = 'filters.award_type_codes';

  it('never rejects when no award types are named — every type can match', () => {
    const codes = { assistance_listings: ['15.507'], psc_codes: ['Y1NE'] };
    expect(analyticsTypeMismatch(codes, undefined, FIELD)).toBeUndefined();
    expect(analyticsTypeMismatch(codes, [], FIELD)).toBeUndefined();
  });

  it.each([[['A', 'B', 'C', 'D']], [['IDV_A', 'IDV_E']], [['A', 'IDV_B']]])(
    'rejects listings when every code in %j is a contract or IDV code',
    (types) => {
      expect(analyticsTypeMismatch({ assistance_listings: ['15.507'] }, types, FIELD)).toEqual({
        filter: 'assistance_listings',
        message: `assistance_listings match only assistance awards, but ${FIELD} [${types.join(', ')}] holds only contract and IDV codes, which carry no listings.`,
      });
    },
  );

  it.each([
    [['02', '03', '04', '05']],
    [['06', '10', 'F006']],
    [['07', '08', '09', '11', '-1', 'F010']],
  ])('rejects psc_codes when every code in %j is an assistance code', (types) => {
    expect(analyticsTypeMismatch({ psc_codes: ['Y1NE'] }, types, FIELD)).toEqual({
      filter: 'psc_codes',
      message: `psc_codes match only contracts and IDVs, but ${FIELD} [${types.join(', ')}] holds only assistance codes, which carry no PSC.`,
    });
  });

  it('runs both filters when the award types span both kinds', () => {
    const codes = { assistance_listings: ['15.507'], psc_codes: ['Y1NE'] };
    expect(analyticsTypeMismatch(codes, ['A', '02'], FIELD)).toBeUndefined();
  });

  it('leaves an unrecognized award type code for upstream to judge', () => {
    expect(
      analyticsTypeMismatch({ assistance_listings: ['15.507'] }, ['A', 'ZZ'], FIELD),
    ).toBeUndefined();
    expect(analyticsTypeMismatch({ psc_codes: ['Y1NE'] }, ['02', 'ZZ'], FIELD)).toBeUndefined();
  });

  it('never rejects def_codes, which every award type can carry', () => {
    expect(analyticsTypeMismatch({ def_codes: ['Z'] }, ['A'], FIELD)).toBeUndefined();
    expect(analyticsTypeMismatch({ def_codes: ['Z'] }, ['02'], FIELD)).toBeUndefined();
  });
});

/**
 * One shape per failure branch of `resolveLocation`, with the field each
 * message must name: the offending field, quoted value included when it has one.
 */
const LOCATION_FAILURES = [
  ['a county under a non-USA country', { country: 'CAN', county: '049' }, 'county "049"'],
  ['a FIPS-number state under a non-USA country', { country: 'CAN', state: '35' }, 'state "35"'],
  ['an unknown US state', { state: 'ZZ' }, 'state "ZZ"'],
  ['a state contradicting a territory code', { country: 'PRI', state: 'NM' }, 'state "NM"'],
  ['a 5-digit county with an unknown state prefix', { county: '99049' }, 'county "99049"'],
  [
    'a 5-digit county with an armed-forces state',
    { state: 'AE', county: '35049' },
    'county "35049"',
  ],
  ['a 5-digit county contradicting state', { state: 'NM', county: '06037' }, 'county "06037"'],
  ['a 3-digit county without state', { county: '049' }, 'county "049"'],
  ['a 3-digit county with an armed-forces state', { state: 'AE', county: '049' }, 'county "049"'],
] as const;

describe('resolveLocation field path (#109)', () => {
  it('names location_filter when no field is given, as award search calls it', () => {
    expect(resolveLocation({ county: '049' })).toEqual({
      ok: false,
      message:
        'location_filter.county "049" needs location_filter.state: a 3-digit county code is unique only within its state. Add state, or send the 5-digit state + county code.',
    });
  });

  it.each(LOCATION_FAILURES)(
    'names the given field for %s, never location_filter',
    (_label, location, named) => {
      const result = resolveLocation(location, 'filters.recipient_location');

      expect(result.ok).toBe(false);
      const { message } = result as { message: string };
      expect(message).toContain(`filters.recipient_location.${named}`);
      expect(message).not.toContain('location_filter');
    },
  );
});

describe('location filters (#109)', () => {
  it('declares both keys as strict location objects with their own descriptions', () => {
    const schema = z.toJSONSchema(z.object(LOCATION_FILTER_FIELDS), { io: 'input' }) as {
      properties: Record<
        string,
        { additionalProperties?: boolean; description?: string; properties?: object }
      >;
      required?: string[];
    };
    const pop = schema.properties.place_of_performance_location;
    const recipient = schema.properties.recipient_location;

    expect(schema.required ?? []).toEqual([]);
    for (const field of [pop, recipient]) {
      expect(Object.keys(field?.properties ?? {})).toEqual(['country', 'state', 'county', 'city']);
      expect(field?.additionalProperties).toBe(false);
      expect(field?.description).toContain('usaspending_autocomplete_filters type=location');
    }
    expect(pop?.description).toContain('applied_location');
    expect(recipient?.description).toContain('applied_recipient_location');
    expect(pop?.description).not.toEqual(recipient?.description);
  });

  it('resolves no key to no location', () => {
    expect(resolveLocationFilters({})).toEqual({ ok: true, locations: {} });
  });

  it('normalizes each key as award search normalizes location_filter', () => {
    expect(
      resolveLocationFilters({
        place_of_performance_location: { county: '35049' },
        recipient_location: { country: 'PRI' },
      }),
    ).toEqual({
      ok: true,
      locations: {
        place_of_performance_location: { country: 'USA', state: 'NM', county: '049' },
        recipient_location: { country: 'USA', state: 'PR' },
      },
    });
    expect(resolveLocationFilters({ recipient_location: { state: '53' } })).toEqual({
      ok: true,
      locations: { recipient_location: { country: 'USA', state: 'WA' } },
    });
  });

  it('treats an all-blank object as no filter on either key', () => {
    const blank = { country: '', state: ' ', county: '', city: '' };
    expect(
      resolveLocationFilters({
        place_of_performance_location: blank,
        recipient_location: blank,
      }),
    ).toEqual({ ok: true, locations: {} });
  });

  it.each([
    ['place_of_performance_location', 'recipient_location'],
    ['recipient_location', 'place_of_performance_location'],
  ] as const)('names filters.%s when that key fails, beside a valid %s', (bad, good) => {
    const result = resolveLocationFilters({
      [good]: { state: 'WA' },
      [bad]: { state: 'NM', county: '06037' },
    });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining(`filters.${bad}.county "06037"`),
    });
    expect((result as { message: string }).message).not.toContain('location_filter');
    expect((result as { message: string }).message).not.toContain(good);
  });

  it('writes each location as a one-element upstream list, and nothing when unset', () => {
    const filters: Record<string, unknown> = { keywords: ['bridge'] };
    applyLocationFilters(filters, {});
    expect(filters).toEqual({ keywords: ['bridge'] });

    applyLocationFilters(filters, {
      place_of_performance_location: { country: 'USA', state: 'NM' },
      recipient_location: { country: 'USA', state: 'WA', county: '033' },
    });
    expect(filters).toEqual({
      keywords: ['bridge'],
      place_of_performance_locations: [{ country: 'USA', state: 'NM' }],
      recipient_locations: [{ country: 'USA', state: 'WA', county: '033' }],
    });
  });

  it('echoes and describes each location sent, and nothing when unset', () => {
    const locations = {
      place_of_performance_location: { country: 'USA', state: 'NM', county: '049' },
      recipient_location: { country: 'CAN', state: 'ON', city: 'Ottawa' },
    };
    expect(locationFilterEcho(locations)).toEqual({
      applied_location: 'country=USA, state=NM, county=049',
      applied_recipient_location: 'country=CAN, state=ON, city=Ottawa',
    });
    expect(describeLocationFilters(locations)).toEqual([
      'place_of_performance_location="country=USA, state=NM, county=049"',
      'recipient_location="country=CAN, state=ON, city=Ottawa"',
    ]);
    expect(locationFilterEcho({})).toEqual({});
    expect(describeLocationFilters({})).toEqual([]);
  });
});
