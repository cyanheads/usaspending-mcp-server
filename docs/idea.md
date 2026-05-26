# usaspending-mcp-server

USAspending.gov — federal spending data: contracts, grants, loans, direct payments, and other financial assistance.

## API

- **Base**: `https://api.usaspending.gov/api/v2/`
- **Auth**: None required
- **Rate limits**: Reasonable (no published hard cap; bulk downloads available separately)
- **Docs**: https://api.usaspending.gov/
- **Status**: Confirmed alive and serving data as of May 2026

## Key endpoints

- Award search (keyword, recipient, agency, NAICS, location, date range)
- Spending by agency / category / geography
- Federal account and budget data
- Recipient profiles (who's getting the money)
- Contract details (FPDS-derived)
- Grant details
- Sub-award data
- Spending over time / trends

## Cross-domain value

| Chain to | Query |
|---|---|
| SEC EDGAR | Federal contractor → public company financials, lobbying disclosures |
| OpenFEC | Government contractors → campaign contributions by their employees |
| Congress | Appropriations bills → actual spending outcomes |
| Census | Federal spending per capita by geography |
| BLS | Federal contracts by industry → employment in those sectors |
| OpenStates | State-level matching funds, block grant allocations |

## Tool ideas

- `usaspending_search_awards` — keyword + filter search across all award types
- `usaspending_get_award` — full award record by ID
- `usaspending_search_recipients` — find organizations receiving federal funds
- `usaspending_get_recipient` — recipient profile with award history
- `usaspending_spending_by_agency` — agency-level spending breakdown
- `usaspending_spending_by_geography` — geographic distribution of federal spending
- `usaspending_spending_over_time` — trend data for budget categories

## Licensing (audited 2026-05-25)

- **Status: Clear to host**
- US federal government data (Treasury/DATA Act) — public domain under 17 USC §105
- No API key required
- Open-source codebase (github.com/fedspendingtransparency/usaspending-api)
- Confirmed alive and serving data as of May 2026

## Notes

- Concern that Trump admin shut this down was incorrect — API is live, data current
- "Follow the money" use case is a natural extension of the Congress → OpenFEC chain in CROSS-DOMAIN.md
- NAICS code filtering enables industry-specific spending analysis
