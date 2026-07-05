"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, ExternalLink, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

const STATUS_CLS: Record<CommandStatus, string> = {
  queued:    "text-[var(--attention)]  bg-[var(--attention-muted)]  border-[rgba(210,153,34,0.4)]",
  claimed:   "text-[var(--attention)]  bg-[var(--attention-muted)]  border-[rgba(210,153,34,0.4)]",
  succeeded: "text-[var(--success)]    bg-[var(--success-muted)]    border-[rgba(63,185,80,0.4)]",
  failed:    "text-[var(--danger)]     bg-[var(--danger-muted)]     border-[rgba(248,81,73,0.4)]",
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
        if (!cancelled) { setCommands(body.commands ?? []); setError(null); }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not read command activity");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const interval = window.setInterval(load, 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
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
    <div className="overflow-hidden rounded-md border border-[var(--border-muted)] bg-[var(--card)]">
      {/* header */}
      <div className="flex items-center justify-between border-b border-[var(--border-muted)] px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-[var(--muted-foreground)]" />
          <span className="text-[13px] font-semibold">Activity</span>
          {loading && <Loader2 className="size-3.5 animate-spin text-[var(--muted-foreground)]" />}
        </div>
        {latest && (
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CLS[latest.status]}`}>
            <span className="size-1.5 rounded-full bg-current" />
            {latest.status}
          </span>
        )}
      </div>

      <div className="space-y-4 px-4 py-4">
        {latestDescription && (
          <p className="text-xs text-[var(--muted-foreground)]">{latestDescription}</p>
        )}

        {error && (
          <div className="rounded-md border border-[rgba(248,81,73,0.4)] bg-[var(--danger-muted)] px-3 py-2 text-xs text-[var(--danger)]">
            {error}
          </div>
        )}

        {/* blocked mods alert */}
        {blockedMods.length > 0 && (
          <div className="rounded-md border border-[rgba(248,81,73,0.4)] bg-[var(--danger-muted)] px-4 py-3 space-y-3">
            <p className="text-[13px] font-semibold text-[var(--danger)]">Manual CurseForge download required</p>
            <p className="text-xs text-[var(--danger)]">
              CurseForge blocks automatic download of {blockedMods.length === 1 ? "this file" : `these ${blockedMods.length} files`}
              {" "}because the author disabled third-party downloads. Download {blockedMods.length === 1 ? "it" : "each one"} from CurseForge,
              then upload the file{blockedMods.length === 1 ? "" : "s"} here so the next deploy can finish.
            </p>
            <ul className="space-y-2">
              {blockedMods.map((mod) => (
                <li key={mod.url} className="space-y-1 rounded-md border border-[rgba(248,81,73,0.3)] bg-[var(--canvas)] p-2 text-xs">
                  <p className="break-all font-mono text-[var(--danger)]">{mod.filename}</p>
                  <p className="break-all">
                    <a className="inline-flex items-center gap-1 text-[var(--link)] underline" href={mod.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-3" />{mod.url}
                    </a>
                  </p>
                  {mod.sha1 && <p className="font-mono text-[var(--muted-foreground)]">Expected SHA-1: {mod.sha1}</p>}
                </li>
              ))}
            </ul>
            <form action={uploadMissingMods} className="flex flex-col gap-2 sm:flex-row">
              <Input name="missingMods" type="file" accept=".jar,.zip" multiple disabled={uploading} className="bg-[var(--canvas)]" />
              <Button type="submit" variant="secondary" disabled={uploading}>
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                Upload file{blockedMods.length === 1 ? "" : "s"}
              </Button>
            </form>
            {uploadMessage && <p className="text-xs text-[var(--muted-foreground)]">{uploadMessage}</p>}
          </div>
        )}

        {/* command table */}
        {commands.length > 0 && (
          <div className="overflow-auto rounded-md border border-[var(--border-muted)]">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border-muted)] text-left text-[var(--muted-foreground)]">
                  <th className="px-3 py-2 font-medium">Command</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="hidden px-3 py-2 font-medium sm:table-cell">Timing</th>
                  <th className="px-3 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-muted)]">
                {commands.map((cmd) => (
                  <tr key={cmd.id} className="align-top">
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{cmd.kind}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${STATUS_CLS[cmd.status]}`}>
                        <span className="size-1.5 rounded-full bg-current" />
                        {cmd.status}
                      </span>
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 text-[var(--muted-foreground)] sm:table-cell">{timing(cmd)}</td>
                    <td className="min-w-[18rem] break-words px-3 py-2 text-[var(--muted-foreground)]">{detail(cmd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && commands.length === 0 && !error && (
          <p className="text-sm text-[var(--text-faint)]">No command history is available.</p>
        )}
      </div>
    </div>
  );
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
    if (blocked.length) return `${blocked.length} CurseForge mod${blocked.length === 1 ? "" : "s"} need a manual download — see the panel above.`;
  }
  if (command.error) return tidyErrorMessage(command.error);
  if (command.result?.message) return tidyErrorMessage(command.result.message);
  if (command.status === "claimed" && (command.kind === "create_instance" || command.kind === "retry_deploy")) {
    return "Importing/resolving the pack, copying server files, or launching Docker.";
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
