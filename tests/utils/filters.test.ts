/**
 * @fileoverview Unit tests for the shared buildFilters utility.
 * @module tests/utils/filters.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFilters } from '@/mcp-server/tools/definitions/filters.js';

describe('buildFilters', () => {
  it('returns empty filters and no time period for null input', () => {
    expect(buildFilters(null)).toEqual({ filters: {}, timePeriod: undefined });
  });

  it('returns empty filters and no time period for undefined input', () => {
    expect(buildFilters(undefined)).toEqual({ filters: {}, timePeriod: undefined });
  });

  it('returns empty filters when all fields are absent', () => {
    expect(buildFilters({})).toEqual({ filters: {}, timePeriod: undefined });
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
});
