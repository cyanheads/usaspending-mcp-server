/**
 * @fileoverview Disclosure for a call that answers while one of its secondary
 * requests failed: the `unavailable_sections` entry schema, the settle step that
 * turns a failed request into an entry, the trailer render, and the
 * partial-result notice sentence.
 * @module mcp-server/tools/definitions/unavailable-sections
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/** Why a section is missing, mapped from the service's typed upstream failure reasons. */
export const UNAVAILABLE_REASONS = ['api_unavailable', 'api_timeout', 'upstream_error'] as const;

/** One section omitted from a result because its request failed. */
export interface UnavailableSection<S extends string = string> {
  message: string;
  reason: (typeof UNAVAILABLE_REASONS)[number];
  retryable: boolean;
  section: S;
}

/**
 * The `unavailable_sections` entry schema for one tool's section names.
 * `sectionDescription` says which output fields each section covers.
 */
export function unavailableSectionSchema<const S extends readonly [string, ...string[]]>(
  sections: S,
  sectionDescription: string,
) {
  return z
    .object({
      section: z.enum(sections).describe(sectionDescription),
      reason: z
        .enum(UNAVAILABLE_REASONS)
        .describe(
          'api_unavailable: USAspending was unreachable or answered with a server error. api_timeout: no answer before the request deadline. upstream_error: USAspending rejected the request, or its record lacks the identifier the section is requested by.',
        ),
      retryable: z.boolean().describe('Whether retrying the call may load this section.'),
      message: z.string().describe('The failure message for this section.'),
    })
    .describe('A section omitted from the result because its request failed');
}

/**
 * Settles one secondary request: its value when it fulfilled; otherwise
 * `undefined`, with an entry pushed onto `into`. Caller cancellation and any
 * error that is not a classified upstream failure (`McpError`) rethrow.
 */
export function settleSection<T, S extends string>(
  ctx: Context,
  section: S,
  leg: PromiseSettledResult<T>,
  into: UnavailableSection<S>[],
): T | undefined {
  if (leg.status === 'fulfilled') return leg.value;
  const err: unknown = leg.reason;
  if (ctx.signal.aborted || !(err instanceof McpError)) throw err;
  const reason = err.data?.reason;
  into.push({
    section,
    reason: reason === 'api_unavailable' || reason === 'api_timeout' ? reason : 'upstream_error',
    retryable: err.data?.retryable === true,
    message: err.message,
  });
  return;
}

/** The `content[]` trailer for `unavailable_sections`. */
export function renderUnavailableSections(
  sections: readonly UnavailableSection[] | undefined,
): string {
  return [
    '**Unavailable sections:**',
    ...(sections ?? []).map(
      (s) =>
        `- ${escapeMarkdownInline(s.section)}: ${escapeMarkdownInline(s.reason)}${s.retryable ? ' (retryable)' : ''} — ${escapeMarkdownInline(s.message)}`,
    ),
  ].join('\n');
}

/** The partial-result sentence for a call's notice, naming each missing section and whether a retry may load it. */
export function unavailableNotice(sections: readonly UnavailableSection[]): string {
  const retryable = sections.filter((s) => s.retryable).map((s) => s.section);
  return `Partial result: ${sections.map((s) => `${s.section} (${s.reason})`).join(' and ')} could not be fetched, so ${sections.length === 1 ? 'its fields are' : 'their fields are'} omitted. ${
    retryable.length > 0
      ? `Retry the call to load ${retryable.join(' and ')}.`
      : 'Retrying is unlikely to help.'
  }`;
}
