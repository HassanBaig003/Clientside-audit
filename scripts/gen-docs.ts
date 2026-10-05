/** Generates docs/RULES.md and docs/SOURCES.md from the live registries so the documents cannot drift from the code. */
import fs from 'node:fs';
import { AI_BUCKETS, CATEGORY_LABELS, RULES, RULE_REGISTRY_VERSION, TECH_WEIGHTS } from '../server/src/checks/registry';
import { BOTS, BOT_REGISTRY_VERSION, FEATURES, FEATURE_REGISTRY_REVIEWED, FEATURE_REGISTRY_VERSION, SOURCES, SOURCE_REGISTRY_REVIEWED } from '../server/src/sources/registry';

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
let rules = `# Rule registry ${RULE_REGISTRY_VERSION}\n\nGenerated from \`server/src/checks/registry.ts\` by \`npm run docs\`. Do not edit by hand.\n\n`;
rules += `Check statuses: PASS, WARN, FAIL, NOT_APPLICABLE, NOT_TESTABLE, ERROR. ERROR is a tool defect, never a website defect.\n\n`;
rules += `## Scoring (Wellows tool policy)\n\nPASS = 1, WARN = 0.5, FAIL = 0. Page units are averaged inside each check, checks are combined by rule weight inside a category, categories by the weights below, normalised over categories with evaluated checks. NOT_APPLICABLE, NOT_TESTABLE, ERROR, derived composites, optional signals and lab diagnostics are excluded. The headline is withheld without a genuine evaluated page or below 50% coverage.\n\n`;
rules += `| Initial Technical Health category | Weight |\n| --- | ---: |\n${TECH_WEIGHTS.map((w) => `| ${CATEGORY_LABELS[w.id]} | ${w.weight} |`).join('\n')}\n\n`;
rules += `| AI Technical Accessibility bucket | Weight |\n| --- | ---: |\n${AI_BUCKETS.map((w) => `| ${w.label} | ${w.weight} |`).join('\n')}\n\n`;
for (const cat of Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]) {
  const list = RULES.filter((r) => r.category === cat);
  if (!list.length) continue;
  rules += `## ${CATEGORY_LABELS[cat]}\n\n| ID | Check | Scope | Score | Weight | Applicability | Evidence required | Severity policy | Sources | Basis |\n| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |\n`;
  for (const r of list) rules += `| ${r.check_id} | ${cell(r.name)} | ${r.scope} | ${r.score ?? 'unscored'} | ${r.score ? r.weight : '-'} | ${cell(r.applicability)}${r.dependencies.length ? ` Depends on ${r.dependencies.join(', ')}.` : ''} | ${cell(r.evidence_requirements)} | ${cell(r.severity_policy)} | ${r.source_ids.join(', ')} | ${r.source_label} |\n`;
  rules += '\n';
}
fs.writeFileSync('docs/RULES.md', rules);

let src = `# Source registry\n\nGenerated from \`server/src/sources/registry.ts\` by \`npm run docs\`. Registry reviewed: ${SOURCE_REGISTRY_REVIEWED}.\n\nReviewing sources is a product maintenance task. Vendor documentation is not fetched during client audits. A "seeded" review note means the claim was taken from the builder prompt's registry and was not re-fetched in the build session; re-check those before relying on them for a FAIL.\n\n`;
src += `| ID | Source | Label | Supports | Reviewed |\n| --- | --- | --- | --- | --- |\n${SOURCES.map((s) => `| ${s.source_id} | [${cell(s.title)}](${s.url}) | ${s.label} | ${cell(s.supports)} | ${s.reviewed} |`).join('\n')}\n\n`;
src += `## Google feature registry ${FEATURE_REGISTRY_VERSION} (reviewed ${FEATURE_REGISTRY_REVIEWED})\n\nSchema.org defines vocabulary; these rows are Google's search-feature requirements. FAQ is deliberately absent: Google no longer shows the FAQ rich result.\n\n| Feature | Types | Required | One of | Recommended (checked) | Source |\n| --- | --- | --- | --- | --- | --- |\n${FEATURES.map((f) => `| ${f.feature} | ${f.types.slice(0, 6).join(', ')}${f.types.length > 6 ? ', ...' : ''} | ${f.required.join(', ') || 'none'} | ${f.one_of.map((g) => g.join(' / ')).join('; ') || '-'} | ${f.recommended.join(', ') || '-'} | ${f.source_id} |`).join('\n')}\n\n`;
src += `## Bot registry ${BOT_REGISTRY_VERSION}\n\n| Token | Vendor | Role | Scored | Interpretation | Source |\n| --- | --- | --- | --- | --- | --- |\n${BOTS.map((b) => `| ${b.token} | ${b.vendor} | ${b.role} | ${b.scored ? 'AI Technical Accessibility' : 'no'} | ${cell(b.interpretation)} | ${b.source_id} |`).join('\n')}\n`;
fs.writeFileSync('docs/SOURCES.md', src);
console.log('docs written');
