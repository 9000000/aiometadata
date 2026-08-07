import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Folder, GripVertical, Plus, Tags, Trash2, Tv } from 'lucide-react';
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

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getTagColor } from '@/lib/tagColors';
import type { IssueSeverity } from '@/lib/collectionBuilder/issueCenter';
import { catalogKey, type ManifestCatalog } from '@/lib/collectionBuilder/manifestSources';
import { aliasHint, TERMS, type Target } from '@/lib/collectionBuilder/terms';
import { hasNuvioFolderArt, type FolderDraft } from '@shared/types';

import { ImageUrlField } from './ImageUrlField';
import { ScopeChip } from './ScopeChip';
import { ReorderArrows, RowActions, SortableSourceRow } from './SourceRow';
import { ASPECT_BY_TILE, SHAPE_LABELS, SHAPE_ORDER, SHAPE_PREVIEW, type TagOption } from './shared';

export function SortableFolderRow({
  folder,
  severity,
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
  /** The worst thing the issue list says about this folder, if anything. */
  severity?: IssueSeverity;
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
        {severity && severity !== 'info' && (
          <span
            className="shrink-0"
            title={severity === 'blocking' ? 'Must be fixed before saving' : 'Worth checking'}
          >
            <AlertTriangle
              className={`h-3.5 w-3.5 ${severity === 'blocking' ? 'text-red-500' : 'text-amber-500'}`}
            />
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

export function FolderCard({
  folder,
  catalogs,
  pendingKeys,
  target,
  onChange,
  onUndoableChange,
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
  /** Same as onChange, but the caller offers an Undo for it. */
  onUndoableChange?: (label: string, next: FolderDraft) => void;
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
          {aliasHint(target, 'shape') && (
            <span className="text-[10px] text-muted-foreground">{aliasHint(target, 'shape')}</span>
          )}
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
          <Label className="text-xs" title={aliasHint(target, 'sources') ?? undefined}>{terms.sources}</Label>
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
                  onRemove={() => {
                    const next = { ...folder, sources: folder.sources.filter((_, i) => i !== index) };
                    const label = `Removed ${source.name || source.catalogId}`;
                    if (onUndoableChange) onUndoableChange(label, next);
                    else onChange(next);
                  }}
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
