/**
 * @fileoverview Date inputs shared by the award search and spending analytics
 * tools: the advertised `YYYY-MM-DD` schemas, zero-padding, the searchable
 * floor, and resolution of a half-open range into the two-ended range the
 * endpoints require.
 * @module mcp-server/tools/definitions/dates
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * Earliest date `search/spending_by_award/`, `search/spending_by_category/`,
 * `search/spending_by_geography/`, and `search/spending_over_time/` accept —
 * each answers an earlier start with a 422 naming this date.
 */
export const EARLIEST_SEARCH_DATE = '2007-10-01';

/**
 * Year, month, day. Month and day may be unpadded (`2024-1-1`): the analytics
 * endpoints accept that form but `search/spending_by_award/` answers it with an
 * empty-bodied 503, so every handler pads before sending ({@link padIsoDate}).
 * A calendar-impossible date (`2024-02-30`) passes and is left to upstream,
 * whose 4xx names the field.
 */
export const ISO_DATE_PATTERN = /^\d{4}-\d{1,2}-\d{1,2}$/;

const DATE_FORMAT_MESSAGE = 'Expected a date as YYYY-MM-DD (e.g. 2024-01-31)';

/**
 * A date input that also accepts `""` — what form-based clients send for an
 * untouched field — as "no date". The union follows the form-client convention:
 * the advertised schema is `anyOf ["", pattern]`, so a client that validates
 * before calling accepts the blank and still sees the `YYYY-MM-DD` pattern.
 * A whitespace-only value is read as blank too — before the pattern existed a
 * lone one was dropped like any blank — while a whitespace-padded date fails
 * the pattern. Handlers read a blank as absent. The preprocess wrapper leaves
 * the `anyOf` in the advertised schema.
 */
export function blankableIsoDate(description: string) {
  return z
    .preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? '' : value),
      z.union([
        z.literal(''),
        z
          .string()
          .regex(ISO_DATE_PATTERN, DATE_FORMAT_MESSAGE)
          .describe('Date as YYYY-MM-DD; month and day may be unpadded'),
      ]),
    )
    .describe(description);
}

/** An optional {@link blankableIsoDate}: omitted and `""` both mean no date. */
export function optionalIsoDate(description: string) {
  return blankableIsoDate(description).optional();
}

/** Zero-pads month and day of a pattern-valid date: `2024-1-1` → `2024-01-01`. */
export function padIsoDate(date: string): string {
  const [year, month = '', day = ''] = date.split('-');
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Today's date in UTC. UTC keeps the fill independent of where the server runs;
 * when UTC is already a day ahead of US time the date is in the future there,
 * which the endpoints accept.
 */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** A two-ended range as sent upstream, and which end (if any) was filled in. */
export interface DateRange {
  end_date: string;
  filled?: 'start_date' | 'end_date';
  start_date: string;
}

/**
 * Resolves optional start and end dates into the two-ended range the endpoints
 * require, padding both. A lone start runs through today (UTC); a lone end runs
 * from {@link EARLIEST_SEARCH_DATE}. The filled end never inverts the range — an
 * inverted range draws an HTML 500 from the analytics endpoints — so a lone
 * start after today closes on itself, and a lone end before the floor opens on
 * itself (which the endpoints then reject for preceding the floor).
 *
 * @returns `undefined` when neither end is supplied.
 */
export function resolveDateRange(
  start: string | undefined,
  end: string | undefined,
  today: string = todayUtc(),
): DateRange | undefined {
  const startDate = start ? padIsoDate(start) : undefined;
  const endDate = end ? padIsoDate(end) : undefined;
  if (startDate && endDate) return { start_date: startDate, end_date: endDate };
  if (startDate) {
    return {
      start_date: startDate,
      end_date: startDate > today ? startDate : today,
      filled: 'end_date',
    };
  }
  if (endDate) {
    return {
      start_date: endDate < EARLIEST_SEARCH_DATE ? endDate : EARLIEST_SEARCH_DATE,
      end_date: endDate,
      filled: 'start_date',
    };
  }
  return;
}

/** The two input paths a tool reads a range's start and end from. */
export interface DateFields {
  end: string;
  start: string;
}

/** The input paths that carry the date range on the spending analytics tools. */
export const ANALYTICS_DATE_FIELDS = {
  start: 'filters.time_period_start',
  end: 'filters.time_period_end',
} as const satisfies DateFields;

/**
 * The rejection message for a range whose start falls after its end, naming the
 * two input fields that carried them and telling the caller to swap them — or
 * `undefined` when the range is ordered, has equal ends, or is absent. Padded
 * dates order correctly as strings. A half range {@link resolveDateRange}
 * filled never inverts, so only a range supplied with both ends can fail here.
 * Upstream answers an inverted range with an HTML 500 on the analytics
 * endpoints and by ignoring it on `search/spending_by_award/`, so callers check
 * before any request.
 */
export function invertedRangeMessage(
  range: DateRange | undefined,
  fields: DateFields,
): string | undefined {
  if (!range || range.start_date <= range.end_date) return;
  return `${fields.start} (${range.start_date}) falls after ${fields.end} (${range.end_date}). Swap the two dates so the range starts on or before it ends.`;
}

/**
 * The rejection message for a range starting before {@link EARLIEST_SEARCH_DATE},
 * or `undefined` when it starts on or after it. Every search endpoint answers
 * such a start with its own 422, so callers check before any request. A lone end
 * before the floor opens the range on itself, so it is named as the end date.
 */
export function floorViolationMessage(range: DateRange | undefined): string | undefined {
  if (!range || range.start_date >= EARLIEST_SEARCH_DATE) return;
  const [bound, date] =
    range.filled === 'start_date' ? ['End', range.end_date] : ['Start', range.start_date];
  return `${bound} date ${date} precedes ${EARLIEST_SEARCH_DATE}, the earliest date this endpoint can search.`;
}

/**
 * The notice disclosing which bound {@link resolveDateRange} filled, naming the
 * input field (from `fields`) the caller omitted and the date used for it.
 * `undefined` when both ends were supplied or no range applies.
 */
export function filledBoundNotice(
  range: DateRange | undefined,
  fields: DateFields,
): string | undefined {
  if (range?.filled === 'end_date') {
    const why =
      range.end_date === range.start_date
        ? 'the start date itself, since it falls after today (UTC)'
        : 'today (UTC)';
    return `${fields.end} was not supplied, so the range runs from ${range.start_date} through ${range.end_date} — ${why}.`;
  }
  if (range?.filled === 'start_date') {
    const why =
      range.start_date === EARLIEST_SEARCH_DATE
        ? 'the earliest date this endpoint searches'
        : 'the end date itself';
    return `${fields.start} was not supplied, so the range runs from ${range.start_date} — ${why} — through ${range.end_date}.`;
  }
  return;
}
