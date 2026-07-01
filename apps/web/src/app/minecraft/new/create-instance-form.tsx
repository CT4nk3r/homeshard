"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { FileArchive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PackSource } from "@/lib/packs";

type UploadMode = "blob" | "local" | "none";
type CommandStatus = {
  id: string;
  status: "queued" | "claimed" | "succeeded" | "failed";
  instanceId?: string | null;
  error?: string | null;
  result?: {
    message?: string;
    data?: { instanceId?: string };
  } | null;
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function CreateInstanceForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [missingBusy, setMissingBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [missingMessage, setMissingMessage] = useState<string | null>(null);
  const [mode, setMode] = useState<UploadMode>("none");

  useEffect(() => {
    fetch("/api/packs/capabilities")
      .then((response) => response.json())
      .then((body) => setMode(body.mode ?? "none"))
      .catch(() => setMode("none"));
  }, []);

  async function stagePack(file: File): Promise<PackSource> {
    if (file.size > 250 * 1024 * 1024) throw new Error("Pack exceeds the 250 MB limit");
    if (!file.name.toLowerCase().endsWith(".zip") && !file.name.toLowerCase().endsWith(".mrpack")) {
      throw new Error("Pack must be a CurseForge ZIP or Modrinth .mrpack file");
    }

    if (mode === "blob") {
      const blob = await upload(`staging/packs/${file.name}`, file, {
        access: "private",
        handleUploadUrl: "/api/packs/upload",
        contentType: "application/zip",
      });
      return {
        kind: "blob",
        url: blob.url,
        pathname: blob.pathname,
        originalName: file.name,
        sizeBytes: file.size,
      };
    }

    if (mode === "local") {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/packs/local", { method: "POST", body: form });
      if (!response.ok) throw new Error((await response.json()).error ?? "Could not stage pack");
      return response.json();
    }

    throw new Error("Pack uploads are not configured yet");
  }

  async function readCommand(id: string): Promise<CommandStatus> {
    const response = await fetch(`/api/commands?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not read command status");
    return body;
  }

  async function waitForCommand(id: string) {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const command = await readCommand(id);
      if (command.status === "queued") {
        setMessage("Queued. Waiting for the homeserver agent to pick it up...");
      } else if (command.status === "claimed") {
        setMessage("Agent is working: validating the pack, importing through Prism if needed, and launching the instance...");
      } else if (command.status === "succeeded") {
        const instanceId = command.instanceId ?? command.result?.data?.instanceId;
        setMessage(command.result?.message ?? "Instance created.");
        if (instanceId) {
          router.push(`/minecraft/${instanceId}`);
        } else {
          router.push("/");
        }
        router.refresh();
        return;
      } else if (command.status === "failed") {
        throw new Error(command.error ?? command.result?.message ?? "Agent failed to create the instance");
      }
      await wait(1500);
    }
    throw new Error("Still waiting for the agent. Check the dashboard or agent logs for progress.");
  }

  async function submit(formData: FormData) {
    setBusy(true);
    setMessage(null);
    try {
      const file = formData.get("pack");
      const packSource = file instanceof File && file.size > 0 ? await stagePack(file) : undefined;
      if (packSource?.summary) {
        setMessage(`Validated ${packSource.summary.name}: ${packSource.summary.fileCount} referenced files.`);
      }
      const response = await fetch("/api/packs/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          serverType: formData.get("serverType"),
          gameVersion: formData.get("gameVersion"),
          levelSeed: formData.get("levelSeed"),
          memoryMb: Number(formData.get("memoryMb")),
          packSource,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not queue instance");
      setMessage(
        result.demo
          ? packSource
            ? "Pack validated and staged in demo mode. Connect Neon to let the agent archive and deploy it."
            : "Blueprint validated in demo mode. Connect Neon to let the agent deploy it."
          : "Creation queued. Waiting for the homeserver agent...",
      );
      if (!result.demo && result.id) await waitForCommand(result.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not queue instance");
    } finally {
      setBusy(false);
    }
  }

  async function uploadMissingMods(formData: FormData) {
    setMissingBusy(true);
    setMissingMessage(null);
    try {
      const files = formData.getAll("missingMods").filter((file) => file instanceof File && file.size > 0);
      if (!files.length) throw new Error("Choose one or more .jar files first.");
      const uploadForm = new FormData();
      for (const file of files) uploadForm.append("files", file);
      const response = await fetch("/api/missing-mods", { method: "POST", body: uploadForm });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not upload missing mods");
      const uploaded = Array.isArray(body.uploaded) ? body.uploaded.length : files.length;
      setMissingMessage(`Uploaded ${uploaded} missing mod jar${uploaded === 1 ? "" : "s"}. Prism will pick them up during import.`);
    } catch (error) {
      setMissingMessage(error instanceof Error ? error.message : "Could not upload missing mods");
    } finally {
      setMissingBusy(false);
    }
  }

  return (
    <div className="space-y-6">
    <form action={submit} className="space-y-5">
      <div className="space-y-2"><label htmlFor="name" className="text-sm font-medium">Instance name</label><Input id="name" name="name" placeholder="TwoWeekMc" required maxLength={48} /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><label className="text-sm font-medium">Server type</label><Select name="serverType" defaultValue="FABRIC"><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="VANILLA">Vanilla</SelectItem><SelectItem value="PAPER">Paper</SelectItem><SelectItem value="FABRIC">Fabric</SelectItem><SelectItem value="FORGE">Forge</SelectItem><SelectItem value="NEOFORGE">NeoForge</SelectItem></SelectContent></Select></div>
        <div className="space-y-2"><label htmlFor="gameVersion" className="text-sm font-medium">Minecraft version</label><Input id="gameVersion" name="gameVersion" defaultValue="1.21.1" /></div>
      </div>
      <div className="space-y-2"><label htmlFor="memoryMb" className="text-sm font-medium">Memory recommendation (MiB)</label><Input id="memoryMb" name="memoryMb" type="number" min="2048" max="12288" step="1024" defaultValue="8192" /></div>
      <div className="space-y-2"><label htmlFor="levelSeed" className="text-sm font-medium">World seed <span className="text-muted-foreground">(optional)</span></label><Input id="levelSeed" name="levelSeed" placeholder="Leave blank for random" maxLength={128} /></div>
      <div className="space-y-2">
        <label htmlFor="pack" className="text-sm font-medium">Modpack ZIP <span className="text-muted-foreground">(optional)</span></label>
        <Input id="pack" name="pack" type="file" accept=".zip,.mrpack,application/zip" />
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><FileArchive className="size-3.5" />{mode === "blob" ? "Private temporary Blob staging. CurseForge packs also need a matching fresh Prism import." : mode === "local" ? "Homeserver local test staging. CurseForge packs also need a matching fresh Prism import." : "Generated worlds only until staging is configured"}</p>
      </div>
      {message && <p className="rounded-md bg-secondary p-3 text-sm">{message}</p>}
      <Button disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{busy ? "Preparing instance..." : "Create instance"}</Button>
    </form>
    <form action={uploadMissingMods} className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <label htmlFor="missingMods" className="text-sm font-medium">Blocked CurseForge mod jars</label>
        <p className="text-xs text-muted-foreground">If Prism says a mod is blocked, download the jar from CurseForge and upload it here. Files are saved to the server&apos;s missing-mods folder for Prism to scan.</p>
      </div>
      <Input id="missingMods" name="missingMods" type="file" accept=".jar,application/java-archive" multiple />
      {missingMessage && <p className="rounded-md bg-secondary p-3 text-sm">{missingMessage}</p>}
      <Button type="submit" variant="outline" disabled={missingBusy}>{missingBusy && <Loader2 className="size-4 animate-spin" />}{missingBusy ? "Uploading jars..." : "Upload missing jars"}</Button>
    </form>
    </div>
  );
}
