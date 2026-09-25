<div align="center">
  <h1>@cyanheads/usaspending-mcp-server</h1>
  <p><b>Access US federal award, recipient, agency, and spending analytics data from USAspending.gov via MCP. STDIO or Streamable HTTP.</b>
  <div>18 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/usaspending-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/usaspending-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/usaspending-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Federal award, recipient, agency, and spending data from USAspending.gov, the US Treasury's DATA Act transparency platform. Search and trace awards down to transactions, subawards, and funding accounts; profile recipients and agencies; and aggregate spending by geography, category, time, and disaster appropriation. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `usaspending_list_agencies` | List every top-tier federal agency with its toptier code, slug, and current-year budget totals |
| `usaspending_autocomplete_filters` | Look up NAICS, PSC, CFDA, agency, or recipient codes from a free-text description |
| `usaspending_search_awards` | Search awards by keyword, recipient, agency, award type, NAICS code, assistance listing, location, or date range |
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

## Capability reference

### `usaspending_list_agencies` <sub>tool</sub>

- Takes only `sort` (`agency_name`, `budget_authority_amount`, `obligated_amount`, `outlay_amount`) and `order`; returns every agency in one unpaginated response
- Rows carry `toptier_code` and `agency_slug`, both accepted by `usaspending_get_agency`, plus current-year `budget_authority_amount`, `obligated_amount`, and `outlay_amount`

---

### `usaspending_autocomplete_filters` <sub>tool</sub>

- `type` (`naics`, `psc`, `cfda`, `awarding_agency`, `recipient`) plus `search_text`; `limit` 1–500, default 10
- Rows carry `code` and `name`, with `id` for agencies and `uei` / `duns` for recipients; no match fails as `no_match`. A `cfda` code is what `usaspending_search_awards` takes in `assistance_listings`
- `naics` matches official NAICS title text: "software" resolves, "cybersecurity" does not, so search with the industry term a title would use

---

### `usaspending_search_awards` <sub>tool</sub>

- Filters: `keyword`, `agency_name`, `recipient_name`, `naics_codes`, `assistance_listings`, `time_period`, and `location_filter` (country, state, FIPS county, city); `award_type_codes` defaults to contracts (`A`–`D`) and must stay in one group: IDVs `IDV_A`–`IDV_E`, grants `02`–`05`/`F001`/`F002`, direct payments `06`/`10`/`F006`/`F007`, loans `07`/`08`/`F003`/`F004`, or other assistance `09`/`11`/`-1`/`F005`/`F008`/`F009`/`F010`. `limit` up to 100
- `assistance_listings` takes Assistance Listing (CFDA) numbers such as `93.866` or `11.67A` — look them up with `usaspending_autocomplete_filters` `type: cfda` — and matches awards carrying any of them. It needs an assistance group in `award_type_codes`; with contract or IDV codes, or the contract default, it fails as `assistance_listings_type_mismatch`
- `sort` depends on the award type group: loans sort by `Loan Value` (default), `Subsidy Cost`, `Issued Date`, `Recipient Name`, or `Awarding Agency`; every other group by `Award Amount` (default), `Total Outlays`, `Start Date`, `End Date`, `Recipient Name`, or `Awarding Agency`, except that IDVs have no `End Date`. Any other pairing fails as `unsupported_sort` with the group's list
- Dates are `YYYY-MM-DD` from 2007-10-01 on (month and day may be unpadded). Either end may be given alone, on the nested `filters.time_period_start` / `time_period_end` or by leaving one side of `time_period` blank (`""`) — a lone start runs through today (UTC), a lone end from 2007-10-01 — and the response echoes the range sent with a `notice` naming the filled field. A fully blank `time_period` means no date filter. A start after the end fails as `date_range_inverted`
- Rows carry `generated_internal_id` for `usaspending_get_award` and `agency_slug` for `usaspending_get_agency`; loan rows carry `loan_value`, `subsidy_cost`, and `issued_date` in place of amounts and dates. There is no total, and `page_metadata.has_next` is true on any full page
- Page numbers stop at a 50,000-result offset (`pagination_limit_exceeded`); go further with the `last_record_sort_value` + `last_record_unique_id` cursor, which is only returned below a 10,000-result offset

---

### `usaspending_get_award` <sub>tool</sub>

- `award_id` is a `generated_unique_award_id`, the `generated_internal_id` from search; an unknown ID fails as `award_not_found`
- Returns `category`, `total_obligation`, `total_outlays`, `subaward_count`, NAICS / PSC or CFDA codes, and `account_obligations_by_defc`
- `recipient.recipient_id` chains to `usaspending_get_recipient` and `parent_award.generated_unique_award_id` to the parent IDV; `category: "idv"` awards list their children via `usaspending_get_idv_awards`

---

### `usaspending_get_award_transactions` <sub>tool</sub>

- `award_id` plus `sort` (`action_date`, `federal_action_obligation`, `modification_number`); `limit` up to 100
- Rows carry `action_date`, `modification_number`, `action_type`, and a signed `federal_action_obligation` (negative is a deobligation)

---

### `usaspending_get_award_subawards` <sub>tool</sub>

- `award_id` plus `sort` (`subaward_number`, `description`, `action_date`, `amount`, `recipient_name`); `limit` up to 100
- Rows carry `subaward_number`, `amount`, `action_date`, `recipient_name`, `recipient_uei`, and place of performance; `subaward_count` on `usaspending_get_award` says whether any exist

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

- `keyword` matches names, UEI, or DUNS, partial matches included; optional `award_type` scopes the totals; `limit` up to 100
- Rows carry `id` (a hash suffixed `-P` parent, `-C` child, or `-R` standalone) for `usaspending_get_recipient`, plus `uei`, `duns`, `recipient_level`, and `amount`; `page_metadata.total` is the full match count

---

### `usaspending_get_recipient` <sub>tool</sub>

- `recipient_id` from `usaspending_search_recipients` or `usaspending_get_award`; optional `fiscal_year` (2001–2030) and `award_type` scope the totals; an unknown ID fails as `recipient_not_found`
- Returns address, `business_types`, `parent_name` / `parent_uei`, `alternate_names`, `total_transaction_amount`, `total_transactions`, and loan face-value totals

---

### `usaspending_get_agency` <sub>tool</sub>

- One of `toptier_code` (e.g. `097`) or `agency_slug` (e.g. `department-of-defense`); `page` walks the sub-agency list 10 at a time. Failures are `missing_input` and `agency_not_found`
- Returns `mission`, plus `budgetary_resources_amount`, `obligated_amount`, and `outlay_amount` for the latest `fiscal_year`, `sub_agencies` with obligations and transaction and new-award counts, and `def_codes`

---

### `usaspending_spending_by_geography` <sub>tool</sub>

- `scope` (`place_of_performance`, `recipient_location`) and `geo_layer` (`state`, `county`, `district`) are required; `filters` takes `keywords`, `award_type_codes`, `agency_name`, `recipient_id`, `naics_codes`, and `time_period_start` / `time_period_end` (`YYYY-MM-DD`; either alone fills the other, as in `usaspending_search_awards`, `applied_time_period_*` echoes the range sent, a start after the end fails as `date_range_inverted`, and a range starting before 2007-10-01 fails as `date_before_earliest`); `limit` 1–500, default 50
- Rows carry `shape_code`, `display_name`, `aggregated_amount`, `population`, `per_capita`, and `award_count`, ranked by amount; `total_areas_available` counts every match before the cap
- With no filters, every award type is aggregated and `applied_award_type_default` says so; `subawards: true` switches to subaward data

---

### `usaspending_spending_by_category` <sub>tool</sub>

- `category` is `naics`, `psc`, `awarding_agency`, `awarding_subagency`, `funding_agency`, `funding_subagency`, `cfda`, `recipient_duns`, or `recipient_parent_duns`; takes the same `filters` object as `usaspending_spending_by_geography`; `limit` up to 100
- Rows carry `id`, `code`, `name`, and `amount`, ranked by obligation

---

### `usaspending_spending_over_time` <sub>tool</sub>

- `group` is `fiscal_year`, `quarter`, or `month` (fiscal month, where 1 is October); the same `filters` object, with `award_type_codes` defaulting to contracts and limited to one group; `subawards: true` switches to subaward data
- Rows carry `time_period`, `aggregated_amount`, and per-type `contracts`, `grants`, `direct_payments`, `idvs`, `loans`, and `other`

---

### `usaspending_disaster_spending` <sub>tool</sub>

- `dimension` is `overview`, `agency`, `cfda`, `recipient`, or `geography`; every dimension except `overview` requires `filters.def_codes` (e.g. `["L", "M", "N", "O", "P"]` for COVID-19); `limit` up to 100 on agency, cfda, and recipient
- Rows carry `obligation`, `outlay`, and `award_count`, plus `total_budgetary_resources` on agency rows under `spending_type: total`; `overview` returns totals and `funding_by_def_code`. A recipient row's `id` is one recipient hash for `usaspending_get_recipient` — the recipient-level `-R` ID when USAspending lists several. The recipient total tops out at 10,000, and a response at that cap is flagged `truncated`
- Agency, cfda, and recipient also return `totals` for every matching row, as USAspending reports them: `obligation`, `outlay`, and either `total_budgetary_resources` (agency, `total`) or `award_count`. When the overview endpoint outlasts the request budget, the agency breakdown with `spending_type: total` still reports obligations, outlays, and budgetary resources
- `spending_type` (`award`, the default, or `total`) applies to the agency dimension only — USAspending returns the same recipient breakdown for either value; geography takes `filters.geo_layer` (`state`, `county`) and always reports obligations

---

### `usaspending_search_federal_accounts` <sub>tool</sub>

- Optional `keyword` and 3-digit `agency_identifier`; `sort_field` is `account_name`, `account_number`, `budgetary_resources` (default), or `managing_agency`; `limit` up to 100
- Rows carry `account_number` (e.g. `097-8097`) for the federal-account tools, `managing_agency`, and `budgetary_resources`; `page_metadata.count` is the total

---

### `usaspending_get_federal_account` <sub>tool</sub>

- `account_code` in AGENCY-MAIN format, from `account_number` in search results or `federal_account` on an award; an unknown code fails as `account_not_found`
- Returns `total_obligated_amount`, `total_gross_outlay_amount`, and `total_budgetary_resources` for `fiscal_year`, plus `children`: one entry per Treasury Account Symbol with its own amounts

---

### `usaspending_get_federal_account_breakdown` <sub>tool</sub>

- `account_code` plus `dimension` (`program_activity` or `object_class`); `limit` up to 100, with `page_metadata.total` as the row count
- Rows carry `code`, `name`, and `obligations`; `program_activity` rows add `type`, either `PAC/PAN` or `PARK`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

USAspending-specific:

- USAspending.gov API v2, keyless: the data is public under the DATA Act
- Award search and the spending analytics tools cover action dates from 2007-10-01 on (an earlier start date fails as `date_before_earliest`), and DoD contract data lags publication by 90 days
- `usaspending_spending_by_category` puts nine category sub-routes behind one `category` enum, and `usaspending_disaster_spending` puts five disaster endpoints behind `dimension`
- Each request runs under a per-attempt timeout and a wall-clock retry budget; failures surface as `api_timeout` or `api_unavailable` with each tool's recovery hint, and a rejected request carries USAspending's own explanation in the error message

Agent-friendly output:

- Chaining IDs as explicit fields: `generated_internal_id`, `agency_slug`, `recipient.recipient_id`, `federal_account`, and `account_number`, so agents follow the money without parsing display strings
- Honest pagination: `page_metadata.has_next` on every list, a `total` or `count` where the upstream publishes one, and `truncated` / `shown` / `cap` when a response is capped
- Empty results are notices, not errors: an empty page carries a `notice` echoing the filters and how to broaden them. The ID-keyed list tools (transactions, subawards, funding accounts, IDV children, account breakdown) return an empty list for an unknown ID rather than failing
- Typed failures with recovery hints: `award_not_found`, `recipient_not_found`, `agency_not_found`, `account_not_found`, `no_match`, `date_before_earliest`, `date_range_inverted`, `unsupported_sort`, `assistance_listings_type_mismatch`, `pagination_limit_exceeded`

## Getting started

### Public Hosted Instance

A public instance is available at `https://usaspending.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "usaspending-mcp-server": {
      "type": "streamable-http",
      "url": "https://usaspending.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. No API key is required.

```json
{
  "mcpServers": {
    "usaspending-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/usaspending-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "usaspending-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/usaspending-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "usaspending-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/usaspending-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account: USAspending.gov is open to anonymous requests.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/usaspending-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd usaspending-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env if you need to override defaults
```

## Configuration

No variable is required; the defaults work out of the box.

| Variable | Description | Default |
|:---|:---|:---|
| `USASPENDING_BASE_URL` | USAspending.gov API v2 base URL. | `https://api.usaspending.gov/api/v2/` |
| `USASPENDING_TIMEOUT_MS` | Per-attempt HTTP timeout, in ms (1000–120000). | `30000` |
| `USASPENDING_RETRY_BUDGET_MS` | Wall-clock budget for one request across all retry attempts, in ms (1000–300000). | 1.5 × `USASPENDING_TIMEOUT_MS` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

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
docker build -t usaspending-mcp-server .
docker run --rm -p 3010:3010 usaspending-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/usaspending-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

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
