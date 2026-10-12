# usaspending-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `usaspending_search_awards` | Search federal awards by keyword, recipient, agency, award type, NAICS code, assistance listing, PSC, DEF code, location, or date range. Returns ranked award summaries with recipient names, amounts (loan value and subsidy cost for loans), agencies, and award IDs for chaining. `sort` values and default follow the award type group. | `keyword`, `award_type_codes`, `agency_name`, `recipient_name`, `naics_codes`, `assistance_listings`, `psc_codes`, `def_codes`, `location_filter`, `time_period`, `sort`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_get_award` | Fetch full details of a federal award by its generated ID. Returns contract or assistance data, parent IDV info, subaward count, and funding account linkages. Use award IDs from `usaspending_search_awards`. | `award_id` | `readOnlyHint: true`, `openWorldHint: false` |
| `usaspending_get_award_transactions` | List individual transactions (modifications, amendments) on an award. Reveals spending history and obligation changes over time. | `award_id`, `sort`, `order`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: false` |
| `usaspending_get_award_subawards` | List subaward contracts or grants under a prime award. Reveals the sub-contractor or sub-grantee layer — who actually does the work. | `award_id`, `sort`, `order`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: false` |
| `usaspending_get_idv_awards` | List child contracts and task/delivery orders placed under an IDV award. Each row carries `generated_unique_award_id` for chaining into `usaspending_get_award`. This endpoint reports no total count. | `award_id`, `type`, `sort`, `order`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: false`, `idempotentHint: true` |
| `usaspending_get_award_federal_accounts` | List the Treasury federal accounts that funded an award, with the amount obligated from each and the funding agency behind it. Returns `federal_account` for chaining into `usaspending_get_federal_account`. | `award_id`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: false`, `idempotentHint: true` |
| `usaspending_search_recipients` | Search for organizations receiving federal funds by name, UEI, or DUNS. Returns recipient hash IDs, UEI/DUNS, total award amounts, and hierarchy level. Paginated with `page_metadata` (`total`, `page`, `has_next`). | `keyword`, `award_type`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_get_recipient` | Fetch a recipient's profile: address, business types, parent organization, alternate names, and transaction and loan totals over the trailing 12 months or one `fiscal_year` (sent as upstream's `year`), named by `period`. The endpoint has no award-type selector; `usaspending_spending_over_time` with `filters.recipient_id` gives totals by award type. Use recipient IDs from `usaspending_search_recipients`. | `recipient_id`, `fiscal_year` | `readOnlyHint: true`, `openWorldHint: false` |
| `usaspending_get_agency` | Fetch an agency's overview: mission, budgetary resources, obligation and outlay totals for the most recent fiscal year with reported budget data, sub-agency count, and DEF codes. Also returns the sub-agency breakdown with transaction counts for that same fiscal year (the current one when no budget year is available within 5 seconds), named by `sub_agency_fiscal_year`. A failed budget or sub-agency request leaves the overview standing and is named in `unavailable_sections`. Accepts exactly one of a 3-digit `toptier_code` (e.g., `097`) or an `agency_slug` (e.g., `department-of-defense`) — slugs appear in award search results. | `toptier_code`, `agency_slug`, `page` | `readOnlyHint: true`, `openWorldHint: false` |
| `usaspending_spending_by_geography` | Aggregate federal spending by state, county, or congressional district. `shape_codes` selects specific areas by code — postal code for states, 5-digit FIPS for counties, 4-digit state FIPS + district for districts — not place names, so use a geocoding server to resolve names first. Useful for per-capita analysis chained with Census population data. | `scope`, `geo_layer`, `filters`, `limit`, `shape_codes`, `subawards` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_spending_by_category` | Aggregate spending grouped by a dimension: NAICS code, PSC code, awarding agency, funding agency, CFDA program, or recipient. Returns top items with amounts for trend and breakdown analysis. | `category`, `filters`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_spending_over_time` | Fetch aggregated spending by fiscal year, fiscal quarter, or fiscal month. Filter by award type, agency, recipient, keyword, NAICS code, assistance listing, PSC, or DEF code to trace trends in a specific area. | `group`, `filters`, `subawards` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_disaster_spending` | Fetch disaster and emergency supplemental spending (COVID-19, hurricanes, etc.) broken down by agency, CFDA program, recipient, or geography. Pass a `dimension` enum to select the breakdown axis; filter by DEF codes (specific appropriation laws) to isolate a particular emergency. | `dimension`, `spending_type`, `filters`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: true` |
| `usaspending_get_federal_account` | Fetch a federal account's budget data: total obligations, gross outlays, budgetary resources, and the per-Treasury-Account-Symbol component breakdown in `children`. Federal accounts connect appropriations law to actual spending. Account codes come from the `account_number` field returned by `usaspending_search_federal_accounts`. | `account_code` | `readOnlyHint: true`, `openWorldHint: false`, `idempotentHint: true` |
| `usaspending_get_federal_account_breakdown` | Break a federal account's obligations down by program activity or object class. Pass a `dimension` enum to select the axis. Paginated with an honest total count. | `account_code`, `dimension`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: false`, `idempotentHint: true` |
| `usaspending_search_federal_accounts` | List and keyword-search federal accounts by agency identifier or title keyword. Returns account numbers, names, managing agencies, and budgetary resources for chaining into `usaspending_get_federal_account`. | `keyword`, `agency_identifier`, `sort_field`, `sort_direction`, `limit`, `page` | `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true` |
| `usaspending_list_agencies` | List all top-tier federal agencies with toptier codes, budget authority amounts, and obligation totals for the current fiscal year. Entry point for agency navigation — toptier codes are required by `usaspending_get_agency` and agency filters. | `sort`, `order` | `readOnlyHint: true`, `openWorldHint: false`, `idempotentHint: true` |
| `usaspending_autocomplete_filters` | Look up valid code values for filter fields: NAICS industry codes, PSC product/service codes, CFDA assistance programs, recipient names, or awarding agency and sub-agency names with each one's tier and top-tier parent. Use before filtering awards to discover the right code when you only know a description. | `type`, `search_text`, `limit` | `readOnlyHint: true`, `openWorldHint: true` |

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
| `USASPENDING_TIMEOUT_MS` | No | Per-attempt request timeout in ms, 1000–120000 (default: 45000). Each attempt is cut at the smaller of this and the time left in the request budget, and an attempt that times out is not retried: the uncached aggregations behind the slow calls repeat the same work, so a retry started with the leftover budget is cut too, and an answer that would have arrived inside the budget is lost. A timeout surfaces as a `Timeout`, tagged `api_timeout` with the calling tool's recovery hint, naming the per-attempt timeout when that cut the attempt and the request budget when the time left in it did — the latter at the defaults, where the two are equal. |
| `USASPENDING_RETRY_BUDGET_MS` | No | Wall-clock budget in ms for one request, every attempt and backoff included, 1000–300000 (default: 45000, or `USASPENDING_TIMEOUT_MS` when higher, so one attempt can run its full timeout). Fast transient failures — a 5xx, a network error, an HTML or unparseable body — retry inside it, and a backoff that would outlast it fails at once. One shared deadline keeps the retry loop from re-paying a timeout per attempt; at the defaults a call ends within 45 s and a never-answering upstream sees one request. Expiry surfaces as a `Timeout` naming the budget, tagged `api_timeout`. |

## Implementation Order

1. Config and server setup — `server-config.ts` with base URL and timeout
2. `USASpendingService` — single HTTP client with retry, timeout, and parse-failure classification
3. Discovery tools: `usaspending_list_agencies`, `usaspending_autocomplete_filters`
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
| `usaspending_search_awards` | `results[].generated_internal_id` (chain to `usaspending_get_award`), `Recipient Name`, `Award Amount` (`Loan Value`, `Subsidy Cost`, `Issued Date` for loans), `Awarding Agency`, `agency_slug` (chain to `usaspending_get_agency`), `page_metadata` (`has_next`, `page`, `limit`, cursor pair — no total) |
| `usaspending_get_award` | `generated_unique_award_id`, `type`, `type_description`, `description`, `total_obligation`, `subaward_count`, `date_signed`, `parent_award.generated_unique_award_id`, `latest_transaction_contract_data.naics`, `cfda_info[]` (`cfda_number`, `cfda_title`, `federal_action_obligation_amount`), `recipient.recipient_hash` and `recipient.parent_recipient_hash` (chain to `usaspending_get_recipient`), `recipient.recipient_uei`, `recipient.parent_recipient_uei`, `recipient.business_categories`, `location_country_code` (recipient and place of performance), `total_loan_value` and `total_subsidy_cost` (loans), `account_obligations_by_defc` |
| `usaspending_get_award_transactions` | `results[].id`, `action_date`, `federal_action_obligation`, `modification_number`, `description`, `page_metadata` (`has_next`, `page`, `limit` — no total) |
| `usaspending_get_award_subawards` | `results[].id`, `subaward_number`, `description`, `action_date`, `amount`, `recipient_name`, `page_metadata` (`has_next`, `page`, `limit` — no total) |
| `usaspending_get_idv_awards` | `results[].generated_unique_award_id` (chain to `usaspending_get_award`), `piid`, `award_type`, `obligated_amount`, `page_metadata` (`has_next`, `page`, `limit` — no total) |
| `usaspending_get_award_federal_accounts` | `results[].federal_account` (chain to `usaspending_get_federal_account`), `account_title`, `total_transaction_obligated_amount`, `funding_agency_name`, `funding_agency_abbreviation`, `funding_agency_slug` (chain to `usaspending_get_agency`), `funding_agency_id`, `funding_toptier_agency_id`, `page_metadata` (`count`, `page`, `has_next`, `has_previous`, `limit`) |
| `usaspending_search_recipients` | `results[].id` (recipient hash — chain to `usaspending_get_recipient`), `duns`, `uei`, `name`, `recipient_level`, `amount`, `page_metadata` (`total`, `page`, `has_next`, `limit`) |
| `usaspending_get_recipient` | `name`, `uei`, `duns`, `recipient_id`, `recipient_level`, `parent_name`, `business_types`, `location`, `period`, `total_transaction_amount`, `total_transactions`, loan face-value totals |
| `usaspending_get_agency` | `name`, `abbreviation`, `toptier_code`, `agency_id`, `mission`, `fiscal_year`, `budgetary_resources_amount`, `obligated_amount`, `outlay_amount`, `subtier_agency_count`, `sub_agencies[]`, `sub_agency_fiscal_year`, `sub_agency_page_metadata`, `def_codes`, `unavailable_sections` |
| `usaspending_spending_by_geography` | `results[].shape_code`, `display_name`, `aggregated_amount`, `population`, `per_capita` |
| `usaspending_spending_by_category` | `category`, `results[].code`, `name`, `amount`, `id`, `recipient_id` and `uei` (`recipient_duns` rows; `recipient_id` chains to `usaspending_get_recipient`), `page_metadata` (`has_next`, `page`, `limit` — no total) |
| `usaspending_spending_over_time` | `group`, `results[].time_period`, `aggregated_amount`, by-type obligation columns |
| `usaspending_disaster_spending` | Varies by dimension: `results[].description`, `obligation`, `outlay`, `award_count`, `total_budgetary_resources` (agency, `spending_type: total`); `totals` for the whole result set on agency, cfda, and recipient (`obligation`, `outlay`, plus `total_budgetary_resources` or `award_count`); or geography areas — `shape_code`, `display_name`, `aggregated_amount`, `population`, `per_capita`, `award_count` — ranked by `aggregated_amount` and paged client-side, with no `totals` |
| `usaspending_get_federal_account` | `account_title`, `federal_account_code`, `agency_identifier`, `main_account_code`, `parent_agency_name`, `bureau_name`, `fiscal_year`, `total_obligated_amount`, `total_gross_outlay_amount`, `total_budgetary_resources`, `children[]` (per-TAS `name`, `code`, `obligated_amount`, `gross_outlay_amount`, `budgetary_resources_amount`) |
| `usaspending_get_federal_account_breakdown` | `account_code`, `dimension`, `results[].code`, `name`, `obligations`, `type` (program_activity only), `page_metadata` (`total`, `page`, `has_next`, `has_previous`, `limit`) |
| `usaspending_search_federal_accounts` | `results[].account_number` (chain to `usaspending_get_federal_account`), `account_name`, `agency_identifier`, `managing_agency`, `managing_agency_acronym`, `budgetary_resources`, `page_metadata` (`count`, `page`, `has_next`, `limit`) |
| `usaspending_list_agencies` | `results[].agency_name`, `abbreviation`, `toptier_code`, `agency_slug`, `obligated_amount`, `budget_authority_amount` |
| `usaspending_autocomplete_filters` | `results[].code`, `name` (for naics/psc/cfda); `results[].name`, `abbreviation`, `tier`, `toptier_name`, `toptier_code` (for awarding_agency; `toptier_name` is what the top-tier-only `agency_name` filters take); `results[].name`, `uei`, `duns` (for recipient) |

---

## Domain Mapping

| Noun | Operations → Endpoints |
|:-----|:----------------------|
| Award | search (`POST /search/spending_by_award/`), get (`GET /awards/{id}/`), list-transactions (`POST /transactions/`), list-subawards (`POST /subawards/`), list-idv-children (`POST /idvs/awards/`), list-federal-accounts (`POST /awards/accounts/`) |
| Recipient | search (`POST /recipient/`), get (`GET /recipient/{hash_id}/`), get-children (`GET /recipient/children/{uei}/`) |
| Agency | list (`GET /references/toptier_agencies/`), get (`GET /agency/{toptier_code}/`), get-sub-agencies (`GET /agency/{code}/sub_agency/`), get-budget (`GET /agency/{code}/budgetary_resources/`) |
| Spending Analytics | by-geography (`POST /search/spending_by_geography/`), by-category (`POST /search/spending_by_category/{category}/`), over-time (`POST /search/spending_over_time/`) |
| Disaster | overview (`GET /disaster/overview/`), by-agency (`POST /disaster/agency/spending\|loans/`), by-cfda (`POST /disaster/cfda/spending/`), by-recipient (`POST /disaster/recipient/spending\|loans/`), by-geo (`POST /disaster/spending_by_geography/`) |
| Federal Account | search (`POST /federal_accounts/`), get (`GET /federal_accounts/{account_code}/` — carries the per-TAS `children` breakdown), breakdown-by-program-activity (`POST /federal_accounts/{code}/program_activities/total`), breakdown-by-object-class (`POST /federal_accounts/{code}/object_classes/total`) |
| Autocomplete / Reference | naics (`POST /autocomplete/naics/`), psc (`POST /autocomplete/psc/`), cfda (`POST /autocomplete/cfda/`), agency (`POST /autocomplete/awarding_agency/`), recipient (`POST /autocomplete/recipient/`) |

---

## Workflow Analysis

### `usaspending_disaster_spending`

This tool dispatches across the disaster endpoint family on `dimension`, one route per breakdown axis. `spending_type` (`award`, the default, or `total`) is forwarded in the request body, and only the agency route honors it: `total` adds direct non-award spending and `total_budgetary_resources`. The recipient route accepts the field but returns the same response for either value, the cfda route is sent none, and no `/loans/` route is called. Internal call sequence:

| # | Call | Purpose | `dimension` | `spending_type` sent |
|:--|:-----|:--------|:------------|:---------------------|
| 1 | `GET /disaster/overview/` | Top-level totals (budget authority, obligations, outlays) and funding by DEF code | `overview` | — (reported as `spending`) |
| 2 | `POST /disaster/agency/spending/` | Breakdown by awarding agency | `agency` | `award` / `total` — honored |
| 3 | `POST /disaster/cfda/spending/` | Breakdown by CFDA/Assistance Listing | `cfda` | — |
| 4 | `POST /disaster/recipient/spending/` | Breakdown by recipient | `recipient` | `award` / `total` — ignored upstream |
| 5 | `POST /disaster/spending_by_geography/` | Breakdown by state/county (place of performance); the whole set, ranked and paged client-side | `geography` | always `obligation` (that route's own vocabulary) |

This consolidates the disaster endpoints into one tool. The agent selects the breakdown axis (`dimension`) without knowing endpoint topology.

---

## Design Decisions

**Consolidating spending analytics into three tools instead of fifteen.** The `/search/spending_by_category/{category}/` endpoint family has 15 sub-routes (one per category dimension). Exposing these as 15 tools would drown the tool surface. Instead, `usaspending_spending_by_category` takes a `category` enum that maps to the right sub-route. Same pattern for disaster spending (9+ endpoints → one tool with `dimension` + `spending_type` enums). The `spending_by_geography` and `spending_over_time` tools stand alone because their input shapes and workflows are genuinely distinct.

**Adding `usaspending_autocomplete_filters` as a code discovery tool.** Agents filtering by NAICS code, PSC code, CFDA program, or agency name need to know the exact code values. The API provides autocomplete endpoints for each. Without this tool, agents that know "software" or "aircraft maintenance" but not the NAICS/PSC code would have to guess or fail. A single `usaspending_autocomplete_filters` tool with a `type` enum (`naics`, `psc`, `cfda`, `awarding_agency`, `recipient`) consolidates five autocomplete endpoints and serves as the code-lookup step before filtering.

Each lookup inherits its upstream match semantics rather than normalizing them. The `naics` lookup matches official NAICS title text only, so a colloquial term that never appears in a title returns nothing — "software" and "aircraft" resolve, "cybersecurity" and "aircraft maintenance" do not, and "aircraft maintenance" is a `psc` term rather than a `naics` one. Adding synonym expansion or fuzzy matching on this side would make the tool disagree with the codes the filter endpoints actually accept.

**Omitting bulk download, transaction-level search, and IDV-specific tools.** Bulk download endpoints generate async ZIP files that require polling and redirects — unsuitable for interactive MCP workflows. The `/search/spending_by_transaction/` endpoints are nearly identical to `spending_by_award` for most questions. IDV-specific endpoints (`/idvs/*`) are covered structurally by `usaspending_get_award` plus `usaspending_get_award_subawards` for the common case; IDV tree-walking is a low-frequency niche. All three are deferred, not permanently excluded.

**Federal account drill-down, via one tool with a `dimension` enum.** Originally deferred as analyst-only surface, on the premise that `usaspending_get_federal_account` answered "what is this account spending on?" — it does not; that endpoint returns only account metadata and top-level totals. `usaspending_get_federal_account_breakdown` covers the two drill-down axes with a `dimension` enum rather than two tools: `POST /federal_accounts/{code}/program_activities/total` and `.../object_classes/total` share a method, URL shape, request shape, `page_metadata` shape, and row shape, diverging only in the `type` field that program-activity rows carry. That is the same consolidation `usaspending_spending_by_category` and `usaspending_disaster_spending` already use.

Treasury Account Symbol detail needs no tool of its own — it arrives free in the `children` array of the base account response `usaspending_get_federal_account` already fetches, bounded by construction at one entry per availability period.

**No not-found contract on the federal-account breakdown or award-account tools.** Both `POST /awards/accounts/` and the two breakdown routes answer a nonexistent identifier with HTTP 200 and zero rows — byte-identical to a real entity with no rows on that axis, verified live. With no upstream miss signal, a declared `not_found` reason could never fire, so both tools disclose the empty case as an `enrichment.notice` instead. `usaspending_get_federal_account` keeps its `account_not_found` contract because its `GET /federal_accounts/{code}/` route does answer a miss with 400.

**Recipient ID format.** Recipient IDs are UUID hashes with a level suffix (`-P`, `-C`, `-R`). The tool surface passes these as opaque strings and the descriptions explain the format. DUNS and UEI are exposed on the search result for chaining to external systems (SAM.gov, EDGAR).

**`usaspending_get_award_transactions` and `usaspending_get_award_subawards` as separate tools.** These serve different analytical questions — transactions show obligation history/modifications, subawards show the supply chain below the prime. Combining them into a mode-based tool would be awkward given their different sort fields and output shapes.

**`usaspending_get_agency` accepts both `toptier_code` and `agency_slug`.** Award search results return `agency_slug` (e.g., `department-of-defense`) but agency detail requires a `toptier_code` (e.g., `097`). Requiring agents to do an intermediate list-agencies lookup just to resolve a slug adds a needless round trip. The tool resolves either input, with slug resolution backed by a name-match against the agencies list.

**Upstream-failure reasons are attached in the service.** Every tool declares `api_timeout` and `api_unavailable`, but only `USASpendingService.request()` sees the failure's shape, so it tags every `Timeout` (budget expiry, per-attempt timeouts that exhaust the retries, a 504) and every `ServiceUnavailable` (5xx, network, HTML or invalid-JSON body) with the reason, `retryable`, and `ctx.recoveryFor(reason)`. The handler ctx the service receives already carries the calling tool's contract, so each tool's own recovery wording reaches the wire without a catch in the handler. A 4xx gets no `api_*` reason; its message carries upstream's `detail` instead (or its `message` when a body has no `detail`, as the mixed-award-type 422 does), read from a 4 KiB capture of the body because the framework's default 500-byte capture elides a longer one mid-string (the largest `detail` body seen runs 1,430 bytes, and the framework logs the body it reads on every non-2xx, so the capture stays small).

**Date inputs advertise their shape, and a half-open range is filled.** Each date input is `anyOf ["", ^\d{4}-\d{1,2}-\d{1,2}$]`: a malformed date fails argument validation before any request, while `""` — what form clients send for an untouched field, including both inner fields of `time_period` — reads as absent, so a fully blank `time_period` is no date filter, as it was before the pattern existed. A whitespace-only value reads as blank for the same reason (a lone one was dropped like any blank), while a whitespace-padded date fails the pattern. Unpadded month and day stay accepted because the analytics endpoints always took them, and the handlers pad before sending. The endpoints need both ends of a range, so a lone start runs through today in UTC and a lone end from 2007-10-01, echoed as sent with a notice naming the omitted field by the path the other came in on (`filters.time_period_*` or `time_period.*_date`) — dropping it had returned unfiltered results labelled as filtered. The filled bound never inverts the range: a lone start after today closes on itself, and a lone end before the floor opens on itself and draws the floor rejection. On all four tools, a range supplied with both ends and a start after the end fails as `date_range_inverted`, and a resolved start before 2007-10-01 fails as `date_before_earliest`, both before any request — upstream would answer the first with a retryable-looking HTML 500 or, on award search, ignore the range while the echo claimed it, and the second with an undeclared 422.

**Award search sort follows the award type group.** `sort` has no schema default; the handler resolves the group from the effective `award_type_codes` and defaults to `Loan Value` for loans, `Award Amount` otherwise, requesting the loan fields only for loans. A sort outside the group's list fails as `unsupported_sort` before the request, naming the group's sorts, because upstream's 400 names only its internal mapping. Codes spanning groups skip the check and send the sort unchanged, since upstream's own 422 for mixed groups is the accurate answer. The flat `award_type_codes` takes `.min(1)` because an empty array there reaches upstream's 422; the nested `filters.award_type_codes` does not, because an empty nested array falls back to the flat value, as the other nested array filters do — a form client's untouched field keeps working.

**Nested input objects are strict.** The framework rejects an undeclared key at the input root only; a nested `z.object()` strips one, so a misspelled or unsupported filter (`filters.keyword` on the analytics tools, `filters.recipient_id` on award search) vanished and the call answered unfiltered with no sign of it. Every nested object — `filters`, `time_period`, and `location_filter` on `usaspending_search_awards`, and `filters` on the three analytics tools and `usaspending_disaster_spending` — declares `.strict()` directly after `z.object({...})` and before `.describe()` (after it, the description is lost), so the framework rejects the key with `-32602` `invalid_arguments`, naming its path and the keys that object accepts. Calls made only of declared keys, blanks included, are unchanged.

**Award search normalizes `location_filter` to the one shape upstream matches.** Upstream 422s on a missing country or a 5-digit county and answers an empty page for a FIPS-number state or a territory's ISO code. The 5-digit county is what `usaspending_spending_by_geography` returns as a county `shape_code`, so callers reach for it naturally. The handler therefore rewrites every unambiguous form: an omitted country becomes `USA`, `PRI`/`GUM`/`VIR`/`ASM`/`MNP` become `USA` plus `PR`/`GU`/`VI`/`AS`/`MP`, a 2-digit FIPS state becomes its postal code, and a 5-digit county splits into its 3-digit code, setting the state from its prefix when `state` is omitted. A letter state under another country is that country's own subdivision code, which upstream matches (`CAN` + `ON` returns Ontario rows), so it passes through uppercased. It rejects the rest before the request as `invalid_location`: an unknown US state, a 3-digit county without a state, a county or FIPS-number state under a non-USA country, a county (3- or 5-digit) with an armed-forces state, and parts that place the location in different states. The postal ↔ FIPS table (50 states, DC, AS, GU, MP, PR, VI, the freely associated FM, MH, PW, and UM) lives in `locations.ts`; the armed-forces codes AA, AE, and AP, which upstream also files under USA, are accepted as postal codes with no FIPS. The three code fields advertise `anyOf ["", pattern]` like the date inputs, so a malformed shape — a 2-letter country, a non-numeric or 4-digit county — fails argument validation and is never sent; a blank still means unset. The location sent is echoed as `applied_location` and named in the empty-result notice.

**`assistance_listings` rejects contract and IDV codes rather than switching the default.** Upstream returns an empty page with no message for that pairing, which reads as "no awards under this listing". Defaulting to grants instead would silently drop the direct payments and loans that also carry listings, so the tool fails as `assistance_listings_type_mismatch` and asks for an assistance group.

**The code filters share one schema and one type rule across award search and the analytics tools.** `assistance_listings`, `psc_codes`, and `def_codes` are one Zod instance per key in `filters.ts`, spread into the analytics `filters`, award search's nested `filters`, and award search's flat inputs, so `tools/list` describes them identically and award search accepts an analytics `filters` object unchanged except `recipient_id`. PSC and DEF codes are uppercased and an empty list is unset, because upstream 422s on lowercase codes and on `[]`. Upstream answers `program_numbers` under contract/IDV-only types, and `psc_codes` under assistance-only types, with $0 and no message, so both are rejected before the request: `assistance_listings_type_mismatch` and `psc_codes_type_mismatch`. The analytics tools reject only when every effective award type is the wrong kind (their types may mix groups, and no `award_type_codes` means every type, except `usaspending_spending_over_time`, whose contract default counts), and an unrecognized code is left to upstream. Award search keeps its any-code rule, since a mixed group fails there anyway. DEF codes are not checked locally: the valid set grows with each emergency appropriation, and upstream's 400 for an unknown code lists the current set, which reaches the caller verbatim. PSC takes the list form only; the `{require, exclude}` tree form needs tier names (`Service`, `Product`) that `usaspending_autocomplete_filters` does not return, and over the list form it adds only `exclude`.

**Disaster breakdown totals are relayed, never computed.** The agency, cfda, and recipient breakdowns return a `totals` object for the whole result set, which the tool surfaces as-is; summing a page of rows would cover only that page and cannot produce budgetary resources. Members vary — `spending_type: total` on the agency breakdown carries `total_budgetary_resources`, award-level responses carry `award_count` — and geography returns none, so absent members stay absent.

---

## API Reference

### Award search filter object

Key filter fields for `usaspending_search_awards`, `usaspending_spending_by_category`, etc.:

| Field | Type | Notes |
|:------|:-----|:------|
| `keywords` | `string[]` | Full-text search across award descriptions, recipient names, and locations |
| `award_type_codes` | `string[]` | `A/B/C/D` = contracts, `IDV_A/IDV_B/IDV_B_A/IDV_B_B/IDV_B_C/IDV_C/IDV_D/IDV_E` = IDVs, `02/03/04/05/F001/F002` = grants, `06/10/F006/F007` = direct payments, `07/08/F003/F004` = loans, `09/11/-1/F005/F008/F009/F010` = other assistance (the partition `spending_by_award`'s mixed-group 422 lists in `award_type_groups`, which labels the last two groups the other way round). `spending_by_award` takes one group per request (422 with a `message`, not a `detail`, otherwise; `[]` also 422s), while the analytics endpoints accept mixed groups, and checks `sort` against that group's field mapping: loans sort by `Loan Value`, `Subsidy Cost`, `Issued Date`, `Recipient Name`, `Awarding Agency`; IDVs have no `End Date`; the rest share the contract list. The sort key must also be among the requested `fields` |
| `program_numbers` | `string[]` | Assistance Listing (CFDA) numbers, exact match, ORed; matches an award carrying the listing anywhere in its listings, not only as primary. Contracts and IDVs never match and upstream says nothing — 200 with zero rows on `spending_by_award`, $0 on the analytics endpoints. Exposed on `usaspending_search_awards` and the three analytics tools as `assistance_listings` |
| `time_period` | `{start_date, end_date}[]` | `YYYY-MM-DD`; earliest 2007-10-01 on `spending_by_award` and all three analytics endpoints (each 422s earlier). Every element needs both ends. `spending_by_award` answers an unpadded `2024-1-1` with an empty-bodied 503 (the analytics endpoints accept it), so the tools pad month and day before sending. An inverted range draws an HTML 500 from the analytics endpoints and is ignored by `spending_by_award`, so the tools reject it before sending |
| `agencies` | `{type, tier, name}[]` | `type`: `awarding` or `funding`; `tier`: `toptier` or `subtier` |
| `recipient_search_text` | `string[]` | Recipient name search within filter |
| `recipient_id` | `string` | Exact recipient hash ID. `spending_by_award` silently ignores it (returns it in the response `messages` as unused), so `usaspending_search_awards` rejects `filters.recipient_id`; filter by recipient name via `recipient_search_text` there |
| `naics_codes` | `{require, exclude}` | NAICS code arrays |
| `psc_codes` | `string[]` or `{require, exclude}` | List form: 1–4 uppercase alphanumerics, ORed, where a prefix covers the codes under it (`Y1` covers `Y1NE`); lowercase and `[]` 422. Tree form: arrays of tier paths starting at `Research and Development`, `Service`, or `Product` (422 otherwise). Assistance awards never match — $0 or zero rows, no message. The tools send the list form, as `psc_codes` |
| `def_codes` | `string[]` | Disaster Emergency Fund Codes (`Z`, `L`–`P`, `AAA`…), ORed, any award type. An unknown code is a 400 whose `detail` lists the valid set; `[]` 422s. On the analytics endpoints, COVID-19 and IIJA codes count only transactions on or after the law's enactment; on `spending_by_award` they match awards with a File C record for the code. Totals can be negative. Exposed as `def_codes` on `usaspending_search_awards`, the three analytics tools, and `usaspending_disaster_spending` |
| `place_of_performance_locations` | `{country, state, county, city}[]` | Place of performance filter. `country` is required and must be 3 characters (422 otherwise); `county` must be exactly 3 digits and needs `state` (422 otherwise). `state` matches the postal code, case-insensitively. Territories, the freely associated states (`FM`, `MH`, `PW`), the Minor Outlying Islands (`UM`), and the armed-forces codes (`AA`, `AE`, `AP`) are recorded as `country: "USA"` plus their postal `state`. A FIPS-number state (`"35"`), a territory's ISO code as country (`PRI`), a non-numeric county, and an unknown state all answer 200 with zero rows; a letter state under another country matches that country's subdivision (`CAN` + `ON`), and a county there 422s without a state. `usaspending_search_awards` normalizes to this shape or fails as `invalid_location` |
| `recipient_locations` | `{country, state, county, city}[]` | Recipient address filter, with the same location object as `place_of_performance_locations` |

### Pagination

Search and list endpoints return `page_metadata.has_next` and `page_metadata.page`. Use `limit` (max 100) and `page` parameters.

A total count is not universal, so `has_next` is the only continuation signal every paginated tool carries. These endpoints publish no total, and the corresponding tools omit `page_metadata.total` entirely:

| Endpoint | Tool |
|:---------|:-----|
| `search/spending_by_award/` | `usaspending_search_awards` |
| `transactions/` | `usaspending_get_award_transactions` |
| `subawards/` | `usaspending_get_award_subawards` |
| `search/spending_by_category/{category}/` | `usaspending_spending_by_category` |
| `idvs/awards/` | `usaspending_get_idv_awards` |

Among the endpoints that do publish one, `awards/accounts/` and `federal_accounts/` name it `count` rather than `total`, and `disaster/recipient/spending/` reports a 10,000 ceiling rather than a count — `usaspending_disaster_spending` discloses the cap on the response.

`disaster/spending_by_geography/` is not paginated: it returns every area whatever paging the request carries (960 counties for `def_codes: ["L"]`, 3,189 for `["N"]`). `usaspending_disaster_spending` ranks the whole set by `aggregated_amount` descending, ties by `shape_code`, and slices page `page` of size `limit`; `total` counts every area, including the unattributed row (null `shape_code`), and `has_next` is `page × limit < total`. Each page re-fetches the full set. While `has_next` is true the response sets `truncated` / `shown` / `cap` and `truncationCeiling`, the lowest amount shown and an upper bound on every later page. No geography totals are computed.

Two signals, kept apart. `has_next` is the continuation hint and may be conservative: `usaspending_search_awards` and `usaspending_get_idv_awards` report it on any full page, because `search/spending_by_award/` under-reports `hasNext` past a 10,000-result offset. `truncated` (with `shown` and `cap`) means rows are known to exist beyond those returned — an upstream `hasNext: true`, more rows received than returned, or a known upstream ceiling — so an exactly-full final page carries `has_next` without `truncated`. `usaspending_autocomplete_filters` requests one row past `limit` to tell the two apart; at `limit: 500`, the most every autocomplete route accepts, a full page sets no `truncated` and its `notice` says the upstream maximum was reached.

`usaspending_search_awards` compensates for the missing total with a cursor: its `page_metadata` carries `last_record_unique_id` + `last_record_sort_value` on every page with a next page below a 10,000-result offset, where the upstream stops emitting the pair. Page-number paging caps at a 50,000-result offset (`page` × `limit`); past that boundary, continue with keyset (after-cursor) pagination by passing those two cursor values back — page is omitted when the cursor is supplied.

### Spending level parameter

Several search endpoints accept `spending_level`:
- `awards` (default) — one row per award
- `transactions` — one row per transaction/modification  
- `subawards` — one row per subaward

### Geography scope values

`usaspending_spending_by_geography` accepts:
- `scope`: `place_of_performance` or `recipient_location`
- `geo_layer`: `state`, `county`, or `district`

The endpoint is not paginated — it returns every matching area in one response, and a nationwide
`county` query matches over 3,000 of them. Areas are ranked by `aggregated_amount` descending and
capped client-side at `limit` (default 50, max 500), with `total_areas_available` reporting the full
match count. The cap stays at 500; an area ranked past it is reached with `shape_codes`, which keeps
only the listed areas, in the `shape_code` form each layer returns: a postal code for `state` (`NY`),
a 5-digit state + county FIPS code for `county` (`36117`), and a 4-digit state FIPS + district number
for `district` (`3623`, or `5600` for an at-large seat). Selection runs client-side over the full
aggregate the response already carries, before ranking and the cap, so it costs no second request;
a listed code that matches no area is named in the notice. Upstream's `geo_layer_filters` is not
used — the server already holds every area, and selecting locally behaves the same on every layer.
The endpoint also rejects an empty `filters` object with HTTP 500, so a call supplying no filters
at all defaults `award_type_codes` to the complete set rather than to contracts alone — contracts
account for roughly 15% of total federal obligations, and a narrower default would undercount
silently. The substitution is disclosed on the response.

---

## Known Limitations

- **DoD data lag**: Department of Defense contract data has a mandatory 90-day publication delay. Recent DoD awards will not appear in search results.
- **Search window floor**: Award search is limited to 2007-10-01 onward. Pre-FY2008 data requires bulk download (async ZIP), which is out of scope for interactive MCP queries.
- **No geocoding**: The API takes FIPS codes and state postal codes, not place names. Agents need to resolve location names externally (e.g., via the Census or OpenStreetMap servers) before applying `location_filter` or `shape_codes`.
- **No full-text in descriptions**: Contract descriptions (PIID descriptions) are often cryptic government shorthand (e.g., "IGF::OT::IGF AFSOC ACTS..."). Keyword search works, but description-based interpretation may require domain knowledge.
