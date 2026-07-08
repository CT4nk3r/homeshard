"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { InstanceBackup, InstanceState } from "@/lib/types";

type CommandStatus = {
  status: "queued" | "claimed" | "succeeded" | "failed";
  error?: string | null;
  result?: { message?: string } | null;
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const SAFE_STATES: InstanceState[] = ["sleeping", "stopped", "failed"];

export function BackupManager({
  instanceId,
  state,
  worldSeed,
  backups,
}: {
  instanceId: string;
  state: InstanceState;
  worldSeed: string | null;
  backups: InstanceBackup[];
}) {
  const router = useRouter();
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [seed, setSeed] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const safe = SAFE_STATES.includes(state);

  async function queue(kind: "backup_instance" | "regenerate_world" | "restore_backup", payload: Record<string, unknown>) {
    setPending(kind);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceId, kind, payload }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not queue backup command");
      if (body.id) await waitForCommand(body.id);
      setRegenerateOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Backup command failed");
    } finally {
      setPending(null);
    }
  }

  async function waitForCommand(id: string) {
    for (let attempt = 0; attempt < 800; attempt += 1) {
      const response = await fetch(`/api/commands?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const command = (await response.json()) as CommandStatus;
      if (!response.ok) throw new Error(command.error ?? "Could not read command status");
      if (command.status === "queued") setMessage("Queued. Waiting for the homeserver agent...");
      if (command.status === "claimed") setMessage("The homeserver agent is creating and validating the world archive...");
      if (command.status === "succeeded") {
        setMessage(command.result?.message ?? "Backup command completed.");
        return;
      }
      if (command.status === "failed") throw new Error(command.error ?? command.result?.message ?? "Backup command failed");
      await wait(1500);
    }
    throw new Error("The backup command is still running. Check Activity for progress.");
  }

  function regenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void queue("regenerate_world", { seed: seed.trim() || null });
  }

  function restore(backup: InstanceBackup) {
    const confirmed = window.confirm(
      `Restore the ${formatBackupKind(backup.kind)} backup from ${formatDate(backup.createdAt)}? A backup of the current world will be created first.`,
    );
    if (confirmed) void queue("restore_backup", { backupId: backup.id });
  }

  return (
    <div className="overflow-hidden rounded-md border border-[var(--border-muted)] bg-[var(--card)]">
      <div className="flex flex-col justify-between gap-3 border-b border-[var(--border-muted)] px-4 py-3 sm:flex-row sm:items-center">
        <div>
          <p className="text-[13px] font-semibold">World backups</p>
          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">Sleeping instances are backed up daily at 06:00 Europe/Budapest.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!safe || Boolean(pending)} onClick={() => void queue("backup_instance", { backupKind: "manual" })}>
            {pending === "backup_instance" ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />}Back up now
          </Button>
          <Button variant="destructive" size="sm" disabled={!safe || Boolean(pending)} onClick={() => setRegenerateOpen(true)}>
            <RefreshCw className="size-4" />New Seed
          </Button>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        {!safe && <p className="text-sm text-[var(--attention)]">Sleep or stop the server before creating, restoring, or regenerating a world.</p>}
        {backups.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)]">No world backups yet.</p>
        ) : (
          <div className="overflow-auto rounded-md border border-[var(--border-muted)]">
            <Table>
              <TableHeader>
                <TableRow className="border-[var(--border-muted)] bg-[var(--canvas-inset)]">
                  <TableHead>Created</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Seed</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {backups.map((backup) => (
                  <TableRow key={backup.id} className="border-[var(--border-muted)]">
                    <TableCell className="whitespace-nowrap text-xs">{formatDate(backup.createdAt)}</TableCell>
                    <TableCell className="text-xs">{formatBackupKind(backup.kind)}</TableCell>
                    <TableCell className="max-w-52 truncate font-mono text-xs text-[var(--muted-foreground)]">{backup.worldSeed || "random"}</TableCell>
                    <TableCell className="text-right text-xs text-[var(--muted-foreground)]">{formatBytes(backup.sizeBytes)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="xs" disabled={!safe || Boolean(pending)} onClick={() => restore(backup)}>
                        <RotateCcw className="size-3" />Restore
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {message && <p className="text-sm text-[var(--muted-foreground)]">{message}</p>}
        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      </div>

      <Dialog open={regenerateOpen} onOpenChange={setRegenerateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Seed</DialogTitle>
            <DialogDescription>
              The current world will be backed up first, then replaced and the server started. Leave the seed blank for a random world.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={regenerate} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="worldSeed" className="text-sm font-medium">New seed</label>
              <Input id="worldSeed" value={seed} onChange={(event) => setSeed(event.currentTarget.value)} maxLength={128} placeholder="Random seed" disabled={Boolean(pending)} />
              <p className="text-xs text-[var(--muted-foreground)]">Current seed: <span className="font-mono">{worldSeed || "random / unknown"}</span></p>
            </div>
            {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRegenerateOpen(false)} disabled={Boolean(pending)}>Cancel</Button>
              <Button type="submit" variant="destructive" disabled={Boolean(pending)}>
                {pending === "regenerate_world" && <Loader2 className="size-4 animate-spin" />}Back up and regenerate
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatBackupKind(kind: InstanceBackup["kind"]) {
  return ({ scheduled: "Daily", manual: "Manual", pre_regenerate: "Before regeneration", pre_restore: "Before restore" })[kind];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Budapest" }).format(new Date(value));
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}
