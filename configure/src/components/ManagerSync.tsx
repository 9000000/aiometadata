import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { RefreshCw, Loader2, ChevronDown } from "lucide-react";
import { useConfig } from "@/contexts/ConfigContext";

interface ManagerDef {
  id: string;
  name: string;
  endpoint: string;
  urlPlaceholder: string;
  keyHint: string;
  description: string;
  publicInstances?: { name: string; url: string }[];
  statusEndpoint?: string;
}

const MANAGERS: ManagerDef[] = [
  {
    id: 'aiomanager',
    name: 'AIOManager',
    endpoint: '/api/aiomanager/reinstall',
    urlPlaceholder: 'https://aio.example.com',
    keyHint: 'Your AIOManager account API key (settings → API access)',
    description: 'Installs or updates this addon in your AIOManager account and propagates it to all your connected platforms.',
    publicInstances: [
      { name: "Kuu's (beta)", url: 'https://aiomanager-beta.stremio.ru' },
      { name: "Yeb's (beta)", url: 'https://aiomanager-beta.fortheweak.cloud' },
      { name: "Ibby's", url: 'https://aiomanager.ibbylabs.dev' },
      { name: 'Elfhosted', url: 'https://aiomanager.elfhosted.com' },
      { name: "Midnight's", url: 'https://aiomanagerfortheweebs.midnightignite.me' },
      { name: "Yeb's", url: 'https://aiomanager.fortheweak.cloud' },
      { name: "Kuu's", url: 'https://aiomanager.stremio.ru' },
    ],
    statusEndpoint: '/api/aiomanager/status',
  },
];

const CUSTOM_INSTANCE = 'custom';

const SYNC_BUTTON_CLASSES = "border-violet-400/30 bg-violet-500/15 text-violet-600 dark:text-violet-300 hover:bg-violet-500/25 hover:text-violet-700 dark:hover:text-violet-200";

interface ManagerSyncProps {
  manifestUrl: string;
  onSynced?: () => void;
}

export function ManagerSync({ manifestUrl, onSynced }: ManagerSyncProps) {
  const { config, setConfig, auth } = useConfig();
  const [activeManager, setActiveManager] = useState<ManagerDef | null>(null);
  const [selectedInstance, setSelectedInstance] = useState(CUSTOM_INSTANCE);
  const [instanceUrl, setInstanceUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [remember, setRemember] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [support, setSupport] = useState<'unknown' | 'checking' | 'yes' | 'no'>('unknown');
  const [instanceSupport, setInstanceSupport] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (activeManager) {
      const saved = config.managers?.[activeManager.id];
      const savedUrl = saved?.instanceUrl || '';
      const publicMatch = activeManager.publicInstances?.find(i => i.url === savedUrl);
      setSelectedInstance(publicMatch ? publicMatch.url : CUSTOM_INSTANCE);
      setInstanceUrl(publicMatch ? '' : savedUrl);
      setApiKey(saved?.apiKey || '');
    }
  }, [activeManager, config.managers]);

  useEffect(() => {
    const endpoint = activeManager?.statusEndpoint;
    const listed = activeManager?.publicInstances;
    if (!endpoint || !listed?.length) return;
    let cancelled = false;
    Promise.all(listed.map(async instance => {
      try {
        const response = await fetch(`${endpoint}?instanceUrl=${encodeURIComponent(instance.url)}`);
        const data = await response.json();
        return [instance.url, !!data?.supported] as const;
      } catch {
        return [instance.url, false] as const;
      }
    })).then(pairs => { if (!cancelled) setInstanceSupport(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [activeManager]);

  const probeUrl = (selectedInstance === CUSTOM_INSTANCE ? instanceUrl : selectedInstance).trim().replace(/\/+$/, '');

  useEffect(() => {
    const endpoint = activeManager?.statusEndpoint;
    if (!activeManager || !endpoint || !probeUrl) {
      setSupport('unknown');
      return;
    }
    let cancelled = false;
    setSupport('checking');
    const timer = setTimeout(() => {
      fetch(`${endpoint}?instanceUrl=${encodeURIComponent(probeUrl)}`)
        .then(response => response.json())
        .then(data => { if (!cancelled) setSupport(data?.supported ? 'yes' : 'no'); })
        .catch(() => { if (!cancelled) setSupport('unknown'); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeManager, probeUrl]);

  const handleSync = async () => {
    if (!activeManager) return;
    const effectiveUrl = selectedInstance === CUSTOM_INSTANCE ? instanceUrl : selectedInstance;
    const trimmedUrl = effectiveUrl.trim().replace(/\/+$/, '');
    const trimmedKey = apiKey.trim();
    if (!trimmedUrl || !trimmedKey) {
      toast.error(`Enter your ${activeManager.name} instance URL and API key.`);
      return;
    }
    setIsSyncing(true);
    try {
      const response = await fetch(activeManager.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceUrl: trimmedUrl, apiKey: trimmedKey, addonUrl: manifestUrl })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || `Sync failed (${response.status})`);
      }
      setConfig(prev => ({
        ...prev,
        managers: { ...prev.managers, [activeManager.id]: { instanceUrl: trimmedUrl, apiKey: trimmedKey } }
      }));
      if (remember && auth.authenticated && auth.userUUID) {
        const saveResponse = await fetch('/api/managers/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userUUID: auth.userUUID,
            password: auth.password,
            managerId: activeManager.id,
            instanceUrl: trimmedUrl,
            apiKey: trimmedKey
          })
        });
        if (!saveResponse.ok) {
          toast.warning("Synced, but failed to remember the credentials.");
        }
      }
      toast.success(`Addon synced to ${activeManager.name}!`);
      setActiveManager(null);
      onSynced?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to sync to ${activeManager.name}`);
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <>
      {MANAGERS.length === 1 ? (
        <Button variant="outline" className={SYNC_BUTTON_CLASSES} onClick={() => setActiveManager(MANAGERS[0])}>
          <RefreshCw className="h-4 w-4 mr-2" /> Sync to {MANAGERS[0].name}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className={SYNC_BUTTON_CLASSES}>
              <RefreshCw className="h-4 w-4 mr-2" /> Sync to Manager <ChevronDown className="h-4 w-4 ml-2" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {MANAGERS.map((manager) => (
              <DropdownMenuItem key={manager.id} onClick={() => setActiveManager(manager)}>
                {manager.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog open={!!activeManager} onOpenChange={(open) => { if (!open) setActiveManager(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sync to {activeManager?.name}</DialogTitle>
            <DialogDescription>
              {activeManager?.description}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="manager-instance">Instance</Label>
              {activeManager?.publicInstances?.length ? (
                <Select value={selectedInstance} onValueChange={setSelectedInstance}>
                  <SelectTrigger id="manager-instance">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {activeManager.publicInstances.map((instance) => {
                      const unsupported = instanceSupport[instance.url] === false;
                      return (
                        <SelectItem key={instance.url} value={instance.url} disabled={unsupported}>
                          {instance.name} <span className="text-muted-foreground">({instance.url.replace('https://', '')})</span>
                          {unsupported && <span className="text-muted-foreground"> · no Hydra API</span>}
                        </SelectItem>
                      );
                    })}
                    <SelectItem value={CUSTOM_INSTANCE}>Custom URL…</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              {(selectedInstance === CUSTOM_INSTANCE || !activeManager?.publicInstances?.length) && (
                <Input
                  id="manager-url"
                  placeholder={activeManager?.urlPlaceholder}
                  value={instanceUrl}
                  onChange={(e) => setInstanceUrl(e.target.value)}
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manager-key">Account API key</Label>
              <Input
                id="manager-key"
                type="password"
                placeholder={activeManager?.keyHint}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            {support === 'no' && (
              <p className="text-xs text-amber-500">
                This instance does not serve the Hydra API, so it cannot accept a sync. It needs a
                newer {activeManager?.name} release.
              </p>
            )}
            {support === 'yes' && (
              <p className="text-xs text-emerald-500">Hydra API available on this instance.</p>
            )}
            <div className="flex items-center justify-between">
              <Label htmlFor="manager-remember" className="text-sm text-muted-foreground">
                Remember credentials in my configuration
              </Label>
              <Switch
                id="manager-remember"
                checked={remember}
                onCheckedChange={setRemember}
              />
            </div>
            <Button
              className="w-full"
              onClick={handleSync}
              disabled={isSyncing || support === 'checking' || support === 'no'}
            >
              {isSyncing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Syncing…
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" /> Sync
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
