import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Layers,
  Link as LinkIcon,
  Plus,
  Replace,
  Rows3,
  Tv,
  Upload,
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useConfig } from '@/contexts/ConfigContext';
import { getSourceBadgeStyle } from '@/lib/sourceBadges';

import {
  createClassicRowDraft,
  createCollectionDraft,
  newId,
  type AddonIdentity,
  type BuilderEntry,
  type ExportNote,
  type SourceDraft,
} from '@shared/types';
import { toNuvioCollections } from '@shared/nuvioExport';
import {
  groupMissingCatalogs,
  parseImport,
  remapSources,
  type ImportResult,
  type MissingCatalogGroup,
} from '@shared/importers';
import { toFusionWidgets } from '@shared/fusionExport';
import {
  buildIdentity,
  buildManifestUrl,
  catalogKey,
  findSourceIssues,
  findUnknownSources,
  healSourceNames,
  loadCatalogSources,
  stripManifestSuffix,
  type CatalogSourceList,
  type ManifestCatalog,
} from '@/lib/collectionBuilder/manifestSources';
import {
  buildProblemTargets,
  collectProblems,
  countProblems,
  withStagedCatalogs,
} from '@/lib/collectionBuilder/problems';
import { FUSION_CHIP, NUVIO_CHIP, TERMS, type Target } from '@/lib/collectionBuilder/terms';
import { CollectionPreview } from './CollectionPreview';
import { buildBlueprintLookup } from '@shared/blueprintLookup';
import {
  additionCount,
  additionLabels,
  applyCatalogAdditions,
  resolveCatalogAdditions,
  type CatalogAdditions,
} from '@/lib/collectionBuilder/catalogBlueprints';
import {
  dedupeBlueprints,
  fromNativeSource,
  isNativeSource,
  type CatalogBlueprint,
} from '@shared/catalogReconstruction';
import type { ShareableCatalog } from '@shared/catalogSharing';

import { CatalogPicker } from './collectionBuilder/CatalogPicker';
import { ClassicRowEditor } from './collectionBuilder/ClassicRowEditor';
import { CollectionEditor } from './collectionBuilder/CollectionEditor';
import { SortableEntryRow } from './collectionBuilder/EntryRail';
import { clone, duplicateEntryDraft, entrySourceCount, type TagOption } from './collectionBuilder/shared';

const SETTINGS_LAYOUT_NAVIGATE_EVENT = 'settings-layout:navigate';

/**
 * Above this many catalogs an import stops to ask. A community file can carry
 * thousands, and every one added becomes a manifest entry.
 */
const BULK_ADD_THRESHOLD = 100;

interface CollectionBuilderDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

function collectIds(entries: BuilderEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(entry.id);
    if (entry.kind !== 'collection') continue;
    for (const folder of entry.folders) ids.add(folder.id);
  }
  return ids;
}

/**
 * An exported design carries its ids, and importing one twice would otherwise
 * seat two entries on the same id: deleting either would take both. Only the
 * clashes are reissued, so a design imported once keeps the ids Nuvio knows it by.
 */
function reissueTakenIds(entries: BuilderEntry[], taken: Set<string>): void {
  for (const entry of entries) {
    if (!entry.id || taken.has(entry.id)) entry.id = newId();
    taken.add(entry.id);
    if (entry.kind !== 'collection') continue;
    for (const folder of entry.folders) {
      if (!folder.id || taken.has(folder.id)) folder.id = newId();
      taken.add(folder.id);
    }
  }
}

// ---- Main dialog ----

export function CollectionBuilderDialog({ isOpen, onClose }: CollectionBuilderDialogProps) {
  const { config, setConfig, auth, maxCatalogs, collectionImportCatalogCap } = useConfig();

  const [entries, setEntries] = useState<BuilderEntry[]>([]);
  /** Entries as they stood when opened or last applied, to spot real edits. */
  const [baseline, setBaseline] = useState('[]');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('design');
  const [focusFolder, setFocusFolder] = useState<{ entryId: string; folderId: string } | null>(null);
  const [titleFocusId, setTitleFocusId] = useState<string | null>(null);
  const clearFocusFolder = useCallback(() => setFocusFolder(null), []);
  const clearTitleFocus = useCallback(() => setTitleFocusId(null), []);
  const [target, setTarget] = useState<Target>('nuvio');
  const [manifestUrl, setManifestUrl] = useState('');
  const [usePlaceholder, setUsePlaceholder] = useState(false);
  const [sourceList, setSourceList] = useState<CatalogSourceList>({ catalogs: [], origin: 'derived' });
  const [manifestIdentity, setManifestIdentity] = useState<Partial<AddonIdentity>>({});
  const [pickerTarget, setPickerTarget] = useState<{ entryId: string; folderId: string | null; replaceIndex?: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null);
  const [stagedBlueprints, setStagedBlueprints] = useState<CatalogBlueprint[]>([]);
  const [convertNative, setConvertNative] = useState(false);
  const [overLimitOpen, setOverLimitOpen] = useState(false);
  const [nativeBlockFor, setNativeBlockFor] = useState<'apply' | 'copy' | 'download' | 'link' | null>(null);
  const terms = TERMS[target];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    if (!isOpen) return;
    const saved = clone(config.collections || []) as BuilderEntry[];
    setEntries(saved);
    setBaseline(JSON.stringify(saved));
    setSelectedId(saved[0]?.id ?? null);
    setStagedBlueprints([]);
    setActiveTab('design');
    setFocusFolder(null);
    setTitleFocusId(null);
    setManifestUrl(buildManifestUrl(auth.userUUID));
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    loadCatalogSources(config, manifestUrl).then(result => {
      if (cancelled) return;
      setSourceList({ catalogs: result.catalogs, origin: result.origin, error: result.error });
      setManifestIdentity(result.identity);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, manifestUrl, config.catalogs]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sourceList.catalogs.length === 0) return;
    const healed = healSourceNames(entries, sourceList.catalogs);
    if (healed === entries) return;
    setEntries(healed);
    // Only carry the baseline along if nothing else had been edited yet,
    // otherwise healing would quietly mark real work as saved.
    if (JSON.stringify(entries) === baseline) setBaseline(JSON.stringify(healed));
  }, [sourceList.catalogs, entries, baseline]);

  const identity = useMemo(
    () => buildIdentity(config, manifestUrl, manifestIdentity),
    [config, manifestUrl, manifestIdentity]
  );

  // Catalogs ride along with the file so an importer who does not have them can
  // rebuild them instead of adding each one by hand.
  const blueprints = useMemo(
    () => buildBlueprintLookup(config.catalogs as ShareableCatalog[]),
    [config.catalogs]
  );

  const nuvioResult = useMemo(
    () => toNuvioCollections(entries, identity, blueprints),
    [entries, identity, blueprints]
  );
  const fusionResult = useMemo(
    () => toFusionWidgets(entries, identity, { usePlaceholder, blueprints }),
    [entries, identity, usePlaceholder, blueprints]
  );

  const json = useMemo(
    () => JSON.stringify(target === 'nuvio' ? nuvioResult.output : fusionResult.output, null, 2),
    [target, nuvioResult, fusionResult]
  );

  const notes: ExportNote[] = target === 'nuvio' ? nuvioResult.notes : fusionResult.notes;

  const unknownSources = useMemo(
    () => findUnknownSources(entries, sourceList.catalogs),
    [entries, sourceList.catalogs]
  );
  const [confirmApply, setConfirmApply] = useState(false);
  const [pendingNavigate, setPendingNavigate] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [remapOpen, setRemapOpen] = useState(false);
  const [remapChoices, setRemapChoices] = useState<Record<string, SourceDraft>>({});
  const [remapPickFor, setRemapPickFor] = useState<string | null>(null);

  const applyRemap = () => {
    const { entries: next, replaced } = remapSources(entries, remapChoices);
    setEntries(next);
    setRemapOpen(false);
    setRemapChoices({});
    toast.success(replaced === 1 ? '1 source repointed' : `${replaced} sources repointed`);
  };

  const selected = entries.find(entry => entry.id === selectedId) || null;

  const updateEntry = useCallback((next: BuilderEntry) => {
    setEntries(prev => prev.map(entry => (entry.id === next.id ? next : entry)));
  }, []);

  const addEntry = (entry: BuilderEntry) => {
    setEntries(prev => [...prev, entry]);
    setSelectedId(entry.id);
    setActiveTab('design');
    setTitleFocusId(entry.id);
  };

  const removeEntry = (id: string) => {
    setEntries(prev => {
      const next = prev.filter(entry => entry.id !== id);
      setSelectedId(current => (current === id ? next[0]?.id ?? null : current));
      return next;
    });
  };

  const goToProblem = (entryId: string | null, folderId: string | null) => {
    if (!entryId) return;
    setSelectedId(entryId);
    setActiveTab('design');
    if (folderId) setFocusFolder({ entryId, folderId });
  };

  const handleRailDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setEntries(prev => {
      const from = prev.findIndex(entry => entry.id === active.id);
      const to = prev.findIndex(entry => entry.id === over.id);
      if (from < 0 || to < 0) return prev;
      return arrayMove(prev, from, to);
    });
  };

  const moveEntry = (index: number, delta: number) => {
    setEntries(prev => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      return arrayMove(prev, index, to);
    });
  };

  const moveEntryTo = (index: number, position: 'top' | 'bottom') => {
    setEntries(prev => {
      const to = position === 'top' ? 0 : prev.length - 1;
      if (to === index) return prev;
      return arrayMove(prev, index, to);
    });
  };

  const duplicateEntry = (id: string) => {
    const original = entries.find(entry => entry.id === id);
    if (!original) return;
    const copy = duplicateEntryDraft(original);
    setEntries(prev => {
      const at = prev.findIndex(entry => entry.id === id);
      if (at < 0) return prev;
      return [...prev.slice(0, at + 1), copy, ...prev.slice(at + 1)];
    });
    setSelectedId(copy.id);
    setTitleFocusId(copy.id);
  };

  const pickerExistingKeys = useMemo(() => {
    if (!pickerTarget) return [];
    // Replacing is a single pick, so nothing needs to be marked as already added.
    if (typeof pickerTarget.replaceIndex === 'number') return [];
    const entry = entries.find(item => item.id === pickerTarget.entryId);
    if (!entry || entry.kind !== 'collection') return [];
    const folder = entry.folders.find(item => item.id === pickerTarget.folderId);
    return folder ? folder.sources.map(catalogKey) : [];
  }, [pickerTarget, entries]);

  /** Only tags that actually cover a catalog the user can use. */
  const tagOptions: TagOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const catalog of sourceList.catalogs) {
      for (const tag of catalog.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return (config.tags ?? [])
      .filter(tag => counts.has(tag.name))
      .map(tag => ({ name: tag.name, color: tag.color, count: counts.get(tag.name) ?? 0 }));
  }, [sourceList.catalogs, config.tags]);

  const addSourcesByTag = (entryId: string, folderId: string, tag: string) => {
    const matching = sourceList.catalogs.filter(catalog => (catalog.tags ?? []).includes(tag));
    if (matching.length === 0) return;

    let added = 0;
    setEntries(prev => prev.map(entry => {
      if (entry.id !== entryId || entry.kind !== 'collection') return entry;
      return {
        ...entry,
        folders: entry.folders.map(folder => {
          if (folder.id !== folderId) return folder;
          const existing = new Set(folder.sources.map(catalogKey));
          const incoming = matching
            .filter(catalog => !existing.has(catalogKey(catalog)))
            .map(catalog => ({
              catalogId: catalog.id,
              type: catalog.type,
              name: catalog.name,
              genre: catalog.genreRequired ? catalog.genres?.[0] ?? null : null,
            }));
          added = incoming.length;
          return { ...folder, sources: [...folder.sources, ...incoming] };
        }),
      };
    }));

    const skipped = matching.length - added;
    toast.success(
      `${added} ${added === 1 ? 'catalog' : 'catalogs'} added from "${tag}"` +
      (skipped > 0 ? `, ${skipped} already there` : '')
    );
  };

  const isDirty = useMemo(() => JSON.stringify(entries) !== baseline, [entries, baseline]);

  const requestClose = () => {
    if (isDirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const handlePick = (picked: ManifestCatalog[]) => {
    if (!pickerTarget || picked.length === 0) return;
    const sources: SourceDraft[] = picked.map(catalog => ({
      catalogId: catalog.id,
      type: catalog.type,
      name: catalog.name,
      genre: catalog.genreRequired ? catalog.genres?.[0] ?? null : null,
    }));
    setEntries(prev =>
      prev.map(entry => {
        if (entry.id !== pickerTarget.entryId) return entry;
        if (entry.kind === 'classicRow') return { ...entry, source: sources[0] };
        return {
          ...entry,
          folders: entry.folders.map(folder => {
            if (folder.id !== pickerTarget.folderId) return folder;

            if (typeof pickerTarget.replaceIndex === 'number') {
              const swapped = folder.sources.map((existing, index) =>
                index === pickerTarget.replaceIndex ? sources[0] : existing
              );
              // The replacement may already be elsewhere in this folder.
              const seen = new Set<string>();
              return {
                ...folder,
                sources: swapped.filter(source => {
                  const key = catalogKey(source);
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                }),
              };
            }

            const existing = new Set(folder.sources.map(catalogKey));
            const added = sources.filter(source => !existing.has(catalogKey(source)));
            return { ...folder, sources: [...folder.sources, ...added] };
          }),
        };
      })
    );
    setPickerTarget(null);
  };

  const applyToConfig = (
    thenGoToConfiguration = false,
    options: { withCatalogs?: boolean } = {}
  ) => {
    const addCatalogs = options.withCatalogs !== false && pendingCount > 0;

    setConfig(prev => ({
      ...prev,
      collections: clone(entries),
      ...(addCatalogs && { catalogs: applyCatalogAdditions(prev.catalogs || [], pendingAdditions) }),
    }));
    setBaseline(JSON.stringify(entries));
    if (addCatalogs) setStagedBlueprints([]);

    const catalogNote = addCatalogs
      ? ` ${pendingCount} catalog${pendingCount === 1 ? '' : 's'} added.`
      : '';

    if (thenGoToConfiguration) {
      toast.success(`Applied.${catalogNote} Save your configuration to store it.`);
      onClose();
      window.dispatchEvent(
        new CustomEvent(SETTINGS_LAYOUT_NAVIGATE_EVENT, {
          detail: { tab: 'configuration', scrollToTop: true },
        })
      );
      return;
    }
    toast.success(
      (entries.length === 1 ? '1 entry applied.' : `${entries.length} entries applied.`) +
      `${catalogNote} Save your configuration to store it.`
    );
  };

  const handleSave = (thenGoToConfiguration = false) => {
    // The design stays valid for Nuvio, but applying it while building for
    // Fusion also publishes the hosted widgets URL, which would serve tiles the
    // export cannot fill.
    if (target === 'fusion' && totalNative > 0) {
      setPendingNavigate(thenGoToConfiguration);
      setNativeBlockFor('apply');
      return;
    }
    // A config over the ceiling is refused on save, so this has to stop here
    // rather than let the catalogs through and fail later.
    if (overBy > 0) {
      setPendingNavigate(thenGoToConfiguration);
      setOverLimitOpen(true);
      return;
    }
    // Catalogs nothing can rebuild render as empty rows rather than breaking
    // anything, so this asks rather than refuses.
    if (unresolvedSources.length > 0) {
      setPendingNavigate(thenGoToConfiguration);
      setConfirmApply(true);
      return;
    }
    applyToConfig(thenGoToConfiguration);
  };

  const hasUnappliedEntries = useMemo(
    () => JSON.stringify(entries) !== JSON.stringify(config.collections || []),
    [entries, config.collections]
  );

  const hostedUrl = useMemo(() => {
    const base = stripManifestSuffix(manifestUrl);
    if (!base) return '';
    const file = target === 'fusion' ? 'fusion-widgets.json' : 'nuvio-collections.json';
    const query = manifestUrl.includes('?') ? manifestUrl.slice(manifestUrl.indexOf('?')) : '';
    return `${base}/${file}${query}`;
  }, [manifestUrl, target]);

  const previewImport = (text: string, convert = convertNative) => {
    setImportText(text);
    setImportPreview(text.trim() ? parseImport(text, { convertNative: convert }) : null);
  };

  const toggleConvertNative = (next: boolean) => {
    setConvertNative(next);
    if (importText.trim()) previewImport(importText, next);
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    previewImport(await file.text());
  };

  const importUnknown = useMemo(
    () => (importPreview ? findUnknownSources(importPreview.entries, sourceList.catalogs) : []),
    [importPreview, sourceList.catalogs]
  );

  /** What the file being previewed would add on its own, for the import panel. */
  const importAdditions: CatalogAdditions = useMemo(
    () => (importPreview
      ? resolveCatalogAdditions(
          config.catalogs || [],
          importPreview.blueprints,
          importUnknown,
          config.apiKeys || {}
        )
      : {
        added: [],
        enabled: [],
        resolved: new Set<string>(),
        needsAccount: [],
        needsAccountKeys: new Set<string>(),
      }),
    [importPreview, importUnknown, config.catalogs, config.apiKeys]
  );

  const rebuildable = additionCount(importAdditions);

  const importUnresolved = useMemo(
    () => importUnknown.filter(
      source => !importAdditions.resolved.has(`${source.catalogId}:${source.type}`)
    ),
    [importUnknown, importAdditions]
  );

  /**
   * Imported catalogs wait here rather than going straight into the config. A
   * community file can reference thousands, and which of them are actually
   * needed depends on what survives editing, so they are resolved against the
   * current design and only written on apply.
   */
  const pendingAdditions: CatalogAdditions = useMemo(
    () => resolveCatalogAdditions(
      config.catalogs || [],
      stagedBlueprints,
      unknownSources,
      config.apiKeys || {}
    ),
    [config.catalogs, stagedBlueprints, unknownSources, config.apiKeys]
  );

  const pendingCount = additionCount(pendingAdditions);

  /**
   * Sources that resolve to a catalog an apply would add. They are absent from
   * the manifest, so without this they would read as missing rather than staged.
   * A catalog waiting on an account it does not have is resolved but not added,
   * so it stays out: it is missing, and saying otherwise is the more costly lie.
   */
  const pendingKeys = useMemo(() => {
    if (pendingCount === 0) return new Set<string>();
    const { resolved, needsAccountKeys } = pendingAdditions;
    if (needsAccountKeys.size === 0) return resolved;
    return new Set([...resolved].filter(key => !needsAccountKeys.has(key)));
  }, [pendingAdditions, pendingCount]);

  /** Entries still pointing at a catalog neither the config nor the import can serve. */
  const entriesWithUnresolved = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) {
      const missing = findUnknownSources([entry], sourceList.catalogs);
      if (missing.some(source => !pendingKeys.has(catalogKey(source)))) ids.add(entry.id);
    }
    return ids;
  }, [entries, sourceList.catalogs, pendingKeys]);

  const issueCatalogs = useMemo(
    () => withStagedCatalogs(sourceList.catalogs, pendingKeys),
    [sourceList.catalogs, pendingKeys]
  );

  const issues = useMemo(() => findSourceIssues(entries, issueCatalogs), [entries, issueCatalogs]);

  const problemTargets = useMemo(() => buildProblemTargets(entries), [entries]);

  const problems = useMemo(
    () => collectProblems(issues, notes, problemTargets),
    [issues, notes, problemTargets]
  );

  const entryProblemCounts = useMemo(() => countProblems(problems, 'entryId'), [problems]);

  const folderProblemCounts = useMemo(() => countProblems(problems, 'folderId'), [problems]);

  const countNative = useCallback((entry: BuilderEntry) => {
    const sources = entry.kind === 'classicRow'
      ? (entry.source ? [entry.source] : [])
      : entry.folders.flatMap(folder => folder.sources);
    return sources.filter(isNativeSource).length;
  }, []);

  /**
   * Takes over client-resolved sources. Scoped to one collection by default so
   * the cost is taken on only where it buys something, and to everything when a
   * target cannot serve them at all.
   */
  const convertNativeSources = useCallback((entryId?: string) => {
    const rebuilt: CatalogBlueprint[] = [];
    let converted = 0;
    let kept = 0;

    setEntries(prev => prev.map(entry => {
      if (entryId !== undefined && entry.id !== entryId) return entry;
      if (entry.kind !== 'collection') return entry;

      return {
        ...entry,
        folders: entry.folders.map(folder => {
          const seen = new Set<string>();
          const sources: SourceDraft[] = [];
          for (const source of folder.sources) {
            let next = source;
            if (isNativeSource(source) && source.native) {
              const result = fromNativeSource(source.native);
              if (result.ok === true) {
                rebuilt.push(result.blueprint);
                next = result.source;
                converted += 1;
              } else {
                kept += 1;
              }
            }
            const key = `${next.catalogId}:${next.type}`;
            if (seen.has(key)) continue;
            seen.add(key);
            sources.push(next);
          }
          return { ...folder, sources };
        }),
      };
    }));

    if (rebuilt.length > 0) {
      setStagedBlueprints(prev => dedupeBlueprints([...prev, ...rebuilt]));
    }

    if (converted === 0) {
      toast.info('Nothing here could be routed through AIOMetadata');
      return;
    }
    toast.success(
      `${converted} source${converted === 1 ? '' : 's'} routed through AIOMetadata`,
      kept > 0
        ? { description: `${kept} had no equivalent here and stay with Nuvio.` }
        : undefined
    );
  }, []);

  /** How much of the design the selected target would drop, for the warning. */
  const fusionTileTotal = useMemo(
    () => entries.reduce((sum, entry) => sum + (entry.kind === 'collection' ? entry.folders.length : 0), 0),
    [entries]
  );

  const fusionTileLoss = useMemo(() => {
    const kept = fusionResult.output.widgets.reduce(
      (sum, widget) => sum + ('dataSource' in widget && widget.dataSource?.kind === 'collection'
        ? widget.dataSource.payload.items.length
        : 0),
      0
    );
    return Math.max(0, fusionTileTotal - kept);
  }, [fusionResult, fusionTileTotal]);

  const totalNative = useMemo(
    () => entries.reduce((sum, entry) => sum + countNative(entry), 0),
    [entries, countNative]
  );

  const entryIsNative = useCallback((entry: BuilderEntry) => {
    const sources = entry.kind === 'classicRow'
      ? (entry.source ? [entry.source] : [])
      : entry.folders.flatMap(folder => folder.sources);
    return sources.length > 0 && sources.every(isNativeSource);
  }, []);

  /** Sources the design points at that nothing in the config or the file can serve. */
  const unresolvedSources = useMemo(
    () => unknownSources.filter(
      source => !pendingAdditions.resolved.has(`${source.catalogId}:${source.type}`)
    ),
    [unknownSources, pendingAdditions]
  );

  const missingGroups: MissingCatalogGroup[] = useMemo(
    () => groupMissingCatalogs(unresolvedSources),
    [unresolvedSources]
  );

  const enabledCatalogCount = useMemo(
    () => (config.catalogs || []).filter(catalog => catalog.enabled !== false).length,
    [config.catalogs]
  );

  // The instance ceiling when it has one, otherwise the import's own cap, which
  // exists so an unlimited instance is not handed a manifest of thousands.
  const catalogLimit = maxCatalogs ?? collectionImportCatalogCap;
  const headroom = Math.max(0, catalogLimit - enabledCatalogCount);
  const overBy = Math.max(0, pendingCount - headroom);

  const runImport = (mode: 'replace' | 'merge') => {
    if (!importPreview || importPreview.entries.length === 0) return;
    const incoming = healSourceNames(
      clone(importPreview.entries) as BuilderEntry[],
      sourceList.catalogs
    );
    reissueTakenIds(incoming, mode === 'merge' ? collectIds(entries) : new Set<string>());

    setStagedBlueprints(prev => dedupeBlueprints(
      mode === 'replace' ? importPreview.blueprints : [...prev, ...importPreview.blueprints]
    ));

    setEntries(prev => {
      const next = mode === 'replace' ? incoming : [...prev, ...incoming];
      setSelectedId(next[0]?.id ?? null);
      return next;
    });
    setImportOpen(false);
    setImportText('');
    setImportPreview(null);
    setConvertNative(false);
    toast.success(
      incoming.length === 1 ? '1 entry imported' : `${incoming.length} entries imported`,
      rebuildable > 0
        ? { description: `${rebuildable} catalog${rebuildable === 1 ? '' : 's'} will be added when you apply.` }
        : undefined
    );
  };

  const handleCopyUrl = async () => {
    if (target === 'fusion' && totalNative > 0) {
      setNativeBlockFor('link');
      return;
    }
    await navigator.clipboard.writeText(hostedUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 1500);
    toast.success('Link copied to clipboard');
  };

  const handleCopy = async () => {
    if (target === 'fusion' && totalNative > 0) {
      setNativeBlockFor('copy');
      return;
    }
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    toast.success('JSON copied to clipboard');
  };

  const handleDownload = () => {
    if (target === 'fusion' && totalNative > 0) {
      setNativeBlockFor('download');
      return;
    }
    const name = target === 'nuvio' ? 'nuvio-collections' : 'fusion-widgets';
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name}-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={open => !open && requestClose()}>
        <DialogContent
          className="max-w-6xl max-h-[90vh] overflow-y-auto"
          onInteractOutside={event => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5" />
              Collections &amp; Widgets
            </DialogTitle>
            <DialogDescription>
              Arrange your catalogs once, then export as Nuvio collection JSON or Fusion widget JSON. The switch below
              only changes wording and which options apply; the design itself is shared.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Building for</span>
            <div className="flex gap-1 rounded-lg border p-1">
              <button
                type="button"
                onClick={() => setTarget('nuvio')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs transition-colors ${
                  target === 'nuvio'
                    ? 'bg-cyan-900/50 text-cyan-200 ring-1 ring-cyan-500/60'
                    : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                <Tv className="h-3.5 w-3.5" /> Nuvio
              </button>
              <button
                type="button"
                onClick={() => setTarget('fusion')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs transition-colors ${
                  target === 'fusion'
                    ? 'bg-violet-900/50 text-violet-200 ring-1 ring-violet-500/60'
                    : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                <Rows3 className="h-3.5 w-3.5" /> Fusion
              </button>
            </div>
          </div>

          {target === 'fusion' && totalNative > 0 && (
            <div className="flex flex-col gap-2 rounded-md border border-amber-600/50 bg-amber-950/20 p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-start gap-1.5 text-xs text-amber-500">
                <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
                <span>
                  Fusion cannot serve {totalNative} of these sources. Nuvio fetches them from TMDB and Trakt
                  itself, and Fusion has no equivalent, so the tiles using them are left out of this export.
                  Routing them through AIOMetadata is the only way to keep them.
                </span>
              </p>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 border-amber-600/60 text-amber-200 hover:bg-amber-900/40"
                onClick={() => convertNativeSources()}
              >
                <Replace className="mr-1.5 h-4 w-4" /> Route all through AIOMetadata
              </Button>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div className="space-y-2">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 border-cyan-700/50 hover:bg-cyan-900/30"
                  onClick={() => addEntry(createCollectionDraft())}
                >
                  <Layers className="mr-1.5 h-4 w-4 text-cyan-400" /> {terms.collection}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 border-violet-700/50 hover:bg-violet-900/30"
                  onClick={() => addEntry(createClassicRowDraft())}
                >
                  <Rows3 className="mr-1.5 h-4 w-4 text-violet-400" /> {terms.row}
                </Button>
              </div>
              <Button size="sm" variant="ghost" className="w-full" onClick={() => setImportOpen(true)}>
                <Upload className="mr-1.5 h-4 w-4" /> Import JSON
              </Button>

              {entries.length === 0 && (
                <button
                  type="button"
                  onClick={() => addEntry(createCollectionDraft())}
                  className="w-full rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 hover:text-foreground"
                >
                  Nothing yet.
                  <span className="mt-0.5 block font-medium">Start with a collection</span>
                </button>
              )}

              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleRailDragEnd}>
                <SortableContext items={entries.map(entry => entry.id)} strategy={verticalListSortingStrategy}>
                  <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1 lg:max-h-none lg:overflow-visible lg:pr-0">
                    {entries.map((entry, index) => {
                      const excluded =
                        (target === 'nuvio' && entry.kind === 'classicRow')
                        || (target === 'fusion' && entryIsNative(entry));
                      return (
                        <SortableEntryRow
                          key={entry.id}
                          entry={entry}
                          excluded={excluded}
                          hasUnknown={entriesWithUnresolved.has(entry.id)}
                          warnings={excluded ? 0 : entryProblemCounts.get(entry.id) ?? 0}
                          allNative={entryIsNative(entry)}
                          isActive={entry.id === selectedId}
                          canMoveUp={index > 0}
                          canMoveDown={index < entries.length - 1}
                          onMove={delta => moveEntry(index, delta)}
                          onMoveTo={position => moveEntryTo(index, position)}
                          onDuplicate={() => duplicateEntry(entry.id)}
                          onSelect={() => setSelectedId(entry.id)}
                          onDelete={() => removeEntry(entry.id)}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>

              {sourceList.origin === 'derived' && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-2 text-[11px] text-amber-600 dark:text-amber-400">
                  {sourceList.error
                    ? `Could not read your manifest (${sourceList.error}). The catalog list is derived from your local config.`
                    : 'Save your configuration to read the real manifest. Until then the catalog list is derived from your local config.'}
                  {' '}Genre options and genre requirements only come from the manifest, so save first if a catalog needs one.
                </div>
              )}
            </div>

            <div className="min-w-0">
              {problems.length > 0 && (
                <div className="mb-3 space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4 shrink-0" /> Worth checking
                    <Badge variant="outline" className="h-5 border-amber-600/50 px-1.5 text-[10px] text-amber-500">
                      {problems.length}
                    </Badge>
                    <span className="text-[10px] font-normal text-muted-foreground">
                      for the {target === 'nuvio' ? 'Nuvio' : 'Fusion'} export
                    </span>
                  </div>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {problems.slice(0, 12).map(problem => (
                      <li key={problem.key}>
                        {problem.entryId ? (
                          <button
                            type="button"
                            onClick={() => goToProblem(problem.entryId, problem.folderId)}
                            className="w-full rounded px-1 py-0.5 text-left underline-offset-2 hover:bg-amber-500/10 hover:text-foreground hover:underline"
                          >
                            {problem.message}
                          </button>
                        ) : (
                          <span className="block px-1 py-0.5">{problem.message}</span>
                        )}
                      </li>
                    ))}
                    {problems.length > 12 && (
                      <li className="px-1 py-0.5">and {problems.length - 12} more</li>
                    )}
                  </ul>
                </div>
              )}

              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList>
                  <TabsTrigger value="design">Design</TabsTrigger>
                  <TabsTrigger value="preview">Preview</TabsTrigger>
                  <TabsTrigger value="json">JSON</TabsTrigger>
                </TabsList>

                <TabsContent value="design" className="pt-4">
                  {!selected && (
                    <div className="rounded-md border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
                      <p>
                        {entries.length > 0
                          ? 'Select something on the left to edit it.'
                          : 'Nothing to edit yet.'}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => addEntry(createCollectionDraft())}
                      >
                        <Layers className="mr-1.5 h-4 w-4 text-cyan-400" /> New {terms.collection.toLowerCase()}
                      </Button>
                    </div>
                  )}
                  {selected?.kind === 'collection' && (
                    <CollectionEditor
                      entry={selected}
                      catalogs={sourceList.catalogs}
                      pendingKeys={pendingKeys}
                      target={target}
                      onChange={updateEntry}
                      onAddSource={folderId => setPickerTarget({ entryId: selected.id, folderId })}
                      onReplaceSource={(folderId, index) =>
                        setPickerTarget({ entryId: selected.id, folderId, replaceIndex: index })}
                      tagOptions={tagOptions}
                      onAddByTag={(folderId, tag) => addSourcesByTag(selected.id, folderId, tag)}
                      nativeCount={countNative(selected)}
                      onConvertNative={() => convertNativeSources(selected.id)}
                      folderWarnings={folderProblemCounts}
                      focus={focusFolder?.entryId === selected.id ? focusFolder : null}
                      onFocusHandled={clearFocusFolder}
                      focusTitle={titleFocusId === selected.id}
                      onTitleFocused={clearTitleFocus}
                    />
                  )}
                  {selected?.kind === 'classicRow' && (
                    <ClassicRowEditor
                      entry={selected}
                      catalogs={sourceList.catalogs}
                      pendingKeys={pendingKeys}
                      target={target}
                      onChange={updateEntry}
                      onAddSource={() => setPickerTarget({ entryId: selected.id, folderId: null })}
                      focusTitle={titleFocusId === selected.id}
                      onTitleFocused={clearTitleFocus}
                    />
                  )}
                </TabsContent>

                <TabsContent value="preview" className="pt-4">
                  <CollectionPreview
                    entry={selected}
                    target={target}
                    onEditFolder={folderId => selected && goToProblem(selected.id, folderId)}
                  />
                </TabsContent>

                <TabsContent value="json" className="space-y-3 pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`text-[11px] ${target === 'nuvio' ? NUVIO_CHIP : FUSION_CHIP}`}
                    >
                      {target === 'nuvio' ? 'Nuvio collections' : 'Fusion widgets'}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">switch target in the header</span>
                    <div className="ml-auto flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={handleCopy}>
                      {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
                      Copy
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleDownload}>
                      <Download className="mr-1.5 h-4 w-4" /> Download
                    </Button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="collection-manifest-url" className="text-xs">Manifest URL</Label>
                    <Input
                      id="collection-manifest-url"
                      value={manifestUrl}
                      onChange={event => setManifestUrl(event.target.value)}
                      placeholder="https://your-host/stremio/<uuid>/manifest.json"
                      className="h-9 font-mono text-xs"
                    />
                  </div>

                  <div className="space-y-1.5 rounded-lg border border-primary/40 bg-primary/5 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <LinkIcon className="h-4 w-4 text-primary" />
                      <Label htmlFor="collection-hosted-url" className="text-xs font-medium">Import by link</Label>
                      <span className="text-[11px] text-muted-foreground">
                        {target === 'fusion'
                          ? 'Paste this straight into Fusion instead of the JSON'
                          : 'Serves the same JSON live, if your app can read a URL'}
                      </span>
                    </div>
                    {hostedUrl ? (
                      <>
                        <div className="flex gap-2">
                          <Input id="collection-hosted-url" readOnly value={hostedUrl} className="h-9 font-mono text-xs" onClick={e => (e.target as HTMLInputElement).select()} />
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={handleCopyUrl}
                            aria-label="Copy the import link"
                          >
                            {copiedUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          </Button>
                        </div>
                        <p className="flex items-start gap-1.5 text-[11px] text-amber-500">
                          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                          {hasUnappliedEntries
                            ? 'The link serves what is saved on the server, which is not these edits yet. Apply to config, then save the configuration on the Config tab.'
                            : 'The link serves what is saved on the server. Save the configuration on the Config tab, or it will still serve the version from before you opened this.'}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          It rebuilds on every request, so re-importing after saving picks up your edits. Anyone with
                          the link can read it, same as your manifest URL{target === 'fusion' && usePlaceholder
                            ? ', and it always carries your real URL rather than the placeholder'
                            : ''}.
                        </p>
                      </>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        Save your configuration first. The link is served per user, so it needs a saved config to read.
                      </p>
                    )}
                  </div>

                  {target === 'fusion' && (
                    <div className="space-y-1.5 rounded-lg border p-3">
                      <div className="flex items-center gap-2">
                        <Switch
                          id="collection-use-placeholder"
                          checked={usePlaceholder}
                          onCheckedChange={setUsePlaceholder}
                        />
                        <Label htmlFor="collection-use-placeholder" className="text-xs font-medium">
                          Make a copy for someone else
                        </Label>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Your addon link contains your user ID, and this file embeds it on every row. Turn this on to
                        blank it out before posting the file publicly. Whoever imports it here gets their own link
                        filled in automatically, so they end up with your layout pointing at their catalogs.
                      </p>
                      {usePlaceholder && (
                        <p className="flex items-start gap-1.5 text-[11px] text-amber-500">
                          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                          This copy is for handing out, not for your own use. It has no addon link in it, so
                          importing it back here is what puts one in.
                        </p>
                      )}
                    </div>
                  )}

                  <textarea
                    readOnly
                    value={json}
                    className="h-80 w-full resize-none rounded-md border bg-muted p-3 font-mono text-xs focus:outline-none"
                    onClick={event => (event.target as HTMLTextAreaElement).select()}
                  />
                </TabsContent>
              </Tabs>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            <div className="min-w-0 space-y-1 sm:mr-auto">
              {overBy > 0 && (
                <p className="flex items-start gap-1.5 text-[11px] text-amber-500">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                  This design needs {pendingCount} new catalogs and there is room for {headroom}. Delete{' '}
                  {overBy} more catalog{overBy === 1 ? '' : 's'} worth of tiles to apply it.
                </p>
              )}
              {overBy === 0 && pendingCount > 0 && (
                <p className="text-[11px] text-emerald-500">
                  {pendingCount} catalog{pendingCount === 1 ? '' : 's'} will be added when you apply, leaving{' '}
                  {headroom - pendingCount} of your {catalogLimit} spare.
                </p>
              )}
              {unresolvedSources.length > 0 && (
                <p className="flex items-start gap-1.5 text-[11px] text-amber-500">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                  {unresolvedSources.length === 1
                    ? '1 source points at a catalog you do not have.'
                    : `${unresolvedSources.length} sources point at catalogs you do not have.`}{' '}
                  Swap them for yours, or leave them and those tiles come up empty.
                </p>
              )}
              {pendingAdditions.needsAccount.length > 0 && (
                <p className="flex items-start gap-1.5 text-[11px] text-amber-500">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                  This design uses your own {pendingAdditions.needsAccount.join(' and ')} catalogs, such as
                  your watchlist. Connect{' '}
                  {pendingAdditions.needsAccount.length === 1 ? 'that account' : 'those accounts'} first, or
                  applying leaves those tiles empty.
                </p>
              )}
              {overBy === 0
                && pendingCount === 0
                && unresolvedSources.length === 0
                && pendingAdditions.needsAccount.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Applying puts this in your configuration. It is only stored once you save the configuration
                  itself on the Config tab.
                </p>
              )}
            </div>
            {unresolvedSources.length > 0 && (
              <Button variant="outline" onClick={() => setRemapOpen(true)}>
                <Replace className="mr-1.5 h-4 w-4" /> Swap catalogs
              </Button>
            )}
            <Button variant="ghost" onClick={requestClose}>Close</Button>
            <Button variant="outline" onClick={() => handleSave()}>Apply to config</Button>
            <Button onClick={() => handleSave(true)}>Apply and go save</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={open => { if (!open) { setImportOpen(false); setImportText(''); setImportPreview(null); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import collections</DialogTitle>
            <DialogDescription>
              Paste or upload a Nuvio collections file, a Fusion widgets file, or a previous export from here.
              The format is detected for you.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <input
              type="file"
              accept="application/json,.json"
              id="collection-import-file"
              className="hidden"
              onChange={event => { void handleImportFile(event.target.files?.[0]); event.target.value = ''; }}
            />
            <Button size="sm" variant="outline" onClick={() => document.getElementById('collection-import-file')?.click()}>
              <Upload className="mr-1.5 h-4 w-4" /> Choose file
            </Button>
            <span className="text-xs text-muted-foreground">or paste below</span>
          </div>

          <textarea
            value={importText}
            onChange={event => previewImport(event.target.value)}
            placeholder='[{"id":"...","title":"My Collection","folders":[...]}]'
            className="h-48 w-full resize-none rounded-md border bg-muted p-3 font-mono text-xs focus:outline-none"
          />

          {importPreview && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                {importPreview.format === 'unknown' ? (
                  <Badge variant="outline" className="border-amber-600/50 bg-amber-800/60 text-[10px] text-amber-200">
                    unrecognised
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className={`text-[10px] ${importPreview.format === 'fusion' ? FUSION_CHIP : NUVIO_CHIP}`}
                  >
                    {importPreview.format === 'fusion'
                      ? 'Fusion widgets'
                      : importPreview.format === 'nuvio'
                        ? 'Nuvio collections'
                        : 'AIOMetadata export'}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {importPreview.entries.length === 0
                    ? 'Nothing importable found'
                    : `${importPreview.entries.length} ${importPreview.entries.length === 1 ? 'entry' : 'entries'}, ` +
                      `${importPreview.entries.reduce((n, e) => n + entrySourceCount(e), 0)} sources`}
                </span>
                {rebuildable > 0 && (
                  <Badge variant="outline" className="border-emerald-600/50 bg-emerald-800/60 text-[10px] text-emerald-200">
                    {rebuildable} catalog{rebuildable === 1 ? '' : 's'} rebuildable
                  </Badge>
                )}
                {importUnresolved.length > 0 && (
                  <Badge variant="outline" className="border-amber-600/50 bg-amber-800/60 text-[10px] text-amber-200">
                    {importUnresolved.length} not in your catalogs
                  </Badge>
                )}
              </div>

              {importPreview.nativeCount > 0 && (
                <div className="space-y-2 rounded-md border p-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Label htmlFor="convert-native" className="text-xs font-medium">
                        Route Nuvio's own sources through AIOMetadata
                      </Label>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {importPreview.nativeCount} of this file's sources are fetched by Nuvio straight from
                        TMDB or Trakt. Left alone they work as they are and cost nothing. Turning this on gives
                        them your artwork, ratings and filters, at{' '}
                        {importPreview.convertibleCount} catalog
                        {importPreview.convertibleCount === 1 ? '' : 's'} added to your setup.
                      </p>
                    </div>
                    <Switch
                      id="convert-native"
                      checked={convertNative}
                      onCheckedChange={toggleConvertNative}
                    />
                  </div>
                  {convertNative && importPreview.convertibleCount < importPreview.nativeCount && (
                    <p className="text-[11px] text-muted-foreground">
                      {importPreview.nativeCount - importPreview.convertibleCount} of them have no equivalent
                      here and stay with Nuvio.
                    </p>
                  )}
                </div>
              )}

              {rebuildable > 0 && (
                <div className="space-y-1 rounded-md border border-emerald-600/40 bg-emerald-950/20 p-2">
                  <p className="text-[11px] text-emerald-500">
                    This file carries the definitions for {rebuildable} catalog{rebuildable === 1 ? '' : 's'} you
                    do not have. Only the ones your design still uses when you apply are added, so trimming the
                    collections trims what you take on.
                  </p>
                  <ul className="space-y-0.5 text-[10px] text-muted-foreground">
                    {additionLabels(importAdditions, 6).map((label, index) => (
                      <li key={`${label}-${index}`}>{label}</li>
                    ))}
                    {importAdditions.added.length > 6 && (
                      <li>and {importAdditions.added.length - 6} more</li>
                    )}
                  </ul>
                </div>
              )}

              {importAdditions.needsAccount.length > 0 && (
                <p className="rounded-md border border-amber-600/40 bg-amber-950/20 p-2 text-[11px] text-amber-500">
                  This file uses your own {importAdditions.needsAccount.join(' and ')} catalogs, such as your
                  watchlist. Connect {importAdditions.needsAccount.length === 1 ? 'that account' : 'those accounts'} and
                  import again to have them added.
                </p>
              )}

              {importUnresolved.length > 0 && (
                <div className="space-y-1 rounded-md border border-amber-600/40 bg-amber-950/20 p-2">
                  <p className="text-[11px] text-amber-500">
                    These catalogs are not in your setup and the file does not say how to rebuild them. You can
                    still import, but those tiles will come up empty.
                  </p>
                  <ul className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
                    {importUnresolved.slice(0, 6).map((source, index) => (
                      <li key={`${source.catalogId}-${source.type}-${index}`}>
                        {source.catalogId} <span className="opacity-60">({source.type})</span>
                      </li>
                    ))}
                    {importUnresolved.length > 6 && <li>and {importUnresolved.length - 6} more</li>}
                  </ul>
                </div>
              )}

              {importPreview.entries.length > 0 && (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {importPreview.entries.slice(0, 6).map(entry => (
                    <li key={entry.id} className="flex items-center gap-2">
                      {entry.kind === 'collection'
                        ? <Layers className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                        : <Rows3 className="h-3.5 w-3.5 shrink-0 text-violet-400" />}
                      <span className="truncate">{entry.title}</span>
                      <span className="shrink-0">({entrySourceCount(entry)})</span>
                    </li>
                  ))}
                  {importPreview.entries.length > 6 && (
                    <li>and {importPreview.entries.length - 6} more</li>
                  )}
                </ul>
              )}

              {importPreview.notes.length > 0 && (
                <ul className="space-y-1 text-[11px] text-amber-500">
                  {importPreview.notes.slice(0, 5).map((note, index) => (
                    <li key={index} className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /> {note}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
            <Button variant="ghost" onClick={() => { setImportOpen(false); setImportText(''); setImportPreview(null); }}>
              Cancel
            </Button>
            <Button
              variant="outline"
              disabled={!importPreview || importPreview.entries.length === 0}
              onClick={() => runImport('replace')}
            >
              {entries.length > 0 ? `Replace all ${entries.length}` : 'Replace all'}
            </Button>
            <Button
              disabled={!importPreview || importPreview.entries.length === 0}
              onClick={() => runImport('merge')}
            >
              Add to existing
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={remapOpen} onOpenChange={open => { if (!open) { setRemapOpen(false); setRemapChoices({}); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Replace className="h-5 w-5" /> Swap in your catalogs
            </DialogTitle>
            <DialogDescription>
              Keep the imported layout and point each missing catalog at one of yours. Every place it is
              used gets updated.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[26rem] space-y-2 overflow-y-auto">
            {missingGroups.map(group => {
              const chosen = remapChoices[group.key];
              return (
                <div
                  key={group.key}
                  className={`space-y-2 rounded-lg border p-3 ${
                    chosen ? 'border-primary/50 bg-primary/5' : 'border-amber-600/40 bg-amber-950/10'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {chosen
                      ? <Check className="h-4 w-4 shrink-0 text-primary" />
                      : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />}
                    <span className="min-w-0 flex-1 truncate text-sm">{group.name}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">{group.type}</Badge>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      used {group.occurrences === 1 ? 'once' : `${group.occurrences} times`}
                    </span>
                  </div>
                  <p className="font-mono text-[10px] text-muted-foreground">{group.catalogId}</p>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">replace with</span>
                    {chosen ? (
                      <>
                        <Badge
                          variant="outline"
                          className={`text-[10px] font-semibold ${getSourceBadgeStyle(
                            sourceList.catalogs.find(c => catalogKey(c) === catalogKey(chosen))?.source
                          )}`}
                        >
                          {chosen.name}
                        </Badge>
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => setRemapPickFor(group.key)}>
                          Change
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => setRemapChoices(prev => {
                            const next = { ...prev };
                            delete next[group.key];
                            return next;
                          })}
                        >
                          Clear
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" className="h-7" onClick={() => setRemapPickFor(group.key)}>
                        <Plus className="mr-1 h-3.5 w-3.5" /> Pick a catalog
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-end">
            <span className="text-[11px] text-muted-foreground sm:mr-auto">
              {Object.keys(remapChoices).length} of {missingGroups.length} matched. Anything left unmatched stays
              as it is.
            </span>
            <Button variant="ghost" onClick={() => { setRemapOpen(false); setRemapChoices({}); }}>Cancel</Button>
            <Button disabled={Object.keys(remapChoices).length === 0} onClick={applyRemap}>
              Swap {Object.keys(remapChoices).length > 0 ? Object.keys(remapChoices).length : ''}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CatalogPicker
        isOpen={remapPickFor !== null}
        catalogs={sourceList.catalogs}
        multiple={false}
        existingKeys={[]}
        tagOptions={tagOptions}
        onConfirm={picked => {
          const catalog = picked[0];
          if (!catalog || !remapPickFor) return;
          setRemapChoices(prev => ({
            ...prev,
            [remapPickFor]: {
              catalogId: catalog.id,
              type: catalog.type,
              name: catalog.name,
              genre: catalog.genreRequired ? catalog.genres?.[0] ?? null : null,
            },
          }));
        }}
        onClose={() => setRemapPickFor(null)}
      />

      <Dialog open={confirmClose} onOpenChange={open => !open && setConfirmClose(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Keep your changes?
            </DialogTitle>
            <DialogDescription>
              You have edits that are not in your configuration yet. Closing now loses them.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfirmClose(false)}>Keep editing</Button>
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => { setConfirmClose(false); onClose(); }}
            >
              Discard
            </Button>
            <Button
              onClick={() => {
                applyToConfig();
                setConfirmClose(false);
                onClose();
              }}
            >
              Apply and close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmApply}
        onOpenChange={open => { if (!open) { setConfirmApply(false); setPendingNavigate(false); } }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Some catalogs are missing
            </DialogTitle>
            <DialogDescription>
              {unresolvedSources.length === 1
                ? '1 source points'
                : `${unresolvedSources.length} sources point`} at a catalog that is not in your setup:{' '}
              {unresolvedSources.slice(0, 3).map(source => source.catalogId).join(', ')}
              {unresolvedSources.length > 3 ? `, and ${unresolvedSources.length - 3} more` : ''}. Those tiles will
              come up empty until you add and enable the catalogs. Everything else works as normal.
            </DialogDescription>
          </DialogHeader>

          <p className="rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
            Swapping keeps the layout and points each one at a catalog you already have, everywhere it is used.
          </p>

          <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
            <Button
              variant="ghost"
              onClick={() => { setConfirmApply(false); setPendingNavigate(false); }}
            >
              Back to editing
            </Button>
            <Button
              variant="outline"
              onClick={() => { setConfirmApply(false); setPendingNavigate(false); setRemapOpen(true); }}
            >
              <Replace className="mr-1.5 h-4 w-4" /> Swap catalogs
            </Button>
            <Button onClick={() => { setConfirmApply(false); applyToConfig(pendingNavigate); }}>
              Apply anyway
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={nativeBlockFor !== null} onOpenChange={open => { if (!open) setNativeBlockFor(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Fusion cannot serve most of this
            </DialogTitle>
            <DialogDescription>
              {totalNative} source{totalNative === 1 ? '' : 's'} in this design {totalNative === 1 ? 'is' : 'are'}{' '}
              fetched by Nuvio itself, and Fusion has no equivalent. {fusionTileLoss > 0
                ? `${fusionTileLoss} of ${fusionTileTotal} tiles would come out empty.`
                : 'The tiles using them are left out.'}
            </DialogDescription>
          </DialogHeader>

          <p className="rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
            {nativeBlockFor === 'apply'
              ? 'The design is fine for Nuvio, so you can apply it and build for Nuvio instead. Applying also publishes your hosted widgets URL, which would hand out the same empty export.'
              : 'Switching to Nuvio gives you the complete export. Routing the sources through AIOMetadata keeps them on both targets, at one catalog each.'}
          </p>

          <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
            <Button variant="ghost" onClick={() => setNativeBlockFor(null)}>Cancel</Button>
            <Button
              variant="outline"
              onClick={() => { setTarget('nuvio'); setNativeBlockFor(null); }}
            >
              <Tv className="mr-1.5 h-4 w-4" /> Build for Nuvio
            </Button>
            <Button onClick={() => { convertNativeSources(); setNativeBlockFor(null); }}>
              <Replace className="mr-1.5 h-4 w-4" /> Route through AIOMetadata
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={overLimitOpen} onOpenChange={open => { if (!open) setOverLimitOpen(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Too many catalogs to add
            </DialogTitle>
            <DialogDescription>
              This design needs {pendingCount} catalog{pendingCount === 1 ? '' : 's'} you do not have, but there
              is room for {headroom}
              {maxCatalogs === null
                ? ' in a single import'
                : ` before this instance's limit of ${maxCatalogs}`}. Remove {overBy} more
              catalog{overBy === 1 ? '' : 's'} worth of tiles, or delete a collection you do not need, and the
              rest will be added.
            </DialogDescription>
          </DialogHeader>

          <p className="rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
            You have {enabledCatalogCount} catalog{enabledCatalogCount === 1 ? '' : 's'} enabled. Every catalog
            added here becomes an entry in your manifest, which your client fetches each time it loads the addon.
          </p>

          <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
            <Button variant="ghost" onClick={() => setOverLimitOpen(false)}>Back to editing</Button>
            <Button
              variant="outline"
              onClick={() => { setOverLimitOpen(false); applyToConfig(pendingNavigate, { withCatalogs: false }); }}
            >
              Apply layout only
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CatalogPicker
        isOpen={pickerTarget !== null}
        catalogs={sourceList.catalogs}
        multiple={pickerTarget?.folderId !== null && typeof pickerTarget?.replaceIndex !== 'number'}
        existingKeys={pickerExistingKeys}
        tagOptions={tagOptions}
        onConfirm={handlePick}
        onClose={() => setPickerTarget(null)}
      />
    </>
  );
}
