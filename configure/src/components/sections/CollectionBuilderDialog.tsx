import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Copy,
  MoreVertical,
  Download,
  Folder,
  FolderPlus,
  GripVertical,
  Layers,
  Link as LinkIcon,
  ListOrdered,
  Replace,
  Tags,
  Upload,
  Plus,
  Rows3,
  Image as ImageIcon,
  ImageOff,
  Search,
  Trash2,
  Tv,
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
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useConfig } from '@/contexts/ConfigContext';
import { getSourceBadgeLabel, getSourceBadgeStyle } from '@/lib/sourceBadges';
import { getTagColor } from '@/lib/tagColors';
import { TagChip } from '@/components/TagChip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import {
  createClassicRowDraft,
  createCollectionDraft,
  createFolderDraft,
  hasNuvioCollectionSettings,
  hasNuvioFolderArt,
  newId,
  type BuilderEntry,
  type ClassicRowDraft,
  type CollectionDraft,
  type ExportNote,
  type FolderDraft,
  type FusionAspectRatio,
  type SourceDraft,
  type TileShape,
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
  nativeLabel,
  type CatalogBlueprint,
} from '@shared/catalogReconstruction';
import type { ShareableCatalog } from '@shared/catalogSharing';
import type { AddonIdentity } from '@shared/types';

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

const SHAPE_LABELS: Record<TileShape, string> = {
  POSTER: 'Poster',
  LANDSCAPE: 'Wide',
  SQUARE: 'Square',
};

const SHAPE_ORDER: TileShape[] = ['POSTER', 'LANDSCAPE', 'SQUARE'];

/** Classic rows spell the same three shapes lowercase, on presentation.aspectRatio. */
const ASPECT_BY_SHAPE: Record<TileShape, FusionAspectRatio> = {
  POSTER: 'poster',
  LANDSCAPE: 'wide',
  SQUARE: 'square',
};

/** Rough proportions so the choice reads at a glance. */
const SHAPE_PREVIEW: Record<TileShape, string> = {
  POSTER: 'h-4 w-[11px]',
  LANDSCAPE: 'h-3 w-5',
  SQUARE: 'h-4 w-4',
};

interface TagOption {
  name: string;
  color: string;
  count: number;
}

/** Marks a control that only one of the two targets understands. */
function ScopeChip({ scope }: { scope: 'nuvio' | 'fusion' }) {
  return (
    <Badge
      variant="outline"
      className={`h-5 shrink-0 px-1.5 text-[10px] font-medium ${scope === 'nuvio' ? NUVIO_CHIP : FUSION_CHIP}`}
    >
      {scope === 'nuvio' ? 'Nuvio only' : 'Fusion only'}
    </Badge>
  );
}

type PreviewAspect = 'poster' | 'wide' | 'square' | 'logo';

const PREVIEW_BOX: Record<PreviewAspect, string> = {
  poster: 'h-24 w-16',
  wide: 'h-16 w-[7.1rem]',
  square: 'h-20 w-20',
  logo: 'h-12 w-[7.1rem]',
};

const ASPECT_BY_TILE: Record<TileShape, PreviewAspect> = {
  POSTER: 'poster',
  LANDSCAPE: 'wide',
  SQUARE: 'square',
};

/** URL input with a live thumbnail, so art can be judged before exporting. */
function ImageUrlField({
  label,
  value,
  aspect,
  placeholder = 'https://...',
  hint,
  onChange,
}: {
  label: string;
  value: string;
  aspect: PreviewAspect;
  placeholder?: string;
  hint?: string;
  onChange: (next: string) => void;
}) {
  const [debounced, setDebounced] = useState(value);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const fieldId = useId();

  // Wait for a pause in typing so a half-typed URL is not fetched on every key.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), 400);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    setStatus(debounced ? 'loading' : 'idle');
  }, [debounced]);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={fieldId} className="text-xs">{label}</Label>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex items-start gap-3">
        <div
          className={`relative shrink-0 overflow-hidden rounded-md border ${PREVIEW_BOX[aspect]} ${
            status === 'error' ? 'border-amber-600/60 bg-amber-950/20' : 'border-dashed bg-muted/40'
          }`}
        >
          {debounced && status !== 'error' && (
            <img
              key={debounced}
              src={debounced}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onLoad={() => setStatus('ok')}
              onError={() => setStatus('error')}
              className={`h-full w-full ${aspect === 'logo' ? 'object-contain p-1' : 'object-cover'} ${
                status === 'ok' ? 'opacity-100' : 'opacity-0'
              } transition-opacity`}
            />
          )}
          {status === 'loading' && <div className="absolute inset-0 animate-pulse bg-muted" />}
          {status === 'idle' && (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground/50">
              <ImageIcon className="h-4 w-4" />
            </div>
          )}
          {status === 'error' && (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center text-amber-500">
              <ImageOff className="h-4 w-4" />
              <span className="text-[9px] leading-tight">won&rsquo;t load</span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <Input
            id={fieldId}
            value={value}
            onChange={event => onChange(event.target.value)}
            placeholder={placeholder}
            className="h-9"
          />
          {status === 'error' && (
            <p className="text-[10px] text-amber-500">
              The image did not load. Check the link is public and points straight at the file.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function entrySourceCount(entry: BuilderEntry): number {
  if (entry.kind === 'classicRow') return entry.source ? 1 : 0;
  return entry.folders.reduce((total, folder) => total + folder.sources.length, 0);
}

// ---- Reordering ----

function ReorderArrows({
  label,
  canMoveUp,
  canMoveDown,
  onMove,
}: {
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
}) {
  const buttonClass =
    'flex h-3.5 w-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-25';
  return (
    <div className="flex shrink-0 flex-col">
      <button
        type="button"
        className={buttonClass}
        disabled={!canMoveUp}
        onClick={() => onMove(-1)}
        title={`Move ${label} up`}
        aria-label={`Move ${label} up`}
      >
        <ChevronUp className="h-3 w-3" />
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={!canMoveDown}
        onClick={() => onMove(1)}
        title={`Move ${label} down`}
        aria-label={`Move ${label} down`}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
    </div>
  );
}

function RowActions({
  label,
  canMoveUp,
  canMoveDown,
  onDuplicate,
  onMoveTo,
}: {
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onDuplicate: () => void;
  onMoveTo: (position: 'top' | 'bottom') => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`More actions for ${label}`}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onDuplicate}>
          <Copy className="mr-2 h-3.5 w-3.5" /> Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveUp} onClick={() => onMoveTo('top')}>
          <ChevronsUp className="mr-2 h-3.5 w-3.5" /> Move to top
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveDown} onClick={() => onMoveTo('bottom')}>
          <ChevronsDown className="mr-2 h-3.5 w-3.5" /> Move to bottom
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function duplicateEntryDraft(entry: BuilderEntry): BuilderEntry {
  const copy = clone(entry);
  copy.id = newId();
  copy.title = `${entry.title} copy`;
  if (copy.kind === 'collection') {
    copy.folders = copy.folders.map(folder => ({ ...folder, id: newId() }));
  }
  return copy;
}

// ---- Entry rail ----

function SortableEntryRow({
  entry,
  isActive,
  excluded,
  hasUnknown,
  warnings = 0,
  allNative,
  canMoveUp,
  canMoveDown,
  onMove,
  onMoveTo,
  onDuplicate,
  onSelect,
  onDelete,
}: {
  entry: BuilderEntry;
  isActive: boolean;
  /** True when the active target has no equivalent and will skip this entry. */
  excluded: boolean;
  /** True when it points at a catalog that is not in the user's setup. */
  hasUnknown: boolean;
  warnings?: number;
  /** Every source here is resolved by the client, so none of it reaches us. */
  allNative?: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  onMoveTo: (position: 'top' | 'bottom') => void;
  onDuplicate: () => void;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 'auto',
  };
  const isCollection = entry.kind === 'collection';
  const Icon = isCollection ? Layers : entry.numbered ? ListOrdered : Rows3;
  const count = entrySourceCount(entry);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 rounded-md border border-l-[3px] px-2 py-2 text-sm transition-colors ${
        isCollection ? 'border-l-cyan-500' : 'border-l-violet-500'
      } ${isActive ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/50'} ${
        excluded ? 'opacity-50' : ''
      }`}
      title={excluded ? 'Not exported for the selected target' : undefined}
    >
      <ReorderArrows
        label={entry.title || 'this'}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        onMove={onMove}
      />
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground"
        aria-label={`Drag ${entry.title || 'this entry'} to reorder`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon className={`h-4 w-4 shrink-0 ${isCollection ? 'text-cyan-400' : 'text-violet-400'}`} />
        <span className="min-w-0 flex-1 truncate">{entry.title || 'Untitled'}</span>
        {(hasUnknown || warnings > 0) && (
          <span
            className="shrink-0"
            title={warnings > 0
              ? `${warnings} thing${warnings === 1 ? '' : 's'} worth checking on this entry`
              : 'Points at a catalog you do not have'}
          >
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          </span>
        )}
        {allNative && (
          <span className="shrink-0 text-[10px] text-muted-foreground" title="Nuvio fetches these itself, so they cost this addon nothing">
            Nuvio
          </span>
        )}
        <span
          className={`shrink-0 rounded-full px-1.5 text-[10px] font-medium ${
            count === 0 ? 'bg-amber-800/60 text-amber-200' : 'bg-muted text-muted-foreground'
          }`}
        >
          {count}
        </span>
      </button>
      <RowActions
        label={entry.title || 'this entry'}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        onDuplicate={onDuplicate}
        onMoveTo={onMoveTo}
      />
      <button
        type="button"
        onClick={onDelete}
        className="text-muted-foreground hover:text-destructive"
        aria-label={`Delete ${entry.title || 'this entry'}`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

// ---- Catalog picker ----

function CatalogPicker({
  isOpen,
  catalogs,
  multiple,
  existingKeys,
  tagOptions = [],
  onConfirm,
  onClose,
}: {
  isOpen: boolean;
  catalogs: ManifestCatalog[];
  /** Classic rows hold a single catalog, so selection collapses to one there. */
  multiple: boolean;
  /** Already on the tile, shown as such instead of being silently deduped. */
  existingKeys: string[];
  tagOptions?: TagOption[];
  onConfirm: (picked: ManifestCatalog[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelected([]);
      setTypeFilter(null);
      setTagFilters([]);
      setActiveIndex(0);
    }
  }, [isOpen]);

  const types = useMemo(() => {
    const seen = new Set<string>();
    for (const catalog of catalogs) {
      if (catalog.type) seen.add(catalog.type);
    }
    return [...seen].sort();
  }, [catalogs]);

  const pickerTags = useMemo(
    () => tagOptions.filter(tag => catalogs.some(catalog => (catalog.tags ?? []).includes(tag.name))),
    [tagOptions, catalogs]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalogs.filter(catalog => {
      if (typeFilter && catalog.type !== typeFilter) return false;
      if (tagFilters.length > 0 && !tagFilters.some(tag => (catalog.tags ?? []).includes(tag))) return false;
      if (!needle) return true;
      return `${catalog.name} ${catalog.id} ${catalog.type} ${catalog.source || ''}`
        .toLowerCase()
        .includes(needle);
    });
  }, [catalogs, query, typeFilter, tagFilters]);

  const alreadyAdded = useMemo(() => new Set(existingKeys), [existingKeys]);

  const addable = useMemo(
    () => filtered.filter(catalog => !alreadyAdded.has(catalogKey(catalog))),
    [filtered, alreadyAdded]
  );

  // Selection outlives a filter change, so "select all" adds to it rather than
  // becoming it, and offers itself whenever this set holds something unticked.
  const unselectedAddable = useMemo(() => {
    const picked = new Set(selected);
    return addable.map(catalogKey).filter(key => !picked.has(key));
  }, [addable, selected]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, typeFilter, tagFilters]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 40,
    overscan: 12,
  });

  const toggle = (catalog: ManifestCatalog) => {
    const key = catalogKey(catalog);
    if (alreadyAdded.has(key)) return;
    if (!multiple) {
      onConfirm([catalog]);
      onClose();
      return;
    }
    setSelected(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
  };

  const confirm = () => {
    const byKey = new Map(catalogs.map(catalog => [catalogKey(catalog), catalog]));
    onConfirm(selected.map(key => byKey.get(key)).filter((c): c is ManifestCatalog => Boolean(c)));
    onClose();
  };

  const move = (delta: number) => {
    if (filtered.length === 0) return;
    const next = Math.min(Math.max(activeIndex + delta, 0), filtered.length - 1);
    setActiveIndex(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (multiple && (event.metaKey || event.ctrlKey)) {
      if (selected.length > 0) confirm();
      return;
    }
    const catalog = filtered[activeIndex];
    if (catalog) toggle(catalog);
  };

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{multiple ? 'Add catalogs' : 'Pick a catalog'}</DialogTitle>
          <DialogDescription>
            {multiple
              ? 'Select as many as you want, then add them all at once.'
              : 'Classic rows read from a single catalog.'}
          </DialogDescription>
        </DialogHeader>
        <div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search catalogs"
              className="pl-9"
            />
          </div>

          {(types.length > 1 || pickerTags.length > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {types.length > 1 && types.map(type => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={typeFilter === type}
                  onClick={() => setTypeFilter(prev => (prev === type ? null : type))}
                  className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    typeFilter === type
                      ? 'border-primary bg-primary/15 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent/50'
                  }`}
                >
                  {type}
                </button>
              ))}
              {pickerTags.map(tag => (
                <TagChip
                  key={tag.name}
                  name={`${tag.name} (${tag.count})`}
                  color={tag.color}
                  dimmed={tagFilters.length > 0 && !tagFilters.includes(tag.name)}
                  pressed={tagFilters.includes(tag.name)}
                  onClick={() => setTagFilters(prev =>
                    prev.includes(tag.name) ? prev.filter(name => name !== tag.name) : [...prev, tag.name]
                  )}
                />
              ))}
              {(typeFilter !== null || tagFilters.length > 0) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => { setTypeFilter(null); setTagFilters([]); }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          )}

          <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>
              {filtered.length === catalogs.length
                ? `${catalogs.length} ${catalogs.length === 1 ? 'catalog' : 'catalogs'}`
                : `${filtered.length} of ${catalogs.length}`}
            </span>
            <span className="hidden sm:inline">
              &uarr;&darr; to move, Enter to {multiple ? 'tick' : 'pick'}
              {multiple ? ', Ctrl+Enter to add' : ''}
            </span>
          </div>

          <div
            ref={setScrollEl}
            className="mt-1 overflow-y-auto"
            style={filtered.length === 0 ? undefined : { height: Math.min(320, filtered.length * 40) }}
          >
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {catalogs.length === 0
                  ? 'No catalogs to pick from yet.'
                  : 'Nothing matches that search and those filters.'}
              </p>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map(virtualRow => {
                  const catalog = filtered[virtualRow.index];
                  const key = catalogKey(catalog);
                  const isAdded = alreadyAdded.has(key);
                  const isSelected = selected.includes(key);
                  const isActive = virtualRow.index === activeIndex;
                  return (
                    <div
                      key={key}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: virtualRow.size,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <button
                        type="button"
                        disabled={isAdded}
                        aria-pressed={multiple && !isAdded ? isSelected : undefined}
                        onClick={() => toggle(catalog)}
                        onMouseEnter={() => setActiveIndex(virtualRow.index)}
                        className={`flex h-9 w-full items-center gap-2 rounded-md border px-2 text-left text-sm transition-colors ${
                          isAdded
                            ? 'cursor-default border-transparent opacity-45'
                            : isSelected
                              ? 'border-primary/60 bg-primary/10'
                              : 'border-transparent hover:border-border hover:bg-accent/50'
                        } ${isActive && !isAdded ? 'ring-1 ring-primary/40' : ''}`}
                      >
                        {multiple && (
                          isAdded ? (
                            <Check className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                          ) : (
                            <span
                              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                isSelected
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-muted-foreground/40'
                              }`}
                            >
                              {isSelected && <Check className="h-3 w-3" />}
                            </span>
                          )
                        )}
                        <span className="min-w-0 flex-1 truncate">{catalog.name}</span>
                        {isAdded && (
                          <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">added</span>
                        )}
                        {catalog.pendingSave && (
                          <Badge
                            variant="outline"
                            className="shrink-0 border-sky-600/50 bg-sky-900/50 text-[10px] text-sky-200"
                            title="In your config but not saved yet, so it is not in the manifest"
                          >
                            unsaved
                          </Badge>
                        )}
                        {catalog.genreRequired && (
                          <Badge variant="outline" className="shrink-0 border-amber-600/50 bg-amber-800/60 text-[10px] text-amber-200">
                            genre
                          </Badge>
                        )}
                        <Badge
                          variant="outline"
                          className={`shrink-0 text-[10px] font-semibold ${getSourceBadgeStyle(catalog.source)}`}
                        >
                          {getSourceBadgeLabel(catalog.source)}
                        </Badge>
                        <Badge variant="outline" className="hidden shrink-0 text-[10px] sm:inline-flex">
                          {catalog.type}
                        </Badge>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {multiple && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">
                {selected.length === 0 ? 'Nothing selected' : `${selected.length} selected`}
              </span>
              {unselectedAddable.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setSelected(prev => [...prev, ...unselectedAddable])}
                >
                  Select all {addable.length}
                </Button>
              )}
              {selected.length > 0 && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setSelected([])}>
                  Clear
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button size="sm" disabled={selected.length === 0} onClick={confirm}>
                Add {selected.length > 0 ? selected.length : ''}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- Source row ----

function SourceRow({
  source,
  catalogs,
  pendingKeys,
  onChange,
  onRemove,
  onReplace,
  innerRef,
  style,
  leading,
}: {
  source: SourceDraft;
  catalogs: ManifestCatalog[];
  /** Sources an apply would add a catalog for, so not missing, just not saved yet. */
  pendingKeys?: Set<string>;
  onChange: (next: SourceDraft) => void;
  onRemove: () => void;
  /** Swap this one for a catalog the user has. */
  onReplace?: () => void;
  innerRef?: (node: HTMLElement | null) => void;
  style?: CSSProperties;
  /** Reorder controls, where the row is one of several in a folder. */
  leading?: ReactNode;
}) {
  const native = isNativeSource(source);
  const match = native ? undefined : catalogs.find(catalog => catalogKey(catalog) === catalogKey(source));
  const genres = match?.genres || [];
  const genreRequired = Boolean(match?.genreRequired);
  const pending = !native && !match && Boolean(pendingKeys?.has(catalogKey(source)));
  const unknown = !native && !match && !pending;
  const label = match?.name || source.name || source.catalogId;

  return (
    <div
      ref={innerRef}
      style={style}
      className={`flex flex-col gap-2 rounded-md border px-2 py-2 sm:flex-row sm:flex-wrap sm:items-center ${
        unknown
          ? 'border-amber-600/60 bg-amber-950/20'
          : pending ? 'border-emerald-600/50 bg-emerald-950/20' : 'bg-muted/30'
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
      {leading}
      {unknown && <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />}
      <span
        className="min-w-0 flex-1 truncate text-sm"
        title={`${source.catalogId} (${source.type})`}
      >
        {label}
      </span>
      {native ? (
        <>
          <Badge variant="outline" className="shrink-0 text-[10px] font-semibold">
            {nativeLabel(source)}
          </Badge>
          <span className="shrink-0 text-[10px] text-muted-foreground">served by Nuvio</span>
        </>
      ) : pending ? (
        <span className="shrink-0 text-[10px] text-emerald-500" title={`${source.catalogId} (${source.type})`}>
          added on apply
        </span>
      ) : unknown ? (
        <>
          <span className="shrink-0 text-[10px] text-amber-500" title={`${source.catalogId} (${source.type})`}>
            not in your catalogs
          </span>
          {onReplace && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 border-amber-600/60 text-amber-200 hover:bg-amber-900/40"
              onClick={onReplace}
            >
              <Replace className="mr-1 h-3.5 w-3.5" /> Replace
            </Button>
          )}
        </>
      ) : (
        <Badge
          variant="outline"
          className={`shrink-0 text-[10px] font-semibold ${getSourceBadgeStyle(match?.source)}`}
        >
          {getSourceBadgeLabel(match?.source)}
        </Badge>
      )}
        <Badge variant="outline" className="shrink-0 text-[10px]">{source.type}</Badge>
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:shrink-0">
      {genres.length > 0 && (
        <Select
          value={source.genre || '__all__'}
          onValueChange={value => onChange({ ...source, genre: value === '__all__' ? null : value })}
        >
          <SelectTrigger className={`h-8 min-w-0 flex-1 sm:w-40 sm:flex-none ${genreRequired && !source.genre ? 'border-amber-500' : ''}`}>
            <SelectValue placeholder={genreRequired ? 'Pick a genre' : 'All genres'} />
          </SelectTrigger>
          <SelectContent>
            {!genreRequired && <SelectItem value="__all__">All genres</SelectItem>}
            {genres.map(genre => (
              <SelectItem key={genre} value={genre}>{genre}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      </div>
    </div>
  );
}

function SortableSourceRow({
  id,
  label,
  canMoveUp,
  canMoveDown,
  onMove,
  ...rest
}: {
  id: string;
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  source: SourceDraft;
  catalogs: ManifestCatalog[];
  pendingKeys?: Set<string>;
  onChange: (next: SourceDraft) => void;
  onRemove: () => void;
  onReplace?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  return (
    <SourceRow
      {...rest}
      innerRef={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 50 : 'auto',
      }}
      leading={
        <>
          <ReorderArrows
            label={label}
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
            onMove={onMove}
          />
          <button
            type="button"
            className="cursor-grab touch-none text-muted-foreground"
            aria-label={`Drag ${label} to reorder`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        </>
      }
    />
  );
}

// ---- Folder rail ----

function SortableFolderRow({
  folder,
  hasUnknown,
  warnings = 0,
  allNative,
  placeholder,
  isActive,
  canMoveUp,
  canMoveDown,
  onMove,
  onMoveTo,
  onDuplicate,
  onSelect,
  onDelete,
}: {
  folder: FolderDraft;
  hasUnknown: boolean;
  warnings?: number;
  /** Every source here is resolved by the client, so none of it reaches us. */
  allNative?: boolean;
  placeholder: string;
  isActive: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
  onMoveTo: (position: 'top' | 'bottom') => void;
  onDuplicate: () => void;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: folder.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 'auto',
  };
  const count = folder.sources.length;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1.5 text-sm transition-colors ${
        isActive ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/50'
      }`}
    >
      <ReorderArrows
        label={folder.title || 'this'}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        onMove={onMove}
      />
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground"
        aria-label={`Drag ${folder.title || placeholder} to reorder`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{folder.title || placeholder}</span>
        {(hasUnknown || warnings > 0) && (
          <span
            className="shrink-0"
            title={hasUnknown
              ? 'Points at a catalog you do not have'
              : `${warnings} thing${warnings === 1 ? '' : 's'} worth checking here`}
          >
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          </span>
        )}
        {allNative && (
          <span className="shrink-0 text-[10px] text-muted-foreground" title="Nuvio fetches these itself, so they cost this addon nothing">
            Nuvio
          </span>
        )}
        <span
          className={`shrink-0 rounded-full px-1.5 text-[10px] font-medium ${
            count === 0 ? 'bg-amber-800/60 text-amber-200' : 'bg-muted text-muted-foreground'
          }`}
        >
          {count}
        </span>
      </button>
      <RowActions
        label={folder.title || placeholder}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        onDuplicate={onDuplicate}
        onMoveTo={onMoveTo}
      />
      <button
        type="button"
        onClick={onDelete}
        className="text-muted-foreground hover:text-destructive"
        aria-label={`Delete ${folder.title || placeholder}`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

// ---- Folder card ----

function FolderCard({
  folder,
  catalogs,
  pendingKeys,
  target,
  onChange,
  onRemove,
  onAddSource,
  onReplaceSource,
  tagOptions,
  onAddByTag,
  focusTitle,
  onTitleFocused,
}: {
  folder: FolderDraft;
  catalogs: ManifestCatalog[];
  pendingKeys?: Set<string>;
  target: Target;
  onChange: (next: FolderDraft) => void;
  onRemove: () => void;
  onAddSource: () => void;
  onReplaceSource: (index: number) => void;
  tagOptions: TagOption[];
  onAddByTag: (tag: string) => void;
  focusTitle?: boolean;
  onTitleFocused?: () => void;
}) {
  const terms = TERMS[target];
  const [showExtras, setShowExtras] = useState(false);
  const nuvioArtVisible = target === 'nuvio' || hasNuvioFolderArt(folder);

  const update = (patch: Partial<FolderDraft>) => onChange({ ...folder, ...patch });
  const uid = useId();
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusTitle) return;
    titleRef.current?.focus();
    titleRef.current?.select();
    onTitleFocused?.();
  }, [focusTitle, onTitleFocused]);

  const sourceSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const sourceDndId = (index: number) => `source-${index}`;

  const moveSource = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= folder.sources.length) return;
    update({ sources: arrayMove(folder.sources, index, to) });
  };

  const handleSourceDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = folder.sources.findIndex((_, index) => sourceDndId(index) === active.id);
    const to = folder.sources.findIndex((_, index) => sourceDndId(index) === over.id);
    if (from < 0 || to < 0) return;
    update({ sources: arrayMove(folder.sources, from, to) });
  };

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Label htmlFor={`${uid}-title`} className="sr-only">{terms.childTitle}</Label>
        <Input
          id={`${uid}-title`}
          ref={titleRef}
          value={folder.title}
          onChange={event => update({ title: event.target.value })}
          placeholder={terms.childTitle}
          className="h-9 min-w-0 flex-1"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          onClick={onRemove}
          aria-label={`Delete ${folder.title || terms.child.toLowerCase()}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Label id={`${uid}-shape`} className="text-xs">{terms.shape}</Label>
          <span className="text-[10px] text-muted-foreground">
            {terms.shapeOther}
          </span>
        </div>
        <div role="group" aria-labelledby={`${uid}-shape`} className="flex gap-1 rounded-lg border p-1">
          {SHAPE_ORDER.map(shape => {
            const active = folder.shape === shape;
            return (
              <button
                key={shape}
                type="button"
                onClick={() => update({ shape })}
                className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors ${
                  active ? 'bg-primary/15 text-foreground ring-1 ring-primary/50' : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                <span
                  className={`shrink-0 rounded-[2px] border ${SHAPE_PREVIEW[shape]} ${
                    active ? 'border-primary bg-primary/40' : 'border-muted-foreground/50'
                  }`}
                />
                <span className="truncate">{SHAPE_LABELS[shape]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <ImageUrlField
        label={terms.cover}
        value={folder.coverImageUrl || ''}
        aspect={ASPECT_BY_TILE[folder.shape]}
        hint="preview follows the tile shape above"
        onChange={next => update({ coverImageUrl: next })}
      />

      <div className="flex items-center gap-2">
        <Switch
          id={`${uid}-hide-title`}
          checked={Boolean(folder.hideTitle)}
          onCheckedChange={value => update({ hideTitle: value })}
        />
        <Label htmlFor={`${uid}-hide-title`} className="text-xs">
          Hide title on the {terms.child.toLowerCase()}
        </Label>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs">{terms.sources}</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {tagOptions.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7">
                    <Tags className="mr-1 h-3.5 w-3.5" /> Add by tag
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {tagOptions.map(tag => (
                    <DropdownMenuItem key={tag.name} onClick={() => onAddByTag(tag.name)}>
                      <span className={`mr-2 h-2.5 w-2.5 shrink-0 rounded-full ${getTagColor(tag.color).swatch}`} />
                      <span className="flex-1 truncate">{tag.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{tag.count}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button variant="outline" size="sm" className="h-7" onClick={onAddSource}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add catalog
            </Button>
          </div>
        </div>
        {folder.sources.length === 0 && (
          <button
            type="button"
            onClick={onAddSource}
            className="w-full rounded-md border border-dashed px-2 py-3 text-center text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 hover:text-foreground"
          >
            No catalogs yet. Both Nuvio and Fusion drop tiles that have none.
            <span className="mt-0.5 block font-medium">Add one</span>
          </button>
        )}
        <DndContext sensors={sourceSensors} collisionDetection={closestCenter} onDragEnd={handleSourceDragEnd}>
          <SortableContext
            items={folder.sources.map((_, index) => sourceDndId(index))}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2">
              {folder.sources.map((source, index) => (
                <SortableSourceRow
                  key={`${catalogKey(source)}-${index}`}
                  id={sourceDndId(index)}
                  label={source.name || source.catalogId}
                  canMoveUp={index > 0}
                  canMoveDown={index < folder.sources.length - 1}
                  onMove={delta => moveSource(index, delta)}
                  source={source}
                  catalogs={catalogs}
                  pendingKeys={pendingKeys}
                  onChange={next => update({ sources: folder.sources.map((s, i) => (i === index ? next : s)) })}
                  onRemove={() => update({ sources: folder.sources.filter((_, i) => i !== index) })}
                  onReplace={() => onReplaceSource(index)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {nuvioArtVisible && (
        <button
          type="button"
          onClick={() => setShowExtras(!showExtras)}
          className="flex items-center gap-1.5 text-xs text-cyan-400 underline-offset-2 hover:underline"
        >
          <Tv className="h-3.5 w-3.5" />
          {showExtras ? 'Hide' : 'Show'} Nuvio artwork
          {target === 'fusion' && <ScopeChip scope="nuvio" />}
        </button>
      )}
      {nuvioArtVisible && showExtras && (
        <div className="grid gap-3 rounded-lg border border-cyan-800/40 bg-cyan-950/20 p-3 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-emoji`} className="text-xs">Cover emoji</Label>
            <Input
              id={`${uid}-emoji`}
              value={folder.coverEmoji || ''}
              onChange={event => update({ coverEmoji: event.target.value })}
              className="h-9"
            />
          </div>
          <ImageUrlField
            label="Focus GIF URL"
            value={folder.focusGifUrl || ''}
            aspect={ASPECT_BY_TILE[folder.shape]}
            onChange={next => update({ focusGifUrl: next })}
          />
          <ImageUrlField
            label="Hero backdrop URL"
            value={folder.heroBackdropUrl || ''}
            aspect="wide"
            onChange={next => update({ heroBackdropUrl: next })}
          />
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-hero-video`} className="text-xs">Hero video URL</Label>
            <Input
              id={`${uid}-hero-video`}
              value={folder.heroVideoUrl || ''}
              onChange={event => update({ heroVideoUrl: event.target.value })}
              placeholder="https://..."
              className="h-9"
            />
          </div>
          <ImageUrlField
            label="Title logo URL"
            value={folder.titleLogoUrl || ''}
            aspect="logo"
            onChange={next => update({ titleLogoUrl: next })}
          />
          <div className="flex items-center gap-2 pt-6">
            <Switch
              id={`${uid}-focus-gif`}
              checked={folder.focusGifEnabled !== false}
              onCheckedChange={value => update({ focusGifEnabled: value })}
            />
            <Label htmlFor={`${uid}-focus-gif`} className="text-xs">Play focus GIF</Label>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Collection editor ----

function CollectionEditor({
  entry,
  catalogs,
  pendingKeys,
  target,
  onChange,
  onAddSource,
  onReplaceSource,
  tagOptions,
  onAddByTag,
  nativeCount,
  onConvertNative,
  folderWarnings,
  focus,
  onFocusHandled,
  focusTitle,
  onTitleFocused,
}: {
  entry: CollectionDraft;
  catalogs: ManifestCatalog[];
  pendingKeys?: Set<string>;
  target: Target;
  onChange: (next: CollectionDraft) => void;
  onAddSource: (folderId: string) => void;
  onReplaceSource: (folderId: string, index: number) => void;
  tagOptions: TagOption[];
  onAddByTag: (folderId: string, tag: string) => void;
  /** Sources here that Nuvio resolves itself and this addon could take over. */
  nativeCount: number;
  onConvertNative: () => void;
  /** Notes the export would raise about a folder, counted per folder id. */
  folderWarnings?: Map<string, number>;
  focus?: { entryId: string; folderId: string } | null;
  onFocusHandled?: () => void;
  focusTitle?: boolean;
  onTitleFocused?: () => void;
}) {
  const terms = TERMS[target];
  const [showNuvioBox, setShowNuvioBox] = useState(target === 'nuvio');
  const nuvioBoxVisible = target === 'nuvio' || hasNuvioCollectionSettings(entry);
  const uid = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [newFolderId, setNewFolderId] = useState<string | null>(null);
  const clearNewFolderId = useCallback(() => setNewFolderId(null), []);

  useEffect(() => {
    if (!focusTitle) return;
    titleRef.current?.focus();
    titleRef.current?.select();
    onTitleFocused?.();
  }, [focusTitle, onTitleFocused]);

  useEffect(() => {
    setShowNuvioBox(target === 'nuvio');
  }, [target]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const update = (patch: Partial<CollectionDraft>) => onChange({ ...entry, ...patch });

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const activeIndex = Math.max(entry.folders.findIndex(folder => folder.id === selectedFolderId), 0);
  const activeFolder = entry.folders[activeIndex] ?? null;

  useEffect(() => {
    if (!focus?.folderId) return;
    setSelectedFolderId(focus.folderId);
    onFocusHandled?.();
  }, [focus, onFocusHandled]);

  const knownKeys = useMemo(() => new Set(catalogs.map(catalogKey)), [catalogs]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = entry.folders.findIndex(folder => folder.id === active.id);
    const to = entry.folders.findIndex(folder => folder.id === over.id);
    if (from < 0 || to < 0) return;
    update({ folders: arrayMove(entry.folders, from, to) });
  };

  const moveFolder = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= entry.folders.length) return;
    update({ folders: arrayMove(entry.folders, index, to) });
  };

  const moveFolderTo = (index: number, position: 'top' | 'bottom') => {
    const to = position === 'top' ? 0 : entry.folders.length - 1;
    if (to === index) return;
    update({ folders: arrayMove(entry.folders, index, to) });
  };

  const duplicateFolder = (index: number) => {
    const original = entry.folders[index];
    if (!original) return;
    const copy: FolderDraft = { ...clone(original), id: newId(), title: `${original.title} copy` };
    setSelectedFolderId(copy.id);
    setNewFolderId(copy.id);
    update({
      folders: [...entry.folders.slice(0, index + 1), copy, ...entry.folders.slice(index + 1)],
    });
  };

  const addFolder = () => {
    const folder = createFolderDraft();
    setSelectedFolderId(folder.id);
    setNewFolderId(folder.id);
    update({ folders: [...entry.folders, folder] });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-title`} className="text-xs">{terms.entryTitle}</Label>
          <Input
            id={`${uid}-title`}
            ref={titleRef}
            value={entry.title}
            onChange={event => update({ title: event.target.value })}
            className="h-9"
          />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <Switch
            id={`${uid}-hide-title`}
            checked={Boolean(entry.hideTitle)}
            onCheckedChange={value => update({ hideTitle: value })}
          />
          <Label htmlFor={`${uid}-hide-title`} className="text-xs">Hide title</Label>
          <ScopeChip scope="fusion" />
        </div>
      </div>

      {nuvioBoxVisible && (
      <div className="space-y-3 rounded-lg border border-cyan-800/40 bg-cyan-950/20 p-3">
        <button
          type="button"
          onClick={() => setShowNuvioBox(!showNuvioBox)}
          className="flex w-full items-center gap-2 text-left"
        >
          <Tv className="h-4 w-4 shrink-0 text-cyan-400" />
          <Label className="cursor-pointer text-sm font-medium text-cyan-300">Nuvio presentation</Label>
          <span className="text-[11px] text-muted-foreground">
            {target === 'fusion' ? 'Set here, unused by Fusion' : 'Fusion ignores these'}
          </span>
          <span className="flex-1" />
          <span className="text-[11px] text-muted-foreground">{showNuvioBox ? 'Hide' : 'Show'}</span>
        </button>

        {showNuvioBox && (
        <>
        <div className="grid gap-3 lg:grid-cols-2">
          <ImageUrlField
            label="Backdrop image URL"
            value={entry.backdropImageUrl || ''}
            aspect="wide"
            onChange={next => update({ backdropImageUrl: next })}
          />
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-view-mode`} className="text-xs">Folder view mode</Label>
            <Select
              value={entry.viewMode || 'TABBED_GRID'}
              onValueChange={(value: CollectionDraft['viewMode']) => update({ viewMode: value })}
            >
              <SelectTrigger id={`${uid}-view-mode`} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="TABBED_GRID">Tabbed grid</SelectItem>
                <SelectItem value="ROWS">Rows</SelectItem>
                <SelectItem value="FOLLOW_LAYOUT">Follow layout</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <Switch
              id={`${uid}-pin`}
              checked={Boolean(entry.pinToTop)}
              onCheckedChange={value => update({ pinToTop: value })}
            />
            <Label htmlFor={`${uid}-pin`} className="text-xs">Pin to top</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id={`${uid}-glow`}
              checked={entry.focusGlowEnabled !== false}
              onCheckedChange={value => update({ focusGlowEnabled: value })}
            />
            <Label htmlFor={`${uid}-glow`} className="text-xs">Focus glow</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id={`${uid}-all-tab`}
              checked={entry.showAllTab !== false}
              onCheckedChange={value => update({ showAllTab: value })}
            />
            <Label htmlFor={`${uid}-all-tab`} className="text-xs">Show &ldquo;All&rdquo; tab</Label>
          </div>
        </div>
        </>
        )}
      </div>
      )}

      {nativeCount > 0 && (
        <div className="flex flex-col gap-2 rounded-md border p-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{nativeCount}</span> source
            {nativeCount === 1 ? '' : 's'} here {nativeCount === 1 ? 'is' : 'are'} fetched by Nuvio straight from
            TMDB or Trakt. They cost this addon nothing. Routing them through it adds your artwork, ratings and
            filters, and a catalog to your setup for each.
          </p>
          <Button variant="outline" size="sm" className="shrink-0" onClick={onConvertNative}>
            <Replace className="mr-1.5 h-4 w-4" /> Route through AIOMetadata
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between border-t pt-3">
        <Label className="text-sm font-medium">{terms.children}</Label>
        <Button variant="outline" size="sm" onClick={addFolder}>
          <FolderPlus className="mr-1.5 h-4 w-4" /> {terms.addChild}
        </Button>
      </div>

      {entry.folders.length === 0 ? (
        <button
          type="button"
          onClick={addFolder}
          className="w-full rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 hover:text-foreground"
        >
          Nothing here yet. Add {terms.child.toLowerCase() === 'folder' ? 'a folder' : 'an item'}, then point it at
          one or more of your catalogs.
        </button>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={entry.folders.map(folder => folder.id)} strategy={verticalListSortingStrategy}>
              <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1 lg:max-h-none lg:overflow-visible lg:pr-0">
                {entry.folders.map((folder, index) => (
                  <SortableFolderRow
                    key={folder.id}
                    folder={folder}
                    placeholder={`Untitled ${terms.child.toLowerCase()}`}
                    hasUnknown={folder.sources.some(source =>
                      !isNativeSource(source)
                      && !knownKeys.has(catalogKey(source))
                      && !pendingKeys?.has(catalogKey(source))
                    )}
                    warnings={folderWarnings?.get(folder.id) ?? 0}
                    allNative={folder.sources.length > 0 && folder.sources.every(isNativeSource)}
                    isActive={index === activeIndex}
                    canMoveUp={index > 0}
                    canMoveDown={index < entry.folders.length - 1}
                    onMove={delta => moveFolder(index, delta)}
                    onMoveTo={position => moveFolderTo(index, position)}
                    onDuplicate={() => duplicateFolder(index)}
                    onSelect={() => setSelectedFolderId(folder.id)}
                    onDelete={() => update({ folders: entry.folders.filter((_, i) => i !== index) })}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          <div className="min-w-0">
            {activeFolder && (
              <FolderCard
                key={activeFolder.id}
                folder={activeFolder}
                catalogs={catalogs}
            pendingKeys={pendingKeys}
                target={target}
                onChange={next =>
                  update({ folders: entry.folders.map((f, i) => (i === activeIndex ? next : f)) })}
                onRemove={() => update({ folders: entry.folders.filter((_, i) => i !== activeIndex) })}
                onAddSource={() => onAddSource(activeFolder.id)}
                onReplaceSource={index => onReplaceSource(activeFolder.id, index)}
                tagOptions={tagOptions}
                onAddByTag={tag => onAddByTag(activeFolder.id, tag)}
                focusTitle={newFolderId === activeFolder.id}
                onTitleFocused={clearNewFolderId}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Classic row editor ----

function ClassicRowEditor({
  entry,
  catalogs,
  pendingKeys,
  target,
  onChange,
  onAddSource,
  focusTitle,
  onTitleFocused,
}: {
  entry: ClassicRowDraft;
  catalogs: ManifestCatalog[];
  pendingKeys?: Set<string>;
  target: Target;
  onChange: (next: ClassicRowDraft) => void;
  onAddSource: () => void;
  focusTitle?: boolean;
  onTitleFocused?: () => void;
}) {
  const terms = TERMS[target];
  const update = (patch: Partial<ClassicRowDraft>) => onChange({ ...entry, ...patch });
  const uid = useId();
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusTitle) return;
    titleRef.current?.focus();
    titleRef.current?.select();
    onTitleFocused?.();
  }, [focusTitle, onTitleFocused]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-md border border-violet-700/50 bg-violet-950/30 px-3 py-2 text-xs text-violet-300">
        <Rows3 className="h-4 w-4 shrink-0" />
        Classic rows are Fusion only. Nuvio has no equivalent, so this row is left out of the Nuvio export.
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-title`} className="text-xs">{terms.entryTitle}</Label>
          <Input
            id={`${uid}-title`}
            ref={titleRef}
            value={entry.title}
            onChange={event => update({ title: event.target.value })}
            className="h-9"
          />
        </div>
        <ImageUrlField
          label={terms.cover}
          value={entry.backgroundImageURL || ''}
          aspect={entry.aspectRatio === 'wide' ? 'wide' : entry.aspectRatio === 'square' ? 'square' : 'poster'}
          onChange={next => update({ backgroundImageURL: next })}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Catalog</Label>
          <Button variant="outline" size="sm" className="h-7" onClick={onAddSource}>
            <Plus className="mr-1 h-3.5 w-3.5" /> {entry.source ? 'Change' : 'Pick catalog'}
          </Button>
        </div>
        {entry.source ? (
          <SourceRow
            source={entry.source}
            catalogs={catalogs}
            pendingKeys={pendingKeys}
            onChange={next => update({ source: next })}
            onRemove={() => update({ source: null })}
            onReplace={onAddSource}
          />
        ) : (
          <button
            type="button"
            onClick={onAddSource}
            className="w-full rounded-md border border-dashed px-2 py-3 text-center text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 hover:text-foreground"
          >
            No catalog selected. Fusion drops rows without one.
            <span className="mt-0.5 block font-medium">Pick one</span>
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-limit`} className="text-xs">Items shown</Label>
          <Input
            id={`${uid}-limit`}
            type="number"
            min={1}
            value={entry.limit}
            onChange={event => update({ limit: Math.max(1, parseInt(event.target.value, 10) || 1) })}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-ttl`} className="text-xs">Cache TTL (seconds)</Label>
          <Input
            id={`${uid}-ttl`}
            type="number"
            min={0}
            value={entry.cacheTTL}
            onChange={event => update({ cacheTTL: Math.max(0, parseInt(event.target.value, 10) || 0) })}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label id={`${uid}-aspect`} className="text-xs">Aspect ratio</Label>
          <div role="group" aria-labelledby={`${uid}-aspect`} className="flex gap-1 rounded-lg border p-1">
            {SHAPE_ORDER.map(shape => {
              const value = ASPECT_BY_SHAPE[shape];
              const active = entry.aspectRatio === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => update({ aspectRatio: value })}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors ${
                    active ? 'bg-primary/15 text-foreground ring-1 ring-primary/50' : 'text-muted-foreground hover:bg-accent/50'
                  }`}
                >
                  <span
                    className={`shrink-0 rounded-[2px] border ${SHAPE_PREVIEW[shape]} ${
                      active ? 'border-primary bg-primary/40' : 'border-muted-foreground/50'
                    }`}
                  />
                  <span className="truncate">{SHAPE_LABELS[shape]}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-card-size`} className="text-xs">Card size</Label>
          <Select
            value={entry.cardStyle}
            onValueChange={(value: ClassicRowDraft['cardStyle']) => update({ cardStyle: value })}
          >
            <SelectTrigger id={`${uid}-card-size`} className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="small">Small</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="large">Large</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <Switch
            id={`${uid}-numbered`}
            checked={Boolean(entry.numbered)}
            onCheckedChange={value => update({ numbered: value })}
          />
          <Label htmlFor={`${uid}-numbered`} className="text-xs">Numbered ranking</Label>
          <span className="text-[10px] text-muted-foreground">1, 2, 3 … over each card</span>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`${uid}-row-hide-title`}
            checked={Boolean(entry.hideTitle)}
            onCheckedChange={value => update({ hideTitle: value })}
          />
          <Label htmlFor={`${uid}-row-hide-title`} className="text-xs">Hide title</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`${uid}-provider-badges`}
            checked={entry.badges.providers}
            onCheckedChange={value => update({ badges: { ...entry.badges, providers: value } })}
          />
          <Label htmlFor={`${uid}-provider-badges`} className="text-xs">Provider badges</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`${uid}-rating-badges`}
            checked={entry.badges.ratings}
            onCheckedChange={value => update({ badges: { ...entry.badges, ratings: value } })}
          />
          <Label htmlFor={`${uid}-rating-badges`} className="text-xs">Rating badges</Label>
        </div>
      </div>
    </div>
  );
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
      : { added: [], enabled: [], resolved: new Set<string>(), needsAccount: [] }),
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
   */
  const pendingKeys = useMemo(
    () => (pendingCount > 0 ? pendingAdditions.resolved : new Set<string>()),
    [pendingAdditions, pendingCount]
  );

  /** Entries still pointing at a catalog neither the config nor the import can serve. */
  const entriesWithUnresolved = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) {
      const missing = findUnknownSources([entry], sourceList.catalogs);
      if (missing.some(source => !pendingKeys.has(catalogKey(source)))) ids.add(entry.id);
    }
    return ids;
  }, [entries, sourceList.catalogs, pendingKeys]);

  const issueCatalogs = useMemo(() => {
    if (pendingKeys.size === 0) return sourceList.catalogs;
    const known = new Set(sourceList.catalogs.map(catalogKey));
    const staged: ManifestCatalog[] = [];
    for (const key of pendingKeys) {
      if (known.has(key)) continue;
      const split = key.lastIndexOf(':');
      if (split <= 0) continue;
      staged.push({ id: key.slice(0, split), type: key.slice(split + 1), name: key.slice(0, split) });
    }
    return staged.length > 0 ? [...sourceList.catalogs, ...staged] : sourceList.catalogs;
  }, [sourceList.catalogs, pendingKeys]);

  const issues = useMemo(() => findSourceIssues(entries, issueCatalogs), [entries, issueCatalogs]);

  const problemTargets = useMemo(() => {
    const map = new Map<string, { entryId: string; folderId: string | null }>();
    for (const entry of entries) {
      map.set(entry.id, { entryId: entry.id, folderId: null });
      if (entry.kind !== 'collection') continue;
      for (const folder of entry.folders) {
        map.set(folder.id, { entryId: entry.id, folderId: folder.id });
      }
    }
    return map;
  }, [entries]);

  const problems = useMemo(() => {
    const rows: Array<{
      key: string;
      message: string;
      entryId: string | null;
      folderId: string | null;
    }> = [];
    const push = (key: string, id: string, message: string) => {
      const target = problemTargets.get(id);
      rows.push({
        key,
        message,
        entryId: target?.entryId ?? null,
        folderId: target?.folderId ?? null,
      });
    };
    issues.forEach((issue, index) => push(`issue-${index}`, issue.entryId, issue.message));
    notes.forEach((note, index) => push(`note-${index}`, note.entryId, note.message));
    return rows;
  }, [issues, notes, problemTargets]);

  const entryProblemCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of problems) {
      if (!row.entryId) continue;
      counts.set(row.entryId, (counts.get(row.entryId) ?? 0) + 1);
    }
    return counts;
  }, [problems]);

  const folderProblemCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of problems) {
      if (!row.folderId) continue;
      counts.set(row.folderId, (counts.get(row.folderId) ?? 0) + 1);
    }
    return counts;
  }, [problems]);

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
              {overBy === 0 && pendingCount === 0 && unresolvedSources.length === 0 && (
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
