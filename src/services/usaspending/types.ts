/**
 * @fileoverview Domain types for the USAspending.gov API v2 service.
 * @module services/usaspending/types
 */

/** Raw award summary from spending_by_award search results */
export interface RawAwardSummary {
  'Award Amount'?: number | string | null;
  'Award Type'?: string | null;
  Award_ID?: string;
  'Awarding Agency'?: string | null;
  'Awarding Agency Code'?: string | null;
  'Awarding Sub Agency'?: string | null;
  'Awarding SubAgency Code'?: string | null;
  agency_slug?: string | null;
  'Base Obligation Date'?: string | null;
  'Contract Award Type'?: string | null;
  Description?: string | null;
  'End Date'?: string | null;
  'Funding Agency'?: string | null;
  'Funding Agency Code'?: string | null;
  'Funding Sub Agency'?: string | null;
  'Funding Sub Agency Code'?: string | null;
  generated_internal_id?: string;
  'Last Modified Date'?: string | null;
  'Place of Performance City Code'?: string | null;
  'Place of Performance Country Code'?: string | null;
  'Place of Performance State Code'?: string | null;
  'Place of Performance Zip5'?: string | null;
  program_activities?: unknown;
  'Recipient City Name'?: string | null;
  'Recipient Country Code'?: string | null;
  'Recipient Name'?: string;
  'Recipient State Code'?: string | null;
  'Recipient Zip Code'?: string | null;
  'Start Date'?: string | null;
  'Total Outlays'?: number | string | null;
  [key: string]: unknown;
}

/** Page metadata returned by search endpoints */
export interface RawPageMetadata {
  hasNext?: boolean;
  hasPrevious?: boolean;
  limit?: number;
  page?: number;
  total?: number;
}

/** Raw award detail object */
export interface RawAwardDetail {
  account_obligations_by_defc?: Array<{
    code?: string | null;
    def_codes?: unknown;
    amount?: number | null;
  }> | null;
  account_outlays_by_defc?: Array<{
    code?: string | null;
    amount?: number | null;
  }> | null;
  awarding_agency?: {
    toptier_agency?: {
      name?: string | null;
      abbreviation?: string | null;
      code?: string | null;
      slug?: string | null;
    } | null;
    subtier_agency?: {
      name?: string | null;
      abbreviation?: string | null;
      code?: string | null;
    } | null;
  } | null;
  base_and_all_options_value?: number | null;
  base_exercised_options_val?: number | null;
  category?: string | null;
  date_signed?: string | null;
  description?: string | null;
  executive_details?: {
    officers?: Array<{
      name?: string | null;
      amount?: number | null;
    }> | null;
  } | null;
  fain?: string | null;
  funding_agency?: {
    toptier_agency?: {
      name?: string | null;
      abbreviation?: string | null;
      code?: string | null;
      slug?: string | null;
    } | null;
    subtier_agency?: {
      name?: string | null;
      abbreviation?: string | null;
      code?: string | null;
    } | null;
  } | null;
  generated_unique_award_id?: string | null;
  id?: number | null;
  latest_transaction_assistance_data?: {
    cfda_number?: string | null;
    cfda_title?: string | null;
    face_value_loan_guarantee?: number | null;
    original_loan_subsidy_cost?: number | null;
  } | null;
  latest_transaction_contract_data?: {
    naics?: string | null;
    naics_description?: string | null;
    product_or_service_code?: string | null;
    product_or_service_code_description?: string | null;
    type_of_contract_pricing?: string | null;
    type_of_contract_pricing_description?: string | null;
    extent_competed?: string | null;
    extent_competed_description?: string | null;
  } | null;
  parent_award?: {
    agency_name?: string | null;
    agency_slug?: string | null;
    award_id?: string | null;
    generated_unique_award_id?: string | null;
    idv_type_description?: string | null;
    last_date_to_order?: string | null;
    piid?: string | null;
    solicitation_id?: string | null;
    type_of_set_aside?: string | null;
    type_of_set_aside_description?: string | null;
  } | null;
  period_of_performance?: {
    start_date?: string | null;
    end_date?: string | null;
    last_modified_date?: string | null;
    potential_end_date?: string | null;
  } | null;
  piid?: string | null;
  place_of_performance?: {
    city_name?: string | null;
    state_code?: string | null;
    state_name?: string | null;
    country_name?: string | null;
    country_code?: string | null;
    zip5?: string | null;
    congressional_code?: string | null;
    location_country_code?: string | null;
  } | null;
  recipient?: {
    recipient_name?: string | null;
    recipient_hash?: string | null;
    recipient_unique_id?: string | null;
    parent_recipient_unique_id?: string | null;
    parent_recipient_name?: string | null;
    recipient_id?: string | null;
    uei?: string | null;
    parent_uei?: string | null;
    location?: {
      address_line1?: string | null;
      address_line2?: string | null;
      city_name?: string | null;
      state_code?: string | null;
      zip5?: string | null;
      zip4?: string | null;
      country_name?: string | null;
      country_code?: string | null;
    } | null;
    business_types?: string[] | null;
  } | null;
  subaward_count?: number | null;
  total_account_obligation?: number | null;
  total_account_outlay?: number | null;
  total_loan_value?: number | null;
  total_obligation?: number | null;
  total_outlays?: number | null;
  total_subsidy_cost?: number | null;
  transactions_count?: number | null;
  type?: string | null;
  type_description?: string | null;
  unique_awards?: number | null;
  uri?: string | null;
}

/** Raw transaction from /transactions/ endpoint */
export interface RawTransaction {
  action_date?: string | null;
  action_type?: string | null;
  action_type_description?: string | null;
  awarding_agency_name?: string | null;
  description?: string | null;
  face_value_loan_guarantee?: number | null;
  federal_action_obligation?: number | null;
  funding_agency_name?: string | null;
  id?: number | null;
  is_fpds?: boolean | null;
  modification_number?: string | null;
  original_loan_subsidy_cost?: number | null;
  recipient_name?: string | null;
  type?: string | null;
  type_description?: string | null;
}

/** Raw subaward from /subawards/ endpoint */
export interface RawSubaward {
  action_date?: string | null;
  amount?: number | null;
  business_type_description?: string | null;
  description?: string | null;
  id?: number | null;
  place_of_performance?: {
    city_name?: string | null;
    state_code?: string | null;
    country_code?: string | null;
    zip5?: string | null;
  } | null;
  prime_award_id?: string | null;
  prime_award_internal_id?: string | null;
  recipient_duns?: string | null;
  recipient_location?: {
    city_name?: string | null;
    state_code?: string | null;
    country_code?: string | null;
    zip5?: string | null;
  } | null;
  recipient_name?: string | null;
  recipient_uei?: string | null;
  subaward_number?: string | null;
}

/** Raw recipient search result */
export interface RawRecipientSearchResult {
  amount?: number | null;
  duns?: string | null;
  id?: string | null;
  location?: {
    address_line1?: string | null;
    city_name?: string | null;
    state_code?: string | null;
    zip5?: string | null;
    country_code?: string | null;
    country_name?: string | null;
  } | null;
  name?: string | null;
  recipient_level?: string | null;
  state_province?: string | null;
  uei?: string | null;
}

/** Raw recipient detail */
export interface RawRecipientDetail {
  alternate_names?: string[] | null;
  business_types?: string[] | null;
  business_types_description?: string[] | null;
  children?: unknown[] | null;
  duns?: string | null;
  location?: {
    address_line1?: string | null;
    address_line2?: string | null;
    city_name?: string | null;
    state_code?: string | null;
    zip5?: string | null;
    zip4?: string | null;
    country_code?: string | null;
    country_name?: string | null;
    congressional_code?: string | null;
  } | null;
  name?: string | null;
  parent_duns?: string | null;
  parent_id?: string | null;
  parent_name?: string | null;
  parent_uei?: string | null;
  recipient_id?: string | null;
  recipient_level?: string | null;
  total?: {
    contracts?: number | null;
    grants?: number | null;
    direct_payments?: number | null;
    loans?: number | null;
    other?: number | null;
  } | null;
  uei?: string | null;
}

/** Raw agency list entry */
export interface RawAgencyEntry {
  abbreviation?: string | null;
  active_fq?: string | null;
  active_fy?: string | null;
  agency_id?: number | null;
  agency_name?: string | null;
  agency_slug?: string | null;
  budget_authority_amount?: number | null;
  budget_authority_change?: number | null;
  congressional_justification_url?: string | null;
  has_agency_page?: boolean | null;
  icon_filename?: string | null;
  mission?: string | null;
  obligated_amount?: number | null;
  obligated_change?: number | null;
  outlay_amount?: number | null;
  outlay_change?: number | null;
  percentage_of_total_budget_authority?: number | null;
  toptier_code?: string | null;
  website?: string | null;
}

/** Raw agency detail */
export interface RawAgencyDetail {
  abbreviation?: string | null;
  agency_id?: number | null;
  agency_overview?: {
    mission?: string | null;
    about_agency_data?: string | null;
    congression_justification?: {
      cj_title?: string | null;
      cj_pdf_url?: string | null;
      cj_html_url?: string | null;
    } | null;
  } | null;
  budget_authority_amount?: number | null;
  current_total_budget_authority_amount?: number | null;
  def_codes?: Array<{
    code?: string | null;
    public_law?: string | null;
    title?: string | null;
    group?: string | null;
    urls?: Array<{
      url?: string | null;
      name?: string | null;
    }> | null;
  }> | null;
  icon_filename?: string | null;
  mission?: string | null;
  name?: string | null;
  new_award_summary?: {
    quarter_dts?: string | null;
    transaction_count?: number | null;
    agency_slug?: string | null;
  } | null;
  obligated_amount?: number | null;
  slug?: string | null;
  sub_agency_count?: number | null;
  subtier_agency_count?: number | null;
  toptier_code?: string | null;
  transactions_count?: number | null;
  website?: string | null;
}

/** Sub-agency breakdown entry */
export interface RawSubAgencyEntry {
  abbreviation?: string | null;
  name?: string | null;
  new_award_count?: number | null;
  subagency_code?: string | null;
  total_obligations?: number | null;
  transaction_count?: number | null;
}

/** Raw budgetary resources entry */
export interface RawBudgetaryResources {
  agency_budget_authority_amount?: number | null;
  agency_budgetary_resources?: number | null;
  agency_obligated_amount?: number | null;
  agency_total_obligated?: number | null;
  agency_total_outlays?: number | null;
  fiscal_year?: number | null;
}

/** Raw geography spending result */
export interface RawGeographyResult {
  aggregated_amount?: number | null;
  award_count?: number | null;
  display_name?: string | null;
  per_capita?: number | null;
  population?: number | null;
  shape_code?: string | null;
}

/** Raw spending by category result */
export interface RawSpendingByCategoryResult {
  amount?: number | null;
  category?: string | null;
  code?: string | null;
  description?: string | null;
  id?: number | string | null;
  name?: string | null;
}

/** Raw spending over time result */
export interface RawSpendingOverTimeResult {
  aggregated_amount?: number | null;
  Contract_Obligations?: number | null;
  'Direct Payment_Obligations'?: number | null;
  Grant_Obligations?: number | null;
  Loan_Obligations?: number | null;
  Other_Obligations?: number | null;
  time_period?: {
    fiscal_year?: string | null;
    quarter?: string | null;
    month?: string | null;
    calendar_month?: string | null;
    calendar_year?: string | null;
  } | null;
}

/** Raw disaster overview response */
export interface RawDisasterOverview {
  funding?: Array<{
    def_code?: string | null;
    amount?: number | null;
    label?: string | null;
    public_law?: string | null;
    fiscal_year?: number | null;
    title?: string | null;
    group?: string | null;
    urls?: unknown;
  }> | null;
  spending?: {
    award_obligations?: number | null;
    award_outlays?: number | null;
    face_value_of_loans?: number | null;
    total_obligations?: number | null;
    total_outlays?: number | null;
    unobligated_balance?: number | null;
  } | null;
  total_budget_authority?: number | null;
}

/** Raw disaster breakdown result (agency/cfda/recipient) */
export interface RawDisasterResult {
  award_count?: number | null;
  children?: unknown[] | null;
  code?: string | null;
  count?: number | null;
  description?: string | null;
  face_value_of_loan?: number | null;
  id?: number | string | null;
  name?: string | null;
  obligated_amount?: number | null;
  obligation?: number | null;
  outlay?: number | null;
  outlays?: number | null;
  total_budgetary_resources?: number | null;
}

/** Raw disaster geography result */
export interface RawDisasterGeoResult {
  aggregated_amount?: number | null;
  display_name?: string | null;
  per_capita?: number | null;
  population?: number | null;
  shape_code?: string | null;
}

/** Raw federal account response from /federal_accounts/{code}/ */
export interface RawFederalAccount {
  account_title?: string | null;
  agency_identifier?: string | null;
  bureau_name?: string | null;
  bureau_slug?: string | null;
  children?: unknown[] | null;
  federal_account_code?: string | null;
  fiscal_year?: number | null;
  id?: number | null;
  main_account_code?: string | null;
  parent_agency_name?: string | null;
  parent_agency_toptier_code?: string | null;
  total_budgetary_resources?: number | null;
  total_gross_outlay_amount?: number | null;
  total_obligated_amount?: number | null;
}

/** Raw NAICS autocomplete result */
export interface RawNaicsAutocomplete {
  naics?: string | null;
  naics_description?: string | null;
  year_retired?: number | null;
}

/** Raw PSC autocomplete result */
export interface RawPscAutocomplete {
  product_or_service_code?: string | null;
  psc_description?: string | null;
}

/** Raw CFDA autocomplete result */
export interface RawCfdaAutocomplete {
  popular_name?: string | null;
  program_number?: string | null;
  program_title?: string | null;
}

/** Raw agency autocomplete result */
export interface RawAgencyAutocomplete {
  id?: number | string | null;
  subtier_agency?: {
    abbreviation?: string | null;
    name?: string | null;
  } | null;
  toptier_agency?: {
    toptier_code?: string | null;
    abbreviation?: string | null;
    name?: string | null;
  } | null;
  toptier_flag?: boolean | null;
}

/** Raw recipient autocomplete result */
export interface RawRecipientAutocomplete {
  legal_business_name?: string | null;
  recipient_id?: string | null;
  uei?: string | null;
  [key: string]: unknown;
}
