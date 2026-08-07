import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { FolderPlus, Replace, Tv } from 'lucide-react';
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

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { nextCopyTitle } from '@/lib/collectionBuilder/entryOps';
import type { IssueSeverity } from '@/lib/collectionBuilder/issueCenter';
import { catalogKey, type ManifestCatalog } from '@/lib/collectionBuilder/manifestSources';
import { TERMS, type Target } from '@/lib/collectionBuilder/terms';
import { isNativeSource } from '@shared/catalogReconstruction';
import { createFolderDraft, hasNuvioCollectionSettings, newId, type CollectionDraft, type FolderDraft } from '@shared/types';

import { FolderCard, SortableFolderRow } from './FolderCard';
import { ImageUrlField } from './ImageUrlField';
import { ScopeChip } from './ScopeChip';
import { clone, type TagOption } from './shared';

export function CollectionEditor({
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
  folderSeverity,
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
  /** The worst thing the issue list says about each folder, by folder id. */
  folderSeverity?: Map<string, IssueSeverity>;
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
    const copy: FolderDraft = { ...clone(original), id: newId(), title: nextCopyTitle(original.title) };
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
          Nothing here yet. Add a folder, then point it at one or more of your catalogs.
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
                    severity={folderSeverity?.get(folder.id)}
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
