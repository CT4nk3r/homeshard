"use client";

import { useState } from "react";
import { Send, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

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
  const [lines, setLines] = useState(["Homeshard console queues compact commands. Full logs stay on the homeserver."]);
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!command.trim() || busy) return;
    const value = command.trim();
    setCommand("");
    setBusy(true);
    setLines((current) => [...current, `> ${value}`]);
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceId, kind: "console", payload: { command: value } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Command could not be queued.");
      setLines((current) => [...current, "Command queued."]);
      if (body.id) await waitForCommand(body.id);
    } catch (error) {
      setLines((current) => [...current, error instanceof Error ? error.message : "Command failed."]);
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
        setLines((current) => [...current, "Agent is sending it to RCON..."]);
      } else if (status.status === "succeeded") {
        const output = status.result?.data?.output?.trim();
        setLines((current) => [...current, output ? `< ${output}` : status.result?.message ?? "Command executed."]);
        return;
      } else if (status.status === "failed") {
        throw new Error(status.error ?? status.result?.message ?? "Command failed.");
      }
      await wait(1500);
    }
    throw new Error("Still waiting for the homeserver agent.");
  }

  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><TerminalSquare className="size-5" />Console</CardTitle><CardDescription>Near-realtime through the Neon command queue; no full console history is written to Neon.</CardDescription></CardHeader><CardContent className="space-y-4"><ScrollArea className="h-80 rounded-md border bg-black/40 p-4 font-mono text-xs text-zinc-300"><div className="space-y-1">{lines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}</div></ScrollArea><div className="flex gap-2"><Input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => event.key === "Enter" && send()} placeholder="say hello from Homeshard" className="font-mono" disabled={busy} /><Button onClick={send} disabled={busy}><Send className="size-4" />Send</Button></div></CardContent></Card>;
}
