import { createHash } from "node:crypto";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";

export const MAX_PACK_BYTES = 250 * 1024 * 1024;

export type PackSummary = {
  format: "curseforge" | "modrinth" | "prism-modlist";
  name: string;
  minecraftVersion: string;
  loader: string;
  fileCount: number;
};

export type PackSource = {
  kind: "local" | "blob";
  originalName: string;
  sizeBytes: number;
  sha256?: string;
  path?: string;
  url?: string;
  pathname?: string;
  summary?: PackSummary;
};

export function safeZipName(name: string) {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const lower = base.toLowerCase();
  if (!lower.endsWith(".zip") && !lower.endsWith(".mrpack") && !lower.endsWith(".json")) {
    throw new Error("Pack must be a CurseForge ZIP, Modrinth .mrpack, or Prism modlist .json file");
  }
  return base.slice(0, 128);
}

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Detect a PrismLauncher JSON modlist export: an array of mod entries each with
 * a `url` and (usually) a `filename`. Loader + MC version are not in the export. */
export function inspectPrismModlist(bytes: Uint8Array): PackSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(bytes).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const entries = parsed as Array<{ url?: unknown; filename?: unknown }>;
  const looksLikeModlist = entries.every(
    (entry) => entry && typeof entry === "object" && typeof entry.url === "string",
  );
  const withFiles = entries.filter((entry) => typeof entry.filename === "string" && entry.filename);
  if (!looksLikeModlist || withFiles.length === 0) return null;
  return {
    format: "prism-modlist",
    name: "Prism modlist",
    minecraftVersion: "unknown",
    loader: "unknown",
    fileCount: entries.length,
  };
}

export function inspectPack(bytes: Uint8Array): PackSummary {
  const modlist = inspectPrismModlist(bytes);
  if (modlist) return modlist;

  const selected = unzipSync(bytes, {
    filter: (file) => {
      const selected = file.name === "manifest.json" || file.name === "modrinth.index.json";
      if (selected && file.originalSize > 2 * 1024 * 1024) {
        throw new Error("Pack manifest is unexpectedly large");
      }
      return selected;
    },
  });

  if (selected["manifest.json"]) {
    const manifest = JSON.parse(strFromU8(selected["manifest.json"])) as {
      name?: string;
      files?: unknown[];
      minecraft?: { version?: string; modLoaders?: Array<{ id?: string; primary?: boolean }> };
    };
    const loader = manifest.minecraft?.modLoaders?.find((item) => item.primary)?.id
      ?? manifest.minecraft?.modLoaders?.[0]?.id
      ?? "unknown";
    return {
      format: "curseforge",
      name: manifest.name ?? "CurseForge pack",
      minecraftVersion: manifest.minecraft?.version ?? "unknown",
      loader,
      fileCount: manifest.files?.length ?? 0,
    };
  }

  if (selected["modrinth.index.json"]) {
    const manifest = JSON.parse(strFromU8(selected["modrinth.index.json"])) as {
      name?: string;
      files?: unknown[];
      dependencies?: Record<string, string>;
    };
    const loader = Object.entries(manifest.dependencies ?? {}).find(([key]) => key !== "minecraft")?.[0]
      ?? "unknown";
    return {
      format: "modrinth",
      name: manifest.name ?? "Modrinth pack",
      minecraftVersion: manifest.dependencies?.minecraft ?? "unknown",
      loader,
      fileCount: manifest.files?.length ?? 0,
    };
  }

  throw new Error("ZIP is not a CurseForge or Modrinth pack");
}
