<div align="center">
  <h1>@cyanheads/usaspending-mcp-server</h1>
  <p><b>Access US federal award, recipient, agency, and spending analytics data from USAspending.gov via MCP. STDIO or Streamable HTTP.</b>
  <div>18 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.7.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/usaspending-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/usaspending-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/usaspending-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/usaspending-mcp-server/releases/latest/download/usaspending-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=usaspending-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdXNhc3BlbmRpbmctbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22usaspending-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fusaspending-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://usaspending.caseyjhand.com/mcp](https://usaspending.caseyjhand.com/mcp)

</div>

---

## Overview

Where federal money goes, from USAspending.gov: awards, recipients, agencies, and spending. Search and trace awards down to transactions, subawards, and funding accounts; profile recipients and agencies; and aggregate spending by geography, category, time, and disaster appropriation.

### Tools

| Tool | Description |
|:---|:---|
| `usaspending_list_agencies` | List top-tier federal agencies with codes, slugs, and budget totals labelled by reporting year and quarter |
| `usaspending_autocomplete_filters` | Look up NAICS, PSC, CFDA, agency, or recipient codes from a free-text description |
| `usaspending_search_awards` | Search awards by keyword, recipient, agency, award type, NAICS code, assistance listing, PSC, DEF code, location, or date range |
| `usaspending_get_award` | Fetch one award's full record: amounts, recipient, agencies, codes, parent IDV, DEF-code funding |
| `usaspending_get_award_transactions` | List the transactions (modifications, amendments) on an award |
| `usaspending_get_award_subawards` | List the subcontracts or subgrants under a prime award |
| `usaspending_get_award_federal_accounts` | List the Treasury federal accounts that funded an award, with the amount from each |
| `usaspending_get_idv_awards` | List the child orders and sub-IDVs placed under an IDV |
| `usaspending_search_recipients` | Search recipients by name, UEI, or DUNS |
| `usaspending_get_recipient` | Fetch a recipient's profile: address, business types, parent, and award totals |
| `usaspending_get_agency` | Fetch an agency's mission, latest-year budget totals, sub-agencies, and DEF codes |
| `usaspending_spending_by_geography` | Aggregate spending by state, county, or congressional district |
| `usaspending_spending_by_category` | Aggregate spending by NAICS, PSC, agency, CFDA program, or recipient |
| `usaspending_spending_over_time` | Aggregate spending by fiscal year, quarter, or month |
| `usaspending_disaster_spending` | Break down disaster and emergency supplemental spending by agency, program, recipient, or geography |
| `usaspending_search_federal_accounts` | Search federal accounts by title keyword or agency identifier |
| `usaspending_get_federal_account` | Fetch a federal account's budget totals and its Treasury Account Symbol components |
| `usaspending_get_federal_account_breakdown` | Break a federal account's obligations down by program activity or object class |

### Research guide

The [usaspending-guide](./skills/usaspending-guide/SKILL.md) covers recipient research, award-to-account funding traces, and spending comparisons across periods and emergency appropriations. Plugin installs discover it in `skills/`; MCP clients can read `skill://usaspending-guide/SKILL.md` through the Skills extension. There are no domain-data resources.

## Capability reference

### `usaspending_list_agencies` <sub>tool</sub>

- Takes `sort` (`agency_name`, `budget_authority_amount`, `obligated_amount`, `outlay_amount`) and `order`; returns every agency unless an optional positive `limit` is supplied. With `limit`, `page` defaults to 1; without it, `page` is ignored. `total` always counts the full directory and `has_next` appears only when paginating
- Rows carry `toptier_code` and `agency_slug`, both accepted by `usaspending_get_agency`, plus `budget_authority_amount`, `obligated_amount`, and `outlay_amount` for the latest reported period. `fiscal_year` and `fiscal_quarter` preserve the provider's reporting labels when present

---

### `usaspending_autocomplete_filters` <sub>tool</sub>

- `type` (`naics`, `psc`, `cfda`, `awarding_agency`, `recipient`) plus `search_text`; `limit` 1–500, default 10
- Rows carry `code` and `name`, and `uei` / `duns` for recipients; no match fails as `no_match`. A `cfda` code goes in `assistance_listings` and a `psc` code in `psc_codes` on `usaspending_search_awards` and the three spending analytics tools
- Agency rows carry the matched agency's own `name`, `abbreviation`, and `tier` (`toptier` or `subtier`), its parent's `toptier_name` and `toptier_code`, and `subtier_code` when supplied. Pass `name` to `agency_name` on award search or spending analytics to match that agency; pass `toptier_name` for the whole department. Agency results combine top-tier then sub-tier matches under one `limit`; office matches are excluded
- `naics` matches official NAICS title text: "software" resolves, "cybersecurity" does not, so search with the industry term a title would use

---

### `usaspending_search_awards` <sub>tool</sub>

- Filters: `keyword`, `agency_name`, `recipient_name`, `naics_codes`, `assistance_listings` (Assistance Listing numbers such as `93.866`, from `usaspending_autocomplete_filters` `type: cfda`), `psc_codes` (1–4 characters, where a prefix such as `Y1` covers the codes under it; contracts and IDVs only), `def_codes` (Disaster Emergency Fund Codes such as `Z`; PSC and DEF codes are sent uppercased), `time_period` (`YYYY-MM-DD` from 2007-10-01 on; either end may be given alone), and `location_filter` (`country` defaults to `USA`, and a territory code such as `PRI` becomes `USA` plus its state; `state` as a postal or 2-digit FIPS code, `FM`/`MH`/`PW`/`UM` and armed-forces `AA`/`AE`/`AP` included, or under another country as that country's own 2-letter subdivision code such as `ON` with `CAN`; `county` as 3 digits with `state` or the 5-digit FIPS code alone; echoed as `applied_location`); `award_type_codes` defaults to contracts (`A`–`D`) and must stay in one group: IDVs `IDV_A`–`IDV_E`, grants `02`–`05`/`F001`/`F002`, direct payments `06`/`10`/`F006`/`F007`, loans `07`/`08`/`F003`/`F004`, or other assistance `09`/`11`/`-1`/`F005`/`F008`/`F009`/`F010`; `limit` up to 100
- Rows carry `generated_internal_id` for `usaspending_get_award` and `agency_slug` for `usaspending_get_agency`; loan rows carry `loan_value`, `subsidy_cost`, and `issued_date` in place of amounts and dates. There is no total, and `page_metadata.has_next` is true on any full page. The nested `filters` object takes the analytics tools' `filters` keys, except `recipient_id`, and wins per field over the flat ones. Failures are `assistance_listings_type_mismatch` (listings with a non-assistance group), `psc_codes_type_mismatch` (PSC codes with an assistance group), `unsupported_sort`, `date_range_inverted`, `date_before_earliest`, and `invalid_location` (an unknown state, a 3-digit county without a state, a county under an armed-forces code (`AA`/`AE`/`AP`), a county or FIPS-number state under another country, or parts naming different states)
- `sort` depends on the group: loans take `Loan Value` (default), `Subsidy Cost`, `Issued Date`, `Recipient Name`, or `Awarding Agency`; the others `Award Amount` (default), `Total Outlays`, `Start Date`, `End Date` (not IDVs), `Recipient Name`, or `Awarding Agency`. Page numbers stop at a 50,000-result offset (`pagination_limit_exceeded`); past it, page with the `last_record_sort_value` + `last_record_unique_id` cursor, returned below a 10,000-result offset

---

### `usaspending_get_award` <sub>tool</sub>

- `award_id` is a `generated_unique_award_id`, the `generated_internal_id` from search; an unknown ID fails as `award_not_found`
- Returns `category`, `total_obligation`, `total_outlays`, `total_account_obligation`, `total_account_outlay`, `base_exercised_options`, `subaward_count`, NAICS / PSC codes, `account_obligations_by_defc`, `account_outlays_by_defc`, and, on loans, `total_loan_value` and `total_subsidy_cost`, where supplied
- `assistance_listings` lists every Assistance Listing on an assistance award, in upstream order, as `number`, `title`, and `obligation`; a `number` goes in `usaspending_search_awards` `assistance_listings`
- `recipient` carries `uei`, `parent_uei`, `business_categories` (category names, not the `business_types` codes of `usaspending_get_recipient`), and a three-letter `country_code`, `county_name`, `congressional_code`, and `zip5` on its `location`. `place_of_performance` also carries a country code, county name, and congressional code; a location with no fields upstream is omitted
- `recipient.recipient_id` and `recipient.parent_recipient_id` chain to `usaspending_get_recipient` and `parent_award.generated_unique_award_id` to the parent IDV; `category: "idv"` awards list their children via `usaspending_get_idv_awards`

---

### `usaspending_get_award_transactions` <sub>tool</sub>

- `award_id` plus `sort` (`action_date`, `federal_action_obligation`, `modification_number`); `limit` up to 100
- Rows carry a string `id` (`ASST_TX` or `CONT_TX`), `action_date`, `modification_number`, `action_type`, and a signed `federal_action_obligation` (negative is a deobligation). Loan transactions also carry `face_value_loan_guarantee` and `original_loan_subsidy_cost`; assistance transactions carry `cfda_number` when supplied

---

### `usaspending_get_award_subawards` <sub>tool</sub>

- `award_id` plus `sort` (`subaward_number`, `description`, `action_date`, `amount`, `recipient_name`); `limit` up to 100
- Rows carry `id`, `subaward_number`, `description`, `amount`, `action_date`, and `recipient_name`; the upstream listing supplies no recipient UEI or location. `subaward_count` on `usaspending_get_award` says whether any exist

---

### `usaspending_get_award_federal_accounts` <sub>tool</sub>

- `award_id` is a `generated_unique_award_id`; `limit` up to 100, with `page_metadata.count` as the total
- Rows carry `federal_account` (AGENCY-MAIN, e.g. `080-0120`) for `usaspending_get_federal_account`, `total_transaction_obligated_amount`, and the funding agency with its `funding_agency_slug`

---

### `usaspending_get_idv_awards` <sub>tool</sub>

- Parent IDV `award_id`; `type` is `child_awards` (task and delivery orders, the default), `child_idvs`, or `grandchild_awards`; `limit` up to 100
- Rows carry `generated_unique_award_id` for `usaspending_get_award`, `obligated_amount`, and performance dates; there is no total, and `has_next` is true on any full page

---

### `usaspending_search_recipients` <sub>tool</sub>

- `keyword` matches names, UEI, or DUNS, partial matches included; surrounding whitespace is trimmed, and blank text applies no keyword filter with a notice. Optional `award_type` still scopes the totals; `limit` up to 100
- Rows carry `id` (a hash suffixed `-P` parent, `-C` child, or `-R` standalone) for `usaspending_get_recipient`, plus `uei`, `duns`, `recipient_level`, and `amount`; `page_metadata.total` is the full match count

---

### `usaspending_get_recipient` <sub>tool</sub>

- `recipient_id` from `usaspending_search_recipients` or `usaspending_get_award`; optional `fiscal_year` (2001–2030) scopes the totals to that fiscal year, which otherwise cover the trailing 12 months; an unknown ID fails as `recipient_not_found`
- Returns address, `business_types`, `parent_name` / `parent_uei`, `alternate_names`, `total_transaction_amount`, `total_transactions`, and loan face-value totals, with `period` naming the window (`FY2020` or `trailing 12 months`). Totals span every award type; for totals by type, use `usaspending_spending_over_time` with `filters.recipient_id` and `award_type_codes`

---

### `usaspending_get_agency` <sub>tool</sub>

- One of `toptier_code` (e.g. `097`) or `agency_slug` (e.g. `department-of-defense`); `page` walks the sub-agency list 10 at a time. Failures are `missing_input`, `conflicting_input` (both identifiers sent), and `agency_not_found`
- Returns `mission`, plus `budgetary_resources_amount`, `obligated_amount`, and `outlay_amount` for the most recent `fiscal_year` with reported budget data (a newly opened year with no amounts yet is skipped), `sub_agencies` with obligations and transaction and new-award counts for that same year (`sub_agency_fiscal_year` names it; without a budget year within 5 seconds the breakdown covers the current fiscal year), and `def_codes`
- A failed budget or sub-agency request still returns the overview: the missing fields are omitted and `unavailable_sections` names each section with its `reason` (`api_unavailable`, `api_timeout`, or `upstream_error`) and whether a retry may load it

---

### `usaspending_spending_by_geography` <sub>tool</sub>

- `scope` (`place_of_performance`, `recipient_location`) and `geo_layer` (`state`, `county`, `district`) are required; `filters` takes `keywords`, `award_type_codes`, `agency_name`, `recipient_id`, `naics_codes`, `assistance_listings`, `psc_codes`, `def_codes` (the same code filters as `usaspending_search_awards`, echoed as `applied_*`), and `time_period_start` / `time_period_end` (`YYYY-MM-DD`; either alone fills the other, as in `usaspending_search_awards`, `applied_time_period_*` echoes the range sent, a start after the end fails as `date_range_inverted`, and a range starting before 2007-10-01 fails as `date_before_earliest`); `limit` 1–500, default 50
- Award types may mix groups. When every one named is a contract or IDV, `assistance_listings` fails as `assistance_listings_type_mismatch`; when every one is assistance, `psc_codes` fails as `psc_codes_type_mismatch`. Code-filtered amounts cover whole matching awards, and DEF-filtered totals can be negative
- Rows carry `shape_code`, `display_name`, `aggregated_amount`, `population`, and `per_capita`, ranked by amount; `total_areas_available` counts every match before the cap
- `shape_codes` (1–500) returns only the listed areas, in the `shape_code` form of the layer: postal code for `state` (`NY`), 5-digit state + county FIPS for `county` (`36117`), 4-digit state FIPS + district for `district` (`3623`). Selection runs over every matched area, so it reaches areas ranked past `limit`; the codes are echoed as `applied_shape_codes`, and a code that matches no area is named in the `notice`
- With no filters, every award type is aggregated and `applied_award_type_default` says so; `subawards: true` switches to subaward data

---

### `usaspending_spending_by_category` <sub>tool</sub>

- `category` is `naics`, `psc`, `awarding_agency`, `awarding_subagency`, `funding_agency`, `funding_subagency`, `cfda`, or `recipient_duns`; takes the same `filters` object as `usaspending_spending_by_geography`; `limit` up to 100
- Rows carry `id`, `code`, `name`, and `amount`, ranked by obligation; `recipient_duns` rows carry the DUNS as `code` plus `recipient_id` and `uei` when upstream has them, and `recipient_id` chains to `usaspending_get_recipient`

---

### `usaspending_spending_over_time` <sub>tool</sub>

- `group` is `fiscal_year`, `quarter`, or `month` (fiscal month, where 1 is October); the same `filters` object, with `award_type_codes` defaulting to contracts, so `assistance_listings` needs an assistance group named; `subawards: true` switches to subaward data
- Rows carry `time_period`, `aggregated_amount`, and per-type `contracts`, `grants`, `direct_payments`, `idvs`, `loans`, and `other`

---

### `usaspending_disaster_spending` <sub>tool</sub>

- `dimension` is `overview`, `agency`, `cfda`, `recipient`, or `geography`; `filters.def_codes` is optional for `overview` and required for every other dimension (`missing_def_codes` when absent/empty). Codes such as `["L", "M", "N", "O", "P"]` isolate COVID-19 funding and are echoed as `applied_def_codes`. `limit` is up to 100 on every dimension but `overview`; `spending_type` (`award`, the default, or `total`) applies to agency only, and geography takes `filters.geo_layer` (`state`, `county`)
- Rows carry `obligation`, `outlay`, and `award_count`, plus `total_budgetary_resources` on agency rows under `spending_type: total`; `overview` returns totals and `funding_by_def_code`. A recipient row's `id` chains to `usaspending_get_recipient`. Recipient `filters.query` narrows by search text; it is trimmed and echoed as `applied_query`, with blanks applying no query. A recipient total of 10,000 is a reachable ceiling and a lower bound on possible matches, flagged `truncated`; narrow with `filters.query` to reach the tail. Geography areas are ranked by `aggregated_amount` and paged with `limit` and `page`, with the full area count as `total`; a page with areas below it is flagged `truncated`, and `truncationCeiling` is the lowest amount shown. Spending with no recorded place of performance ranks as one unattributed area
- Agency, cfda, and recipient also return `totals` across every matching row: `obligation`, `outlay`, and either `total_budgetary_resources` (agency, `total`) or `award_count`. Overview can still time out with codes supplied: narrow `filters.def_codes`, retry later, or use the agency breakdown with `spending_type: total` for obligations, outlays, and budgetary resources
- Notices preserve upstream messages, ignored filters, cap guidance, and empty-page recovery on both output surfaces. `query` is ignored outside recipient, `geo_layer` outside geography, and `award_type_codes` on overview. An empty page whose offset reaches a positive total directs callers to an earlier page with the same filters; an empty interior page reports the total without claiming exhaustion, and an absent total stays unknown

---

### `usaspending_search_federal_accounts` <sub>tool</sub>

- Optional `keyword` and 3-digit `agency_identifier`; `sort_field` is `account_name`, `account_number`, `budgetary_resources` (default), or `managing_agency`; `limit` up to 100
- Rows carry `account_number` (e.g. `097-8097`) for the federal-account tools, `managing_agency`, and `budgetary_resources`; `page_metadata.count` is the total. Optional `fiscal_year` selects the reporting year; otherwise the provider uses its latest submission year. The returned `fiscal_year` identifies that period

---

### `usaspending_get_federal_account` <sub>tool</sub>

- `account_code` in AGENCY-MAIN format, from `account_number` in search results or `federal_account` on an award; an unknown code fails as `account_not_found`
- Optional `fiscal_year` selects the reporting year; otherwise the provider uses the current federal fiscal year. Returns `total_obligated_amount`, `total_gross_outlay_amount`, and `total_budgetary_resources` for the returned `fiscal_year`, plus `children`: one entry per Treasury Account Symbol with its own amounts. A year without financial data retains account metadata and a notice, without substituting another year

---

### `usaspending_get_federal_account_breakdown` <sub>tool</sub>

- `account_code` plus `dimension` (`program_activity` or `object_class`); `limit` up to 100, with `page_metadata.total` as the row count
- Rows carry `code`, `name`, and `obligations`; `program_activity` rows add `type`, either `PAC/PAN` or `PARK`
- Optional `fiscal_year` scopes financial reporting periods to October 1 through September 30, echoed in `time_period` and `period`. Omission covers `all available periods`

All three federal-account tools accept an integer `fiscal_year` from 2001 through the current federal fiscal year (which rolls over October 1); blank form values mean omitted. Search and detail budget totals use different upstream calculations and need not match even for the same year.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

USAspending-specific:

- USAspending.gov API v2, keyless: the data is public under the DATA Act
- Award search and the spending analytics tools cover action dates from 2007-10-01 on (an earlier start date fails as `date_before_earliest`), and DoD contract data lags publication by 90 days
- `usaspending_spending_by_category` puts eight category sub-routes behind one `category` enum, and `usaspending_disaster_spending` puts five disaster endpoints behind `dimension`
- Each request runs under one wall-clock budget (45 s by default); a slow answer gets the whole budget in one attempt, and only fast failures are retried. Failures surface as `api_timeout` or `api_unavailable` with each tool's recovery hint, and a rejected request carries USAspending's own explanation in the error message

Agent-friendly output:

- Chaining IDs as explicit fields: `generated_internal_id`, `agency_slug`, `recipient.recipient_id`, `federal_account`, and `account_number`, so agents follow the money without parsing display strings
- Honest pagination: `page_metadata.has_next` on every list, a `total` or `count` where the upstream publishes one, and `truncated` / `shown` / `cap` only when rows are known to exist beyond those returned. A full page with no such evidence keeps `has_next` without claiming truncation
- Empty results are notices, not errors: account funding, account breakdown, and recipient search distinguish a known zero total from an empty page past the total, which directs callers to an earlier page with the same filters. Without a total, notices describe only the page; award search never supplies a total. The ID-keyed list tools (transactions, subawards, funding accounts, IDV children, account breakdown) return an empty list for an unknown ID rather than failing
- Typed failures with recovery hints: `award_not_found`, `recipient_not_found`, `agency_not_found`, `account_not_found`, `no_match`, `conflicting_input`, `date_before_earliest`, `date_range_inverted`, `unsupported_sort`, `assistance_listings_type_mismatch`, `psc_codes_type_mismatch`, `invalid_location`, `pagination_limit_exceeded`, `incomplete_cursor`, `missing_def_codes`

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http usaspending-mcp-server https://usaspending.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add usaspending-mcp-server -- npx -y @cyanheads/usaspending-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "usaspending-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/usaspending-mcp-server"]
    }
  }
}
```

No API key or account is required. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

No variable is required; the defaults work out of the box.

| Variable | Description | Default |
|:---|:---|:---|
| `USASPENDING_BASE_URL` | USAspending.gov API v2 base URL. | `https://api.usaspending.gov/api/v2/` |
| `USASPENDING_TIMEOUT_MS` | Per-attempt HTTP timeout, in ms (1000–120000). Each attempt is cut at this or at the time left in the request budget, whichever is smaller; a timed-out attempt is not retried. | `45000` |
| `USASPENDING_RETRY_BUDGET_MS` | Wall-clock budget for one request, every attempt and backoff included, in ms (1000–300000). Fast failures such as a 503 retry inside it. | `45000`, or `USASPENDING_TIMEOUT_MS` when higher |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in OTLP log export endpoint; the base `OTEL_EXPORTER_OTLP_ENDPOINT` never enables it. | — |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+). No API key or account is required.

```sh
git clone https://github.com/cyanheads/usaspending-mcp-server.git
cd usaspending-mcp-server && bun install
cp .env.example .env # optional overrides
```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/usaspending-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/usaspending-mcp-server`. For stdio, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/usaspending-mcp-server:latest"]`. Build locally with `docker build -t usaspending-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the tools and initializes the USAspending service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`) plus shared filter, date, pagination, and formatting helpers. |
| `src/services/usaspending` | USAspending.gov API client: request timeouts, retry budget, raw response types. |
| `tests/` | Unit tests for tools, the service, config, and scripts. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
