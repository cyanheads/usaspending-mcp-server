/**
 * @fileoverview Unit tests for the shared date helpers: padding, UTC "today",
 * half-range resolution, the filled-bound notice, and the inverted-range message.
 * @module tests/utils/dates.test
 */

import { describe, expect, it } from 'vitest';
import {
  EARLIEST_SEARCH_DATE,
  filledBoundNotice,
  floorViolationMessage,
  invertedRangeMessage,
  padIsoDate,
  resolveDateRange,
  todayUtc,
} from '@/mcp-server/tools/definitions/dates.js';

const TODAY = '2026-09-24';

describe('padIsoDate', () => {
  it.each([
    ['2024-1-1', '2024-01-01'],
    ['2024-01-1', '2024-01-01'],
    ['2024-12-31', '2024-12-31'],
  ])('%s → %s', (input, expected) => {
    expect(padIsoDate(input)).toBe(expected);
  });
});

describe('todayUtc', () => {
  it('reads the UTC calendar date, not the local one', () => {
    // 20:00 on the 24th in US Pacific time is already the 25th in UTC.
    expect(todayUtc(new Date('2026-09-25T03:00:00Z'))).toBe('2026-09-25');
  });
});

describe('resolveDateRange', () => {
  it('returns undefined when neither end is supplied', () => {
    expect(resolveDateRange(undefined, undefined, TODAY)).toBeUndefined();
  });

  it('passes a two-ended range through padded, with nothing filled', () => {
    expect(resolveDateRange('2020-2-1', '2021-3-4', TODAY)).toEqual({
      start_date: '2020-02-01',
      end_date: '2021-03-04',
    });
  });

  it('fills a lone start through today', () => {
    expect(resolveDateRange('2020-01-01', undefined, TODAY)).toEqual({
      start_date: '2020-01-01',
      end_date: TODAY,
      filled: 'end_date',
    });
  });

  it('closes a lone start after today on itself rather than inverting', () => {
    expect(resolveDateRange('2027-01-01', undefined, TODAY)).toMatchObject({
      start_date: '2027-01-01',
      end_date: '2027-01-01',
    });
  });

  it('fills a lone end from the floor', () => {
    expect(resolveDateRange(undefined, '2010-06-30', TODAY)).toEqual({
      start_date: EARLIEST_SEARCH_DATE,
      end_date: '2010-06-30',
      filled: 'start_date',
    });
  });

  it('opens a lone end before the floor on itself, leaving the floor rejection to the caller', () => {
    expect(resolveDateRange(undefined, '2005-1-1', TODAY)).toEqual({
      start_date: '2005-01-01',
      end_date: '2005-01-01',
      filled: 'start_date',
    });
  });
});

describe('filledBoundNotice', () => {
  const NESTED = { start: 'filters.time_period_start', end: 'filters.time_period_end' };
  const FLAT = { start: 'time_period.start_date', end: 'time_period.end_date' };

  it('is undefined when nothing was filled', () => {
    expect(filledBoundNotice(undefined, NESTED)).toBeUndefined();
    expect(
      filledBoundNotice({ start_date: '2020-01-01', end_date: '2020-12-31' }, NESTED),
    ).toBeUndefined();
  });

  it('names the filled end and says it is today in UTC', () => {
    expect(
      filledBoundNotice({ start_date: '2020-01-01', end_date: TODAY, filled: 'end_date' }, NESTED),
    ).toBe(
      `filters.time_period_end was not supplied, so the range runs from 2020-01-01 through ${TODAY} — today (UTC).`,
    );
  });

  it('names the filled start and says it is the floor', () => {
    expect(
      filledBoundNotice(
        { start_date: '2007-10-01', end_date: '2010-06-30', filled: 'start_date' },
        NESTED,
      ),
    ).toBe(
      'filters.time_period_start was not supplied, so the range runs from 2007-10-01 — the earliest date this endpoint searches — through 2010-06-30.',
    );
  });

  it('names whichever field path it is given', () => {
    expect(
      filledBoundNotice({ start_date: '2020-01-01', end_date: TODAY, filled: 'end_date' }, FLAT),
    ).toMatch(/^time_period\.end_date was not supplied/);
    expect(
      filledBoundNotice(
        { start_date: '2007-10-01', end_date: '2010-06-30', filled: 'start_date' },
        FLAT,
      ),
    ).toMatch(/^time_period\.start_date was not supplied/);
  });
});

describe('floorViolationMessage', () => {
  it('is undefined for no range and a start on or after the floor', () => {
    expect(floorViolationMessage(undefined)).toBeUndefined();
    expect(
      floorViolationMessage({ start_date: EARLIEST_SEARCH_DATE, end_date: '2008-01-01' }),
    ).toBeUndefined();
  });

  it('names a supplied start before the floor', () => {
    expect(floorViolationMessage({ start_date: '2005-01-01', end_date: '2010-01-01' })).toBe(
      'Start date 2005-01-01 precedes 2007-10-01, the earliest date this endpoint can search.',
    );
  });

  it('names a lone end before the floor as the end date', () => {
    expect(floorViolationMessage(resolveDateRange(undefined, '2005-6-30', TODAY))).toBe(
      'End date 2005-06-30 precedes 2007-10-01, the earliest date this endpoint can search.',
    );
  });
});

describe('invertedRangeMessage', () => {
  const FIELDS = { start: 'filters.time_period_start', end: 'filters.time_period_end' };

  it('is undefined for no range, an ordered range, and equal ends', () => {
    expect(invertedRangeMessage(undefined, FIELDS)).toBeUndefined();
    expect(
      invertedRangeMessage({ start_date: '2024-01-01', end_date: '2024-12-31' }, FIELDS),
    ).toBeUndefined();
    expect(
      invertedRangeMessage({ start_date: '2024-06-15', end_date: '2024-06-15' }, FIELDS),
    ).toBeUndefined();
  });

  it('names both fields with their dates and says to swap them', () => {
    expect(invertedRangeMessage({ start_date: '2024-12-31', end_date: '2024-01-01' }, FIELDS)).toBe(
      'filters.time_period_start (2024-12-31) falls after filters.time_period_end (2024-01-01). Swap the two dates so the range starts on or before it ends.',
    );
  });

  it('never fires on a half range resolveDateRange filled', () => {
    for (const range of [
      resolveDateRange('2027-01-01', undefined, TODAY),
      resolveDateRange(undefined, '2005-01-01', TODAY),
      resolveDateRange('2020-01-01', undefined, TODAY),
      resolveDateRange(undefined, '2010-06-30', TODAY),
    ]) {
      expect(invertedRangeMessage(range, FIELDS)).toBeUndefined();
    }
  });
});
