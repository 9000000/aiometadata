import { Button } from '@/components/ui/button';
import { ExternalLink, Loader2 } from 'lucide-react';
import type { DeviceAuthCode } from '@/hooks/useDeviceAuth';

interface DeviceAuthCardProps {
  code: DeviceAuthCode | null;
  requesting: boolean;
  disabled: boolean;
  startLabel: string;
  hint: string;
  onStart: () => void;
  onCancel: () => void;
}

/** Code display for the Simkl PIN flow. */
export function DeviceAuthCard({
  code,
  requesting,
  disabled,
  startLabel,
  hint,
  onStart,
  onCancel,
}: DeviceAuthCardProps) {
  if (!code) {
    return (
      <>
        <Button onClick={onStart} className="w-full" disabled={disabled || requesting}>
          {requesting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ExternalLink className="mr-2 h-4 w-4" />
          )}
          {startLabel}
        </Button>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </>
    );
  }

  return (
    <div className="space-y-3 p-4 border rounded-lg bg-gray-50 dark:bg-gray-900">
      <p className="text-sm text-muted-foreground">
        Enter this code at{" "}
        <a href={code.verificationUrl} target="_blank" rel="noopener noreferrer" className="underline">
          {code.verificationUrl.replace(/^https?:\/\//, "")}
        </a>
      </p>
      <p className="text-3xl font-mono font-bold tracking-[0.3em] text-center select-all">
        {code.userCode}
      </p>
      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Waiting for you to approve the code...
      </div>
      <Button variant="ghost" className="w-full" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
