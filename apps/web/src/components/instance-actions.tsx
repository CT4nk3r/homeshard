"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Moon, Play, RefreshCw, RotateCcw, Square, Trash2 } from "lucide-react";
import type { InstanceState } from "@/lib/types";

type CommandStatus = {
  status: "queued" | "claimed" | "succeeded" | "failed";
  error?: string | null;
  result?: { message?: string } | null;
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const BASE =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50";

const BTN = {
  default: `${BASE} border-[var(--border-interactive)] bg-[var(--card)] text-foreground hover:bg-[var(--panel-hover)]`,
  danger:  `${BASE} border-[rgba(248,81,73,0.4)] bg-[var(--danger-muted)] text-[var(--danger)] hover:border-[var(--danger)]`,
};

export function InstanceActions({
  instanceId,
  state,
  disabled = false,
}: {
  instanceId: string;
  state: InstanceState;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const unavailable = disabled || state === "failed" || state === "deploying" || state === "trashed";

  async function command(kind: string) {
    if (
      kind === "trash" &&
      !window.confirm(
        "Delete this instance? This stops and removes its managed container, hides it from the dashboard, and moves its files to trash.",
      )
    ) return;
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
      const cmd = await readCommand(id);
      if (cmd.status === "queued") {
        setNotice(`${kindLabel(kind)} queued. Waiting for the homeserver agent...`);
      } else if (cmd.status === "claimed") {
        setNotice(`${kindLabel(kind)} is running on the homeserver...`);
      } else if (cmd.status === "succeeded") {
        setNotice(cmd.result?.message ?? `${kindLabel(kind)} completed.`);
        return;
      } else if (cmd.status === "failed") {
        throw new Error(cmd.error ?? cmd.result?.message ?? `${kindLabel(kind)} failed`);
      }
      await wait(1500);
    }
    throw new Error(`${kindLabel(kind)} is still waiting for the agent`);
  }

  async function runCommand(kind: string) {
    try {
      await command(kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue command");
    }
  }

  function btn(
    kind: string,
    label: string,
    icon: React.ReactNode,
    isDisabled = false,
    variant: keyof typeof BTN = "default",
  ) {
    return (
      <button
        key={kind}
        className={BTN[variant]}
        disabled={Boolean(pending) || isDisabled}
        onClick={() => runCommand(kind)}
      >
        {pending === kind ? <Loader2 className="size-3.5 animate-spin" /> : icon}
        {label}
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {state === "failed" && btn("retry_deploy", "Retry deploy", <RotateCcw className="size-3.5" />, disabled)}
        {btn("start",   "Start",   <Play      className="size-3.5" />, unavailable || state === "running")}
        {btn("restart", "Restart", <RefreshCw className="size-3.5" />, unavailable || state !== "running")}
        {btn("stop",    "Stop",    <Square    className="size-3.5" />, unavailable || state === "stopped" || state === "sleeping")}
        {btn("sleep",   "Sleep",   <Moon      className="size-3.5" />, unavailable || state !== "running")}
        {btn("trash",   "Delete",  <Trash2    className="size-3.5" />, disabled || state === "trashed", "danger")}
      </div>
      {notice && <p className="text-xs text-[var(--muted-foreground)]">{notice}</p>}
      {error  && <p className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}

function kindLabel(kind: string) {
  return kind.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
