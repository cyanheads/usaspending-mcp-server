/**
 * @fileoverview Unit tests for the shared buildFilters utility.
 * @module tests/utils/filters.test
 */

import { describe, expect, it } from 'vitest';
import { buildFilters } from '@/mcp-server/tools/definitions/filters.js';

describe('buildFilters', () => {
  it('returns empty object for null input', () => {
    expect(buildFilters(null)).toEqual({});
  });

  it('returns empty object for undefined input', () => {
    expect(buildFilters(undefined)).toEqual({});
  });

  it('returns empty object when all fields are absent', () => {
    expect(buildFilters({})).toEqual({});
  });

  it('maps keywords array to filters.keywords', () => {
    const result = buildFilters({ keywords: ['cloud', 'defense'] });
    expect(result.keywords).toEqual(['cloud', 'defense']);
  });

  it('omits keywords when array is empty', () => {
    const result = buildFilters({ keywords: [] });
    expect(result.keywords).toBeUndefined();
  });

  it('maps award_type_codes to filters.award_type_codes', () => {
    const result = buildFilters({ award_type_codes: ['A', 'B'] });
    expect(result.award_type_codes).toEqual(['A', 'B']);
  });

  it('omits award_type_codes when array is empty', () => {
    const result = buildFilters({ award_type_codes: [] });
    expect(result.award_type_codes).toBeUndefined();
  });

  it('maps agency_name to agencies filter with awarding toptier structure', () => {
    const result = buildFilters({ agency_name: 'Department of Defense' });
    expect(result.agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name: 'Department of Defense' },
    ]);
  });

  it('omits agencies when agency_name is absent', () => {
    const result = buildFilters({ keywords: ['cloud'] });
    expect(result.agencies).toBeUndefined();
  });

  it('maps recipient_id to filters.recipient_id', () => {
    const result = buildFilters({ recipient_id: 'abc123-P' });
    expect(result.recipient_id).toBe('abc123-P');
  });

  it('maps naics_codes array to naics_codes.require', () => {
    const result = buildFilters({ naics_codes: ['541512', '541511'] });
    expect(result.naics_codes).toEqual({ require: ['541512', '541511'] });
  });

  it('omits naics_codes when array is empty', () => {
    const result = buildFilters({ naics_codes: [] });
    expect(result.naics_codes).toBeUndefined();
  });

  it('maps time_period_start and time_period_end to time_period array', () => {
    const result = buildFilters({
      time_period_start: '2023-01-01',
      time_period_end: '2023-12-31',
    });
    expect(result.time_period).toEqual([{ start_date: '2023-01-01', end_date: '2023-12-31' }]);
  });

  it('omits time_period when only start_date is provided', () => {
    const result = buildFilters({ time_period_start: '2023-01-01' });
    expect(result.time_period).toBeUndefined();
  });

  it('omits time_period when only end_date is provided', () => {
    const result = buildFilters({ time_period_end: '2023-12-31' });
    expect(result.time_period).toBeUndefined();
  });

  it('combines multiple fields correctly', () => {
    const result = buildFilters({
      keywords: ['AI'],
      award_type_codes: ['A'],
      agency_name: 'DoD',
      naics_codes: ['541512'],
      time_period_start: '2022-01-01',
      time_period_end: '2022-12-31',
    });
    expect(result.keywords).toEqual(['AI']);
    expect(result.award_type_codes).toEqual(['A']);
    expect(result.agencies).toEqual([{ type: 'awarding', tier: 'toptier', name: 'DoD' }]);
    expect(result.naics_codes).toEqual({ require: ['541512'] });
    expect(result.time_period).toEqual([{ start_date: '2022-01-01', end_date: '2022-12-31' }]);
  });

  it('handles single-element keyword array', () => {
    const result = buildFilters({ keywords: ['cybersecurity'] });
    expect(result.keywords).toEqual(['cybersecurity']);
  });

  it('does not include undefined recipient_id', () => {
    const result = buildFilters({ keywords: ['test'] });
    expect('recipient_id' in result).toBe(false);
  });
});
