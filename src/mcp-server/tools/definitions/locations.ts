/**
 * @fileoverview Location inputs for `usaspending_search_awards`: the advertised
 * code schemas, the US state/territory postal ↔ FIPS table, and resolution of a
 * caller's location into the shape `search/spending_by_award/` matches.
 * @module mcp-server/tools/definitions/locations
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * Two-digit FIPS code of every place with one that a US `state` can name: the
 * 50 states, DC, the five inhabited territories, the freely associated states
 * (FM, MH, PW), and the U.S. Minor Outlying Islands (UM). Upstream records
 * each as a state under country USA.
 */
const STATE_FIPS = {
  AL: '01',
  AK: '02',
  AZ: '04',
  AR: '05',
  CA: '06',
  CO: '08',
  CT: '09',
  DE: '10',
  DC: '11',
  FL: '12',
  GA: '13',
  HI: '15',
  ID: '16',
  IL: '17',
  IN: '18',
  IA: '19',
  KS: '20',
  KY: '21',
  LA: '22',
  ME: '23',
  MD: '24',
  MA: '25',
  MI: '26',
  MN: '27',
  MS: '28',
  MO: '29',
  MT: '30',
  NE: '31',
  NV: '32',
  NH: '33',
  NJ: '34',
  NM: '35',
  NY: '36',
  NC: '37',
  ND: '38',
  OH: '39',
  OK: '40',
  OR: '41',
  PA: '42',
  RI: '44',
  SC: '45',
  SD: '46',
  TN: '47',
  TX: '48',
  UT: '49',
  VT: '50',
  VA: '51',
  WA: '53',
  WV: '54',
  WI: '55',
  WY: '56',
  AS: '60',
  GU: '66',
  MP: '69',
  PR: '72',
  VI: '78',
  FM: '64',
  MH: '68',
  PW: '70',
  UM: '74',
} as const satisfies Record<string, string>;

const POSTAL_BY_FIPS: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_FIPS).map(([postal, fips]) => [fips, postal]),
);

/**
 * Armed-forces postal codes (Americas, Europe, Pacific). Upstream records them
 * as states under country USA; they have no FIPS code, so no 5-digit county.
 */
const ARMED_FORCES_STATES = new Set(['AA', 'AE', 'AP']);

/**
 * Territories by their ISO 3166-1 alpha-3 code. Upstream records them as
 * country USA with the territory's postal code as state, so the ISO code
 * alone matches nothing.
 */
const TERRITORY_STATES: Record<string, string> = {
  PRI: 'PR',
  GUM: 'GU',
  VIR: 'VI',
  ASM: 'AS',
  MNP: 'MP',
};

/**
 * A code input that also accepts `""` — what form-based clients send for an
 * untouched field — as unset, advertised as `anyOf ["", pattern]`. A
 * whitespace-only value reads as blank; a whitespace-padded code fails the
 * pattern.
 */
function blankableCode(pattern: RegExp, message: string, description: string) {
  return z
    .preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? '' : value),
      z.union([z.literal(''), z.string().regex(pattern, message)]),
    )
    .describe(description)
    .optional();
}

/** The `location_filter` object of `usaspending_search_awards`. */
export const LocationFilterSchema = z
  .object({
    country: blankableCode(
      /^[A-Za-z]{3}$/,
      'Expected a 3-letter ISO 3166-1 alpha-3 country code (e.g. USA)',
      'ISO 3166-1 alpha-3 country code (e.g., USA); USA when omitted. A US territory code — PRI, GUM, VIR, ASM, MNP — is sent as USA with the territory as state.',
    ),
    state: blankableCode(
      /^(?:[A-Za-z]{2}|\d{2})$/,
      'Expected a 2-letter US postal code (e.g. NM) or a 2-digit state FIPS code (e.g. 35)',
      "Under USA (the default): a US state, DC, territory, freely associated state, or armed-forces code as a 2-letter postal code (NM, PR, FM, AE) or 2-digit FIPS code (35). Under another country: that country's own 2-letter subdivision code (ON with CAN).",
    ),
    county: blankableCode(
      /^(?:\d{3}|\d{5})$/,
      'Expected a county FIPS code: 3 digits with state (e.g. 049) or 5 digits (e.g. 35049)',
      'US county FIPS code: 3 digits with state (049 with state NM), or the 5-digit state + county code (35049, Santa Fe County, NM), whose first two digits set the state — the form usaspending_spending_by_geography county rows carry as shape_code.',
    ),
    city: z.string().optional().describe('City name'),
  })
  .strict()
  .optional()
  .describe(
    'Filter by place of performance. Takes codes, not place names — use a geocoding server to resolve names to codes first. Blank fields are ignored, and an all-blank object is no location filter. The location sent is echoed as applied_location.',
  );

/** A location as `search/spending_by_award/` matches it. */
export interface SentLocation {
  city?: string;
  country: string;
  county?: string;
  state?: string;
}

/** The resolved location, `undefined` when every field is blank, or why it cannot be sent. */
export type LocationResolution =
  | { location: SentLocation | undefined; ok: true }
  | { message: string; ok: false };

const fail = (message: string): LocationResolution => ({ ok: false, message });

/**
 * Resolves a caller's location into the shape upstream matches: country
 * defaults to USA, a territory code becomes USA plus its postal state, a FIPS
 * state becomes its postal code, and a 5-digit county splits into state and
 * the 3-digit county code. Under another country, a letter state is that
 * country's own subdivision code and passes through. Shapes that would draw
 * upstream's 422 or an empty page — an unknown US state, a county without a
 * state or under an armed-forces code, a county or FIPS-number state under
 * another country, or parts that
 * name different states — come back as a message naming the field and the form
 * it accepts.
 */
export function resolveLocation(input?: z.infer<typeof LocationFilterSchema>): LocationResolution {
  const read = (value: string | undefined) => value?.trim() || undefined;
  const countryIn = read(input?.country)?.toUpperCase();
  const stateIn = read(input?.state)?.toUpperCase();
  const countyIn = read(input?.county);
  const city = read(input?.city);
  if (!countryIn && !stateIn && !countyIn && !city) return { ok: true, location: undefined };

  const territory = countryIn ? TERRITORY_STATES[countryIn] : undefined;
  const country = territory || !countryIn ? 'USA' : countryIn;

  if (country !== 'USA') {
    if (countyIn) {
      return fail(
        `location_filter.county "${countyIn}" is a US county FIPS code, but location_filter.country is ${country}. Drop county, or set country to USA.`,
      );
    }
    if (stateIn && /^\d{2}$/.test(stateIn)) {
      return fail(
        `location_filter.state "${stateIn}" is a US state FIPS code, but location_filter.country is ${country}. Send ${country}'s own 2-letter subdivision code as state, or set country to USA.`,
      );
    }
    return {
      ok: true,
      location: { country, ...(stateIn ? { state: stateIn } : {}), ...(city ? { city } : {}) },
    };
  }

  let state: string | undefined;
  if (stateIn) {
    state =
      stateIn in STATE_FIPS || ARMED_FORCES_STATES.has(stateIn) ? stateIn : POSTAL_BY_FIPS[stateIn];
    if (!state) {
      return fail(
        `location_filter.state "${stateIn}" is not a US state, DC, territory, freely associated state, or armed-forces code. Send its 2-letter postal code (NM) or 2-digit FIPS code (35).`,
      );
    }
  }
  if (territory) {
    if (state && state !== territory) {
      return fail(
        `location_filter.state "${stateIn}" contradicts location_filter.country ${countryIn}, which is sent as country USA with state ${territory}. Drop state, or send ${territory}.`,
      );
    }
    state = territory;
  }

  let county: string | undefined;
  if (countyIn?.length === 5) {
    const prefixState = POSTAL_BY_FIPS[countyIn.slice(0, 2)];
    if (!prefixState) {
      return fail(
        `location_filter.county "${countyIn}" starts with ${countyIn.slice(0, 2)}, which is not the FIPS code of a US state, DC, or territory. Send the 5-digit state + county code, or the 3-digit county code with state.`,
      );
    }
    if (state && ARMED_FORCES_STATES.has(state)) {
      return fail(
        `location_filter.county "${countyIn}" lies in ${prefixState} (FIPS ${countyIn.slice(0, 2)}), but the state is ${state}, an armed-forces code with no FIPS code. Drop county, or drop state to search that county in ${prefixState}.`,
      );
    }
    if (state && state !== prefixState) {
      return fail(
        `location_filter.county "${countyIn}" lies in ${prefixState} (FIPS ${countyIn.slice(0, 2)}), but the state is ${state}. Send a county in ${state}: its 3-digit code, or a 5-digit code starting ${STATE_FIPS[state as keyof typeof STATE_FIPS]}.`,
      );
    }
    state = prefixState;
    county = countyIn.slice(2);
  } else if (countyIn) {
    if (!state) {
      return fail(
        `location_filter.county "${countyIn}" needs location_filter.state: a 3-digit county code is unique only within its state. Add state, or send the 5-digit state + county code.`,
      );
    }
    if (ARMED_FORCES_STATES.has(state)) {
      return fail(
        `location_filter.county "${countyIn}" cannot be sent with state ${state}, an armed-forces code with no counties. Drop county, or send a US state with it.`,
      );
    }
    county = countyIn;
  }

  return {
    ok: true,
    location: {
      country,
      ...(state ? { state } : {}),
      ...(county ? { county } : {}),
      ...(city ? { city } : {}),
    },
  };
}

/** The location as sent, for echoes and notices: `country=USA, state=NM, county=049`. */
export function describeLocation(location: SentLocation): string {
  return Object.entries(location)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}
