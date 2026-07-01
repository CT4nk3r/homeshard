"use client";

import { type DragEvent, type FormEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Link, Loader2, Plus, RefreshCw, Save, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ExtraModSource } from "@/lib/instance-mods";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { InstanceMod, InstanceState } from "@/lib/types";

type CommandStatus = {
  status: "queued" | "claimed" | "succeeded" | "failed";
  error?: string | null;
  result?: { message?: string } | null;
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function ModManager({ instanceId, mods, state }: { instanceId: string; mods: InstanceMod[]; state: InstanceState }) {
  const router = useRouter();
  const initialDisabled = useMemo(
    () => new Set(mods.filter((mod) => !mod.enabled).map((mod) => mod.filename)),
    [mods],
  );
  const [disabled, setDisabled] = useState(initialDisabled);
  const [pending, setPending] = useState<"sync_mods" | "set_instance_mods" | "add_instance_mod" | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [modUrl, setModUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const disabledList = Array.from(disabled).sort();
  const initialDisabledList = Array.from(initialDisabled).sort();
  const changed = disabledList.join("\n") !== initialDisabledList.join("\n");
  const activeCount = mods.length - disabled.size;

  async function queue(kind: "sync_mods" | "set_instance_mods") {
    setPending(kind);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId,
          kind,
          payload: kind === "set_instance_mods" ? { disabled: disabledList } : {},
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not queue mod command");
      if (body.id) await waitForCommand(body.id, kind);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update mods");
    } finally {
      setPending(null);
    }
  }

  async function addMod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("add_instance_mod");
    setMessage(null);
    setError(null);
    try {
      const source = selectedFile ? await stageMod(selectedFile) : urlModSource(modUrl);
      const response = await fetch("/api/instance-mods", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceId, source }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not queue mod install");
      if (body.id) await waitForCommand(body.id, "add_instance_mod");
      setAddOpen(false);
      setModUrl("");
      setSelectedFile(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add mod");
    } finally {
      setPending(null);
    }
  }

  async function waitForCommand(id: string, kind: "sync_mods" | "set_instance_mods" | "add_instance_mod") {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await fetch(`/api/commands?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const command = (await response.json()) as CommandStatus;
      if (!response.ok) throw new Error(command.error ?? "Could not read command status");
      if (command.status === "queued") {
        setMessage("Queued. Waiting for the homeserver agent...");
      } else if (command.status === "claimed") {
        setMessage(
          kind === "sync_mods"
            ? "Scanning mods on the homeserver..."
            : kind === "add_instance_mod"
              ? "Installing the new jar and restarting the instance if needed..."
              : "Moving jars and restarting the instance...",
        );
      } else if (command.status === "succeeded") {
        setMessage(command.result?.message ?? "Mod settings updated.");
        return;
      } else if (command.status === "failed") {
        throw new Error(command.error ?? command.result?.message ?? "Mod command failed");
      }
      await wait(1500);
    }
    throw new Error("Still waiting for the homeserver agent");
  }

  function toggle(filename: string, enabled: boolean) {
    setDisabled((current) => {
      const next = new Set(current);
      if (enabled) {
        next.delete(filename);
      } else {
        next.add(filename);
      }
      return next;
    });
  }

  function onFile(file: File | null) {
    setSelectedFile(file);
    if (file) setModUrl("");
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    onFile(event.dataTransfer.files.item(0));
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <CardTitle>Server mods</CardTitle>
            <CardDescription>Unchecked jars are moved to <span className="font-mono">mods_disabled/</span>; checked jars run from <span className="font-mono">mods/</span>.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{activeCount} enabled</Badge>
            <Badge variant={disabled.size ? "secondary" : "outline"}>{disabled.size} disabled</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!mods.length ? (
          <p className="text-sm text-muted-foreground">No mod inventory has been synced yet. Refresh to scan the instance folders.</p>
        ) : (
          <div className="max-h-[34rem] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Run</TableHead>
                  <TableHead>Jar</TableHead>
                  <TableHead className="w-28 text-right">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mods.map((mod) => {
                  const enabled = !disabled.has(mod.filename);
                  return (
                    <TableRow key={mod.filename}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={Boolean(pending)}
                          onChange={(event) => toggle(mod.filename, event.currentTarget.checked)}
                          className="size-4 rounded border-input"
                          aria-label={`Run ${mod.filename}`}
                        />
                      </TableCell>
                      <TableCell className="whitespace-normal break-all font-mono text-xs">{mod.filename}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{formatBytes(mod.sizeBytes)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={Boolean(pending) || state === "trashed"} onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />Add new mod
          </Button>
          <Button variant="outline" disabled={Boolean(pending)} onClick={() => queue("sync_mods")}>
            {pending === "sync_mods" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Refresh mods
          </Button>
          <Button disabled={Boolean(pending) || !mods.length || !changed || state === "trashed"} onClick={() => queue("set_instance_mods")}>
            {pending === "set_instance_mods" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}Save and restart
          </Button>
        </div>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add new mod</DialogTitle>
            <DialogDescription>Install one server-side <span className="font-mono">.jar</span> into this instance.</DialogDescription>
          </DialogHeader>
          <form onSubmit={addMod} className="space-y-4">
            <div
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center ${dragging ? "border-primary bg-primary/5" : "border-border"}`}
            >
              <Upload className="size-5 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">{selectedFile ? selectedFile.name : "Drop a jar here"}</p>
                <p className="text-xs text-muted-foreground">{selectedFile ? formatBytes(selectedFile.size) : "or choose one from disk"}</p>
              </div>
              <Input
                ref={fileInputRef}
                type="file"
                accept=".jar,application/java-archive"
                className="hidden"
                onChange={(event) => onFile(event.currentTarget.files?.item(0) ?? null)}
              />
              <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={Boolean(pending)}>
                Choose jar
              </Button>
            </div>
            <div className="space-y-2">
              <label htmlFor="modUrl" className="flex items-center gap-1.5 text-sm font-medium"><Link className="size-4" />Direct jar URL</label>
              <Input
                id="modUrl"
                value={modUrl}
                onChange={(event) => {
                  setModUrl(event.currentTarget.value);
                  if (event.currentTarget.value.trim()) setSelectedFile(null);
                }}
                placeholder="https://example.com/mod-name.jar"
                disabled={Boolean(pending)}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={Boolean(pending) || (!selectedFile && !modUrl.trim())}>
                {pending === "add_instance_mod" ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}Add mod
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

async function stageMod(file: File): Promise<ExtraModSource> {
  if (file.size > 128 * 1024 * 1024) throw new Error("Mod exceeds the 128 MB limit");
  if (!file.name.toLowerCase().endsWith(".jar")) throw new Error("Mods must be .jar files");
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/instance-mods/local", { method: "POST", body: form });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Could not stage mod");
  return body;
}

function urlModSource(value: string): ExtraModSource {
  const url = value.trim();
  if (!url) throw new Error("Choose a jar file or paste a direct jar URL");
  const parsed = new URL(url);
  const originalName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
  if (!originalName.toLowerCase().endsWith(".jar")) {
    throw new Error("URL must point directly to a .jar file");
  }
  return { kind: "url", url, originalName };
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
