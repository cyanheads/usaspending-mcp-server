# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-07-16

usaspending_search_awards gains a nested filters object mirroring the analytics tools, an agency_slug chaining field, and keyset-cursor pagination past the endpoint's 50,000-result window, plus a fix for a crash on any search's terminal page.

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-07-16

Three usaspending_disaster_spending fixes — geography returns real obligation amounts plus population/per-capita (#18), breakdown pagination advances pages (#19), and the unreachable no_data contract is removed (#35) — atop @cyanheads/mcp-ts-core ^0.10.14 adoption with Socket install-time scanning.

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-06-20

@cyanheads/mcp-ts-core ^0.10.9 maintenance: new check-dependency-specifiers devcheck step (floating latest/* specifier guard), plugin-manifest packaging checks gated by packaging.pluginManifests, fresh-scaffold + worktree-deletion devcheck guards, re-synced skills

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-06-15

release:github npm script runs under bun run instead of tsx (an undeclared dependency), fixing the broken GitHub Release step

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-12

@cyanheads/mcp-ts-core ^0.10.6 adoption: enrichment totals emit via ctx.enrich.total() under the canonical totalCount field, truncation disclosed on no-total endpoints via ctx.enrich.truncated(); Dockerfile HEALTHCHECK + version label; synced skills

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-08 · ⚠️ Breaking

Two new tools (usaspending_search_federal_accounts, usaspending_get_idv_awards), applied-filter enrichment echoes on search and analytics tools, empty-result notices on subawards/transactions, naics_codes array input (breaking rename from naics_code)

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-06-04

Fix POST timeout (fetchWithTimeout for all POST calls), fix def_codes validation for disaster_spending non-overview dimensions, convert empty-result throws to structured responses with ctx.enrich.notice()

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-02

@cyanheads/mcp-ts-core ^0.9.21: per-request log context fix, secret-stripping in error messages, withRetry fail-fast; re-synced skills (8 updated + api-mirror + orchestrations); new devcheck/release/skill-version scripts

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-30

Enrichment on search/analytics tools — query context, result totals, and empty-result guidance surface in a typed enrichment block on both channels; dead error contracts removed

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-28

mcp-ts-core ^0.9.13: body cap (413), session-init gate, quieter 4xx logging, keywords on GET /mcp; ValidationError for missing agency input

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-26

Package metadata, scripts, badges, and Docker alignment with ecosystem gold standard

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-25

Add mcpName field and publish-mcp script for MCP Registry registration

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-25

Patch: autocomplete schema, federal account output, disaster spending flexibility, spending-over-time month normalization

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-25

Initial release — 14 tools covering USAspending.gov award search, analytics, and federal account data
