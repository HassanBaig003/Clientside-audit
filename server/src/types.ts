/**
 * Canonical audit contract. The UI and the PDF report both read this one object;
 * nothing in either surface recomputes counts, scores or affected pages.
 */

export const SCHEMA_VERSION = '1.0.0';
export const TOOL_VERSION = '1.0.0';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'NOT_APPLICABLE' | 'NOT_TESTABLE' | 'ERROR';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type Confidence = 'OBSERVED' | 'DERIVED' | 'THIRD_PARTY' | 'MODELLED';
export type SourceLabel = 'DOCUMENTED' | 'TOOL_POLICY' | 'PROPOSED_SPEC' | 'MODELLED';
export type Profile = 'RAW' | 'RENDERED' | 'NONE';
export type Validity =
  | 'VALID_PAGE'
  | 'ACCESS_CHALLENGE'
  | 'ERROR_DOCUMENT'
  | 'EMPTY_OR_TRUNCATED'
  | 'UNKNOWN_RESPONSE';

/** Why a profile has no usable response. Kept apart from Validity, which only describes received responses. */
export type AcquisitionState =
  | 'OK'
  | 'TIMEOUT'
  | 'DNS_ERROR'
  | 'TLS_ERROR'
  | 'NETWORK_ERROR'
  | 'REDIRECT_LOOP'
  | 'TOO_MANY_REDIRECTS'
  | 'UNSAFE_DESTINATION'
  | 'ROBOTS_DISALLOWED_FOR_AUDITOR'
  | 'BUDGET_EXHAUSTED'
  | 'STOPPED_RATE_LIMITED'
  | 'STOPPED_ACCESS_CHALLENGES'
  | 'CANCELLED'
  | 'RENDER_FAILED'
  | 'NOT_ATTEMPTED';

export type CategoryId =
  | 'crawl_indexing'
  | 'onpage_links'
  | 'structured_international'
  | 'field_performance'
  | 'ux_accessibility'
  | 'https_transport'
  | 'ai_access'
  | 'content_review'
  | 'optional_signals';

export type Scope = 'SITE' | 'PAGE' | 'SAMPLE';
export type ScoreId = 'technical_health' | 'ai_accessibility';

export type PageType =
  | 'homepage'
  | 'service'
  | 'product'
  | 'pricing'
  | 'category_hub'
  | 'article'
  | 'author'
  | 'about'
  | 'contact'
  | 'other';

export type FactBasis = 'observed' | 'operator-supplied' | 'unknown';

export interface RedirectHop {
  url: string;
  status: number;
  location: string | null;
  elapsed_ms: number;
}

export interface RawRecord {
  profile: 'RAW';
  requested_url: string;
  final_url: string | null;
  hops: RedirectHop[];
  status: number | null;
  headers: Record<string, string>;
  bytes: number;
  body_complete: boolean;
  truncated_reason: string | null;
  timing_ms: number;
  fetched_at: string;
  acquisition: AcquisitionState;
  error: string | null;
  validity: Validity | null;
  validity_evidence: string[];
  content_type: string | null;
  body_ref: string | null;
  from_cache: boolean;
}

export interface RenderedRecord {
  profile: 'RENDERED';
  requested_url: string;
  final_url: string | null;
  status: number | null;
  headers: Record<string, string>;
  timing_ms: number;
  rendered_at: string;
  acquisition: AcquisitionState;
  error: string | null;
  validity: Validity | null;
  validity_evidence: string[];
  dom_ref: string | null;
  screenshot_ref: string | null;
  viewport: { width: number; height: number };
  console_errors: string[];
  failed_requests: { url: string; reason: string }[];
  mixed_content: { url: string; resource_type: string; blocked: boolean }[];
  resource_count: number;
  resource_bytes: number;
  resource_cap_hit: boolean;
  overflow: {
    scroll_width: number;
    viewport_width: number;
    offenders: { selector: string; right: number; width: number }[];
  } | null;
  axe: {
    violations: { id: string; impact: string | null; help: string; help_url: string; nodes: { target: string; html: string }[] }[];
    incomplete: { id: string; help: string; count: number }[];
    rules_run: string[];
  } | null;
  settle: string;
}

export interface LinkObs {
  href_raw: string;
  url: string | null;
  text: string;
  zone: 'nav' | 'main' | 'footer' | 'other';
  internal: boolean;
  crawlable: boolean;
  rel: string;
  reason: string | null;
}

export interface StructuredItem {
  format: 'JSON-LD' | 'Microdata' | 'RDFa';
  types: string[];
  parse_error: string | null;
  raw_excerpt: string;
  data: unknown;
  in_head: boolean;
}

export interface HreflangObs {
  hreflang: string;
  href: string;
  source: 'HTML' | 'HTTP';
}

export interface Extracted {
  titles: string[];
  title: string | null;
  meta_description: string | null;
  meta_descriptions: string[];
  h1: string[];
  headings: { level: number; text: string }[];
  canonical_head: string[];
  canonical_body: string[];
  canonical_http: string[];
  meta_robots: { name: string; content: string }[];
  x_robots_tag: string[];
  viewport_meta: string | null;
  html_lang: string | null;
  base_href: string | null;
  links: LinkObs[];
  structured: StructuredItem[];
  hreflang: HreflangObs[];
  data_nosnippet_count: number;
  data_nosnippet_excerpts: string[];
  main_text: string;
  main_text_method: string;
  main_text_confidence: 'high' | 'medium' | 'low';
  word_count: number;
  noscript_present: boolean;
  images: { src: string; alt: string | null }[];
  nav_like_controls: { text: string; hint: string; html: string }[];
  author_signals: string[];
  date_signals: string[];
  lists: number;
  tables: number;
  landmarks: string[];
}

export interface PageRecord {
  page_id: string;
  url: string;
  page_type: PageType;
  selection_reason: string;
  discovered_from: string | null;
  observed_group: string;
  operator_override: string | null;
  intent: 'public_search' | 'intentional_restriction';
  robots: {
    auditor: RobotsDecision;
    googlebot: RobotsDecision;
  };
  raw: RawRecord;
  rendered: RenderedRecord;
  raw_extract: Extracted | null;
  rendered_extract: Extracted | null;
  state: 'VALID' | 'BLOCKED' | 'UNAVAILABLE' | 'ERROR_PAGE' | 'CHALLENGED';
  technical_eligibility: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNCERTAIN' | null;
  screenshot_ref: string | null;
}

export interface RobotsDecision {
  token: string;
  decision: 'ALLOW' | 'DISALLOW' | 'UNKNOWN';
  matched_group: string | null;
  matched_rule: string | null;
  reason: string;
}

export interface Evidence {
  evidence_id: string;
  source_url: string;
  profile: Profile;
  locator: string;
  observed: string;
  expected: string | null;
  captured_at: string;
  body_ref: string | null;
  screenshot_ref: string | null;
}

export interface Finding {
  finding_id: string;
  check_id: string;
  finding_status: 'WARN' | 'FAIL';
  classification: 'ISSUE' | 'OPPORTUNITY' | 'ADVISORY' | 'OPTIONAL';
  reason_code: string;
  severity: Severity;
  confidence: Confidence;
  caveat: string | null;
  affected_page_ids: string[];
  evidence_ids: string[];
  source_ids: string[];
  title: string;
  explanation: string;
  practical_impact: string;
  recommended_action: string;
  suggested_owner: string;
  effort: 'S' | 'M' | 'L';
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  related_findings: string[];
  code?: { label: string; language: string; content: string; is_template: boolean } | null;
}

export interface CheckResult {
  check_id: string;
  rule_version: string;
  category: CategoryId;
  scope: Scope;
  page_id: string | null;
  status: CheckStatus;
  score_included: boolean;
  evidence_ids: string[];
  findings: Finding[];
  notes: string[];
  limitations: string[];
}

export interface RootIssue {
  issue_id: string;
  check_id: string;
  reason_code: string;
  category: CategoryId;
  finding_status: 'WARN' | 'FAIL';
  classification: Finding['classification'];
  severity: Severity;
  confidence: Confidence;
  caveat: string | null;
  priority: Finding['priority'];
  title: string;
  explanation: string;
  practical_impact: string;
  recommended_action: string;
  suggested_owner: string;
  effort: Finding['effort'];
  affected_page_ids: string[];
  affected_urls: string[];
  finding_ids: string[];
  evidence_ids: string[];
  source_ids: string[];
  related_issue_ids: string[];
  score_included: boolean;
  code: Finding['code'];
}

export interface ContentObservation {
  observation_id: string;
  area: 'subject_clarity' | 'useful_information' | 'organization' | 'answer_completeness' | 'attribution_dates';
  page_id: string;
  url: string;
  excerpt: string;
  observation: string;
  suggestion: string;
  confidence: Confidence;
  origin: 'DETERMINISTIC' | 'LLM';
  evidence_ids: string[];
  label: 'content-review advisory';
}

export interface CategoryScore {
  id: CategoryId | string;
  label: string;
  weight: number;
  score: number | null;
  evaluated_units: number;
  applicable_units: number;
  checks: { check_id: string; score: number | null; evaluated_units: number; applicable_units: number; weight: number }[];
}

export interface ScoreBlock {
  id: ScoreId;
  label: string;
  value: number | null;
  suppressed_reason: string | null;
  categories: CategoryScore[];
  coverage: { evaluated_units: number; applicable_units: number; pct: number | null };
  method: string;
  source_label: 'TOOL_POLICY';
}

export interface StageRecord {
  id: 'discovery' | 'acquisition' | 'technical_checks' | 'ai_content' | 'performance' | 'report';
  label: string;
  state: 'PENDING' | 'RUNNING' | 'DONE' | 'PARTIAL' | 'SKIPPED' | 'FAILED' | 'CANCELLED';
  started_at: string | null;
  finished_at: string | null;
  detail: string | null;
  completed: number | null;
  total: number | null;
}

export type AuditStatus =
  | 'QUEUED'
  | 'DISCOVERING'
  | 'AWAITING_SELECTION'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'CANCELLED'
  | 'FAILED'
  | 'INTERRUPTED';

export interface Candidate {
  url: string;
  text: string;
  zone: LinkObs['zone'];
  discovered_from: string;
  depth: number;
  in_raw: boolean;
  in_rendered: boolean;
  crawlable: boolean;
  page_type: PageType;
  group: string;
  excluded_reason: string | null;
  robots_auditor: RobotsDecision['decision'];
  robots_googlebot: RobotsDecision['decision'];
  verification: 'unverified' | 'verified' | 'failed' | 'alias';
  verification_note: string | null;
  selected: boolean;
  selection_reason: string | null;
}

export interface SitemapVariantRow {
  requested_url: string;
  initial_status: number | null;
  hops: RedirectHop[];
  final_url: string | null;
  final_status: number | null;
  network_error: string | null;
  content_type: string | null;
  result: 'OPEN' | 'NOT_OPEN' | 'INCONCLUSIVE';
  role: 'declared' | 'canonical' | 'variant';
  note: string | null;
}

export interface FieldRecord {
  scope: 'URL' | 'ORIGIN';
  key: string;
  page_id: string | null;
  available: boolean;
  reason: string | null;
  form_factor: string | null;
  collection_period: { first: string; last: string } | null;
  metrics: { lcp_ms: number | null; inp_ms: number | null; cls: number | null };
  assessment: 'GOOD' | 'NEEDS_IMPROVEMENT' | 'POOR' | 'INCOMPLETE' | 'UNAVAILABLE';
}

export interface LabRecord {
  page_id: string;
  url: string;
  available: boolean;
  reason: string | null;
  environment: string;
  lcp_ms: number | null;
  lcp_element: string | null;
  lcp_resource: string | null;
  cls: number | null;
  cls_sources: string[];
  tbt_ms: number | null;
  long_tasks: number;
  render_blocking: string[];
  transfer_bytes: number | null;
  requests: number | null;
  measured_at: string;
}

export interface AuditConfig {
  sample_size: number;
  operator_urls: string[];
  visibility_goal: 'search_ai_discovery' | 'restricted';
  environment: 'production' | 'staging';
  multilingual: boolean;
  report_language: string;
  form_factor: 'mobile';
  intentional_restrictions: string[];
  branding: { client_display_name: string | null; logo_data_uri: string | null; prepared_by: string | null };
  budgets: Budgets;
  auto_run: boolean;
}

export interface Budgets {
  max_selected_pages: number;
  max_discovery_documents: number;
  max_discovery_depth: number;
  max_links_per_document: number;
  max_internal_link_targets: number;
  max_canonical_target_fetches: number;
  max_hreflang_alternate_fetches: number;
  max_lab_performance_pages: number;
  max_redirect_hops: number;
  concurrency_per_host: number;
  minimum_request_spacing_ms: number;
  connect_timeout_ms: number;
  read_timeout_ms: number;
  render_timeout_ms: number;
  max_document_bytes: number;
  run_hard_budget_seconds: number;
  max_browser_resources_per_page: number;
  max_browser_bytes_per_page: number;
  max_query_variants_per_path: number;
}

export interface Audit {
  schema_version: string;
  tool_version: string;
  rule_registry_version: string;
  source_registry_reviewed: string;
  audit_id: string;
  run_id: string;
  tenant_id: string;
  project_id: string;
  client_name: string;
  mode: 'LIVE' | 'FIXTURE_DEMO';
  retry_of: string | null;
  retry_count: number;
  status: AuditStatus;
  run_quality: 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT' | 'PENDING';
  stop_reason: string | null;
  target: {
    input_url: string;
    normalized_url: string;
    host: string;
    registrable_domain: string | null;
    preferred_origin: string | null;
    origin_resolution: RedirectHop[];
    origin_note: string;
  };
  config: AuditConfig;
  site_facts: Record<string, { value: string; basis: FactBasis }>;
  auditor: { user_agent: string; robots_token: string; contact_url: string | null };
  discovery: {
    documents_fetched: number;
    documents: { url: string; depth: number; profile: string; status: number | null; links: number; note: string | null }[];
    candidates: Candidate[];
    groups: { signature: string; count: number; examples: string[] }[];
    limitations: string[];
    used_sitemap_for_sampling: false;
  };
  pages: PageRecord[];
  site: {
    robots: {
      url: string | null;
      status: number | null;
      state: 'PARSED' | 'NO_RESTRICTIONS_4XX' | 'UNREACHABLE' | 'SERVER_ERROR' | 'CHALLENGED' | 'RATE_LIMITED' | 'NOT_FETCHED';
      note: string;
      sitemaps: string[];
      unsupported_fields: string[];
      bytes: number;
      body_ref: string | null;
    };
    sitemap: {
      chosen: string | null;
      chosen_basis: 'robots_declaration' | 'fallback_probe' | 'none';
      matrix: SitemapVariantRow[];
      scope_statement: string;
    };
    llms_txt: { url: string | null; state: 'PRESENT_TEXT' | 'ABSENT' | 'CHALLENGE' | 'HTML_FALLBACK' | 'UNAVAILABLE' | 'NOT_FETCHED'; status: number | null; excerpt: string | null; note: string };
    soft404: { probe_url: string | null; status: number | null; outcome: string; note: string };
    origins: { url: string; status: number | null; final_url: string | null; hops: RedirectHop[]; canonical: string | null; validity: Validity | null; error: string | null }[];
    ai_bots: { token: string; role: string; scored: boolean; decisions: { page_id: string; decision: RobotsDecision }[] }[];
  };
  evidence: Evidence[];
  checks: CheckResult[];
  root_issues: RootIssue[];
  content_review: {
    state: 'LLM' | 'DETERMINISTIC_ONLY' | 'UNAVAILABLE';
    note: string;
    truncated: boolean;
    input_chars: number;
    observations: ContentObservation[];
    rejected: { reason: string; item: string }[];
    summary: string | null;
  };
  optional_signals: { id: string; label: string; state: string; note: string; evidence_ids: string[] }[];
  performance: { field: FieldRecord[]; lab: LabRecord[]; note: string };
  scores: { technical_health: ScoreBlock; ai_accessibility: ScoreBlock };
  coverage: {
    pages: { requested: number; selected: number; fetched: number; valid: number; blocked: number; unavailable: number; challenged: number; error_pages: number };
    omitted_checks: { check_id: string; page_id: string | null; status: CheckStatus; reason: string }[];
  };
  summary: {
    strengths: string[];
    top_issue_ids: string[];
    counts: { critical: number; high: number; medium: number; low: number; opportunities: number };
    action_plan: { phase: '0-7 days' | '1-2 weeks' | '3-4 weeks'; label: string; issue_ids: string[] }[];
    narrative: string[];
  };
  budgets_used: Record<string, number>;
  timings: { created_at: string; started_at: string | null; finished_at: string | null; elapsed_ms: number | null };
  stages: StageRecord[];
  limitations: string[];
  sources: SourceRef[];
  report: { state: 'NONE' | 'GENERATING' | 'READY' | 'FAILED'; generated_at: string | null; error: string | null; bytes: number | null };
}

export interface SourceRef {
  source_id: string;
  title: string;
  url: string;
  label: SourceLabel;
  supports: string;
  reviewed: string;
}

export interface RuleDef {
  check_id: string;
  name: string;
  category: CategoryId;
  scope: Scope;
  score: ScoreId | null;
  score_bucket: string | null;
  weight: number;
  applicability: string;
  dependencies: string[];
  evidence_requirements: string;
  source_ids: string[];
  source_label: SourceLabel;
  severity_policy: string;
  rule_version: string;
}
