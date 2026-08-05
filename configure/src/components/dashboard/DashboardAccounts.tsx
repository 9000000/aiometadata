import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, ChevronRight, LogOut, Trash2, Loader2 } from "lucide-react";
import { useAdmin } from "@/contexts/AdminContext";
import {
  useDashboardAccounts,
  useAccountConfigs,
  useRevokeAccountSessions,
  useDeleteAccount,
  type AccountRow,
  type DashboardTab,
} from "@/hooks/useDashboardQueries";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

function LinkedConfigs({ accountId }: { accountId: string }) {
  const { data, isLoading, isError } = useAccountConfigs(accountId);

  if (isLoading) return <p className="text-xs text-muted-foreground px-4 py-3">Loading configurations…</p>;
  if (isError) return <p className="text-xs text-red-500 px-4 py-3">Could not load configurations.</p>;

  const configs = data?.configs ?? [];
  if (configs.length === 0) {
    return <p className="text-xs text-muted-foreground px-4 py-3">No configurations saved to this account.</p>;
  }

  return (
    <div className="px-4 py-3 space-y-2">
      {configs.map((config) => (
        <div key={config.userUUID} className="flex items-center justify-between gap-3 text-xs">
          <span className="font-medium truncate">{config.label}</span>
          <span className="font-mono text-muted-foreground">{config.userUUID.slice(0, 8)}</span>
          <span className="text-muted-foreground whitespace-nowrap">linked {formatDate(config.linkedAt)}</span>
          <span className="text-muted-foreground whitespace-nowrap">opened {formatDate(config.lastOpenedAt)}</span>
        </div>
      ))}
    </div>
  );
}

export default function DashboardAccounts({ activeTab }: { activeTab: DashboardTab }) {
  const { session } = useAdmin();
  const { data, isLoading, isError, refetch, isFetching } = useDashboardAccounts({ activeTab });
  const revoke = useRevokeAccountSessions();
  const remove = useDeleteAccount();
  const [expanded, setExpanded] = useState<string | null>(null);

  const accounts: AccountRow[] = data?.accounts ?? [];

  const confirmDelete = (account: AccountRow) => {
    const isSelf = session?.accountId === account.accountId;
    const warning = isSelf
      ? `Delete your own account (${account.username})? This signs you out immediately.`
      : `Delete the account ${account.username}?`;
    if (!window.confirm(`${warning}\n\nTheir saved configurations are unlinked but not deleted, and stay reachable by UUID and password.`)) return;

    remove.mutate({ accountId: account.accountId, confirm: isSelf }, {
      onSuccess: () => {
        if (expanded === account.accountId) setExpanded(null);
        toast.success(`Deleted ${account.username}`);
      },
      onError: (error: Error) => toast.error("Could not delete this account", { description: error.message }),
    });
  };

  const confirmRevoke = (account: AccountRow) => {
    const isSelf = session?.accountId === account.accountId;
    const warning = isSelf
      ? "Revoke your own sessions? This signs you out immediately."
      : `Sign ${account.username} out of every device?`;
    if (!window.confirm(warning)) return;

    revoke.mutate(account.accountId, {
      onSuccess: (result: { revoked?: number }) =>
        toast.success(`Signed ${account.username} out of ${result?.revoked ?? 0} session(s)`),
      onError: (error: Error) => toast.error("Could not revoke these sessions", { description: error.message }),
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading accounts…
      </div>
    );
  }

  if (isError && !data) {
    return (
      <Card>
        <CardContent className="py-6 space-y-3">
          <p className="text-sm text-destructive">Couldn't load accounts — the server did not answer.</p>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : null}
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Accounts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {isError && (
          <p className="text-xs text-destructive pb-2">
            Couldn't refresh — showing the last known state.
          </p>
        )}
        {accounts.length === 0 && (
          <p className="text-sm text-muted-foreground">Nobody has signed in with the identity provider yet.</p>
        )}
        {accounts.map((account) => {
          const isSelf = session?.accountId === account.accountId;
          const isOpen = expanded === account.accountId;
          return (
            <div key={account.accountId} className="border rounded-md">
              <div className="flex items-center gap-3 px-3 py-2">
                <button
                  className="text-muted-foreground"
                  onClick={() => setExpanded(isOpen ? null : account.accountId)}
                  aria-label={isOpen ? "Collapse" : "Expand"}
                >
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{account.username}</span>
                    {isSelf && <Badge variant="outline">you</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{account.email || account.subject}</p>
                </div>
                <div className="hidden md:block text-xs text-muted-foreground truncate max-w-[180px]">{account.issuer}</div>
                <Badge variant={account.activeSessions > 0 ? "default" : "outline"}>
                  {account.activeSessions} active
                </Badge>
                <div className="hidden lg:block text-xs text-muted-foreground whitespace-nowrap">
                  seen {formatDate(account.lastSeenAt)}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => confirmRevoke(account)}
                  disabled={revoke.isPending || remove.isPending}
                >
                  {revoke.isPending && revoke.variables === account.accountId
                    ? <Loader2 className="animate-spin" />
                    : <LogOut />}
                  Revoke
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="shrink-0"
                  onClick={() => confirmDelete(account)}
                  disabled={revoke.isPending || remove.isPending}
                >
                  {remove.isPending && remove.variables?.accountId === account.accountId
                    ? <Loader2 className="animate-spin" />
                    : <Trash2 />}
                  Delete
                </Button>
              </div>
              {isOpen && (
                <div className="border-t">
                  <LinkedConfigs accountId={account.accountId} />
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
