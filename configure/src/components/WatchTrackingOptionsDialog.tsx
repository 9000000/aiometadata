import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useConfig } from '@/contexts/ConfigContext';
import type { WatchTrackingService } from '@/contexts/config';
import {
  isWatchTrackingMediaTypeSelected,
  isWatchTrackingServiceEnabled,
  WATCH_TRACKING_SERVICE_DEFINITIONS,
  type WatchTrackingMediaType,
} from '@/lib/watchTracking';

interface WatchTrackingOptionsDialogProps {
  service: WatchTrackingService | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WatchTrackingOptionsDialog({
  service,
  open,
  onOpenChange,
}: WatchTrackingOptionsDialogProps) {
  const { config, setConfig } = useConfig();

  if (!service) return null;

  const definition = WATCH_TRACKING_SERVICE_DEFINITIONS[service];
  const masterEnabled = isWatchTrackingServiceEnabled(config, service);
  const isAnimeService = service === 'anilist' || service === 'mal';

  const updateMediaType = (
    mediaType: WatchTrackingMediaType,
    checked: boolean,
  ) => {
    setConfig((previous) => ({
      ...previous,
      watchTracking: {
        ...previous.watchTracking,
        [service]: {
          ...previous.watchTracking?.[service],
          [mediaType]: checked,
        },
      },
    }));
  };

  const options: Array<{
    mediaType: WatchTrackingMediaType;
    label: string;
    description: string;
  }> = [
    {
      mediaType: 'movie',
      label: isAnimeService
        ? 'Sync Anime Movie Watch History'
        : 'Sync Movie Watch History',
      description: `Send watched ${definition.movieLabel.toLowerCase()} to ${definition.label}.`,
    },
    {
      mediaType: 'series',
      label: isAnimeService
        ? 'Sync Anime Series Watch History'
        : 'Sync TV Show Watch History',
      description: `Send watched ${definition.seriesLabel.toLowerCase()} to ${definition.label}.`,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{definition.label} Watch Tracking</DialogTitle>
          <DialogDescription>
            Choose which types of playback are synced to {definition.label}.
          </DialogDescription>
        </DialogHeader>

        {!masterEnabled && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-muted-foreground">
            These preferences will take effect when {definition.label} tracking is enabled.
          </div>
        )}

        <div className="space-y-2">
          {options.map(({ mediaType, label, description }) => {
            const id = `${service}-${mediaType}-watch-tracking`;
            return (
              <div
                key={mediaType}
                className="flex items-center justify-between gap-4 rounded-lg border border-white/[0.08] p-3"
              >
                <div className="min-w-0">
                  <Label htmlFor={id} className="font-medium">
                    {label}
                  </Label>
                  <p className="text-sm text-muted-foreground">{description}</p>
                </div>
                <Switch
                  id={id}
                  checked={isWatchTrackingMediaTypeSelected(config, service, mediaType)}
                  onCheckedChange={(checked) => updateMediaType(mediaType, checked)}
                  className="shrink-0"
                />
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

