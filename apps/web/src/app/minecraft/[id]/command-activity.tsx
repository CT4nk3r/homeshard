"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, ExternalLink, Loader2, Upload } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { blockedModsSummary, parseBlockedMods, tidyErrorMessage, type BlockedMod } from "@/lib/blocked-mods";

type CommandStatus = "queued" | "claimed" | "succeeded" | "failed";

type CommandActivityItem = {
  id: string;
  kind: string;
  status: CommandStatus;
  error?: string | null;
  result?: { message?: string } | null;
  claimedBy?: string | null;
  createdAt?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
};

type CommandActivityResponse = {
  commands?: CommandActivityItem[];
  error?: string;
};

export function CommandActivity({ instanceId }: { instanceId: string }) {
  const [commands, setCommands] = useState<CommandActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`/api/commands?instanceId=${encodeURIComponent(instanceId)}`, { cache: "no-store" });
        const body = (await response.json()) as CommandActivityResponse;
        if (!response.ok) throw new Error(body.error ?? "Could not read command activity");
        if (!cancelled) {
          setCommands(body.commands ?? []);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not read command activity");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const interval = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [instanceId]);

  const latest = commands[0];
  const latestDescription = useMemo(() => {
    if (!latest) return "No commands have been queued for this instance yet.";
    return describeCommand(latest);
  }, [latest]);
  const blockedMods = useMemo(() => {
    for (const command of commands) {
      const parsed = blockedModsForCommand(command);
      if (parsed.length) return parsed;
    }
    return [] as BlockedMod[];
  }, [commands]);

  async function uploadMissingMods(formData: FormData) {
    setUploading(true);
    setUploadMessage(null);
    try {
      const files = formData.getAll("missingMods").filter((file) => file instanceof File && file.size > 0);
      if (!files.length) throw new Error("Choose the downloaded .jar or .zip file first.");
      const uploadForm = new FormData();
      for (const file of files) uploadForm.append("files", file);
      const response = await fetch("/api/missing-mods", { method: "POST", body: uploadForm });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not upload missing mods");
      const uploaded = Array.isArray(body.uploaded) ? body.uploaded.length : files.length;
      setUploadMessage(`Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}. Retry deployment to use them.`);
    } catch (caught) {
      setUploadMessage(caught instanceof Error ? caught.message : "Could not upload missing mods");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <CardTitle className="flex items-center gap-2"><Activity className="size-5" />Activity</CardTitle>
            <CardDescription>{latestDescription}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            {latest && <StatusBadge status={latest.status} />}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
        {blockedMods.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Manual CurseForge download required</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                CurseForge blocks automatic download of {blockedMods.length === 1 ? "this file" : `these ${blockedMods.length} files`}
                because the author disabled third-party downloads. Download {blockedMods.length === 1 ? "it" : "each one"} from CurseForge, then upload
                the file{blockedMods.length === 1 ? "" : "s"} here so the next deploy can finish.
              </p>
              <ul className="space-y-2">
                {blockedMods.map((mod) => (
                  <li key={mod.url} className="space-y-1 rounded-md border border-destructive/30 p-2 text-xs">
                    <p className="break-all font-mono">{mod.filename}</p>
                    <p className="break-all">
                      <a className="inline-flex items-center gap-1 underline" href={mod.url} target="_blank" rel="noreferrer">
                        <ExternalLink className="size-3" />{mod.url}
                      </a>
                    </p>
                    {mod.sha1 && <p className="font-mono text-muted-foreground">Expected SHA-1: {mod.sha1}</p>}
                  </li>
                ))}
              </ul>
              <form action={uploadMissingMods} className="flex flex-col gap-2 sm:flex-row">
                <Input name="missingMods" type="file" accept=".jar,.zip" multiple disabled={uploading} />
                <Button type="submit" variant="secondary" disabled={uploading}>
                  {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  Upload file{blockedMods.length === 1 ? "" : "s"}
                </Button>
              </form>
              {uploadMessage && <p className="text-xs">{uploadMessage}</p>}
            </AlertDescription>
          </Alert>
        )}
        {!commands.length ? (
          <p className="text-sm text-muted-foreground">No command history is available.</p>
        ) : (
          <div className="overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Command</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Timing</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commands.map((command) => (
                  <TableRow key={command.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{command.kind}</TableCell>
                    <TableCell><StatusBadge status={command.status} /></TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{timing(command)}</TableCell>
                    <TableCell className="min-w-72 whitespace-normal break-words text-xs text-muted-foreground">{detail(command)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: CommandStatus }) {
  const variant = status === "failed" ? "destructive" : status === "succeeded" ? "outline" : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

function blockedModsForCommand(command: CommandActivityItem): BlockedMod[] {
  if (command.status !== "failed") return [];
  return parseBlockedMods(`${command.error ?? ""}\n${command.result?.message ?? ""}`);
}

function describeCommand(command: CommandActivityItem) {
  if (command.status === "failed") {
    const blocked = blockedModsForCommand(command);
    if (blocked.length) return blockedModsSummary(blocked.length, "here");
    return tidyErrorMessage(command.error ?? command.result?.message) || `${command.kind} failed.`;
  }
  if (command.status === "succeeded") return command.result?.message ?? `${command.kind} completed.`;
  if (command.status === "queued") return `${command.kind} is queued for the homeserver agent.`;
  if (command.kind === "create_instance" || command.kind === "retry_deploy") {
    return "The homeserver agent is deploying this instance. CurseForge packs may need a manual mod download if the author blocked automatic downloads.";
  }
  return `${command.kind} is running on the homeserver agent.`;
}

function detail(command: CommandActivityItem) {
  if (command.status === "failed") {
    const blocked = blockedModsForCommand(command);
    if (blocked.length) {
      return `${blocked.length} CurseForge mod${blocked.length === 1 ? "" : "s"} need a manual download — see the panel above.`;
    }
  }
  if (command.error) return tidyErrorMessage(command.error);
  if (command.result?.message) return tidyErrorMessage(command.result.message);
  if (command.status === "claimed" && (command.kind === "create_instance" || command.kind === "retry_deploy")) {
    return "Importing/resolving the pack, copying server files, or launching Docker. Check the server container logs if this sits here for a while.";
  }
  if (command.status === "queued") return "Waiting for the homeserver agent to claim it.";
  return command.claimedBy ? `Claimed by ${command.claimedBy}.` : "-";
}

function timing(command: CommandActivityItem) {
  if (command.completedAt) return `completed ${relativeTime(command.completedAt)}`;
  if (command.claimedAt) return `claimed ${relativeTime(command.claimedAt)}`;
  if (command.createdAt) return `queued ${relativeTime(command.createdAt)}`;
  return "-";
}

function relativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "recently";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
