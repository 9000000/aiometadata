import { useEffect, useState } from 'react';

import { isNativeSource } from '@shared/catalogReconstruction';
import type {
  BuilderEntry,
  CollectionDraft,
  FolderDraft,
  TileShape,
} from '@shared/types';
import { TERMS, type Target } from '@/lib/collectionBuilder/terms';

const TILE_ASPECT: Record<TileShape, string> = {
  POSTER: '2 / 3',
  LANDSCAPE: '16 / 9',
  SQUARE: '1 / 1',
};

/** Share of the stage width one tile takes, roughly a TV grid's density. */
const TILE_WIDTH: Record<TileShape, string> = {
  POSTER: '16%',
  LANDSCAPE: '24%',
  SQUARE: '19%',
};

function initialsFor(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
}

/** Stable hue from the title, so two artless tiles do not read as one. */
function gradientFor(title: string): string {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) % 360;
  }
  return `linear-gradient(135deg, hsl(${hash} 45% 28%), hsl(${(hash + 40) % 360} 40% 16%))`;
}

/** Mirrors the drop rules in nuvioExport.toFolder and fusionExport.toCollectionItem. */
function usableSourceCount(folder: FolderDraft, target: Target): number {
  return folder.sources.filter(source => {
    if (isNativeSource(source)) return target === 'nuvio' && Boolean(source.native);
    return Boolean((source.catalogId || '').trim()) && Boolean((source.type || '').trim());
  }).length;
}

function folderDropped(folder: FolderDraft, target: Target): boolean {
  return !folder.title.trim() || usableSourceCount(folder, target) === 0;
}

function TileArt({
  folder,
  focused,
  allowEmoji,
}: {
  folder: FolderDraft;
  focused: boolean;
  allowEmoji: boolean;
}) {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const cover = (folder.coverImageUrl || '').trim();
  const gif = (folder.focusGifUrl || '').trim();
  const src = focused && gif && folder.focusGifEnabled !== false ? gif : cover;
  const failed = Boolean(src) && brokenSrc === src;
  const title = folder.title.trim();
  const emoji = allowEmoji ? (folder.coverEmoji || '').trim() : '';

  if (src && !failed) {
    return (
      <img
        key={src}
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBrokenSrc(src)}
        className="h-full w-full object-cover"
      />
    );
  }

  return (
    <>
      <span
        className="flex h-full w-full items-center justify-center"
        style={{ backgroundImage: gradientFor(title || 'untitled') }}
      >
        <span className={emoji ? 'text-3xl' : 'text-base font-semibold tracking-wide text-white/75'}>
          {emoji || initialsFor(title)}
        </span>
      </span>
      <span
        className="absolute right-1 top-1 h-2 w-2 rounded-full bg-white/50"
        title={failed ? 'Cover image did not load' : 'No cover set'}
        aria-label={failed ? 'Cover image did not load' : 'No cover set'}
      />
    </>
  );
}

function PreviewTile({
  folder,
  target,
  focused,
  glow,
  showTitle,
  allowEmoji,
  width,
  onFocus,
  onBlur,
  onEdit,
}: {
  folder: FolderDraft;
  target: Target;
  focused: boolean;
  glow: boolean;
  showTitle: boolean;
  allowEmoji: boolean;
  width?: string;
  onFocus: () => void;
  onBlur: () => void;
  onEdit: () => void;
}) {
  const title = folder.title.trim();
  const dropped = folderDropped(folder, target);

  return (
    <button
      type="button"
      onClick={onEdit}
      onMouseEnter={onFocus}
      onMouseLeave={onBlur}
      onFocus={onFocus}
      onBlur={onBlur}
      aria-label={`Edit ${title || `untitled ${TERMS[target].child.toLowerCase()}`}`}
      className={`flex shrink-0 flex-col gap-1.5 text-left ${dropped ? 'opacity-40' : ''}`}
      style={{ width: width || TILE_WIDTH[folder.shape] }}
    >
      <span
        className={`relative block overflow-hidden rounded-md transition-shadow motion-reduce:transition-none ${
          focused && glow
            ? 'shadow-[0_0_0_2px_hsl(var(--primary)),0_0_20px_hsl(var(--primary)/0.5)]'
            : 'shadow-[0_0_0_1px_rgba(255,255,255,0.12)]'
        }`}
        style={{ aspectRatio: TILE_ASPECT[folder.shape] }}
      >
        <TileArt folder={folder} focused={focused} allowEmoji={allowEmoji} />
      </span>
      {showTitle && (
        <span className="line-clamp-2 text-[11px] leading-tight text-white/85">
          {title || `Untitled ${TERMS[target].child.toLowerCase()}`}
        </span>
      )}
      {dropped && <span className="text-[10px] text-amber-400">left out of this export</span>}
    </button>
  );
}

function PreviewCaption() {
  return (
    <p className="text-[11px] text-muted-foreground">
      Approximate. Tile art, shapes, titles, order and counts are exactly what you set; spacing, grids
      and card sizes are this addon&rsquo;s rendering, not the app&rsquo;s.
    </p>
  );
}

function NuvioCollectionStage({
  entry,
  onEditFolder,
}: {
  entry: CollectionDraft;
  onEditFolder: (folderId: string) => void;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focused = entry.folders.find(folder => folder.id === focusedId) || null;
  const base = (entry.backdropImageUrl || '').trim();
  const hero = (focused?.heroBackdropUrl || '').trim();
  const logo = (focused?.titleLogoUrl || '').trim();

  // The hero layer stays mounted with the last one seen, so leaving a tile fades
  // back out instead of unmounting mid-transition.
  const [lastHero, setLastHero] = useState('');
  useEffect(() => {
    if (hero) setLastHero(hero);
  }, [hero]);

  const glow = entry.focusGlowEnabled !== false;
  const viewMode = entry.viewMode || 'TABBED_GRID';
  const asRows = viewMode === 'ROWS';

  const tile = (folder: FolderDraft, width?: string) => (
    <PreviewTile
      key={folder.id}
      folder={folder}
      target="nuvio"
      focused={focusedId === folder.id}
      glow={glow}
      showTitle={!asRows && !folder.hideTitle}
      allowEmoji
      width={width}
      onFocus={() => setFocusedId(folder.id)}
      onBlur={() => setFocusedId(current => (current === folder.id ? null : current))}
      onEdit={() => onEditFolder(folder.id)}
    />
  );

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-neutral-950">
      {base && (
        <img
          key={base}
          src={base}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover opacity-60"
        />
      )}
      {lastHero && (
        <img
          src={lastHero}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 motion-reduce:transition-none ${
            hero ? 'opacity-60' : 'opacity-0'
          }`}
        />
      )}
      <span className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/70 to-black/40" />

      <div className="relative flex h-full flex-col gap-3 overflow-y-auto p-4">
        {entry.pinToTop && (
          <span className="w-fit rounded-full bg-cyan-500/20 px-2 py-0.5 text-[10px] text-cyan-200">
            Pinned above your other collections
          </span>
        )}

        <div className="flex items-center gap-3">
          {logo && (
            <img
              key={logo}
              src={logo}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-8 max-w-[9rem] object-contain"
            />
          )}
          <span className="text-sm font-semibold text-white">
            {entry.title.trim() || 'Untitled collection'}
          </span>
        </div>

        {!asRows && entry.folders.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {entry.showAllTab !== false && (
              <span className="rounded-full bg-white/90 px-2.5 py-0.5 text-[11px] font-medium text-black">
                All
              </span>
            )}
            {entry.folders.map((folder, index) => (
              <span
                key={folder.id}
                className={`rounded-full px-2.5 py-0.5 text-[11px] ${
                  entry.showAllTab === false && index === 0
                    ? 'bg-white/90 font-medium text-black'
                    : 'bg-white/15 text-white/80'
                }`}
              >
                {folder.title.trim() || 'Untitled'}
              </span>
            ))}
          </div>
        )}

        {viewMode === 'FOLLOW_LAYOUT' && (
          <span className="text-[10px] text-white/50">
            Follow layout: the app&rsquo;s own layout setting picks between tabs and rows.
          </span>
        )}

        {entry.folders.length === 0 ? (
          <span className="m-auto text-xs text-white/50">No folders yet.</span>
        ) : asRows ? (
          <div className="space-y-2">
            {entry.folders.map(folder => (
              <div key={folder.id} className="flex items-center gap-3 rounded-md bg-white/5 p-2">
                {tile(folder, '12%')}
                <span className="min-w-0">
                  <span className="block truncate text-xs text-white/90">
                    {folder.hideTitle ? '' : folder.title.trim() || 'Untitled folder'}
                  </span>
                  <span className="block text-[10px] text-white/50">
                    {folder.sources.length} catalog{folder.sources.length === 1 ? '' : 's'}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">{entry.folders.map(folder => tile(folder))}</div>
        )}
      </div>
    </div>
  );
}

export function CollectionPreview({
  entry,
  target,
  onEditFolder,
}: {
  entry: BuilderEntry | null;
  target: Target;
  onEditFolder: (folderId: string) => void;
}) {
  if (!entry) {
    return (
      <div className="rounded-md border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
        Select something on the left to preview it.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entry.kind === 'collection' && target === 'nuvio' ? (
        <NuvioCollectionStage entry={entry} onEditFolder={onEditFolder} />
      ) : (
        <div className="rounded-md border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
          No preview for this yet.
        </div>
      )}
      <PreviewCaption />
    </div>
  );
}
