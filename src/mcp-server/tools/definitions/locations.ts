/**
 * @fileoverview Location inputs — `usaspending_search_awards` `location_filter`
 * and the place-of-performance and recipient location filters every
 * filter-taking search and analytics tool shares: the advertised code schemas,
 * the US state/territory postal ↔ FIPS table, and resolution of a caller's
 * location into the shape USAspending's location filters match.
 * @module mcp-server/tools/definitions/locations
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * Every place with a two-digit FIPS code that a US `state` can name, by postal
 * code: the 50 states, DC, the five inhabited territories, the freely
 * associated states (FM, MH, PW), and the U.S. Minor Outlying Islands (UM).
 * Upstream records each as a state under country USA. `upstreamName` is how
 * `autocomplete/location/` spells the place in its state rows — uppercase, and
 * its own spelling (`U.S. VIRGIN ISLANDS`); null for FM, MH, PW, and UM, which
 * it returns no state row for.
 */
const STATES = {
  AL: { fips: '01', upstreamName: 'ALABAMA' },
  AK: { fips: '02', upstreamName: 'ALASKA' },
  AZ: { fips: '04', upstreamName: 'ARIZONA' },
  AR: { fips: '05', upstreamName: 'ARKANSAS' },
  CA: { fips: '06', upstreamName: 'CALIFORNIA' },
  CO: { fips: '08', upstreamName: 'COLORADO' },
  CT: { fips: '09', upstreamName: 'CONNECTICUT' },
  DE: { fips: '10', upstreamName: 'DELAWARE' },
  DC: { fips: '11', upstreamName: 'DISTRICT OF COLUMBIA' },
  FL: { fips: '12', upstreamName: 'FLORIDA' },
  GA: { fips: '13', upstreamName: 'GEORGIA' },
  HI: { fips: '15', upstreamName: 'HAWAII' },
  ID: { fips: '16', upstreamName: 'IDAHO' },
  IL: { fips: '17', upstreamName: 'ILLINOIS' },
  IN: { fips: '18', upstreamName: 'INDIANA' },
  IA: { fips: '19', upstreamName: 'IOWA' },
  KS: { fips: '20', upstreamName: 'KANSAS' },
  KY: { fips: '21', upstreamName: 'KENTUCKY' },
  LA: { fips: '22', upstreamName: 'LOUISIANA' },
  ME: { fips: '23', upstreamName: 'MAINE' },
  MD: { fips: '24', upstreamName: 'MARYLAND' },
  MA: { fips: '25', upstreamName: 'MASSACHUSETTS' },
  MI: { fips: '26', upstreamName: 'MICHIGAN' },
  MN: { fips: '27', upstreamName: 'MINNESOTA' },
  MS: { fips: '28', upstreamName: 'MISSISSIPPI' },
  MO: { fips: '29', upstreamName: 'MISSOURI' },
  MT: { fips: '30', upstreamName: 'MONTANA' },
  NE: { fips: '31', upstreamName: 'NEBRASKA' },
  NV: { fips: '32', upstreamName: 'NEVADA' },
  NH: { fips: '33', upstreamName: 'NEW HAMPSHIRE' },
  NJ: { fips: '34', upstreamName: 'NEW JERSEY' },
  NM: { fips: '35', upstreamName: 'NEW MEXICO' },
  NY: { fips: '36', upstreamName: 'NEW YORK' },
  NC: { fips: '37', upstreamName: 'NORTH CAROLINA' },
  ND: { fips: '38', upstreamName: 'NORTH DAKOTA' },
  OH: { fips: '39', upstreamName: 'OHIO' },
  OK: { fips: '40', upstreamName: 'OKLAHOMA' },
  OR: { fips: '41', upstreamName: 'OREGON' },
  PA: { fips: '42', upstreamName: 'PENNSYLVANIA' },
  RI: { fips: '44', upstreamName: 'RHODE ISLAND' },
  SC: { fips: '45', upstreamName: 'SOUTH CAROLINA' },
  SD: { fips: '46', upstreamName: 'SOUTH DAKOTA' },
  TN: { fips: '47', upstreamName: 'TENNESSEE' },
  TX: { fips: '48', upstreamName: 'TEXAS' },
  UT: { fips: '49', upstreamName: 'UTAH' },
  VT: { fips: '50', upstreamName: 'VERMONT' },
  VA: { fips: '51', upstreamName: 'VIRGINIA' },
  WA: { fips: '53', upstreamName: 'WASHINGTON' },
  WV: { fips: '54', upstreamName: 'WEST VIRGINIA' },
  WI: { fips: '55', upstreamName: 'WISCONSIN' },
  WY: { fips: '56', upstreamName: 'WYOMING' },
  AS: { fips: '60', upstreamName: 'AMERICAN SAMOA' },
  GU: { fips: '66', upstreamName: 'GUAM' },
  MP: { fips: '69', upstreamName: 'NORTHERN MARIANA ISLANDS' },
  PR: { fips: '72', upstreamName: 'PUERTO RICO' },
  VI: { fips: '78', upstreamName: 'U.S. VIRGIN ISLANDS' },
  FM: { fips: '64', upstreamName: null },
  MH: { fips: '68', upstreamName: null },
  PW: { fips: '70', upstreamName: null },
  UM: { fips: '74', upstreamName: null },
} as const satisfies Record<string, { fips: string; upstreamName: string | null }>;

const STATE_FIPS = Object.fromEntries(
  Object.entries(STATES).map(([postal, { fips }]) => [postal, fips]),
) as Record<keyof typeof STATES, string>;

const POSTAL_BY_FIPS: Record<string, string> = Object.fromEntries(
  Object.entries(STATES).map(([postal, { fips }]) => [fips, postal]),
);

const POSTAL_BY_UPSTREAM_NAME = new Map<string, string>(
  Object.entries(STATES).flatMap(([postal, { upstreamName }]) =>
    upstreamName ? [[upstreamName, postal] as const] : [],
  ),
);

/** The postal code of an `autocomplete/location/` state row's `state_name`; undefined for a name the table lacks. */
export function postalForUpstreamStateName(name: string): string | undefined {
  return POSTAL_BY_UPSTREAM_NAME.get(name);
}

/** The postal code a two-digit state FIPS code stands for; undefined for one the table lacks. */
export function postalForStateFips(fips: string): string | undefined {
  return Object.hasOwn(POSTAL_BY_FIPS, fips) ? POSTAL_BY_FIPS[fips] : undefined;
}

/** The two-digit FIPS code of a postal code; undefined for one the table lacks, armed-forces codes included. */
export function stateFipsForPostal(postal: string): string | undefined {
  return Object.hasOwn(STATE_FIPS, postal) ? STATE_FIPS[postal as keyof typeof STATES] : undefined;
}

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

/**
 * The `location_filter` object of `usaspending_search_awards`, and the object
 * each location key in `filters` takes under its own description.
 */
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
    'Filter by place of performance. Takes codes, not place names — resolve a state or county name to its code with usaspending_autocomplete_filters type=location. Blank fields are ignored, and an all-blank object is no location filter. The location sent is echoed as applied_location.',
  );

/** A location as USAspending's `place_of_performance_locations` and `recipient_locations` match it. */
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
 * another country, or parts that name different states — come back as a
 * message naming the offending field under `field`, the input path the
 * location came from, and the form it accepts.
 */
export function resolveLocation(
  input?: z.infer<typeof LocationFilterSchema>,
  field = 'location_filter',
): LocationResolution {
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
        `${field}.county "${countyIn}" is a US county FIPS code, but ${field}.country is ${country}. Drop county, or set country to USA.`,
      );
    }
    if (stateIn && /^\d{2}$/.test(stateIn)) {
      return fail(
        `${field}.state "${stateIn}" is a US state FIPS code, but ${field}.country is ${country}. Send ${country}'s own 2-letter subdivision code as state, or set country to USA.`,
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
        `${field}.state "${stateIn}" is not a US state, DC, territory, freely associated state, or armed-forces code. Send its 2-letter postal code (NM) or 2-digit FIPS code (35).`,
      );
    }
  }
  if (territory) {
    if (state && state !== territory) {
      return fail(
        `${field}.state "${stateIn}" contradicts ${field}.country ${countryIn}, which is sent as country USA with state ${territory}. Drop state, or send ${territory}.`,
      );
    }
    state = territory;
  }

  let county: string | undefined;
  if (countyIn?.length === 5) {
    const prefixState = POSTAL_BY_FIPS[countyIn.slice(0, 2)];
    if (!prefixState) {
      return fail(
        `${field}.county "${countyIn}" starts with ${countyIn.slice(0, 2)}, which is not the FIPS code of a US state, DC, or territory. Send the 5-digit state + county code, or the 3-digit county code with state.`,
      );
    }
    if (state && ARMED_FORCES_STATES.has(state)) {
      return fail(
        `${field}.county "${countyIn}" lies in ${prefixState} (FIPS ${countyIn.slice(0, 2)}), but the state is ${state}, an armed-forces code with no FIPS code. Drop county, or drop state to search that county in ${prefixState}.`,
      );
    }
    if (state && state !== prefixState) {
      return fail(
        `${field}.county "${countyIn}" lies in ${prefixState} (FIPS ${countyIn.slice(0, 2)}), but the state is ${state}. Send a county in ${state}: its 3-digit code, or a 5-digit code starting ${STATE_FIPS[state as keyof typeof STATE_FIPS]}.`,
      );
    }
    state = prefixState;
    county = countyIn.slice(2);
  } else if (countyIn) {
    if (!state) {
      return fail(
        `${field}.county "${countyIn}" needs ${field}.state: a 3-digit county code is unique only within its state. Add state, or send the 5-digit state + county code.`,
      );
    }
    if (ARMED_FORCES_STATES.has(state)) {
      return fail(
        `${field}.county "${countyIn}" cannot be sent with state ${state}, an armed-forces code with no counties. Drop county, or send a US state with it.`,
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
