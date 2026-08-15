import type { ExportNote } from '@shared/types';
import type { SourceIssue } from './manifestSources';
import { collectProblems, type ProblemTarget } from './problems';

export type IssueSeverity = 'blocking' | 'warning' | 'info';

export interface IssueRow {
  key: string;
  message: string;
  severity: IssueSeverity;
  entryId: string | null;
  folderId: string | null;
}

export interface BlockingInput {
  target: 'nuvio' | 'fusion';
  strandedNative: number;
  overBy: number;
  pendingCount: number;
  headroom: number;
  /** Required API keys the configuration is still missing, by display name. */
  missingKeys: string[];
  /** Classic rows whose type Fusion will not import. */
  unsupportedRows: Array<{ id: string; title: string; type: string }>;
}

export interface IssueCenterArgs {
  blocking: IssueRow[];
  issues: SourceIssue[];
  notes: ExportNote[];
  targets: Map<string, ProblemTarget>;
}

export interface SaveVerdict {
  canSave: boolean;
  blocking: number;
  warnings: number;
  label: string;
}

const RANK: Record<IssueSeverity, number> = { blocking: 0, warning: 1, info: 2 };

/** Also shown inside the row's own editor, so both places say the same thing. */
export function unsupportedRowMessage(type: string, target: 'nuvio' | 'fusion'): string {
  const move = `Move it into a collection folder, or add the row by hand in Fusion. Both work: only the JSON import refuses ${type}.`;
  return target === 'fusion'
    ? `Fusion cannot import this row: its catalog is type ${type}, and one such row makes Fusion reject the whole file rather than just this row. ${move}`
    : `Nuvio serves this, but Fusion cannot import it as a classic row: its catalog is type ${type}. ${move}`;
}

/**
 * The two conditions that refuse a save outright, as rows so they sit in the
 * same list as everything else rather than ambushing the user at the button.
 */
export function blockingIssues({
  target,
  strandedNative,
  overBy,
  pendingCount,
  headroom,
  missingKeys,
  unsupportedRows,
}: BlockingInput): IssueRow[] {
  const rows: IssueRow[] = [];

  // One per row and anchored to it, so the rail marks the row at fault and
  // selecting the issue opens it. Said on both targets, because the design is one
  // thing: Nuvio serves these types, so there it is only worth knowing.
  for (const row of unsupportedRows) {
    rows.push({
      key: `block-row-type-${row.id}`,
      severity: target === 'fusion' ? 'blocking' : 'warning',
      message: unsupportedRowMessage(row.type, target),
      entryId: row.id,
      folderId: null,
    });
  }

  if (missingKeys.length > 0) {
    rows.push({
      key: 'block-missing-keys',
      severity: 'blocking',
      message: `Your configuration cannot be saved until ${missingKeys.join(', ')} ${missingKeys.length === 1 ? 'is' : 'are'} filled in on the Configuration tab. Apply only keeps this design without saving.`,
      entryId: null,
      folderId: null,
    });
  }

  if (overBy > 0) {
    rows.push({
      key: 'block-over-limit',
      severity: 'blocking',
      message: `This design needs ${pendingCount} new catalogs and there is room for ${headroom}. Remove ${overBy} more catalog${overBy === 1 ? '' : 's'} worth of tiles.`,
      entryId: null,
      folderId: null,
    });
  }

  if (strandedNative > 0) {
    const here = target === 'fusion' ? 'Fusion' : 'Nuvio';
    const other = target === 'fusion' ? 'Nuvio' : 'Fusion';
    rows.push({
      key: 'block-native',
      severity: 'blocking',
      message: `${here} cannot serve ${strandedNative} source${strandedNative === 1 ? '' : 's'} that ${other} fetches itself. Route them through AIOMetadata, or build for ${other}.`,
      entryId: null,
      folderId: null,
    });
  }

  return rows;
}

export function buildIssueCenter({ blocking, issues, notes, targets }: IssueCenterArgs): IssueRow[] {
  return [...blocking, ...collectProblems(issues, notes, targets)]
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

export function saveVerdict(rows: IssueRow[]): SaveVerdict {
  const blocking = rows.filter(row => row.severity === 'blocking').length;
  const warnings = rows.filter(row => row.severity === 'warning').length;

  if (blocking > 0) {
    return { canSave: false, blocking, warnings, label: `${blocking} issue${blocking === 1 ? '' : 's'} to fix` };
  }
  if (warnings > 0) {
    return { canSave: true, blocking, warnings, label: `Save · ${warnings} warning${warnings === 1 ? '' : 's'}` };
  }
  return { canSave: true, blocking, warnings, label: 'Save' };
}
