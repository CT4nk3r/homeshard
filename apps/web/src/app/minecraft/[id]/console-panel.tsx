"use client";

import { useEffect, useRef, useState } from "react";
import { Send, TerminalSquare } from "lucide-react";

type CommandStatus = {
  id: string;
  status: "queued" | "claimed" | "succeeded" | "failed";
  error?: string | null;
  result?: {
    message?: string;
    data?: { output?: string };
  } | null;
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function ConsolePanel({ instanceId }: { instanceId: string }) {
  const [command, setCommand] = useState("");
  const [lines, setLines] = useState<{ text: string; kind: "sys" | "in" | "out" | "err" }[]>([
    { text: "Homeshard console queues compact commands. Full logs stay on the homeserver.", kind: "sys" },
  ]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  async function send() {
    if (!command.trim() || busy) return;
    const value = command.trim();
    setCommand("");
    setBusy(true);
    setLines((cur) => [...cur, { text: `> ${value}`, kind: "in" }]);
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceId, kind: "console", payload: { command: value } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Command could not be queued.");
      setLines((cur) => [...cur, { text: "Command queued.", kind: "sys" }]);
      if (body.id) await waitForCommand(body.id);
    } catch (error) {
      setLines((cur) => [...cur, { text: error instanceof Error ? error.message : "Command failed.", kind: "err" }]);
    } finally {
      setBusy(false);
    }
  }

  async function waitForCommand(id: string) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await fetch(`/api/commands?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const status = (await response.json()) as CommandStatus;
      if (!response.ok) throw new Error(status.error ?? "Could not read command status.");
      if (status.status === "claimed") {
        setLines((cur) => [...cur, { text: "Agent is sending it to RCON...", kind: "sys" }]);
      } else if (status.status === "succeeded") {
        const output = status.result?.data?.output?.trim();
        setLines((cur) => [
          ...cur,
          { text: output ? `< ${output}` : (status.result?.message ?? "Command executed."), kind: "out" },
        ]);
        return;
      } else if (status.status === "failed") {
        throw new Error(status.error ?? status.result?.message ?? "Command failed.");
      }
      await wait(1500);
    }
    throw new Error("Still waiting for the homeserver agent.");
  }

  return (
    <div className="overflow-hidden rounded-md border border-[var(--border-muted)] bg-[var(--card)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-muted)] px-4 py-3">
        <TerminalSquare className="size-4 text-[var(--muted-foreground)]" />
        <span className="text-[13px] font-semibold">Console</span>
        <span className="ml-auto text-xs text-[var(--text-faint)]">Near-realtime via Neon command queue</span>
      </div>

      <div
        ref={scrollRef}
        className="h-80 overflow-y-auto bg-[var(--canvas-inset)] px-4 py-3 font-mono text-[12.5px] leading-relaxed"
        role="log"
        aria-label="Server console output"
        tabIndex={0}
      >
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.kind === "in"  ? "text-[var(--link)]"    :
              line.kind === "out" ? "text-[var(--success)]" :
              line.kind === "err" ? "text-[var(--danger)]"  :
                                    "text-[var(--text-faint)]"
            }
          >
            {line.text}
          </div>
        ))}
      </div>

      <div className="flex gap-2 border-t border-[var(--border-muted)] bg-[var(--canvas-inset)] px-4 py-3">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="say hello from Homeshard"
          disabled={busy}
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-[var(--text-faint)] focus:border-[var(--link)] focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={busy || !command.trim()}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-interactive)] bg-[var(--card)] px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-[var(--panel-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="size-3.5" />
          Send
        </button>
      </div>
    </div>
  );
}
