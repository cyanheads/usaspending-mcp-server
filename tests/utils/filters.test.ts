/**
 * @fileoverview Unit tests for the shared buildFilters utility.
 * @module tests/utils/filters.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyticsTypeMismatch, buildFilters } from '@/mcp-server/tools/definitions/filters.js';

describe('buildFilters', () => {
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

  it('maps agency_name to agencies filter with awarding toptier structure', () => {
    const { filters } = buildFilters({ agency_name: 'Department of Defense' });
    expect(filters.agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name: 'Department of Defense' },
    ]);
  });

  it('omits agencies when agency_name is absent', () => {
    const { filters } = buildFilters({ keywords: ['cloud'] });
    expect(filters.agencies).toBeUndefined();
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
    expect(filters.agencies).toEqual([{ type: 'awarding', tier: 'toptier', name: 'DoD' }]);
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
