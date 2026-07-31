import { lazy, Suspense, useState, useEffect, useMemo, type KeyboardEvent } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, Loader2, Save, Key, User, Download, Eye, EyeOff, List } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { TagChip } from "@/components/TagChip";
import { cn } from "@/lib/utils";
import { keyStatuses, missingRequiredKeys } from "@/lib/configStatus";
import { Callout } from "@/components/settings/Callout";
import { ConfigStatusPanel, CONFIG_STATUS_SUMMARY_ID } from "@/components/settings/ConfigStatusPanel";
import { SettingRow } from "@/components/settings/SettingRow";

interface SavedConfig {
  userUUID: string;
  installUrl: string;
}

const LazyInstallDialog = lazy(() =>
  import("@/components/InstallDialog").then((module) => ({ default: module.InstallDialog }))
);
const LazyConfigImportExport = lazy(() =>
  import("@/components/ConfigImportExport").then((module) => ({ default: module.ConfigImportExport }))
);

function ConfigurationSectionFallback() {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-5">
      <div className="text-sm font-medium text-muted-foreground">Loading configuration tools...</div>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export function ConfigurationManager() {
  const { config, setConfig, auth, setAuth, hasBuiltInTvdb, hasBuiltInTmdb, isLoading: contextLoading, manifestChangedSinceInstall, markManifestInstalled } = useConfig();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [savedConfig, setSavedConfig] = useState<SavedConfig | null>(null);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [isInstallOpen, setIsInstallOpen] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [addonPassword, setAddonPassword] = useState("");
  const [requireAddonPassword, setRequireAddonPassword] = useState(false);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [loadPassword, setLoadPassword] = useState("");
  const [loadAddonPassword, setLoadAddonPassword] = useState("");
  const [loadError, setLoadError] = useState("");
  const [isLoadingLoad, setIsLoadingLoad] = useState(false);
  const [isUUIDTrusted, setIsUUIDTrusted] = useState<boolean | null>(null);
  const [showReinstallWarning, setShowReinstallWarning] = useState(false);

  const caps = { hasBuiltInTmdb, hasBuiltInTvdb };
  const statuses = useMemo(
    () => keyStatuses(config, caps),
    [config, hasBuiltInTmdb, hasBuiltInTvdb] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const missingKeys = useMemo(
    () => (contextLoading ? [] : missingRequiredKeys(config, caps)),
    [config, hasBuiltInTmdb, hasBuiltInTvdb, contextLoading] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const canSave = !contextLoading && missingKeys.length === 0;

  const identity: SavedConfig | null = savedConfig
    ?? (auth.authenticated && auth.userUUID && auth.installUrl
      ? { userUUID: auth.userUUID, installUrl: auth.installUrl }
      : null);

  useEffect(() => {
    fetch("/api/config/addon-info")
      .then(res => res.json())
      .then(data => setRequireAddonPassword(!!data.requiresAddonPassword))
      .catch(() => setRequireAddonPassword(false));
  }, []);

  useEffect(() => {
    const uuid = savedConfig?.userUUID ?? (auth.authenticated ? auth.userUUID : null);
    if (uuid && /^[A-Za-z0-9_-]{3,}$/.test(uuid)) {
      fetch(`/api/config/is-trusted/${encodeURIComponent(uuid)}`)
        .then(res => res.json())
        .then(data => {
          setIsUUIDTrusted(!!data.trusted);
          setRequireAddonPassword(!!data.requiresAddonPassword);
        })
        .catch(() => {
          setIsUUIDTrusted(null);
          setRequireAddonPassword(false);
        });
    } else {
      setIsUUIDTrusted(null);
      setRequireAddonPassword(false);
    }
  }, [savedConfig?.userUUID, auth.authenticated, auth.userUUID]);

  const handleSaveConfiguration = async () => {
    setIsLoading(true);
    setError("");
    const missing = missingRequiredKeys(config, caps);
    if (missing.length > 0) {
      setError(`Missing required API keys: ${missing.map(k => k.name).join(', ')}`);
      setIsLoading(false);
      return;
    }
    const isAuthenticated = auth.authenticated && auth.userUUID && auth.password;
    try {
      // Remove instance-specific fields that shouldn't be saved to user config.
      const trimmedApiKeys = Object.fromEntries(
        Object.entries(config.apiKeys).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])
      );
      const configToSave = {
        ...config,
        apiKeys: {
          ...trimmedApiKeys,
          customDescriptionBlurb: undefined // Never save this - it's instance-specific
        }
      };
      
      const response = isAuthenticated
        ? await fetch(`/api/config/update/${encodeURIComponent(auth.userUUID!)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: configToSave, password: auth.password, addonPassword })
          })
        : await fetch('/api/config/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: configToSave, password, addonPassword })
          });
      if (!response.ok) {
        let message = 'Failed to save configuration';
        try {
          const errorData = await response.json();
          message = errorData?.error || message;
        } catch (_) {
          const text = await response.text();
          if (text) message = text;
        }
        throw new Error(message);
      }
      let result: any;
      try {
        result = await response.json();
      } catch (_) {
        const text = await response.text();
        throw new Error(text || 'Invalid JSON response from server');
      }
      setSavedConfig(result);
      if (!isAuthenticated && result?.userUUID) {
        setAuth({ authenticated: true, userUUID: result.userUUID, password, installUrl: result.installUrl ?? null });
        try { sessionStorage.removeItem('fromStremioSettings'); } catch {}
      }
      setShowPasswordDialog(false);
      setPassword("");
      setConfirmPassword("");
      setAddonPassword("");
      setShowReinstallWarning(manifestChangedSinceInstall());
      toast.success("Configuration saved successfully!");
    } catch (err) {
      console.error('Save configuration error:', err);
      setError(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied to clipboard!`);
    } catch (err) {
      console.error('Copy failed:', err);
      toast.error('Failed to copy to clipboard');
    }
  };

  const handleLoadConfiguration = async () => {
    if (!identity?.userUUID) return;
    setIsLoadingLoad(true);
    setLoadError("");
    try {
      const response = await fetch(`/api/config/load/${encodeURIComponent(identity.userUUID)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loadPassword, addonPassword: loadAddonPassword })
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to load configuration');
      }
      const result = await response.json();
      if (!result?.success || !result?.config) {
        throw new Error('Invalid response from server');
      }
      setConfig(prev => ({
        ...result.config,
        catalogSetupComplete: true,
        apiKeys: {
          ...result.config.apiKeys,
          customDescriptionBlurb: prev.apiKeys.customDescriptionBlurb,
        },
      }));
      setAuth({
        authenticated: true,
        userUUID: result.userUUID || identity.userUUID,
        password: loadPassword,
        installUrl: result.installUrl ?? null,
      });
      toast.success("Configuration loaded successfully!");
      setShowLoadDialog(false);
      setLoadPassword("");
      setLoadAddonPassword("");
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setIsLoadingLoad(false);
    }
  };

  const saveHint = auth.authenticated
    ? "Updates your saved configuration in the database."
    : "You'll create a password, then get a UUID and install URL.";

  const canSubmitPasswordDialog = password.length >= 6 && password === confirmPassword;

  const submitPasswordDialog = () => {
    if (isLoading || !canSubmitPasswordDialog) return;
    void handleSaveConfiguration();
  };

  const handlePasswordDialogKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submitPasswordDialog();
  };

  const profileTags = config.tags ?? [];
  const taggedInstallUrl = identity
    ? (selectedTag ? `${identity.installUrl}?tag=${encodeURIComponent(selectedTag)}` : identity.installUrl)
    : "";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <List className="h-5 w-5" />
            Addon Resources
          </CardTitle>
          <CardDescription>What your addon exposes to Stremio.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow
            htmlFor="catalog-mode-only"
            label="Catalog Mode Only"
            description="Catalogs only, no Meta. Use when another addon supplies it: a second AIOMetadata instance, or a different meta provider."
            control={
              <Switch
                id="catalog-mode-only"
                checked={config.catalogModeOnly ?? false}
                onCheckedChange={(checked) => {
                  setConfig(prev => ({
                    ...prev,
                    catalogModeOnly: checked
                  }));
                }}
              />
            }
            note={config.catalogModeOnly ? (
              <Callout variant="warn">
                Meta will come from another addon. AIOMetadata's meta and art provider settings won't apply.
              </Callout>
            ) : null}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Configuration Status
          </CardTitle>
          <CardDescription>
            Check your configuration status and save it to the database
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConfigStatusPanel
            statuses={statuses}
            missingKeys={missingKeys}
            loading={contextLoading}
          />

          <div className="space-y-3">
            {error && !showPasswordDialog && (
              <Callout variant="danger">{error}</Callout>
            )}
          </div>
        </CardContent>
        <CardFooter className="border-t pt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">{saveHint}</p>
          <Dialog open={!auth.authenticated && showPasswordDialog} onOpenChange={setShowPasswordDialog}>
              <Button
                size="lg"
                disabled={!canSave || isLoading}
                aria-describedby={CONFIG_STATUS_SUMMARY_ID}
                className="w-full sm:w-auto flex items-center gap-2"
                onClick={() => {
                  if (!canSave || isLoading) return;
                  setError("");
                  if (auth.authenticated) {
                    void handleSaveConfiguration();
                  } else {
                    setShowPasswordDialog(true);
                  }
                }}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save Configuration
              </Button>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Password</DialogTitle>
                  <DialogDescription>
                    Create a password to protect your configuration. You'll need this password to access your configuration later.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  {error && <Callout variant="danger">{error}</Callout>}
                   <div className="space-y-2">
                    <Label htmlFor="cfgmgr-password">Password</Label>
                    <div className="relative">
                      <Input
                        id="cfgmgr-password"
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={handlePasswordDialogKeyDown}
                        placeholder="Enter your password"
                        minLength={6}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="absolute right-2 top-1/2 -translate-y-1/2"
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Password must be at least 6 characters long.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cfgmgr-confirm-password">Confirm Password</Label>
                    <div className="relative">
                      <Input
                        id="cfgmgr-confirm-password"
                        type={showConfirmPassword ? "text" : "password"}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        onKeyDown={handlePasswordDialogKeyDown}
                        placeholder="Confirm your password"
                        minLength={6}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="absolute right-2 top-1/2 -translate-y-1/2"
                        aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      >
                        {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Must match the password above and be at least 6 characters.</p>
                  </div>
                  {requireAddonPassword && (
                    <div className="space-y-2">
                      <Label htmlFor="cfgmgr-addon-password">Addon Password</Label>
                      <Input
                        id="cfgmgr-addon-password"
                        type="password"
                        value={addonPassword}
                        onChange={e => setAddonPassword(e.target.value)}
                        onKeyDown={handlePasswordDialogKeyDown}
                        placeholder="Enter the addon password"
                        minLength={6}
                      />
                      <p className="text-xs text-muted-foreground mt-1">Required by the addon administrator.</p>
                    </div>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button 
                      variant="outline" 
                      onClick={() => setShowPasswordDialog(false)}
                    >
                      Cancel
                    </Button>
                    <Button 
                      onClick={submitPasswordDialog}
                      disabled={isLoading || !canSubmitPasswordDialog}
                    >
                      {isLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        'Save Configuration'
                      )}
                    </Button>
                  </div>
                </div>
              </DialogContent>
          </Dialog>
        </CardFooter>
      </Card>
      {identity && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Your Configuration
            </CardTitle>
            <CardDescription>
              Save these credentials to access your configuration later
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div>
                <Label className="text-sm font-medium">Your UUID</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input 
                    value={identity.userUUID} 
                    readOnly 
                    className="font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(identity.userUUID, 'UUID')}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div>
                <Label className="text-sm font-medium">Install URL</Label>
                {profileTags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <span className="text-xs text-muted-foreground mr-1">Profile:</span>
                    <button
                      type="button"
                      onClick={() => setSelectedTag('')}
                      className={cn(
                        'rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                        selectedTag === ''
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-muted-foreground/30 text-muted-foreground hover:text-foreground',
                      )}
                    >
                      All catalogs
                    </button>
                    {profileTags.map((t) => (
                      <TagChip
                        key={t.name}
                        name={t.name}
                        color={t.color}
                        onClick={() => setSelectedTag(t.name)}
                        dimmed={selectedTag !== '' && selectedTag !== t.name}
                      />
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    value={taggedInstallUrl}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { markManifestInstalled(); setShowReinstallWarning(false); copyToClipboard(taggedInstallUrl, 'Install URL'); }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                {selectedTag !== '' && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Installs only catalogs tagged <span className="font-medium">{selectedTag}</span> as a separate addon profile.
                  </p>
                )}
              </div>
            </div>
            <Callout variant="info">
              <strong>Important:</strong> Save your UUID and password. You'll need both to access your configuration later.
            </Callout>
            {showReinstallWarning && (
              <Callout variant="warn">
                <div className="flex items-start justify-between gap-2">
                  <span>
                    <strong>Reinstall Required:</strong> Your configuration was saved, but the changes you made affect the addon manifest (catalogs, search, or resources). Stremio does not auto-reload manifests, so you need to reinstall the addon for these changes to take effect.
                  </span>
                  <Button variant="ghost" size="sm" className="shrink-0 -mt-1 -mr-1" onClick={() => setShowReinstallWarning(false)}>
                    Dismiss
                  </Button>
                </div>
              </Callout>
            )}
            <div className="flex gap-2">
              <Dialog open={showLoadDialog} onOpenChange={setShowLoadDialog}>
                <Button
                  variant="outline"
                  onClick={() => setShowLoadDialog(true)}
                  disabled={isLoading}
                >
                  Load Configuration
                </Button>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Load Configuration</DialogTitle>
                    <DialogDescription>
                      Enter your password{requireAddonPassword && isUUIDTrusted === false ? ' and addon password' : ''} to load your configuration.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    {loadError && <Callout variant="danger">{loadError}</Callout>}
                    <div className="space-y-2">
                      <Label htmlFor="cfgmgr-load-password">Password</Label>
                      <Input
                        id="cfgmgr-load-password"
                        type="password"
                        value={loadPassword}
                        onChange={e => setLoadPassword(e.target.value)}
                        placeholder="Enter your password"
                        minLength={6}
                      />
                      <p className="text-xs text-muted-foreground mt-1">Password must be at least 6 characters long.</p>
                    </div>
                    {requireAddonPassword && isUUIDTrusted === false && (
                      <div className="space-y-2">
                        <Label htmlFor="cfgmgr-load-addon-password">Addon Password</Label>
                        <Input
                          id="cfgmgr-load-addon-password"
                          type="password"
                          value={loadAddonPassword}
                          onChange={e => setLoadAddonPassword(e.target.value)}
                          placeholder="Enter the addon password"
                          minLength={6}
                        />
                        <p className="text-xs text-muted-foreground mt-1">Required by the addon administrator.</p>
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setShowLoadDialog(false);
                          setLoadPassword("");
                          setLoadAddonPassword("");
                          setLoadError("");
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={handleLoadConfiguration}
                        disabled={isLoadingLoad || loadPassword.length < 6}
                      >
                        {isLoadingLoad ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Loading...
                          </>
                        ) : (
                          'Load Configuration'
                        )}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
              <Button onClick={() => { markManifestInstalled(); setShowReinstallWarning(false); setInstallUrl(taggedInstallUrl); setIsInstallOpen(true); }}>
                <Download className="h-4 w-4 mr-2" /> Install
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Import/Export Section */}
      <Suspense fallback={<ConfigurationSectionFallback />}>
        <LazyConfigImportExport />
      </Suspense>

      {isInstallOpen ? (
        <Suspense fallback={null}>
          <LazyInstallDialog isOpen={isInstallOpen} onClose={() => setIsInstallOpen(false)} manifestUrl={installUrl} />
        </Suspense>
      ) : null}
    </div>
  );
}
