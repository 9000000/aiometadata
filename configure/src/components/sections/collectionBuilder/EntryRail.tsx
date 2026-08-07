import { AlertTriangle, GripVertical, Layers, ListOrdered, Rows3, Trash2 } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { IssueSeverity } from '@/lib/collectionBuilder/issueCenter';
import type { BuilderEntry } from '@shared/types';
import { entrySourceCount } from './shared';
import { ReorderArrows, RowActions } from './SourceRow';

export function SortableEntryRow({
  entry,
  isActive,
  excluded,
  severity,
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
  /** The worst thing the issue list says about this entry, if anything. */
  severity?: IssueSeverity;
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
