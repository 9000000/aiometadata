import { Button } from '@/components/ui/button';
import type { FeaturedCollection } from '@/lib/collectionBuilder/featured';

interface FeaturedListProps {
  items: FeaturedCollection[];
  /** Catalog slots left, so a design that will not fit says so before it is loaded. */
  headroom: number;
  busy: boolean;
  onLoad: (featured: FeaturedCollection) => void;
}

const CHIP = 'rounded-full border px-2 py-0.5 text-[0.7rem] leading-4 whitespace-nowrap';

export function FeaturedList({ items, headroom, busy, onLoad }: FeaturedListProps) {
  return (
    <div className="space-y-2">
      {items.map(featured => {
        const overBudget = featured.catalogs > headroom;
        return (
          <div key={featured.id} className="rounded-lg border p-3 transition-colors hover:bg-accent/30">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium">{featured.name}</span>
              <a
                href={featured.authorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {featured.author}
              </a>
            </div>

            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{featured.summary}</p>

            <div className="mt-2 flex flex-wrap gap-1">
              <span className={`${CHIP} border-border text-muted-foreground`}>{featured.detail.split(',')[0]}</span>
              <span
                className={`${CHIP} ${
                  overBudget ? 'border-amber-600/50 text-amber-500' : 'border-border text-muted-foreground'
                }`}
                title={
                  overBudget
                    ? `Room for ${headroom}. You can still take the layout without the catalogs.`
                    : `Room for ${headroom}.`
                }
              >
                {featured.catalogs} catalogs
              </span>
              {featured.classicRows ? (
                <span
                  className={`${CHIP} border-border text-muted-foreground`}
                  title="Nuvio has no equivalent and skips them; Fusion keeps them."
                >
                  {featured.classicRows} classic rows
                </span>
              ) : null}
            </div>

            {featured.note && <p className="mt-2 text-xs text-muted-foreground">{featured.note}</p>}

            <Button
              size="sm"
              variant="outline"
              className="mt-2.5 h-8 w-full @2xl/panes:h-7"
              disabled={busy}
              onClick={() => onLoad(featured)}
            >
              {busy ? 'Loading…' : 'Preview'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
