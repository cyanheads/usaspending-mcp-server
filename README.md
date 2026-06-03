<div align="center">
  <h1>@cyanheads/usaspending-mcp-server</h1>
  <p><b>Access US federal award, recipient, agency, and spending analytics data from USAspending.gov via MCP. STDIO or Streamable HTTP.</b>
  <div>14 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.6-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/usaspending-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/usaspending-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/usaspending-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/usaspending-mcp-server/releases/latest/download/usaspending-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=usaspending-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdXNhc3BlbmRpbmctbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22usaspending-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fusaspending-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://usaspending.caseyjhand.com/mcp](https://usaspending.caseyjhand.com/mcp)

</div>

---

## Tools

14 tools covering the full USAspending.gov API surface — award discovery and detail, recipient and agency profiles, spending analytics (by geography, category, and time), disaster/emergency spending, and federal account data:

| Tool | Description |
|:---|:---|
| `usaspending_search_awards` | Search federal awards by keyword, recipient, agency, award type, NAICS code, location, or date range. Returns ranked award summaries with recipient names, amounts, agencies, and award IDs for chaining. |
| `usaspending_get_award` | Fetch full details of a federal award by its generated ID. Returns contract or assistance data, parent IDV info, subaward count, and funding account linkages. |
| `usaspending_get_award_transactions` | List individual transactions (modifications, amendments) on an award. Reveals spending history and obligation changes over time. |
| `usaspending_get_award_subawards` | List subaward contracts or grants under a prime award. Reveals the sub-contractor or sub-grantee layer — who actually does the work. |
| `usaspending_search_recipients` | Search for organizations receiving federal funds by name or UEI. Returns recipient IDs, total award amounts, and business type classifications. |
| `usaspending_get_recipient` | Fetch a recipient's profile: address, business types, parent organization, alternate names, and total award amounts by type. |
| `usaspending_get_agency` | Fetch an agency's fiscal year overview: mission, budget authority, obligation totals, sub-agency count, and DEF codes. Accepts a 3-digit `toptier_code` or an `agency_slug` from award search results. |
| `usaspending_spending_by_geography` | Aggregate federal spending by state, county, or congressional district. Returns per-capita figures when combined with population data. |
| `usaspending_spending_by_category` | Aggregate spending grouped by NAICS code, PSC code, awarding agency, funding agency, CFDA program, or recipient. Returns top items with amounts for trend and breakdown analysis. |
| `usaspending_spending_over_time` | Fetch aggregated spending by fiscal year, fiscal quarter, or calendar month. Filter by award type, agency, recipient, or keyword to trace trends in a specific area. |
| `usaspending_disaster_spending` | Fetch disaster and emergency supplemental spending (COVID-19, hurricanes, etc.) broken down by agency, CFDA program, recipient, or geography. Filter by DEF codes to isolate a specific appropriation. |
| `usaspending_get_federal_account` | Fetch a federal account's budget data: total obligations, outlays, program activities, and object class breakdown. Account codes appear in award funding details. |
| `usaspending_list_agencies` | List all top-tier federal agencies with toptier codes, budget authority amounts, and obligation totals. Entry point for agency navigation. |
| `usaspending_autocomplete` | Look up valid code values for filter fields: NAICS, PSC, CFDA, recipient names, or agency names. Use before filtering to discover the right code from a description. |

### `usaspending_search_awards`

Search for federal awards across contracts, grants, loans, direct payments, and IDVs.

- Full-text keyword search across award descriptions, recipient names, and locations
- Filter by award type codes (`A/B/C/D` = contracts, `02/03/04/05` = grants, `06/10` = direct payments, `07/08` = loans, `IDV_*` = IDVs)
- Filter by awarding or funding agency (toptier or subtier), recipient name or ID, NAICS code, PSC code, and place of performance
- Date range filtering — earliest 2007-10-01 via search API
- Pagination via `limit` (max 100) and `page`; `page_metadata.hasNext` signals more results
- Returns `generated_internal_id` for chaining to `usaspending_get_award` and `agency_slug` for chaining to `usaspending_get_agency`

---

### `usaspending_get_award`

Fetch complete details for a single federal award by its generated ID.

- Returns type, description, total obligation, date signed, and subaward count
- Exposes `recipient.recipient_hash` for chaining to `usaspending_get_recipient`
- Exposes `parent_award.generated_unique_award_id` for traversing IDV parent chains
- Includes NAICS code and product/service code from the latest transaction
- Returns `account_obligations_by_defc` linking the award to specific disaster/emergency appropriations
- Award IDs use the `generated_unique_award_id` format (e.g., `CONT_AWD_FA862118F6251_9700_...`)

---

### `usaspending_get_award_transactions`

List obligation history and modifications for an award.

- Each row is one transaction: `action_date`, `federal_action_obligation`, `modification_number`, and description
- Pagination via `limit` and `page`; configurable sort and order

---

### `usaspending_get_award_subawards`

List subawards under a prime contract or grant.

- Each row covers: subaward number, description, action date, amount, and recipient name
- Reveals the supply chain below the prime — who actually performs the work
- Pagination via `limit` and `page`; configurable sort and order

---

### `usaspending_search_recipients`

Search for organizations receiving federal funds by name or UEI.

- Returns recipient IDs (UUID hashes with level suffix: `-P` parent, `-C` child, `-R` root), UEI, DUNS, name, recipient level, and total award amount
- `results[].id` chains to `usaspending_get_recipient`; `uei` and `duns` chain to SAM.gov or SEC EDGAR

---

### `usaspending_get_recipient`

Fetch a recipient's full profile.

- Returns address, business type classifications, parent organization, alternate names
- Optionally scope to a specific fiscal year and award type
- Requires the UUID-based recipient ID from `usaspending_search_recipients`

---

### `usaspending_get_agency`

Fetch an agency's current fiscal year overview.

- Returns mission, budget authority amount, obligation amount, sub-agency count, and DEF codes
- Accepts either a 3-digit `toptier_code` (e.g., `097` for DoD) or an `agency_slug` (e.g., `department-of-defense`) — slugs appear in award search results, eliminating an intermediate lookup
- Includes sub-agency breakdown with transaction counts

---

### `usaspending_spending_by_geography`

Aggregate federal spending by geographic unit.

- `scope`: `place_of_performance` or `recipient_location`
- `geo_layer`: `state`, `county`, or `district`
- Returns `shape_code`, `display_name`, `aggregated_amount`, and `per_capita` (when `population` is available)
- Geographic filters require FIPS codes or 2-letter state abbreviations — use a geocoding server (e.g., Census or OpenStreetMap) to resolve place names first

---

### `usaspending_spending_by_category`

Aggregate spending broken down by a single dimension.

- `category` enum maps to the right sub-route: `naics`, `psc`, `awarding_agency`, `funding_agency`, `cfda`, or `recipient`
- Returns top items with amounts and codes for trend analysis
- Accepts the standard award filter object for scoping to a specific agency, time period, or keyword

---

### `usaspending_spending_over_time`

Fetch aggregated spending grouped by time period.

- `group`: `fiscal_year`, `quarter`, or `month`
- Filter by award type, agency, recipient, or keyword to trace trends in a specific area
- `subawards: true` shifts aggregation to the subaward layer

---

### `usaspending_disaster_spending`

Fetch disaster and emergency supplemental spending consolidated from nine+ API endpoints.

- `dimension` enum selects the breakdown axis: `overview`, `agency`, `cfda`, `recipient`, or `geography`
- `spending_type` selects between award-level obligations (`award`) and total spending including direct non-award spending (`total`)
- Filter by `def_codes` to isolate a specific emergency appropriation (e.g., COVID-19 = `L`, `M`, `N`, `O`, `P`, `U`)
- Returns obligation, outlay, and award count per row

---

### `usaspending_get_federal_account`

Fetch budget data for a federal account identified by its account code.

- Returns account title, federal account code, budget function, and managing agency
- Includes fiscal year snapshot with total obligations and outlays
- Program activity and object class breakdown shows how funds are categorized
- Account codes appear in `account_obligations_by_defc` from `usaspending_get_award`

---

### `usaspending_list_agencies`

List all top-tier federal agencies.

- Returns agency name, abbreviation, `toptier_code`, `agency_slug`, obligated amount, and budget authority amount for the current fiscal year
- Entry point for agency navigation — `toptier_code` is required by `usaspending_get_agency` and agency filters
- Configurable sort and order

---

### `usaspending_autocomplete`

Discover valid code values for award filter fields.

- `type` enum selects the lookup: `naics`, `psc`, `cfda`, `awarding_agency`, or `recipient`
- Returns matching codes and names — use before filtering to find the right code when you only know a description (e.g., "cybersecurity" → NAICS code)
- Consolidates five autocomplete endpoints into one tool

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

USAspending-specific:

- Full USAspending.gov API v2 coverage — award search, award detail, recipient and agency profiles, spending analytics, disaster spending, and federal accounts
- No authentication required — all data is public domain under the DATA Act
- `usaspending_spending_by_category` consolidates 14 category sub-routes behind a single `category` enum; `usaspending_disaster_spending` consolidates 9+ disaster endpoints behind `dimension` + `spending_type` enums
- `usaspending_get_agency` accepts both `toptier_code` and `agency_slug`, eliminating the intermediate agency-list lookup that award search results would otherwise require
- `usaspending_autocomplete` serves as the code-discovery step before filtering — maps human-readable terms to NAICS, PSC, CFDA, and agency codes

Agent-friendly output:

- Chaining fields on every response — `generated_internal_id`, `agency_slug`, `recipient_hash`, and `account_code` fields are surfaced explicitly so agents can follow the money without parsing identifiers out of display strings
- Pagination metadata on all list responses — `page_metadata.hasNext`, `page_metadata.page`, and `page_metadata.total` let agents iterate large result sets without guessing
- Structured geographic outputs — `shape_code`, `display_name`, `aggregated_amount`, and `per_capita` are typed consistently across state, county, and district views for composable analysis

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

Add the following to your MCP client configuration file. No API key is required — USAspending.gov data is public domain.

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required — USAspending.gov is a public data platform with no authentication requirement.

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

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. No environment variables are required — the defaults work out of the box.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `USASPENDING_BASE_URL` | Base URL for the USAspending.gov API. | `https://api.usaspending.gov/api/v2/` |
| `USASPENDING_TIMEOUT_MS` | Per-request HTTP timeout in milliseconds. | `30000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments. | — |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/services` | USAspending API client and service layer. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrels in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
