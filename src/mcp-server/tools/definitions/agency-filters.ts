/**
 * @fileoverview Resolve spending agency names and apply both agency tiers per role.
 * @module mcp-server/tools/definitions/agency-filters
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { USASpendingService } from '@/services/usaspending/usaspending-service.js';

const LOOKUP_LIMIT = 50;
const LOOKUP_TIMEOUT_MS = 2_000;

/** Awarding and funding names, each resolved against its own role's directory. */
export const AGENCY_FILTER_FIELDS = {
  agency_name: z
    .string()
    .optional()
    .describe(
      'Awarding top-tier or sub-tier agency name. Use the matched name from usaspending_autocomplete_filters type=awarding_agency, or toptier_name to select the whole parent department. A sub-tier name shared by several parents matches under all parents. Exact case-insensitive names and unambiguous abbreviations resolve to the directory spelling.',
    ),
  funding_agency_name: z
    .string()
    .optional()
    .describe(
      'Funding top-tier or sub-tier agency name. Use the matched name from usaspending_autocomplete_filters type=funding_agency. Exact case-insensitive names and unambiguous abbreviations resolve to the directory spelling. When agency_name is also supplied, awards must match both roles.',
    ),
};

/** Effective names selected after input precedence. */
export type AgencyFilters = z.infer<z.ZodObject<typeof AGENCY_FILTER_FIELDS>>;
type AgencyKey = keyof AgencyFilters;
const AGENCY_ROLES = { agency_name: 'awarding', funding_agency_name: 'funding' } as const;
const AGENCY_KEYS = Object.keys(AGENCY_ROLES) as AgencyKey[];

/** Echo the names actually sent after best-effort lookup. */
export const AGENCY_FILTER_ENRICHMENT = {
  applied_agency_name: z.string().optional().describe('Awarding agency name sent to USAspending'),
  applied_funding_agency_name: z
    .string()
    .optional()
    .describe('Funding agency name sent to USAspending'),
};

async function resolveName(
  svc: USASpendingService,
  role: (typeof AGENCY_ROLES)[AgencyKey],
  name: string,
  ctx: Context,
  deadlineAt: number,
) {
  try {
    const { results } = await svc.autocompleteAgency(role, name, LOOKUP_LIMIT, ctx, deadlineAt);
    ctx.signal.throwIfAborted();
    const top = results?.toptier_agency ?? [];
    const sub = results?.subtier_agency ?? [];
    const rows = [...top, ...sub];
    const folded = name.toLowerCase();
    const exact = rows.flatMap((row) =>
      row.name && row.name.toLowerCase() === folded ? [row.name] : [],
    );
    const matches = exact.length
      ? exact
      : rows.flatMap((row) =>
          row.name && row.abbreviation?.toLowerCase() === folded ? [row.name] : [],
        );
    const candidates = [...new Set(matches)];
    const [candidate] = candidates;
    if (top.length >= LOOKUP_LIMIT || sub.length >= LOOKUP_LIMIT) {
      return { name, reason: 'the agency directory result reached its limit', candidates };
    }
    if (candidate && candidates.length === 1) return { name: candidate };
    return {
      name,
      reason: candidates.length
        ? 'multiple distinct agency names matched'
        : 'no exact agency name or abbreviation matched',
      candidates,
    };
  } catch (err) {
    ctx.signal.throwIfAborted();
    if (
      !(err instanceof McpError) ||
      (err.code !== JsonRpcErrorCode.Timeout &&
        err.code !== JsonRpcErrorCode.ServiceUnavailable &&
        err.code !== JsonRpcErrorCode.RateLimited)
    ) {
      throw err;
    }
    return { name, reason: 'the agency directory was unavailable' };
  }
}

/**
 * Look up each effective name in its own role's directory, in parallel under one deadline;
 * disclose unresolved inputs. The same string in both roles is looked up once per directory.
 * Names are trimmed; a whitespace-only name is absent, as an empty one is.
 */
export async function resolveAgencyFilters(
  svc: USASpendingService,
  input: AgencyFilters | undefined,
  ctx: Context,
) {
  const supplied = AGENCY_KEYS.flatMap((key) => {
    const name = input?.[key]?.trim();
    return name ? [{ key, name }] : [];
  });
  if (!supplied.length) return { names: {}, notices: [] };
  const deadlineAt = Date.now() + LOOKUP_TIMEOUT_MS;
  const resolved = await Promise.all(
    supplied.map(async ({ key, name }) => ({
      key,
      name,
      match: await resolveName(svc, AGENCY_ROLES[key], name, ctx, deadlineAt),
    })),
  );
  const names: AgencyFilters = {};
  const notices: string[] = [];
  for (const { key, name, match } of resolved) {
    names[key] = match.name;
    if (match.reason) {
      const candidates = match.candidates?.map((candidate) => JSON.stringify(candidate)).join(', ');
      notices.push(
        `Could not verify ${key}=${JSON.stringify(name)} because ${match.reason}. Sent the original name.${candidates ? ` Matching names: ${candidates}.` : ''} Use usaspending_autocomplete_filters type=${AGENCY_ROLES[key]}_agency to check the name.`,
      );
    }
  }
  return { names, notices };
}

/** Match either tier within each supplied role, retaining matches under every parent. */
export function applyAgencyFilters(filters: Record<string, unknown>, names: AgencyFilters): void {
  const agencies = AGENCY_KEYS.flatMap((key) => {
    const name = names[key]?.trim();
    const type = AGENCY_ROLES[key];
    return name
      ? [
          { type, tier: 'toptier', name },
          { type, tier: 'subtier', name },
        ]
      : [];
  });
  if (agencies.length) filters.agencies = agencies;
}

/** Output enrichment shared by search and analytics. */
export function agencyFilterEcho(names: AgencyFilters) {
  return {
    ...(names.agency_name ? { applied_agency_name: names.agency_name } : {}),
    ...(names.funding_agency_name
      ? { applied_funding_agency_name: names.funding_agency_name }
      : {}),
  };
}

/** Agency predicates mentioned in empty-result guidance. */
export function describeAgencyFilters(names: AgencyFilters): string[] {
  return AGENCY_KEYS.flatMap((key) => (names[key] ? [`${key}=${JSON.stringify(names[key])}`] : []));
}
