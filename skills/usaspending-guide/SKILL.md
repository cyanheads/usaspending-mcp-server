---
name: usaspending-guide
description: Use with usaspending_* tools to trace federal awards through recipients and funding accounts, compare spending across reporting periods, or investigate emergency funding without mixing award totals, transaction obligations, and budget data.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.2"
---

## Scope

Use USAspending for federal award investigations and spending comparisons. Award search cannot establish coverage before 2007-10-01; use bulk downloads for earlier award searches. This restriction does not describe the federal-account tools' reporting-year coverage.

## Identifiers

Preserve identifiers returned at each hop rather than constructing them from display names:

- Award search's `generated_internal_id` opens the award detail and award drill-down tools. The displayed award number is not the chain ID. An IDV child's `generated_unique_award_id` opens that child's detail.
- Recipient search's `id`, award search rows' and award detail's `recipient_id`, and recipient-category rows' `recipient_id` identify recipient profiles. Preserve the hierarchy suffix; UEI and DUNS are separate identifiers.
- Award funding rows' `federal_account` and account search's `account_number` open the federal-account tools. A detail's Treasury Account Symbol child code is not a federal-account code.

## Gates

Before comparing amounts across tools, fix the award types, period, recipient hierarchy, geographic scope, and measure being compared. Search and time series default to contracts; an unfiltered geography query covers every award type. Do not compare their defaults as if they describe the same population.

Before treating an empty ID-keyed listing as evidence of no activity, confirm the award or account with its detail tool. A nonexistent ID can also return an empty listing. Check pagination and response notices before describing any result as exhaustive.

Before attributing a matching award's amount to an Assistance Listing or DEF code, inspect the award's listing obligations or DEF funding breakdown. These filters select matching awards; the returned whole-award amount is not the requested listing's or code's share.

## Workflows

### Investigate a recipient

Resolve the organization with usaspending_search_recipients and inspect its profile before choosing a parent, child, or standalone entity. For exact-entity trends, carry that recipient hash into usaspending_spending_over_time and explicitly select award types. The profile covers every award type and defaults to the trailing 12 months; select a fiscal year when comparing annual results.

Use usaspending_search_awards to discover individual awards by recipient name; each row's `recipient_id` opens usaspending_get_recipient, so inspect the identity there. Name matching is partial and cannot substitute for the analytics tools' exact recipient hash when reconciling an entity's totals.

A recipient can have several parents; the profile's `parents` lists each. A `-P` parent lists its child recipients, but that list is a best-effort second request: when `unavailable_sections` names `children`, the profile stands and the child list is unknown, not empty.

### Trace an award's funding

Open the award, then use usaspending_get_award_federal_accounts and carry each returned account code into usaspending_get_federal_account. Use usaspending_get_federal_account_breakdown to inspect program activity or object class for the same fiscal year. Account search defaults to the latest submission year, detail to the current fiscal year, and breakdown to all available periods: select one year across the chain. Even within one year, account search and detail budget totals use different upstream calculations and need not match.

Keep the award's funding contribution separate from the account's full budget.

### Compare places and periods

Choose recipient location or place of performance according to the question, and retain that distinction in the conclusion. Reuse the same award types and date range across geography, category, and time-series calls. Fiscal month 1 is October.

For a named area absent from a ranked geography result, resolve its code and select it with usaspending_spending_by_geography rather than inferring zero spending. Returned county `shape_code` values can also be carried directly into award search's county location filter; award search normalizes the five-digit FIPS code and infers its state. Scope any of these tools to a place with `filters.place_of_performance_location` (award search also takes the flat `location_filter`) or to where the recipient is based with `filters.recipient_location`; they answer different questions. Resolve a state, county, or congressional district name to its code with usaspending_autocomplete_filters `type: "location"`. Cities, ZIP codes, and countries are not covered there, so resolve those outside this server.

### Reconcile emergency funding

Choose DEF codes for the appropriation being investigated, then keep them fixed across breakdowns. Use the agency breakdown's total-spending view when the question includes direct non-award spending. Recipient and program breakdowns do not gain that coverage by requesting total spending, and geography reports obligations; their sums cannot stand in for the agency total-spending view.

Check amount_coverage before interpreting any monetary value. Award breakdowns and geography aggregate only the provider's COVID DEF grouping; other codes can still add matching rows and award counts. Partial coverage means the amounts exclude unsupported codes; unavailable coverage means retained zeros cannot establish zero spending. Unknown coverage means the reference could not be verified. Overview and agency total cover all requested codes. General category/geography DEF filters offer whole matching award amounts, not the DEF-funded share.

Use the returned overall totals when present instead of summing one page. Breakdowns rank obligations descending before pagination; geography ranks its reported obligation amounts. Agency award breakdowns without award-type filters collect all provider pages before ranking, so reducing the page size does not reduce that upstream work. If the recipient response discloses a reachable ceiling, narrow the recipient query before treating its count as exact. Keep obligations, outlays, and budgetary resources separate in the answer.
