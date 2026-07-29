import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
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
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { getSourceBadgeLabel, getSourceBadgeStyle } from '@/lib/sourceBadges';
import { getTagColor } from '@/lib/tagColors';
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
  entryHasUnknownSource,
  findSourceIssues,
  findUnknownSources,
  healSourceNames,
  loadCatalogSources,
  stripManifestSuffix,
  type CatalogSourceList,
  type ManifestCatalog,
} from '@/lib/collectionBuilder/manifestSources';
import type { AddonIdentity } from '@shared/types';

const SETTINGS_LAYOUT_NAVIGATE_EVENT = 'settings-layout:navigate';

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

const NUVIO_CHIP = 'bg-cyan-800/70 text-cyan-200 border-cyan-600/50';
const FUSION_CHIP = 'bg-violet-800/70 text-violet-200 border-violet-600/50';

type Target = 'nuvio' | 'fusion';

interface TagOption {
  name: string;
  color: string;
  count: number;
}

/**
 * The same draft feeds both apps, but each names the pieces differently.
 * Fusion wording matches the labels Fusion tooling uses for the same fields
 * ("Widget Title", "Item Title", "Layout", "Aspect Ratio", "Image URL").
 */
const TERMS: Record<Target, {
  entryTitle: string;
  collection: string;
  row: string;
  child: string;
  children: string;
  childTitle: string;
  addChild: string;
  shape: string;
  shapeOther: string;
  cover: string;
  sources: string;
}> = {
  nuvio: {
    entryTitle: 'Title',
    collection: 'Collection',
    row: 'Row',
    child: 'Folder',
    children: 'Folders',
    childTitle: 'Folder title',
    addChild: 'Add folder',
    shape: 'Tile shape',
    shapeOther: 'Fusion calls this layout',
    cover: 'Cover image URL',
    sources: 'Sources',
  },
  fusion: {
    entryTitle: 'Widget title',
    collection: 'Collection widget',
    row: 'Classic row',
    child: 'Item',
    children: 'Items',
    childTitle: 'Item title',
    addChild: 'Add item',
    shape: 'Layout',
    shapeOther: 'Nuvio calls this tileShape',
    cover: 'Image URL',
    sources: 'Catalogs',
  },
};

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
        <Label className="text-xs">{label}</Label>
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

// ---- Entry rail ----

function SortableEntryRow({
  entry,
  isActive,
  excluded,
  hasUnknown,
  canMoveUp,
  canMoveDown,
  onMove,
  onSelect,
  onDelete,
}: {
  entry: BuilderEntry;
  isActive: boolean;
  /** True when the active target has no equivalent and will skip this entry. */
  excluded: boolean;
  /** True when it points at a catalog that is not in the user's setup. */
  hasUnknown: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
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
      <button type="button" className="cursor-grab touch-none text-muted-foreground" {...attributes} {...listeners}>
        <GripVertical className="h-4 w-4" />
      </button>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon className={`h-4 w-4 shrink-0 ${isCollection ? 'text-cyan-400' : 'text-violet-400'}`} />
        <span className="min-w-0 flex-1 truncate">{entry.title || 'Untitled'}</span>
        {hasUnknown && (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        )}
        <span
          className={`shrink-0 rounded-full px-1.5 text-[10px] font-medium ${
            count === 0 ? 'bg-amber-800/60 text-amber-200' : 'bg-muted text-muted-foreground'
          }`}
        >
          {count}
        </span>
      </button>
      <button type="button" onClick={onDelete} className="text-muted-foreground hover:text-destructive">
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
  onConfirm,
  onClose,
}: {
  isOpen: boolean;
  catalogs: ManifestCatalog[];
  /** Classic rows hold a single catalog, so selection collapses to one there. */
  multiple: boolean;
  /** Already on the tile, shown as such instead of being silently deduped. */
  existingKeys: string[];
  onConfirm: (picked: ManifestCatalog[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelected([]);
    }
  }, [isOpen]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return catalogs;
    return catalogs.filter(catalog =>
      `${catalog.name} ${catalog.id} ${catalog.type} ${catalog.source || ''}`.toLowerCase().includes(needle)
    );
  }, [catalogs, query]);

  const alreadyAdded = useMemo(() => new Set(existingKeys), [existingKeys]);

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
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search catalogs"
            className="pl-9"
          />
        </div>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {filtered.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No catalogs match that search.</p>
          )}
          {filtered.map(catalog => {
            const key = catalogKey(catalog);
            const isAdded = alreadyAdded.has(key);
            const isSelected = selected.includes(key);
            return (
              <button
                key={key}
                type="button"
                disabled={isAdded}
                onClick={() => toggle(catalog)}
                className={`flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left text-sm transition-colors ${
                  isAdded
                    ? 'cursor-default border-transparent opacity-45'
                    : isSelected
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-transparent hover:border-border hover:bg-accent/50'
                }`}
              >
                {multiple && (
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      isSelected || isAdded
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/40'
                    }`}
                  >
                    {(isSelected || isAdded) && <Check className="h-3 w-3" />}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{catalog.name}</span>
                {isAdded && <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">added</span>}
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
            );
          })}
        </div>
        {multiple && (
          <div className="flex items-center justify-between border-t pt-3">
            <span className="text-xs text-muted-foreground">
              {selected.length === 0
                ? 'Nothing selected'
                : `${selected.length} selected`}
            </span>
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
  onChange,
  onRemove,
  onReplace,
}: {
  source: SourceDraft;
  catalogs: ManifestCatalog[];
  onChange: (next: SourceDraft) => void;
  onRemove: () => void;
  /** Swap this one for a catalog the user has. */
  onReplace?: () => void;
}) {
  const match = catalogs.find(catalog => catalogKey(catalog) === catalogKey(source));
  const genres = match?.genres || [];
  const genreRequired = Boolean(match?.genreRequired);
  const unknown = !match;

  return (
    <div
      className={`flex flex-col gap-2 rounded-md border px-2 py-2 sm:flex-row sm:flex-wrap sm:items-center ${
        unknown ? 'border-amber-600/60 bg-amber-950/20' : 'bg-muted/30'
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
      {unknown && <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />}
      <span
        className="min-w-0 flex-1 truncate text-sm"
        title={`${source.catalogId} (${source.type})`}
      >
        {match?.name || source.name || source.catalogId}
      </span>
      {unknown ? (
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
      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onRemove}>
        <Trash2 className="h-4 w-4" />
      </Button>
      </div>
    </div>
  );
}

// ---- Folder rail ----

function SortableFolderRow({
  folder,
  hasUnknown,
  placeholder,
  isActive,
  canMoveUp,
  canMoveDown,
  onMove,
  onSelect,
  onDelete,
}: {
  folder: FolderDraft;
  hasUnknown: boolean;
  placeholder: string;
  isActive: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: number) => void;
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
      <button type="button" className="cursor-grab touch-none text-muted-foreground" {...attributes} {...listeners}>
        <GripVertical className="h-4 w-4" />
      </button>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{folder.title || placeholder}</span>
        {hasUnknown && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
        <span
          className={`shrink-0 rounded-full px-1.5 text-[10px] font-medium ${
            count === 0 ? 'bg-amber-800/60 text-amber-200' : 'bg-muted text-muted-foreground'
          }`}
        >
          {count}
        </span>
      </button>
      <button type="button" onClick={onDelete} className="text-muted-foreground hover:text-destructive">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

// ---- Folder card ----

function FolderCard({
  folder,
  catalogs,
  target,
  onChange,
  onRemove,
  onAddSource,
  onReplaceSource,
  tagOptions,
  onAddByTag,
}: {
  folder: FolderDraft;
  catalogs: ManifestCatalog[];
  target: Target;
  onChange: (next: FolderDraft) => void;
  onRemove: () => void;
  onAddSource: () => void;
  onReplaceSource: (index: number) => void;
  tagOptions: TagOption[];
  onAddByTag: (tag: string) => void;
}) {
  const terms = TERMS[target];
  const [showExtras, setShowExtras] = useState(false);
  const nuvioArtVisible = target === 'nuvio' || hasNuvioFolderArt(folder);

  const update = (patch: Partial<FolderDraft>) => onChange({ ...folder, ...patch });

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Input
          value={folder.title}
          onChange={event => update({ title: event.target.value })}
          placeholder={terms.childTitle}
          className="h-9 min-w-0 flex-1"
        />
        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Label className="text-xs">{terms.shape}</Label>
          <span className="text-[10px] text-muted-foreground">
            {terms.shapeOther}
          </span>
        </div>
        <div className="flex gap-1 rounded-lg border p-1">
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
        <Switch checked={Boolean(folder.hideTitle)} onCheckedChange={value => update({ hideTitle: value })} />
        <Label className="text-xs">Hide title on the {terms.child.toLowerCase()}</Label>
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
          <p className="rounded-md border border-dashed px-2 py-3 text-center text-xs text-muted-foreground">
            No catalogs yet. Both Nuvio and Fusion drop tiles that have none.
          </p>
        )}
        {folder.sources.map((source, index) => (
          <SourceRow
            key={`${catalogKey(source)}-${index}`}
            source={source}
            catalogs={catalogs}
            onChange={next => update({ sources: folder.sources.map((s, i) => (i === index ? next : s)) })}
            onRemove={() => update({ sources: folder.sources.filter((_, i) => i !== index) })}
            onReplace={() => onReplaceSource(index)}
          />
        ))}
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
            <Label className="text-xs">Cover emoji</Label>
            <Input
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
            <Label className="text-xs">Hero video URL</Label>
            <Input
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
              checked={folder.focusGifEnabled !== false}
              onCheckedChange={value => update({ focusGifEnabled: value })}
            />
            <Label className="text-xs">Play focus GIF</Label>
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
  target,
  onChange,
  onAddSource,
  onReplaceSource,
  tagOptions,
  onAddByTag,
}: {
  entry: CollectionDraft;
  catalogs: ManifestCatalog[];
  target: Target;
  onChange: (next: CollectionDraft) => void;
  onAddSource: (folderId: string) => void;
  onReplaceSource: (folderId: string, index: number) => void;
  tagOptions: TagOption[];
  onAddByTag: (folderId: string, tag: string) => void;
}) {
  const terms = TERMS[target];
  const [showNuvioBox, setShowNuvioBox] = useState(target === 'nuvio');
  const nuvioBoxVisible = target === 'nuvio' || hasNuvioCollectionSettings(entry);

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

  const addFolder = () => {
    const folder = createFolderDraft();
    setSelectedFolderId(folder.id);
    update({ folders: [...entry.folders, folder] });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{terms.entryTitle}</Label>
          <Input value={entry.title} onChange={event => update({ title: event.target.value })} className="h-9" />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <Switch checked={Boolean(entry.hideTitle)} onCheckedChange={value => update({ hideTitle: value })} />
          <Label className="text-xs">Hide title</Label>
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
            <Label className="text-xs">Folder view mode</Label>
            <Select
              value={entry.viewMode || 'TABBED_GRID'}
              onValueChange={(value: CollectionDraft['viewMode']) => update({ viewMode: value })}
            >
              <SelectTrigger className="h-9">
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
            <Switch checked={Boolean(entry.pinToTop)} onCheckedChange={value => update({ pinToTop: value })} />
            <Label className="text-xs">Pin to top</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={entry.focusGlowEnabled !== false}
              onCheckedChange={value => update({ focusGlowEnabled: value })}
            />
            <Label className="text-xs">Focus glow</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={entry.showAllTab !== false} onCheckedChange={value => update({ showAllTab: value })} />
            <Label className="text-xs">Show "All" tab</Label>
          </div>
        </div>
        </>
        )}
      </div>
      )}

      <div className="flex items-center justify-between border-t pt-3">
        <Label className="text-sm font-medium">{terms.children}</Label>
        <Button variant="outline" size="sm" onClick={addFolder}>
          <FolderPlus className="mr-1.5 h-4 w-4" /> {terms.addChild}
        </Button>
      </div>

      {entry.folders.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          Use &ldquo;{terms.addChild}&rdquo;, then point it at one or more of your catalogs.
        </p>
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
                    hasUnknown={folder.sources.some(source => !knownKeys.has(catalogKey(source)))}
                    isActive={index === activeIndex}
                    canMoveUp={index > 0}
                    canMoveDown={index < entry.folders.length - 1}
                    onMove={delta => moveFolder(index, delta)}
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
                target={target}
                onChange={next =>
                  update({ folders: entry.folders.map((f, i) => (i === activeIndex ? next : f)) })}
                onRemove={() => update({ folders: entry.folders.filter((_, i) => i !== activeIndex) })}
                onAddSource={() => onAddSource(activeFolder.id)}
                onReplaceSource={index => onReplaceSource(activeFolder.id, index)}
                tagOptions={tagOptions}
                onAddByTag={tag => onAddByTag(activeFolder.id, tag)}
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
  target,
  onChange,
  onAddSource,
}: {
  entry: ClassicRowDraft;
  catalogs: ManifestCatalog[];
  target: Target;
  onChange: (next: ClassicRowDraft) => void;
  onAddSource: () => void;
}) {
  const terms = TERMS[target];
  const update = (patch: Partial<ClassicRowDraft>) => onChange({ ...entry, ...patch });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-md border border-violet-700/50 bg-violet-950/30 px-3 py-2 text-xs text-violet-300">
        <Rows3 className="h-4 w-4 shrink-0" />
        Classic rows are Fusion only. Nuvio has no equivalent, so this row is left out of the Nuvio export.
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{terms.entryTitle}</Label>
          <Input value={entry.title} onChange={event => update({ title: event.target.value })} className="h-9" />
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
            onChange={next => update({ source: next })}
            onRemove={() => update({ source: null })}
            onReplace={onAddSource}
          />
        ) : (
          <p className="rounded-md border border-dashed px-2 py-3 text-center text-xs text-muted-foreground">
            No catalog selected. Fusion drops rows without one.
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Items shown</Label>
          <Input
            type="number"
            min={1}
            value={entry.limit}
            onChange={event => update({ limit: Math.max(1, parseInt(event.target.value, 10) || 1) })}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Cache TTL (seconds)</Label>
          <Input
            type="number"
            min={0}
            value={entry.cacheTTL}
            onChange={event => update({ cacheTTL: Math.max(0, parseInt(event.target.value, 10) || 0) })}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">Aspect ratio</Label>
          <div className="flex gap-1 rounded-lg border p-1">
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
          <Label className="text-xs">Card size</Label>
          <Select
            value={entry.cardStyle}
            onValueChange={(value: ClassicRowDraft['cardStyle']) => update({ cardStyle: value })}
          >
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
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
          <Switch checked={Boolean(entry.numbered)} onCheckedChange={value => update({ numbered: value })} />
          <Label className="text-xs">Numbered ranking</Label>
          <span className="text-[10px] text-muted-foreground">1, 2, 3 … over each card</span>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={Boolean(entry.hideTitle)} onCheckedChange={value => update({ hideTitle: value })} />
          <Label className="text-xs">Hide title</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={entry.badges.providers}
            onCheckedChange={value => update({ badges: { ...entry.badges, providers: value } })}
          />
          <Label className="text-xs">Provider badges</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={entry.badges.ratings}
            onCheckedChange={value => update({ badges: { ...entry.badges, ratings: value } })}
          />
          <Label className="text-xs">Rating badges</Label>
        </div>
      </div>
    </div>
  );
}

// ---- Main dialog ----

export function CollectionBuilderDialog({ isOpen, onClose }: CollectionBuilderDialogProps) {
  const { config, setConfig, auth } = useConfig();

  const [entries, setEntries] = useState<BuilderEntry[]>([]);
  /** Entries as they stood when opened or last applied, to spot real edits. */
  const [baseline, setBaseline] = useState('[]');
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const nuvioResult = useMemo(() => toNuvioCollections(entries, identity), [entries, identity]);
  const fusionResult = useMemo(
    () => toFusionWidgets(entries, identity, { usePlaceholder }),
    [entries, identity, usePlaceholder]
  );

  const json = useMemo(
    () => JSON.stringify(target === 'nuvio' ? nuvioResult.output : fusionResult.output, null, 2),
    [target, nuvioResult, fusionResult]
  );

  const notes: ExportNote[] = target === 'nuvio' ? nuvioResult.notes : fusionResult.notes;
  const issues = useMemo(() => findSourceIssues(entries, sourceList.catalogs), [entries, sourceList.catalogs]);

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

  const missingGroups: MissingCatalogGroup[] = useMemo(
    () => groupMissingCatalogs(unknownSources),
    [unknownSources]
  );

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
  };

  const removeEntry = (id: string) => {
    setEntries(prev => {
      const next = prev.filter(entry => entry.id !== id);
      setSelectedId(current => (current === id ? next[0]?.id ?? null : current));
      return next;
    });
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

  const applyToConfig = (thenGoToConfiguration = false) => {
    setConfig(prev => ({ ...prev, collections: clone(entries) }));
    setBaseline(JSON.stringify(entries));
    if (thenGoToConfiguration) {
      toast.success('Applied. Save your configuration to store it.');
      onClose();
      window.dispatchEvent(
        new CustomEvent(SETTINGS_LAYOUT_NAVIGATE_EVENT, {
          detail: { tab: 'configuration', scrollToTop: true },
        })
      );
      return;
    }
    toast.success(
      entries.length === 1
        ? '1 entry applied. Save your configuration to store it.'
        : `${entries.length} entries applied. Save your configuration to store it.`
    );
  };

  const handleSave = (thenGoToConfiguration = false) => {
    // Unknown catalogs render as empty rows rather than breaking anything, so
    // this asks rather than refuses.
    if (unknownSources.length > 0) {
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

  const previewImport = (text: string) => {
    setImportText(text);
    setImportPreview(text.trim() ? parseImport(text) : null);
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    previewImport(await file.text());
  };

  const applyImport = (mode: 'replace' | 'merge') => {
    if (!importPreview || importPreview.entries.length === 0) return;
    const incoming = healSourceNames(
      clone(importPreview.entries) as BuilderEntry[],
      sourceList.catalogs
    );
    setEntries(prev => {
      const next = mode === 'replace' ? incoming : [...prev, ...incoming];
      setSelectedId(next[0]?.id ?? null);
      return next;
    });
    setImportOpen(false);
    setImportText('');
    setImportPreview(null);
    toast.success(
      incoming.length === 1 ? '1 entry imported' : `${incoming.length} entries imported`
    );
  };

  const importUnknown = useMemo(
    () => (importPreview ? findUnknownSources(importPreview.entries, sourceList.catalogs) : []),
    [importPreview, sourceList.catalogs]
  );

  const handleCopyUrl = async () => {
    await navigator.clipboard.writeText(hostedUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 1500);
    toast.success('Link copied to clipboard');
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    toast.success('JSON copied to clipboard');
  };

  const handleDownload = () => {
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
                <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                  Nothing yet. Start with a collection.
                </p>
              )}

              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleRailDragEnd}>
                <SortableContext items={entries.map(entry => entry.id)} strategy={verticalListSortingStrategy}>
                  <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1 lg:max-h-none lg:overflow-visible lg:pr-0">
                    {entries.map((entry, index) => (
                      <SortableEntryRow
                        key={entry.id}
                        entry={entry}
                        excluded={target === 'nuvio' && entry.kind === 'classicRow'}
                        hasUnknown={entryHasUnknownSource(entry, sourceList.catalogs)}
                        isActive={entry.id === selectedId}
                        canMoveUp={index > 0}
                        canMoveDown={index < entries.length - 1}
                        onMove={delta => moveEntry(index, delta)}
                        onSelect={() => setSelectedId(entry.id)}
                        onDelete={() => removeEntry(entry.id)}
                      />
                    ))}
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
              <Tabs defaultValue="design">
                <TabsList>
                  <TabsTrigger value="design">Design</TabsTrigger>
                  <TabsTrigger value="json">JSON</TabsTrigger>
                </TabsList>

                <TabsContent value="design" className="pt-4">
                  {!selected && (
                    <p className="rounded-md border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
                      Select something on the left, or create a collection.
                    </p>
                  )}
                  {selected?.kind === 'collection' && (
                    <CollectionEditor
                      entry={selected}
                      catalogs={sourceList.catalogs}
                      target={target}
                      onChange={updateEntry}
                      onAddSource={folderId => setPickerTarget({ entryId: selected.id, folderId })}
                      onReplaceSource={(folderId, index) =>
                        setPickerTarget({ entryId: selected.id, folderId, replaceIndex: index })}
                      tagOptions={tagOptions}
                      onAddByTag={(folderId, tag) => addSourcesByTag(selected.id, folderId, tag)}
                    />
                  )}
                  {selected?.kind === 'classicRow' && (
                    <ClassicRowEditor
                      entry={selected}
                      catalogs={sourceList.catalogs}
                      target={target}
                      onChange={updateEntry}
                      onAddSource={() => setPickerTarget({ entryId: selected.id, folderId: null })}
                    />
                  )}
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
                    <Label className="text-xs">Manifest URL</Label>
                    <Input
                      value={manifestUrl}
                      onChange={event => setManifestUrl(event.target.value)}
                      placeholder="https://your-host/stremio/<uuid>/manifest.json"
                      className="h-9 font-mono text-xs"
                    />
                  </div>

                  <div className="space-y-1.5 rounded-lg border border-primary/40 bg-primary/5 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <LinkIcon className="h-4 w-4 text-primary" />
                      <Label className="text-xs font-medium">Import by link</Label>
                      <span className="text-[11px] text-muted-foreground">
                        {target === 'fusion'
                          ? 'Paste this straight into Fusion instead of the JSON'
                          : 'Serves the same JSON live, if your app can read a URL'}
                      </span>
                    </div>
                    {hostedUrl ? (
                      <>
                        <div className="flex gap-2">
                          <Input readOnly value={hostedUrl} className="h-9 font-mono text-xs" onClick={e => (e.target as HTMLInputElement).select()} />
                          <Button size="sm" variant="outline" className="shrink-0" onClick={handleCopyUrl}>
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
                        <Switch checked={usePlaceholder} onCheckedChange={setUsePlaceholder} />
                        <Label className="text-xs font-medium">Make a copy for someone else</Label>
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

                  {(notes.length > 0 || issues.length > 0) && (
                    <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="h-4 w-4" /> Worth checking
                      </div>
                      <ul className="space-y-1 text-xs text-muted-foreground">
                        {issues.map((issue, index) => (
                          <li key={`issue-${index}`}>{issue.message}</li>
                        ))}
                        {notes.map((note, index) => (
                          <li key={`note-${index}`}>{note.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
            {unknownSources.length > 0 ? (
              <>
                <p className="flex items-start gap-1.5 text-[11px] text-amber-500 sm:mr-auto">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                  {unknownSources.length === 1
                    ? '1 source points at a catalog you do not have.'
                    : `${unknownSources.length} sources point at catalogs you do not have.`}{' '}
                  Swap them for yours, or leave them and those tiles come up empty.
                </p>
                <Button variant="outline" onClick={() => setRemapOpen(true)}>
                  <Replace className="mr-1.5 h-4 w-4" /> Swap catalogs
                </Button>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground sm:mr-auto">
                Applying puts this in your configuration. It is only stored once you save the configuration
                itself on the Config tab.
              </p>
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
                {importUnknown.length > 0 && (
                  <Badge variant="outline" className="border-amber-600/50 bg-amber-800/60 text-[10px] text-amber-200">
                    {importUnknown.length} not in your catalogs
                  </Badge>
                )}
              </div>

              {importUnknown.length > 0 && (
                <div className="space-y-1 rounded-md border border-amber-600/40 bg-amber-950/20 p-2">
                  <p className="text-[11px] text-amber-500">
                    These catalogs are not in your setup. You can still import, but those tiles will come up
                    empty until the catalogs are added and enabled.
                  </p>
                  <ul className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
                    {importUnknown.slice(0, 6).map((source, index) => (
                      <li key={`${source.catalogId}-${source.type}-${index}`}>
                        {source.catalogId} <span className="opacity-60">({source.type})</span>
                      </li>
                    ))}
                    {importUnknown.length > 6 && <li>and {importUnknown.length - 6} more</li>}
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
              onClick={() => applyImport('merge')}
            >
              Add to existing
            </Button>
            <Button
              disabled={!importPreview || importPreview.entries.length === 0}
              onClick={() => applyImport('replace')}
            >
              Replace all
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

      <ConfirmDialog
        isOpen={confirmApply}
        onClose={() => { setConfirmApply(false); setPendingNavigate(false); }}
        onConfirm={() => applyToConfig(pendingNavigate)}
        variant="default"
        title="Some catalogs are missing"
        confirmText="Apply anyway"
        description={
          `${unknownSources.length === 1 ? '1 source points' : `${unknownSources.length} sources point`} at a catalog ` +
          `that is not in your setup: ${unknownSources.slice(0, 3).map(s => s.catalogId).join(', ')}` +
          `${unknownSources.length > 3 ? `, and ${unknownSources.length - 3} more` : ''}. ` +
          'Those tiles will come up empty until you add and enable the catalogs. Everything else works as normal.'
        }
      />

      <CatalogPicker
        isOpen={pickerTarget !== null}
        catalogs={sourceList.catalogs}
        multiple={pickerTarget?.folderId !== null && typeof pickerTarget?.replaceIndex !== 'number'}
        existingKeys={pickerExistingKeys}
        onConfirm={handlePick}
        onClose={() => setPickerTarget(null)}
      />
    </>
  );
}
