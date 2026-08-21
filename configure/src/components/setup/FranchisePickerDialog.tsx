import { useState } from 'react';
import { Check, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { franchiseCatalogs, CatalogDefinition } from '@/data/catalogs';
import { cn } from '@/lib/utils';
import { useConfig } from '@/contexts/ConfigContext';

function FranchiseTile({
  catalog,
  selected,
  onClick,
}: {
  catalog: CatalogDefinition;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={catalog.name}
      className={cn(
        'group flex flex-col items-center gap-2 rounded-xl border p-3 transition-colors text-left w-full h-full justify-start',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        selected
          ? 'border-primary/60 bg-primary/[0.08]'
          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/25'
      )}
    >
      <div className="flex w-full items-center justify-between">
        <span className="font-medium text-sm truncate">{catalog.name.replace(/^(DC|Marvel|Star Wars):\s*/, '')}</span>
        <div className={cn("flex h-5 w-5 items-center justify-center rounded-full border", selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30")}>
          {selected && <Check className="h-3 w-3" />}
        </div>
      </div>
      <div className="text-xs text-muted-foreground w-full flex gap-2 mt-auto pt-2">
        <span className="capitalize">{catalog.type}</span>
      </div>
    </button>
  );
}

export function FranchisePickerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { config, setConfig } = useConfig();
  const [search, setSearch] = useState('');

  const isSelected = (id: string, type: string) => {
    return !!config.catalogs?.find(c => c.id === id && c.type === type);
  };

  const toggleCatalog = (catalog: CatalogDefinition) => {
    setConfig(prev => {
      const catalogs = prev.catalogs || [];
      const exists = catalogs.some(c => c.id === catalog.id && c.type === catalog.type);
      
      if (exists) {
        return {
          ...prev,
          catalogs: catalogs.filter(c => !(c.id === catalog.id && c.type === catalog.type))
        };
      } else {
        return {
          ...prev,
          catalogs: [
            ...catalogs,
            {
              id: catalog.id,
              type: catalog.type,
              name: catalog.name,
              source: 'franchise',
              enabled: true,
              showInHome: true,
              cacheTTL: 86400
            }
          ]
        };
      }
    });
  };

  const getGroupedCatalogs = () => {
    const grouped = {
      dc: franchiseCatalogs.filter(c => (c as any).franchise === 'dc'),
      marvel: franchiseCatalogs.filter(c => (c as any).franchise === 'marvel'),
      star_wars: franchiseCatalogs.filter(c => (c as any).franchise === 'star_wars'),
    };
    return grouped;
  };

  const grouped = getGroupedCatalogs();

  const renderGroup = (title: string, items: CatalogDefinition[]) => {
    const filtered = items.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
    if (filtered.length === 0) return null;

    return (
      <div className="mb-6 space-y-3">
        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">{title}</h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {filtered.map(catalog => (
            <FranchiseTile
              key={`${catalog.id}-${catalog.type}`}
              catalog={catalog}
              selected={isSelected(catalog.id, catalog.type)}
              onClick={() => toggleCatalog(catalog)}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
        <div className="p-6 pb-4 border-b shrink-0 space-y-4">
          <DialogHeader>
            <DialogTitle>Franchise Collections</DialogTitle>
            <DialogDescription>
              Select the franchise catalogs you want to appear in your Stremio library.
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search collections..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-10"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 min-h-0 bg-muted/10">
          {renderGroup('Marvel Cinematic Universe & Comics', grouped.marvel)}
          {renderGroup('DC Universe', grouped.dc)}
          {renderGroup('Star Wars', grouped.star_wars)}
          
          {search && Object.values(grouped).every(arr => arr.filter(c => c.name.toLowerCase().includes(search.toLowerCase())).length === 0) && (
            <div className="text-center py-12 text-muted-foreground">
              No collections found matching "{search}"
            </div>
          )}
        </div>

        <div className="p-4 border-t bg-background shrink-0 flex justify-end">
          <Button onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
