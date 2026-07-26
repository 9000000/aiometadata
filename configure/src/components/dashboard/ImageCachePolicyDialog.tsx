import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, Loader2, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  usePosterCacheStats,
  usePurgePosterCache,
  useUpdateSetting,
} from "@/hooks/useDashboardQueries";
import {
  applyChange,
  buildPolicyRules,
  describeDays,
  inheritedPolicy,
  isValidDomain,
  normalizeDomain,
  pendingChanges,
  rowProblem,
  rowsFromRules,
  type PolicyFormState,
  type PolicyRow,
  type ProviderPolicyRule,
  type TtlPolicy,
} from "@/lib/providerPolicyRules";

const POLICY_LABELS: Record<TtlPolicy, string> = {
  default: "Default",
  infer: "Follow source",
  custom: "Custom",
  bypass: "Never store",
};

/** What each policy does, stated rather than measured off the cache. */
function explain(policy: TtlPolicy, ttl: string, flat: string | null): string {
  switch (policy) {
    case "default":
      return flat
        ? `Kept ${flat} — the validity set above.`
        : "Kept for the validity set above.";
    case "infer":
      return "Follows the Cache-Control this source sends with each image. Where it promises nothing "
        + "usable the flat validity still applies, and a source asking not to be cached at all is served "
        + "without being stored.";
    case "custom":
      return ttl.trim()
        ? `Every image from this provider is kept ${ttl.trim()}, whatever its own headers say.`
        : "Enter a duration — 30s, 15m, 12h, 30d, 2w or 1y.";
    case "bypass":
      return "Served straight through and never stored. Anything already cached for this provider stays "
        + "on disk until it is purged.";
  }
}

export function ImageCachePolicyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // The query the Image Cache card already runs, so opening this costs nothing.
  const statsQuery = usePosterCacheStats({ activeTab: "operations" });
  const updateSetting = useUpdateSetting();
  const purgeMutation = usePurgePosterCache();

  const [rows, setRows] = useState<PolicyRow[]>([]);
  const [infer, setInfer] = useState(false);
  const [flatDays, setFlatDays] = useState("");
  const [baseline, setBaseline] = useState<PolicyFormState | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [purgingDomain, setPurgingDomain] = useState<string | null>(null);
  const [confirmingDomain, setConfirmingDomain] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const data = statsQuery.data as {
    known_providers?: Array<{ domain: string; group: "source" | "rating" }>;
    provider_policies?: ProviderPolicyRule[];
    infer_ttl?: boolean;
    ttl_days?: number;
    domain_purge?: { domain: string; running: boolean; removed: number } | null;
  } | null | undefined;

  const saved = useMemo(() => data?.provider_policies ?? [], [data]);
  const providers = useMemo(() => data?.known_providers ?? [], [data]);
  const known = useMemo(() => providers.map((p) => p.domain), [providers]);
  // Grouping comes from the backend alongside the list, so the two cannot drift.
  const groupOf = useMemo(
    () => new Map(providers.map((p) => [p.domain, p.group])),
    [providers]
  );

  // Seeded once per opening, so the card's polling cannot wipe an edit in progress.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current || !data) return;
    seeded.current = true;
    const inferEnabled = !!data.infer_ttl;
    const days = String(data.ttl_days ?? 30);

    setInfer(inferEnabled);
    setFlatDays(days);
    setRows(rowsFromRules(saved, known, inferEnabled));
    // What Save diffs against, so only what you actually moved is written.
    setBaseline({ flatDays: days, infer: inferEnabled, rules: saved });
    setShowHelp(false);
    setNewDomain("");
  }, [open, data, saved, known]);

  /** Flipping the master toggle re-displays inherited rows; explicit ones are untouched. */
  const setInferToggle = (next: boolean) => {
    setInfer(next);
    setRows((current) => current.map((row) => (row.explicit
      ? row
      : { ...row, policy: inheritedPolicy(next) })));
  };

  const updateRow = (domain: string, patch: Partial<PolicyRow>) => {
    setRows((current) => current.map((row) => (row.domain === domain ? { ...row, ...patch } : row)));
  };

  const resetRow = (domain: string) =>
    updateRow(domain, { explicit: false, policy: inheritedPolicy(infer), ttl: "" });

  const removeRow = (domain: string) =>
    setRows((current) => current.filter((row) => row.domain !== domain));

  const addDomain = () => {
    const domain = normalizeDomain(newDomain);
    if (!domain) return;
    if (!isValidDomain(domain)) {
      toast.error("Not a domain", { description: `"${newDomain.trim()}" does not look like a hostname.` });
      return;
    }
    if (rows.some((row) => row.domain === domain)) {
      toast.info("Already listed", { description: `${domain} is already in the list below.` });
      setNewDomain("");
      return;
    }
    setRows((current) => [...current, {
      domain, builtIn: false, explicit: true, policy: "infer", ttl: "",
    }]);
    setNewDomain("");
  };

  const flatEcho = describeDays(flatDays);
  const current: PolicyFormState = { flatDays, infer, rules: buildPolicyRules(rows) };
  const changes = baseline ? pendingChanges(current, baseline) : [];
  const blocked = rows.some((row) => rowProblem(row) !== null) || flatEcho === null;

  const handleSave = async () => {
    setSaving(true);
    const applied: string[] = [];
    // Advanced as each write lands, so a retry after a partial failure asks only
    // for what is still outstanding and Save disables itself once nothing is.
    let landed = baseline!;

    for (const change of changes) {
      try {
        await updateSetting.mutateAsync({ key: change.key, value: change.value });
        applied.push(change.label);
        landed = applyChange(landed, change);
        setBaseline(landed);
      } catch (error: any) {
        // Stop at the first failure and say exactly how far we got — reporting
        // "Saved" having stored part of the intent would be a lie.
        setSaving(false);
        toast.error(applied.length === 0 ? "Nothing was saved" : "Partly saved", {
          description: applied.length === 0
            ? `${change.label} could not be stored: ${error?.message || "unknown error"}.`
            : `Saved ${applied.join(" and ")}, but ${change.label} did not apply: ${error?.message || "unknown error"}.`,
        });
        return;
      }
    }

    setSaving(false);
    const count = current.rules.length;
    toast.success("Image cache policies saved", {
      description: count === 0
        ? "No per-provider rules. Every provider uses the default validity above."
        : `${count} provider rule${count === 1 ? "" : "s"} in effect, applied to images already cached on their next request.`,
    });
    statsQuery.refetch();
    onOpenChange(false);
  };

  /**
   * Only the row actually being purged spins. The backend's own status keeps it
   * spinning across a reload or a second admin's session, since the walk outlives
   * the request that started it.
   */
  const purgingRow = (domain: string) =>
    purgingDomain === domain
    || (!!data?.domain_purge?.running && data.domain_purge.domain === domain);

  const runPurge = (domain: string) => {
    setConfirmingDomain(null);
    setPurgingDomain(domain);
    // The purge runs in the background — the response says it started, not what it
    // removed. The count arrives with the card's next stats poll.
    purgeMutation.mutate({ domain }, {
      onSuccess: () => toast.success("Purge started", {
        description: `Removing everything cached for ${domain}. On a large cache this takes a while; the Image Cache card shows the count when it finishes.`,
      }),
      onError: (error) => toast.error("Purge failed", { description: error.message }),
      onSettled: () => setPurgingDomain(null),
    });
  };

  const groups: Array<{ title: string; rows: PolicyRow[] }> = [
    { title: "Image sources", rows: rows.filter((r) => groupOf.get(r.domain) === "source") },
    { title: "Rating & overlay services", rows: rows.filter((r) => groupOf.get(r.domain) === "rating") },
    { title: "Your domains", rows: rows.filter((r) => !groupOf.has(r.domain)) },
  ];

  const renderRow = (row: PolicyRow) => {
    const problem = rowProblem(row);
    return (
      <div
        key={row.domain}
        className={`rounded-md px-2 py-1.5 ${row.explicit ? "border-l-2 border-primary/60 bg-muted/30" : "border-l-2 border-transparent"}`}
      >
        <div className="flex items-center gap-3">
          <span className="flex-1 min-w-0 truncate font-mono text-sm" title={row.domain}>
            {row.domain}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <Select
              value={row.policy}
              onValueChange={(policy) => updateRow(row.domain, { explicit: true, policy: policy as TtlPolicy })}
            >
              <SelectTrigger className="w-[150px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(POLICY_LABELS) as TtlPolicy[]).map((policy) => (
                  <SelectItem key={policy} value={policy}>{POLICY_LABELS[policy]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {row.policy === "custom" && (
              <Input
                className={`w-[92px] h-9 ${problem ? "border-red-500/60" : ""}`}
                placeholder="12h"
                value={row.ttl}
                aria-label={`Cache duration for ${row.domain}`}
                onChange={(e) => updateRow(row.domain, { explicit: true, ttl: e.target.value })}
              />
            )}
            {row.builtIn ? (
              <Button
                variant="ghost" size="sm" className="h-9 w-9 p-0"
                aria-label={`Reset ${row.domain} to the default policy`}
                disabled={!row.explicit}
                onClick={() => resetRow(row.domain)}
              >
                <RotateCcw className={`h-3.5 w-3.5 ${row.explicit ? "" : "opacity-0"}`} />
              </Button>
            ) : (
              <Button
                variant="ghost" size="sm" className="h-9 w-9 p-0"
                aria-label={`Remove the rule for ${row.domain}`}
                onClick={() => removeRow(row.domain)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Only rows you actually changed explain themselves — eleven paragraphs
            of help is worse than none. */}
        {row.explicit && (
          <div className="pl-1 pr-10 pt-1 space-y-1">
            <p className={`text-xs ${problem ? "text-red-500" : "text-muted-foreground"}`}>
              {problem || explain(row.policy, row.ttl, flatEcho)}
            </p>
            {row.policy === "bypass" && (
              <Button
                variant="ghost" size="sm"
                className="h-7 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                disabled={purgingRow(row.domain)}
                onClick={() => setConfirmingDomain(row.domain)}
              >
                {purgingRow(row.domain) ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <><Trash2 className="h-3.5 w-3.5 mr-1.5" />Purge them now</>
                )}
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* No inner scroll container: DialogContent already scrolls, and nesting one
          clips the focus ring on every row — `overflow-y: auto` forces the other
          axis to clip too. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Per-provider cache policies</DialogTitle>
          <DialogDescription>
            Overrides how one provider's images are cached, leaving the rest alone. A domain
            covers its subdomains. Changes apply to images already cached, on their next request.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border p-3 space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Default validity
          </p>

          <div className="flex items-center gap-3">
            <Label htmlFor="ttl-flat" className="flex-1 min-w-0 text-sm font-normal">
              Cache validity
            </Label>
            <Input
              id="ttl-flat"
              inputMode="decimal"
              className={`w-[84px] h-9 shrink-0 ${flatEcho === null ? "border-red-500/60" : ""}`}
              value={flatDays}
              onChange={(e) => setFlatDays(e.target.value)}
            />
            <span className={`w-[104px] shrink-0 text-xs ${flatEcho === null ? "text-red-500" : "text-muted-foreground"}`}>
              {flatEcho ?? "not a number"}
            </span>
          </div>

          <div className="flex items-center justify-between gap-3 pt-3 border-t">
            <Label htmlFor="infer-ttl" className="flex-1 min-w-0 text-sm font-normal">
              Follow each source's own validity
              <span className="block text-xs text-muted-foreground mt-0.5">
                Applies to every provider without a rule of its own below.
              </span>
            </Label>
            <Switch id="infer-ttl" checked={infer} onCheckedChange={setInferToggle} />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${showHelp ? "rotate-90" : ""}`} />
          What do these mean?
        </button>
        {showHelp && (
          <dl className="text-xs text-muted-foreground space-y-1.5 pl-5">
            {(Object.keys(POLICY_LABELS) as TtlPolicy[]).map((policy) => (
              <div key={policy}>
                <dt className="inline font-medium text-foreground">{POLICY_LABELS[policy]}: </dt>
                <dd className="inline">{explain(policy, "12h", flatEcho)}</dd>
              </div>
            ))}
          </dl>
        )}

        {groups.map((group) => group.rows.length > 0 && (
          <div key={group.title}>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
              {group.title}
            </p>
            <div className="space-y-0.5">{group.rows.map(renderRow)}</div>
          </div>
        ))}

        <div className="flex items-center gap-2">
          <Input
            placeholder="Add another domain…"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDomain(); } }}
            className="h-9"
          />
          <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={addDomain}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={handleSave} disabled={saving || blocked || changes.length === 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save policies"}
          </Button>
        </DialogFooter>

        <AlertDialog
          open={confirmingDomain !== null}
          onOpenChange={(next) => { if (!next) setConfirmingDomain(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove every cached image for {confirmingDomain}?</AlertDialogTitle>
              <AlertDialogDescription>
                They will not be re-cached while this provider is set to never store.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => runPurge(confirmingDomain!)}>Purge</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
