import { Badge } from '@/components/ui/badge';
import { FUSION_CHIP, NUVIO_CHIP } from '@/lib/collectionBuilder/terms';

/** Marks a control that only one of the two targets understands. */
export function ScopeChip({ scope }: { scope: 'nuvio' | 'fusion' }) {
  return (
    <Badge
      variant="outline"
      className={`h-5 shrink-0 px-1.5 text-xs font-medium ${scope === 'nuvio' ? NUVIO_CHIP : FUSION_CHIP}`}
    >
      {scope === 'nuvio' ? 'Nuvio only' : 'Fusion only'}
    </Badge>
  );
}
