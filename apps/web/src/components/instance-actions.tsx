"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Moon, Play, RefreshCw, RotateCcw, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InstanceState } from "@/lib/types";

type CommandStatus = {
  status: "queued" | "claimed" | "succeeded" | "failed";
  error?: string | null;
  result?: { message?: string } | null;
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function InstanceActions({ instanceId, state, disabled = false }: { instanceId: string; state: InstanceState; disabled?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const unavailable = disabled || state === "failed" || state === "deploying" || state === "trashed";

  async function command(kind: string) {
    if (kind === "trash" && !window.confirm("Delete this instance? This stops and removes its managed container, hides it from the dashboard, and moves its files to trash.")) {
      return;
    }
    setPending(kind);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceId, kind }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not queue command");
      if (body.id) await waitForCommand(body.id, kind);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function readCommand(id: string): Promise<CommandStatus> {
    const response = await fetch(`/api/commands?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not read command status");
    return body;
  }

  async function waitForCommand(id: string, kind: string) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const command = await readCommand(id);
      if (command.status === "queued") {
        setNotice(`${kindLabel(kind)} queued. Waiting for the homeserver agent...`);
      } else if (command.status === "claimed") {
        setNotice(`${kindLabel(kind)} is running on the homeserver...`);
      } else if (command.status === "succeeded") {
        setNotice(command.result?.message ?? `${kindLabel(kind)} completed.`);
        return;
      } else if (command.status === "failed") {
        throw new Error(command.error ?? command.result?.message ?? `${kindLabel(kind)} failed`);
      }
      await wait(1500);
    }
    throw new Error(`${kindLabel(kind)} is still waiting for the agent`);
  }

  async function runCommand(kind: string) {
    try {
      await command(kind);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not queue command");
    }
  }

  const action = (kind: string, label: string, icon: React.ReactNode, disabled = false, variant: "outline" | "destructive" = "outline") => (
    <Button key={kind} size="sm" variant={variant} disabled={Boolean(pending) || disabled} onClick={() => runCommand(kind)}>
      {pending === kind ? <Loader2 className="size-3.5 animate-spin" /> : icon}{label}
    </Button>
  );

  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      {state === "failed" && action("retry_deploy", "Retry deployment", <RotateCcw className="size-3.5" />, disabled)}
      {action("start", "Start", <Play className="size-3.5" />, unavailable || state === "running")}
      {action("restart", "Restart", <RefreshCw className="size-3.5" />, unavailable || state !== "running")}
      {action("stop", "Stop", <Square className="size-3.5" />, unavailable || state === "stopped" || state === "sleeping")}
      {action("sleep", "Sleep", <Moon className="size-3.5" />, unavailable || state !== "running")}
      {action("trash", "Delete", <Trash2 className="size-3.5" />, disabled || state === "trashed", "destructive")}
    </div>
    {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
    {error && <p className="text-xs text-destructive">{error}</p>}
  </div>;
}

function kindLabel(kind: string) {
  return kind
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
