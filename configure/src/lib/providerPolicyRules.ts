/**
 * The rules behind the per-provider cache policy modal.
 *
 * Deliberately free of React, and of path aliases — the node:test runner resolves
 * neither, and the distinction this encodes (a row that is *displayed* is not a
 * row that is *ruled on*) is the part of that screen worth testing. That is also
 * why the shared duration grammar below is imported by relative path.
 *
 * See docs/superpowers/specs/2026-07-26-policy-modal-ux-design.md §4.
 */

export type TtlPolicy = 'default' | 'infer' | 'custom' | 'bypass';

/** A rule exactly as stored in `POSTER_CACHE_PROVIDER_POLICIES`. */
export interface ProviderPolicyRule {
  domain: string;
  policy: TtlPolicy;
  ttl?: string;
}

export interface PolicyRow {
  domain: string;
  /** On the built-in list: offered whether or not it has a rule, so it resets rather than removes. */
  builtIn: boolean;
  /** Whether this row has a rule of its own. Tracked apart from `policy` — see `buildPolicyRules`. */
  explicit: boolean;
  /** What the row shows: its own rule when explicit, otherwise what it inherits. */
  policy: TtlPolicy;
  /** Verbatim, and only meaningful for `custom`. */
  ttl: string;
}

/** What a provider resolves to with no rule of its own. */
export function inheritedPolicy(inferEnabled: boolean): TtlPolicy {
  return inferEnabled ? 'infer' : 'default';
}

// The duration grammar lives in addon/lib/posterCache/duration.ts, imported by
// the engine too, so a rule the modal accepts is one the engine reads the same way.
import { parseDurationMs } from '../../../addon/lib/posterCache/duration';

export { parseDurationMs };

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Lower-cased and stripped of leading dots, matching how the engine reads a rule. */
export function normalizeDomain(value: string): string {
  return (value || '').trim().toLowerCase().replace(/^\.+/, '');
}

export function isValidDomain(value: string): boolean {
  return DOMAIN_RE.test(normalizeDomain(value));
}

/** A human-readable reason this row cannot be saved yet, or `null`. */
export function rowProblem(row: PolicyRow): string | null {
  // A duration only has to parse when the chosen policy is going to use it.
  if (!row.explicit || row.policy !== 'custom') return null;
  if (!row.ttl.trim()) return 'Enter a duration';
  if (parseDurationMs(row.ttl) === null) return 'Use a duration such as 12h, 30d or 1y';
  return null;
}

/**
 * Builds the rows the modal shows: every built-in provider, plus any domain that
 * already has a rule. A provider with no rule still gets a row — that is the
 * point of the screen — but it is marked inherited so it saves as nothing.
 */
export function rowsFromRules(
  rules: ProviderPolicyRule[],
  knownProviders: string[],
  inferEnabled: boolean
): PolicyRow[] {
  const byDomain = new Map<string, ProviderPolicyRule>();
  for (const rule of rules) byDomain.set(normalizeDomain(rule.domain), rule);

  const domains = [...knownProviders.map(normalizeDomain)];
  for (const domain of byDomain.keys()) {
    if (!domains.includes(domain)) domains.push(domain);
  }

  return domains.map((domain) => {
    const rule = byDomain.get(domain);
    return {
      domain,
      builtIn: knownProviders.map(normalizeDomain).includes(domain),
      explicit: !!rule,
      policy: rule ? rule.policy : inheritedPolicy(inferEnabled),
      ttl: rule?.ttl ?? '',
    };
  });
}

/**
 * Only rows with a rule of their own are written.
 *
 * `explicit` is tracked separately from `policy` because `{policy: 'default'}`
 * and *no rule* are not the same thing: with the global toggle on, no-rule
 * resolves to `infer` while an explicit `default` overrides it back. Saving every
 * displayed row would write a rule per provider and neuter the toggle; saving
 * only the non-default ones would make pinning a provider to default
 * unexpressible. So choosing any value marks a row explicit, and only a reset
 * clears it.
 */
export function buildPolicyRules(rows: PolicyRow[]): ProviderPolicyRule[] {
  return rows
    .filter((row) => row.explicit)
    .map((row) => (row.policy === 'custom'
      ? { domain: row.domain, policy: row.policy, ttl: row.ttl.trim() }
      // A duration left behind by switching away from Custom must not ride along.
      : { domain: row.domain, policy: row.policy }));
}

/** The empty string, not `[]`, so an install with no rules reads as unset. */
export function serializePolicies(rules: ProviderPolicyRule[]): string {
  return rules.length === 0 ? '' : JSON.stringify(rules);
}

// --- the flat default ------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** At most two decimals, without a trailing `.0`. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function trimNumber(value: number): string {
  return String(round2(value));
}

function plural(value: number, unit: string): string {
  return `${trimNumber(value)} ${unit}${value === 1 ? '' : 's'}`;
}

/**
 * The stored setting is in days and accepts fractions, and `0` means *never
 * expire* rather than *expire immediately*. Both are easy to get wrong from a
 * bare number box, so the modal echoes the meaning back as you type.
 *
 * `null` for anything unusable, which is what blocks the save.
 */
export function describeDays(raw: unknown): string | null {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const days = Number(text);
  if (!Number.isFinite(days) || days < 0) return null;

  if (days === 0) return 'never expires';

  // The unit is chosen from the *rounded* figure, so a value a hair under an hour
  // reads as "1 hour" rather than "60 minutes".
  const ms = days * DAY_MS;
  const asMinutes = round2(ms / (60 * 1000));
  if (asMinutes < 1) return 'under a minute';
  if (asMinutes < 60) return plural(asMinutes, 'minute');

  const asHours = round2(ms / (60 * 60 * 1000));
  if (asHours < 24) return plural(asHours, 'hour');

  return plural(days, 'day');
}

export interface SettingChange {
  key: string;
  value: string;
  /** Names the setting in a partial-failure message. */
  label: string;
}

export interface PolicyFormState {
  flatDays: string;
  infer: boolean;
  rules: ProviderPolicyRule[];
}

/** Compared rather than the written value: row order is deterministic but arbitrary. */
function canonicalPolicies(rules: ProviderPolicyRule[]): string {
  return JSON.stringify(
    [...rules]
      .sort((a, b) => a.domain.localeCompare(b.domain))
      .map((rule) => (rule.policy === 'custom'
        ? { domain: rule.domain, policy: rule.policy, ttl: (rule.ttl ?? '').trim() }
        : { domain: rule.domain, policy: rule.policy }))
  );
}

/** `30`, ` 30 ` and `30.0` are the same setting; only a different number is a change. */
function sameDays(a: string, b: string): boolean {
  const left = Number(String(a).trim());
  const right = Number(String(b).trim());
  if (Number.isFinite(left) && Number.isFinite(right)) return left === right;
  return String(a).trim() === String(b).trim();
}

/**
 * Folds one landed write back into the baseline Save diffs against.
 *
 * Needed because a save is several requests and any one of them can fail. Without
 * this the baseline stays where it started, so a retry re-asks for settings that
 * already landed and the Save button contradicts the "Partly saved" message.
 *
 * Every key `pendingChanges` can emit must be handled here — a missing one makes
 * Save retry that setting forever.
 */
export function applyChange(state: PolicyFormState, change: SettingChange): PolicyFormState {
  switch (change.key) {
    case 'POSTER_CACHE_TTL_DAYS':
      return { ...state, flatDays: change.value };
    case 'POSTER_CACHE_INFER_TTL':
      return { ...state, infer: change.value === 'true' };
    case 'POSTER_CACHE_PROVIDER_POLICIES':
      return { ...state, rules: change.value === '' ? [] : JSON.parse(change.value) };
    default:
      return state;
  }
}

/**
 * The settings this form would actually write, least specific first so that every
 * intermediate state during a multi-write save is a coherent one. Untouched
 * settings are never written, which keeps the common case — editing one rule — to
 * a single request, and lets the modal disable Save when there is nothing to do.
 */
export function pendingChanges(next: PolicyFormState, saved: PolicyFormState): SettingChange[] {
  const changes: SettingChange[] = [];

  if (!sameDays(next.flatDays, saved.flatDays)) {
    changes.push({
      key: 'POSTER_CACHE_TTL_DAYS',
      value: String(next.flatDays).trim(),
      label: 'the default validity',
    });
  }
  if (next.infer !== saved.infer) {
    changes.push({
      key: 'POSTER_CACHE_INFER_TTL',
      value: String(next.infer),
      label: 'the follow-source setting',
    });
  }
  if (canonicalPolicies(next.rules) !== canonicalPolicies(saved.rules)) {
    changes.push({
      key: 'POSTER_CACHE_PROVIDER_POLICIES',
      value: serializePolicies(next.rules),
      label: 'the per-provider rules',
    });
  }

  return changes;
}
