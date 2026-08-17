import React, { useCallback, useEffect, useState } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { createTvdbListCatalogs, TvdbListPreview } from '@/utils/catalogUtils';

interface TVDBListIntegrationProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TvdbListSummary {
  id: number;
  name: string;
  overview?: string;
  slug?: string;
  image?: string;
  isOfficial?: boolean;
  url?: string;
  movieCount?: number;
  seriesCount?: number;
  itemCount?: number;
}

function listContents(list: { movieCount?: number; seriesCount?: number }): string {
  const parts: string[] = [];
  if (list.movieCount) parts.push(`${list.movieCount} ${list.movieCount === 1 ? 'movie' : 'movies'}`);
  if (list.seriesCount) parts.push(`${list.seriesCount} ${list.seriesCount === 1 ? 'series' : 'series'}`);
  return parts.join(' · ');
}

export function TVDBListIntegration({ isOpen, onClose }: TVDBListIntegrationProps) {
  const { config, setConfig, catalogTTL, auth } = useConfig();

  const [listInput, setListInput] = useState('');
  const [preview, setPreview] = useState<TvdbListPreview | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [splitMode, setSplitMode] = useState<'all' | 'split'>('all');
  const [cacheTTL, setCacheTTL] = useState<number>(catalogTTL);

  const [searchQuery, setSearchQuery] = useState('');
  const [browseResults, setBrowseResults] = useState<TvdbListSummary[]>([]);
  const [browsePage, setBrowsePage] = useState(0);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isSearchResults, setIsSearchResults] = useState(false);

  const tvdbListCatalogs = config.catalogs.filter(c => c.id.startsWith('tvdb.list.'));

  const queryParams = useCallback((extra: Record<string, string>) => {
    const params = new URLSearchParams(extra);
    if (config.apiKeys?.tvdb) params.set('apikey', config.apiKeys.tvdb);
    if (auth?.userUUID) params.set('userUUID', auth.userUUID);
    return params.toString();
  }, [config.apiKeys?.tvdb, auth?.userUUID]);

  const loadBrowsePage = useCallback(async (page: number) => {
    setIsBrowsing(true);
    try {
      const res = await fetch(`/api/tvdb/lists?${queryParams({ page: String(page) })}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load lists');
      setBrowseResults(data.results || []);
      setBrowsePage(page);
      setIsSearchResults(false);
    } catch (error: any) {
      toast.error('Could not load TheTVDB lists', { description: error.message });
    } finally {
      setIsBrowsing(false);
    }
  }, [queryParams]);

  useEffect(() => {
    if (!isOpen || browseResults.length > 0) return;
    loadBrowsePage(0);
  }, [isOpen, browseResults.length, loadBrowsePage]);

  const handleSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query) {
      loadBrowsePage(0);
      return;
    }
    setIsBrowsing(true);
    try {
      const res = await fetch(`/api/tvdb/lists/search?${queryParams({ query })}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      setBrowseResults(data.results || []);
      setIsSearchResults(true);
      if (!data.results?.length) {
        toast.info('No lists matched that search');
      }
    } catch (error: any) {
      toast.error('Search failed', { description: error.message });
    } finally {
      setIsBrowsing(false);
    }
  }, [searchQuery, queryParams, loadBrowsePage]);

  const resolveList = useCallback(async (input: string) => {
    if (!input.trim()) {
      toast.error('Enter a list slug, id or thetvdb.com link');
      return;
    }
    setIsResolving(true);
    setPreview(null);
    try {
      const res = await fetch(`/api/tvdb/lists/resolve?${queryParams({ input: input.trim() })}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not resolve that list');
      setPreview(data);
      setSplitMode('all');
    } catch (error: any) {
      toast.error('Could not load that list', { description: error.message });
    } finally {
      setIsResolving(false);
    }
  }, [queryParams]);

  const handleAdd = useCallback(() => {
    if (!preview) return;

    const catalogs = createTvdbListCatalogs({
      list: preview,
      mode: splitMode,
      cacheTTL,
      displayTypeOverrides: config.displayTypeOverrides,
    });

    if (!catalogs.length) {
      toast.error('That list has no movies or series in it');
      return;
    }

    const existing = new Set(config.catalogs.map(c => `${c.id}:${c.type}`));
    const fresh = catalogs.filter(c => !existing.has(`${c.id}:${c.type}`));
    if (!fresh.length) {
      toast.error('List already added', { description: 'This TheTVDB list is already in your catalogs' });
      return;
    }

    setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, ...fresh] }));
    toast.success(fresh.length > 1 ? 'Lists added' : 'List added', {
      description: `${preview.name} (${preview.itemCount} items) is now in your catalogs`,
    });

    setPreview(null);
    setListInput('');
  }, [preview, splitMode, cacheTTL, config.catalogs, config.displayTypeOverrides, setConfig]);

  const handleRemove = useCallback((catalogId: string, catalogType: string) => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => !(c.id === catalogId && c.type === catalogType)),
    }));
    toast.success('List removed');
  }, [setConfig]);

  const isMixed = !!preview && preview.movieCount > 0 && preview.seriesCount > 0;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <img src="/tvdb_icon.png" alt="TheTVDB" className="h-6 w-6 object-contain" />
            <DialogTitle>TheTVDB Lists</DialogTitle>
          </div>
          <DialogDescription>
            Add a TheTVDB list as its own catalog, by slug or by picking one from the site
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          <Tabs defaultValue="slug" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="slug">By slug or link</TabsTrigger>
              <TabsTrigger value="browse">Browse lists</TabsTrigger>
            </TabsList>

            <TabsContent value="slug" className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="tvdb-list-input">List slug, id or URL</Label>
                <div className="flex gap-2">
                  <Input
                    id="tvdb-list-input"
                    placeholder="star-wars"
                    value={listInput}
                    onChange={(e) => setListInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') resolveList(listInput); }}
                    disabled={isResolving}
                  />
                  <Button onClick={() => resolveList(listInput)} disabled={!listInput.trim() || isResolving}>
                    {isResolving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Look up'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground break-all">
                  Accepts a slug (star-wars), a numeric list id, or a full https://thetvdb.com/lists/star-wars link.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="browse" className="space-y-4 pt-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Search lists by name"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
                  disabled={isBrowsing}
                />
                <Button variant="secondary" onClick={handleSearch} disabled={isBrowsing}>
                  {isBrowsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </Button>
              </div>

              <div className="min-h-[26rem] max-h-[26rem] overflow-y-auto pr-1">
                {isBrowsing && !browseResults.length ? (
                  <div className="flex items-center justify-center h-96 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading lists
                  </div>
                ) : browseResults.length ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                    {browseResults.map(list => {
                      const selected = preview?.id === list.id;
                      return (
                        <button
                          key={list.id}
                          type="button"
                          onClick={() => resolveList(list.slug || String(list.id))}
                          title={list.overview || list.name}
                          className={`group flex flex-col text-left rounded-lg border overflow-hidden transition-colors ${
                            selected ? 'border-primary ring-1 ring-primary' : 'hover:border-muted-foreground/40'
                          }`}
                        >
                          <div className="relative aspect-[2/3] bg-muted">
                            {list.image ? (
                              <img
                                src={list.image}
                                alt=""
                                loading="lazy"
                                className="absolute inset-0 h-full w-full object-cover"
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted-foreground">
                                {list.name}
                              </div>
                            )}
                            {list.isOfficial && (
                              <Badge variant="secondary" className="absolute top-1 left-1 text-[10px] px-1.5 py-0">
                                Official
                              </Badge>
                            )}
                          </div>
                          <div className="p-2 space-y-0.5">
                            <div className="text-sm font-medium leading-tight line-clamp-2">{list.name}</div>
                            <div className="text-[11px] text-muted-foreground">{listContents(list) || 'Empty'}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground py-6 text-center">No lists to show</p>
                )}
              </div>

              {!isSearchResults && (
                <div className="flex items-center justify-between">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => loadBrowsePage(Math.max(0, browsePage - 1))}
                    disabled={browsePage === 0 || isBrowsing}
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" /> Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">Page {browsePage + 1}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => loadBrowsePage(browsePage + 1)}
                    disabled={isBrowsing || browseResults.length === 0}
                  >
                    Next <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>

          {preview && (
            <Card>
              <CardContent className="flex flex-col sm:flex-row gap-5 pt-6">
                {preview.image && (
                  <img
                    src={preview.image}
                    alt=""
                    className="w-32 shrink-0 self-start rounded border object-cover"
                  />
                )}
                <div className="min-w-0 flex-1 space-y-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-semibold break-words">{preview.name}</h3>
                    {preview.isOfficial && <Badge variant="secondary">Official</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {listContents(preview) || 'Empty'}
                  </p>
                </div>
                {preview.overview && (
                  <p className="text-sm text-muted-foreground line-clamp-4">{preview.overview}</p>
                )}

                {isMixed ? (
                  <div className="space-y-2">
                    <Label htmlFor="tvdb-list-mode">Catalog layout</Label>
                    <Select value={splitMode} onValueChange={(v) => setSplitMode(v as 'all' | 'split')}>
                      <SelectTrigger id="tvdb-list-mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">One row with movies and series together</SelectItem>
                        <SelectItem value="split">Separate movie and series rows</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 p-3 bg-muted/40 border rounded-lg">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">
                      This list holds only {preview.movieCount > 0 ? 'movies' : 'series'}, so it becomes a single catalog.
                    </p>
                  </div>
                )}

                <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                  <div className="space-y-2 flex-1">
                    <Label htmlFor="tvdb-list-ttl">Cache TTL (seconds)</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="tvdb-list-ttl"
                        type="number"
                        min={0}
                        step={3600}
                        value={cacheTTL}
                        onChange={(e) => setCacheTTL(parseInt(e.target.value) || catalogTTL)}
                      />
                      <span className="text-sm text-muted-foreground whitespace-nowrap">
                        ({Math.floor(cacheTTL / 3600)}h {Math.floor((cacheTTL % 3600) / 60)}m)
                      </span>
                    </div>
                  </div>
                  <Button className="sm:w-44" onClick={handleAdd}>
                    Add to catalogs
                  </Button>
                </div>
                </div>
              </CardContent>
            </Card>
          )}

          {tvdbListCatalogs.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Your TheTVDB lists</CardTitle>
                <CardDescription>{tvdbListCatalogs.length} added</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2">
                {tvdbListCatalogs.map(catalog => (
                  <div
                    key={`${catalog.id}:${catalog.type}`}
                    className="flex items-center justify-between gap-2 p-3 border rounded-lg bg-muted/30"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium break-words">{catalog.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {catalog.type === 'all' ? 'Movies and series' : catalog.type === 'movie' ? 'Movies' : 'Series'}
                        {catalog.metadata?.itemCount ? ` · ${catalog.metadata.itemCount} items` : ''}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={() => handleRemove(catalog.id, catalog.type)}
                      aria-label={`Remove ${catalog.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
