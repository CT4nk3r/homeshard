"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { FileArchive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { inspectPack, serverTypeFromLoader, type DetectedServerType } from "@/lib/pack-inspection";
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
  const [serverType, setServerType] = useState<DetectedServerType>("FABRIC");
  const [gameVersion, setGameVersion] = useState("1.21.1");
  const [analyzingPack, setAnalyzingPack] = useState(false);
  const [packMessage, setPackMessage] = useState<string | null>(null);
  const inspectionSequence = useRef(0);
  const submittingRef = useRef(false);

  useEffect(() => {
    fetch("/api/packs/capabilities")
      .then((response) => response.json())
      .then((body) => setMode(body.mode ?? "none"))
      .catch(() => setMode("none"));
  }, []);

  async function stagePack(file: File): Promise<PackSource> {
    if (file.size > 250 * 1024 * 1024) throw new Error("Pack exceeds the 250 MB limit");
    const lower = file.name.toLowerCase();
    const isModlist = lower.endsWith(".json");
    if (!lower.endsWith(".zip") && !lower.endsWith(".mrpack") && !isModlist) {
      throw new Error("Pack must be a CurseForge ZIP, Modrinth .mrpack, or Prism modlist .json file");
    }

    if (mode === "blob") {
      const blob = await upload(`staging/packs/${file.name}`, file, {
        access: "private",
        handleUploadUrl: "/api/packs/upload",
        contentType: isModlist ? "application/json" : "application/zip",
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

  async function inspectSelectedPack(file?: File) {
    const sequence = ++inspectionSequence.current;
    setPackMessage(null);
    if (!file || file.size === 0) {
      setAnalyzingPack(false);
      return;
    }

    setAnalyzingPack(true);
    try {
      if (file.size > 250 * 1024 * 1024) throw new Error("Pack exceeds the 250 MB limit");
      const summary = inspectPack(new Uint8Array(await file.arrayBuffer()));
      if (sequence !== inspectionSequence.current) return;

      const detectedType = serverTypeFromLoader(summary.loader);
      const detectedVersion = summary.minecraftVersion !== "unknown" ? summary.minecraftVersion : null;
      if (detectedType) setServerType(detectedType);
      if (detectedVersion) setGameVersion(detectedVersion);

      if (detectedType && detectedVersion) {
        setPackMessage(`Detected ${detectedType === "NEOFORGE" ? "NeoForge" : detectedType.toLowerCase()} ${detectedVersion} from ${summary.name}.`);
      } else {
        setPackMessage(`Read ${summary.name}, but its server type and Minecraft version are not included. Check the selections above.`);
      }
    } catch (error) {
      if (sequence === inspectionSequence.current) {
        setPackMessage(`${error instanceof Error ? error.message : "Could not inspect pack"}. Check the server type and Minecraft version above.`);
      }
    } finally {
      if (sequence === inspectionSequence.current) setAnalyzingPack(false);
    }
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
        setMessage("Agent is working: validating the pack, installing mods, and launching the instance...");
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
    if (submittingRef.current) return;
    submittingRef.current = true;
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
      submittingRef.current = false;
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
      setMissingMessage(`Uploaded ${uploaded} missing mod jar${uploaded === 1 ? "" : "s"}; they'll be used on the next deploy.`);
    } catch (error) {
      setMissingMessage(error instanceof Error ? error.message : "Could not upload missing mods");
    } finally {
      setMissingBusy(false);
    }
  }

  return (
    <div className="space-y-6">
    <form action={submit} className="space-y-5" aria-busy={busy || analyzingPack}>
      <fieldset disabled={busy} className="space-y-5 disabled:opacity-80">
      <div className="space-y-2"><label htmlFor="name" className="text-sm font-medium">Instance name</label><Input id="name" name="name" placeholder="TwoWeekMc" required maxLength={48} /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><label className="text-sm font-medium">Server type</label><Select name="serverType" value={serverType} onValueChange={(value) => setServerType(value as DetectedServerType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="VANILLA">Vanilla</SelectItem><SelectItem value="PAPER">Paper</SelectItem><SelectItem value="FABRIC">Fabric</SelectItem><SelectItem value="FORGE">Forge</SelectItem><SelectItem value="NEOFORGE">NeoForge</SelectItem></SelectContent></Select></div>
        <div className="space-y-2"><label htmlFor="gameVersion" className="text-sm font-medium">Minecraft version</label><Input id="gameVersion" name="gameVersion" value={gameVersion} onChange={(event) => setGameVersion(event.target.value)} /></div>
      </div>
      <div className="space-y-2"><label htmlFor="memoryMb" className="text-sm font-medium">Memory recommendation (MiB)</label><Input id="memoryMb" name="memoryMb" type="number" min="2048" max="12288" step="1024" defaultValue="4096" /></div>
      <div className="space-y-2"><label htmlFor="levelSeed" className="text-sm font-medium">World seed <span className="text-muted-foreground">(optional)</span></label><Input id="levelSeed" name="levelSeed" placeholder="Leave blank for random" maxLength={128} /></div>
      <div className="space-y-2">
        <label htmlFor="pack" className="text-sm font-medium">Modpack <span className="text-muted-foreground">(optional)</span></label>
        <Input id="pack" name="pack" type="file" accept=".zip,.mrpack,.json,application/zip,application/json" onChange={(event) => void inspectSelectedPack(event.target.files?.[0])} />
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><FileArchive className="size-3.5" />CurseForge ZIP, Modrinth .mrpack, or a Prism modlist .json export. Pack metadata automatically fills in the server type and Minecraft version when available.</p>
        {analyzingPack && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Reading pack metadata...</p>}
        {!analyzingPack && packMessage && <p className="rounded-md bg-secondary p-3 text-sm">{packMessage}</p>}
      </div>
      {message && <p className="rounded-md bg-secondary p-3 text-sm">{message}</p>}
      <Button disabled={busy || analyzingPack}>{(busy || analyzingPack) && <Loader2 className="size-4 animate-spin" />}{busy ? "Preparing instance..." : analyzingPack ? "Reading modpack..." : "Create instance"}</Button>
      </fieldset>
    </form>
    <form action={uploadMissingMods} className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <label htmlFor="missingMods" className="text-sm font-medium">Blocked CurseForge mod jars</label>
        <p className="text-xs text-muted-foreground">If a mod is blocked from automatic download, download the jar from CurseForge and upload it here so the next deploy can use it.</p>
      </div>
      <Input id="missingMods" name="missingMods" type="file" accept=".jar,application/java-archive" multiple />
      {missingMessage && <p className="rounded-md bg-secondary p-3 text-sm">{missingMessage}</p>}
      <Button type="submit" variant="outline" disabled={missingBusy}>{missingBusy && <Loader2 className="size-4 animate-spin" />}{missingBusy ? "Uploading jars..." : "Upload missing jars"}</Button>
    </form>
    </div>
  );
}
