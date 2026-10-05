import * as cheerio from 'cheerio';
import type { Validity } from '../types';

export interface ValidityInput {
  status: number | null;
  headers: Record<string, string>;
  html: string | null;
  bodyComplete: boolean;
  truncatedReason: string | null;
  contentType: string | null;
  /** Control files (robots.txt, llms.txt, sitemap endpoints) are not HTML and are judged without the HTML shape rules. */
  expectHtml?: boolean;
  /** True for the RAW source; a serialised DOM is always well-formed so the source-truncation test does not apply. */
  rawSource?: boolean;
}

export interface ValidityResult {
  validity: Validity;
  evidence: string[];
}

const CHALLENGE_HEADERS: [string, RegExp, string][] = [
  ['cf-mitigated', /challenge/i, 'Cloudflare cf-mitigated: challenge header'],
  ['x-amzn-waf-action', /challenge|captcha/i, 'AWS WAF x-amzn-waf-action header'],
  ['x-datadome', /protected|blocked/i, 'DataDome protection header'],
  ['x-sucuri-block', /./, 'Sucuri block header'],
  ['x-px-block', /./, 'PerimeterX block header'],
  ['x-akamai-challenge', /./, 'Akamai challenge header'],
];

/** Vendor challenge markup. Each is specific enough to stand as a strong signal on its own. */
const CHALLENGE_SELECTORS: [string, string][] = [
  ['#challenge-form, #challenge-running, #cf-challenge-running, #challenge-stage, #cf-please-wait', 'Cloudflare challenge element'],
  ['script[src*="/cdn-cgi/challenge-platform/"]', 'Cloudflare challenge-platform script'],
  ['iframe[src*="challenges.cloudflare.com"], .cf-turnstile', 'Cloudflare Turnstile widget'],
  ['#px-captcha, [id^="px-captcha"]', 'PerimeterX captcha element'],
  ['script[src*="captcha-delivery.com"], iframe[src*="captcha-delivery.com"]', 'DataDome captcha resource'],
  ['#sec-if-cpt-container, #sec-cpt-if', 'Akamai challenge container'],
  ['script[src*="/_Incapsula_Resource"], iframe[src*="_Incapsula_Resource"]', 'Imperva Incapsula resource'],
  ['form#captcha-form, form[action*="captcha"], form[action*="/challenge"]', 'CAPTCHA/challenge form'],
  ['[data-wa-fixture-challenge]', 'fixture challenge marker'],
];

/** Widgets that also appear on ordinary pages (contact forms); only meaningful together with an interstitial shape. */
const WEAK_SELECTORS: [string, string][] = [
  ['.g-recaptcha, iframe[src*="recaptcha"]', 'reCAPTCHA widget'],
  ['.h-captcha, iframe[src*="hcaptcha.com"]', 'hCaptcha widget'],
  ['meta[http-equiv="refresh" i]', 'meta refresh'],
];

const CHALLENGE_PHRASES =
  /just a moment|checking your browser|verify(ing)? (that )?you are (a )?human|attention required|pardon our interruption|security check|are you a robot|unusual traffic|enable javascript and cookies to continue|bot verification|please wait while we verify|ddos protection/i;

export function assessValidity(input: ValidityInput): ValidityResult {
  const evidence: string[] = [];
  const { status, headers, html } = input;
  const expectHtml = input.expectHtml !== false;

  if (status === null) return { validity: 'UNKNOWN_RESPONSE', evidence: ['No HTTP response was received.'] };

  // 1. Challenge detection needs corroboration: a header, vendor markup, or phrase + interstitial template.
  for (const [name, re, label] of CHALLENGE_HEADERS) {
    if (headers[name] && re.test(headers[name])) evidence.push(`${label} (${name}: ${headers[name].slice(0, 80)})`);
  }
  let shape: ReturnType<typeof describeShape> | null = null;
  if (html && html.trim()) {
    const $ = cheerio.load(html);
    shape = describeShape($);
    for (const [sel, label] of CHALLENGE_SELECTORS) {
      if ($(sel).length) evidence.push(`${label} (${sel.split(',')[0]})`);
    }
    if (!evidence.length && shape.interstitial) {
      const phraseIn = CHALLENGE_PHRASES.exec(shape.title) ?? CHALLENGE_PHRASES.exec(shape.text.slice(0, 1500));
      const weak = WEAK_SELECTORS.filter(([sel]) => $(sel).length).map(([, l]) => l);
      // A phrase alone is not enough, and a short page alone is not enough; both together are.
      if (phraseIn) {
        evidence.push(`Challenge wording "${phraseIn[0]}" on an interstitial template (${shape.words} words, ${shape.links} links${weak.length ? `, ${weak.join(', ')}` : ''}, HTTP ${status})`);
      }
    }
  }
  if (evidence.length) return { validity: 'ACCESS_CHALLENGE', evidence };

  // 2. Genuine error statuses.
  if (status >= 400) return { validity: 'ERROR_DOCUMENT', evidence: [`HTTP ${status} response`] };
  if (status >= 300) return { validity: 'UNKNOWN_RESPONSE', evidence: [`HTTP ${status} without a followable redirect`] };

  // 3. Completeness.
  if (!html || !html.trim()) return { validity: 'EMPTY_OR_TRUNCATED', evidence: ['The response body is empty.'] };
  if (!input.bodyComplete) return { validity: 'EMPTY_OR_TRUNCATED', evidence: [input.truncatedReason ?? 'The response body is incomplete.'] };

  if (!expectHtml) return { validity: 'VALID_PAGE', evidence: [`HTTP ${status}, complete body`] };

  const ct = (input.contentType ?? '').toLowerCase();
  if (ct && !/html|xml/.test(ct)) return { validity: 'UNKNOWN_RESPONSE', evidence: [`Content-Type ${ct} is not an HTML document`] };
  if (shape && !shape.hasHtmlStructure) return { validity: 'UNKNOWN_RESPONSE', evidence: ['The body has no recognisable HTML document structure.'] };
  if (input.rawSource && looksTruncatedSource(html)) return { validity: 'EMPTY_OR_TRUNCATED', evidence: ['The HTML document ends without closing its body/html element; it may be truncated.'] };

  return { validity: 'VALID_PAGE', evidence: [`HTTP ${status}, complete HTML document`] };
}

function describeShape($: cheerio.CheerioAPI) {
  const html = $.html() ?? '';
  const title = $('head > title').first().text().trim();
  const clone = $('body').clone();
  clone.find('script,style,noscript,template').remove();
  const text = clone.text().replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  const links = $('a[href]').length;
  const hasNavOrMain = $('nav, main, article, footer').length > 0;
  return {
    title,
    text,
    words,
    links,
    // A challenge template is short, link-poor and has no site chrome. Shortness alone proves nothing.
    interstitial: words < 120 && links <= 4 && !hasNavOrMain,
    hasHtmlStructure: /<html[\s>]|<body[\s>]|<head[\s>]|<!doctype html/i.test(html),
  };
}

/** Raw-source truncation check: a complete transfer whose markup stops mid-document. */
export function looksTruncatedSource(source: string): boolean {
  const s = source.trim();
  if (s.length < 200) return false;
  if (!/<body[\s>]/i.test(s)) return false;
  // HTML may legally omit </body></html>, so an unclosed document only counts when it also stops mid-markup.
  return !/<\/body\s*>|<\/html\s*>/i.test(s.slice(-4000)) && !s.endsWith('>');
}
