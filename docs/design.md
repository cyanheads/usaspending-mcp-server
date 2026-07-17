# usaspending-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `usaspending_search_awards` | Search federal awards by keyword, recipient, agency, award type, NAICS code, location, or date range. Returns ranked award summaries with recipient names, amounts, agencies, and award IDs for chaining. | `keyword`, `award_type_codes`, `agency_name`, `recipient_name`, `naics_code`, `location_filter`, `time_period`, `sort`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_get_award` | Fetch full details of a federal award by its generated ID. Returns contract or assistance data, parent IDV info, subaward count, and funding account linkages. Use award IDs from `usaspending_search_awards`. | `award_id` | `readOnlyHint: true`, `openWorldHint: false` |
| `usaspending_get_award_transactions` | List individual transactions (modifications, amendments) on an award. Reveals spending history and obligation changes over time. | `award_id`, `sort`, `order`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: false` |
| `usaspending_get_award_subawards` | List subaward contracts or grants under a prime award. Reveals the sub-contractor or sub-grantee layer — who actually does the work. | `award_id`, `sort`, `order`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: false` |
| `usaspending_search_recipients` | Search for organizations receiving federal funds by name or UEI. Returns recipient IDs, total award amounts, and business type classifications. | `keyword`, `award_type`, `limit` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_get_recipient` | Fetch a recipient's profile: address, business types, parent organization, alternate names, and total award amounts by type. Optionally scope to a specific fiscal year and award type. Use recipient IDs from `usaspending_search_recipients`. | `recipient_id`, `fiscal_year`, `award_type` | `readOnlyHint: true`, `openWorldHint: false` |
| `usaspending_get_agency` | Fetch an agency's current fiscal year overview: mission, budget authority, obligation totals, sub-agency count, and DEF codes. Also returns sub-agency breakdown with transaction counts. Accepts either a 3-digit `toptier_code` (e.g., `097`) or an `agency_slug` (e.g., `department-of-defense`) — slugs appear in award search results. | `toptier_code`, `agency_slug` | `readOnlyHint: true`, `openWorldHint: false` |
| `usaspending_spending_by_geography` | Aggregate federal spending by state, county, or congressional district. Geographic filters require FIPS codes or 2-letter state abbreviations, not place names — use a geocoding server to resolve names first. Useful for per-capita analysis chained with Census population data. | `scope`, `geo_layer`, `filters`, `subawards` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_spending_by_category` | Aggregate spending grouped by a dimension: NAICS code, PSC code, awarding agency, funding agency, CFDA program, or recipient. Returns top items with amounts for trend and breakdown analysis. | `category`, `filters`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_spending_over_time` | Fetch aggregated spending by fiscal year, fiscal quarter, or calendar month. Filter by award type, agency, recipient, or keyword to trace trends in a specific area. | `group`, `filters`, `subawards` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_disaster_spending` | Fetch disaster and emergency supplemental spending (COVID-19, hurricanes, etc.) broken down by agency, CFDA program, recipient, or geography. Pass a `dimension` enum to select the breakdown axis; filter by DEF codes (specific appropriation laws) to isolate a particular emergency. | `dimension`, `spending_type`, `filters`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_get_federal_account` | Fetch a federal account's budget data: total obligations, outlays, program activities, and object class breakdown. Federal accounts connect appropriations law to actual spending. Account codes appear in award funding details returned by `usaspending_get_award`. | `account_code` | `readOnlyHint: true`, `openWorldHint: false` |
| `usaspending_list_agencies` | List all top-tier federal agencies with toptier codes, budget authority amounts, and obligation totals for the current fiscal year. Entry point for agency navigation — toptier codes are required by `usaspending_get_agency` and agency filters. | `sort`, `order` | `readOnlyHint: true`, `openWorldHint: false`, `idempotentHint: true` |
| `usaspending_autocomplete` | Look up valid code values for filter fields: NAICS industry codes, PSC product/service codes, CFDA assistance programs, recipient names, or awarding/funding agency names. Use before filtering awards to discover the right code when you only know a description. | `type`, `search_text`, `limit` | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

None planned. All data is dynamic and filter-driven; no stable URI pattern adds value beyond the tool surface.

### Prompts

None planned. This is a data-retrieval server; no recurring interaction pattern warrants a prompt template.

---

## Overview

`usaspending-mcp-server` wraps the USAspending.gov API v2 — the official US Treasury platform for tracking all federal awards (contracts, grants, loans, direct payments, and IDVs) under the DATA Act. No auth required. Data is public domain.

Primary workflows:

- **Follow the money** — search for awards by keyword or recipient, drill into contract details, traverse subaward layers, trace funding accounts to appropriation laws
- **Contractor research** — look up who receives federal funds, their total award history, business classifications, subsidiaries
- **Spending breakdowns** — aggregate by agency, geography, industry (NAICS), product/service (PSC), CFDA program, or time period
- **Agency analysis** — compare budget authority vs. actual obligations, sub-agency breakdown, program activity detail
- **Disaster and emergency spending** — isolate COVID-19, hurricane, or other supplemental appropriations by DEF code

Target users: investigative journalists, policy researchers, government contracting professionals, and agents chaining federal spending data with OpenFEC, SEC EDGAR, Census, or Congress data.

## Requirements

- Read-only access — no writes, no auth
- Base URL: `https://api.usaspending.gov/api/v2/`
- No published rate limit; reasonable use expected
- Award search limited to data from 2007-10-01 onward via the search API; bulk downloads cover 2000-10-01 forward
- DoD contract data subject to 90-day publication delay
- Award IDs use a `generated_unique_award_id` format (e.g., `CONT_AWD_FA862118F6251_9700_FA862115D6276_9700`), not human-readable piids alone
- Recipient IDs are UUID-based hashes (e.g., `b97d19b0-833c-8d8f-3a2c-157d04ea55ef-P`) with a level suffix (`-P` parent, `-C` child)
- Toptier agency codes are 3-digit strings (e.g., `097` for DoD, `012` for Agriculture)

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `USASpendingService` | `api.usaspending.gov/api/v2/` — all award search, awards, recipient, agency, spending analytics, disaster, and federal account endpoints | All tools |

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `USASPENDING_BASE_URL` | No | Override base URL (default: `https://api.usaspending.gov/api/v2/`) |
| `USASPENDING_TIMEOUT_MS` | No | Request timeout in ms (default: 30000) |

## Implementation Order

1. Config and server setup — `server-config.ts` with base URL and timeout
2. `USASpendingService` — single HTTP client with retry, timeout, and parse-failure classification
3. Discovery tools: `usaspending_list_agencies`, `usaspending_autocomplete`
4. Core search tools: `usaspending_search_awards`, `usaspending_search_recipients`
5. Entity detail tools: `usaspending_get_award`, `usaspending_get_recipient`, `usaspending_get_agency`
6. Award drill-down tools: `usaspending_get_award_transactions`, `usaspending_get_award_subawards`
7. Analytical tools: `usaspending_spending_by_geography`, `usaspending_spending_by_category`, `usaspending_spending_over_time`
8. Specialized tools: `usaspending_disaster_spending`, `usaspending_get_federal_account`

Each step is independently testable.

---

## Output Schemas (Key Fields)

| Tool | Key Output Fields |
|:-----|:-----------------|
| `usaspending_search_awards` | `results[].generated_internal_id` (chain to `usaspending_get_award`), `Recipient Name`, `Award Amount`, `Awarding Agency`, `agency_slug` (chain to `usaspending_get_agency`), `page_metadata.hasNext` |
| `usaspending_get_award` | `generated_unique_award_id`, `type`, `type_description`, `description`, `total_obligation`, `subaward_count`, `date_signed`, `parent_award.generated_unique_award_id`, `latest_transaction_contract_data.naics`, `recipient.recipient_hash` (chain to `usaspending_get_recipient`), `account_obligations_by_defc` |
| `usaspending_get_award_transactions` | `results[].id`, `action_date`, `federal_action_obligation`, `modification_number`, `description`, `page_metadata` |
| `usaspending_get_award_subawards` | `results[].id`, `subaward_number`, `description`, `action_date`, `amount`, `recipient_name` |
| `usaspending_search_recipients` | `results[].id` (recipient hash — chain to `usaspending_get_recipient`), `duns`, `uei`, `name`, `recipient_level`, `amount` |
| `usaspending_get_recipient` | `name`, `uei`, `duns`, `recipient_id`, `recipient_level`, `parent_name`, `business_types`, `location` |
| `usaspending_get_agency` | `name`, `abbreviation`, `toptier_code`, `agency_id`, `mission`, `budget_authority_amount`, `obligation_amount`, `subtier_agency_count`, `def_codes` |
| `usaspending_spending_by_geography` | `results[].shape_code`, `display_name`, `aggregated_amount`, `population`, `per_capita` |
| `usaspending_spending_by_category` | `category`, `results[].code`, `name`, `amount`, `id`, `page_metadata` |
| `usaspending_spending_over_time` | `group`, `results[].time_period`, `aggregated_amount`, by-type obligation columns |
| `usaspending_disaster_spending` | Varies by dimension: `results[].description`, `obligation`, `outlay`, `award_count`; or geography aggregations |
| `usaspending_get_federal_account` | `account_title`, `federal_account_code`, `budget_function`, `managing_agency`, fiscal year snapshot with obligations and outlays |
| `usaspending_list_agencies` | `results[].agency_name`, `abbreviation`, `toptier_code`, `agency_slug`, `obligated_amount`, `budget_authority_amount` |
| `usaspending_autocomplete` | `results[].code`, `name` (for naics/psc/cfda); `results[].id`, `name` (for agency/recipient) |

---

## Domain Mapping

| Noun | Operations → Endpoints |
|:-----|:----------------------|
| Award | search (`POST /search/spending_by_award/`), get (`GET /awards/{id}/`), list-transactions (`POST /transactions/`), list-subawards (`POST /subawards/`), get-funding-accounts (`POST /awards/funding`) |
| Recipient | search (`POST /recipient/`), get (`GET /recipient/{hash_id}/`), get-children (`GET /recipient/children/{uei}/`) |
| Agency | list (`GET /references/toptier_agencies/`), get (`GET /agency/{toptier_code}/`), get-sub-agencies (`GET /agency/{code}/sub_agency/`), get-budget (`GET /agency/{code}/budgetary_resources/`) |
| Spending Analytics | by-geography (`POST /search/spending_by_geography/`), by-category (`POST /search/spending_by_category/{category}/`), over-time (`POST /search/spending_over_time/`) |
| Disaster | overview (`GET /disaster/overview/`), by-agency (`POST /disaster/agency/spending\|loans/`), by-cfda (`POST /disaster/cfda/spending/`), by-recipient (`POST /disaster/recipient/spending\|loans/`), by-geo (`POST /disaster/spending_by_geography/`) |
| Federal Account | get (`GET /federal_accounts/{account_code}/`), get-snapshot (`GET /federal_accounts/{code}/fiscal_year_snapshot/`), get-program-activities (`GET /federal_accounts/{code}/program_activities/`) |
| Autocomplete / Reference | naics (`POST /autocomplete/naics/`), psc (`POST /autocomplete/psc/`), cfda (`POST /autocomplete/cfda/`), agency (`POST /autocomplete/awarding_agency/`), recipient (`POST /autocomplete/recipient/`) |

---

## Workflow Analysis

### `usaspending_disaster_spending`

This tool dispatches across the disaster endpoint family based on two enums: `dimension` (which breakdown axis to use) and `spending_type` (`spending` vs `loans`). Each disaster endpoint has parallel `/spending/` and `/loans/` variants — `spending_type` selects between them. Internal call sequence:

| # | Call | Purpose | `dimension` | `spending_type` |
|:--|:-----|:--------|:------------|:----------------|
| 1 | `GET /disaster/overview/` | Top-level totals (obligations + outlays) | `overview` | — |
| 2 | `POST /disaster/agency/spending/` | Breakdown by awarding agency | `agency` | `spending` |
| 2b | `POST /disaster/agency/loans/` | Loan face values by agency | `agency` | `loans` |
| 3 | `POST /disaster/cfda/spending/` | Breakdown by CFDA/Assistance Listing | `cfda` | `spending` |
| 4 | `POST /disaster/recipient/spending/` | Breakdown by recipient | `recipient` | `spending` |
| 5 | `POST /disaster/spending_by_geography/` | Breakdown by state/county | `geography` | — |

This consolidates 9+ disaster endpoints into one tool. The agent selects the breakdown axis (dimension) and whether to view grants/contracts or loans (spending_type) without knowing endpoint topology.

---

## Design Decisions

**Consolidating spending analytics into three tools instead of fourteen.** The `/search/spending_by_category/{category}/` endpoint family has 14 sub-routes (one per category dimension). Exposing these as 14 tools would drown the tool surface. Instead, `usaspending_spending_by_category` takes a `category` enum that maps to the right sub-route. Same pattern for disaster spending (9+ endpoints → one tool with `dimension` + `spending_type` enums). The `spending_by_geography` and `spending_over_time` tools stand alone because their input shapes and workflows are genuinely distinct.

**Adding `usaspending_autocomplete` as a code discovery tool.** Agents filtering by NAICS code, PSC code, CFDA program, or agency name need to know the exact code values. The API provides autocomplete endpoints for each. Without this tool, agents that know "cybersecurity" or "aircraft maintenance" but not the NAICS/PSC code would have to guess or fail. A single `usaspending_autocomplete` tool with a `type` enum (`naics`, `psc`, `cfda`, `awarding_agency`, `recipient`) consolidates five autocomplete endpoints and serves as the code-lookup step before filtering.

**Omitting bulk download, transaction-level search, and IDV-specific tools.** Bulk download endpoints generate async ZIP files that require polling and redirects — unsuitable for interactive MCP workflows. The `/search/spending_by_transaction/` endpoints are nearly identical to `spending_by_award` for most questions. IDV-specific endpoints (`/idvs/*`) are covered structurally by `usaspending_get_award` plus `usaspending_get_award_subawards` for the common case; IDV tree-walking is a low-frequency niche. All three are deferred, not permanently excluded.

**Omitting federal account sub-detail tools.** Endpoints for federal account object classes, program activity totals, and treasury account symbols serve budget analysts with specialized knowledge of the account structure. The `usaspending_get_federal_account` tool handles the most common "what is this account spending on?" question. Account-level drill-down is deferred.

**Recipient ID format.** Recipient IDs are UUID hashes with a level suffix (`-P`, `-C`, `-R`). The tool surface passes these as opaque strings and the descriptions explain the format. DUNS and UEI are exposed on the search result for chaining to external systems (SAM.gov, EDGAR).

**`usaspending_get_award_transactions` and `usaspending_get_award_subawards` as separate tools.** These serve different analytical questions — transactions show obligation history/modifications, subawards show the supply chain below the prime. Combining them into a mode-based tool would be awkward given their different sort fields and output shapes.

**`usaspending_get_agency` accepts both `toptier_code` and `agency_slug`.** Award search results return `agency_slug` (e.g., `department-of-defense`) but agency detail requires a `toptier_code` (e.g., `097`). Requiring agents to do an intermediate list-agencies lookup just to resolve a slug adds a needless round trip. The tool resolves either input, with slug resolution backed by a name-match against the agencies list.

---

## API Reference

### Award search filter object

Key filter fields for `usaspending_search_awards`, `usaspending_spending_by_category`, etc.:

| Field | Type | Notes |
|:------|:-----|:------|
| `keywords` | `string[]` | Full-text search across award descriptions, recipient names, and locations |
| `award_type_codes` | `string[]` | `A/B/C/D` = contracts, `02/03/04/05` = grants, `06/10` = direct payments, `07/08` = loans, `IDV_*` = IDVs |
| `time_period` | `{start_date, end_date}[]` | ISO 8601 dates; earliest 2007-10-01 via search API |
| `agencies` | `{type, tier, name}[]` | `type`: `awarding` or `funding`; `tier`: `toptier` or `subtier` |
| `recipient_search_text` | `string[]` | Recipient name search within filter |
| `recipient_id` | `string` | Exact recipient hash ID. Not honored by `usaspending_search_awards` — `spending_by_award` silently ignores it (returns it in the response `messages` as unused); filter by recipient name via `recipient_search_text` there |
| `naics_codes` | `{require, exclude}` | NAICS code arrays |
| `psc_codes` | `{require, exclude}` | PSC code arrays |
| `place_of_performance_locations` | `{country, state, county, city}[]` | Place of performance filter |
| `recipient_locations` | `{country, state, county, city}[]` | Recipient address filter |

### Pagination

Search and list endpoints return `page_metadata.hasNext` and `page_metadata.page`. Use `limit` (max 100) and `page` parameters. `usaspending_search_awards` (`spending_by_award`) returns no total count; its `page_metadata` instead carries `last_record_unique_id` + `last_record_sort_value` on every page. Page-number paging caps at a 50,000-result offset (`page` × `limit`); past that boundary, continue with keyset (after-cursor) pagination by passing those two cursor values back — page is omitted when the cursor is supplied.

### Spending level parameter

Several search endpoints accept `spending_level`:
- `awards` (default) — one row per award
- `transactions` — one row per transaction/modification  
- `subawards` — one row per subaward

### Geography scope values

`usaspending_spending_by_geography` accepts:
- `scope`: `place_of_performance` or `recipient_location`
- `geo_layer`: `state`, `county`, or `district`

---

## Known Limitations

- **DoD data lag**: Department of Defense contract data has a mandatory 90-day publication delay. Recent DoD awards will not appear in search results.
- **Search window floor**: Award search is limited to 2007-10-01 onward. Pre-FY2008 data requires bulk download (async ZIP), which is out of scope for interactive MCP queries.
- **No geocoding**: The API takes FIPS codes and state abbreviations, not place names. Agents need to resolve location names externally (e.g., via the Census or OpenStreetMap servers) before applying geographic filters.
- **No full-text in descriptions**: Contract descriptions (PIID descriptions) are often cryptic government shorthand (e.g., "IGF::OT::IGF AFSOC ACTS..."). Keyword search works, but description-based interpretation may require domain knowledge.
