import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export function SettingRow({
  htmlFor,
  label,
  description,
  control,
  note,
  className,
}: {
  htmlFor?: string;
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  /** Optional Callout belonging to this row specifically. */
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('py-3', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-[12rem] flex-1">
          <Label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </Label>
          {description ? (
            <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
          ) : null}
        </div>
        <div className="shrink-0 max-w-full">{control}</div>
      </div>
      {note ? <div className="mt-2">{note}</div> : null}
    </div>
  );
}
