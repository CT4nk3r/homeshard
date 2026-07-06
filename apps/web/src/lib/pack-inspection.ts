import { strFromU8, unzipSync } from "fflate";

export type PackSummary = {
  format: "curseforge" | "modrinth" | "prism-modlist";
  name: string;
  minecraftVersion: string;
  loader: string;
  fileCount: number;
};

export type DetectedServerType = "VANILLA" | "PAPER" | "FABRIC" | "FORGE" | "NEOFORGE";

/** Convert the loader identifiers used by CurseForge and Modrinth manifests to
 * the server types understood by the instance creator. */
export function serverTypeFromLoader(loader: string): DetectedServerType | null {
  const normalized = loader.toLowerCase();
  if (normalized === "minecraft" || normalized === "vanilla") return "VANILLA";
  if (normalized === "paper" || normalized.startsWith("paper-")) return "PAPER";
  if (normalized === "fabric-loader" || normalized === "fabric" || normalized.startsWith("fabric-")) return "FABRIC";
  if (normalized === "neoforge" || normalized.startsWith("neoforge-")) return "NEOFORGE";
  if (normalized === "forge" || normalized.startsWith("forge-")) return "FORGE";
  return null;
}

/** Detect a PrismLauncher JSON modlist export. Loader + MC version are not in
 * this export, so callers should preserve the user's current selections. */
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
      const name = file.name.replace(/^\.\//, "");
      const isManifest = name === "manifest.json" || name === "modrinth.index.json";
      if (isManifest && file.originalSize > 2 * 1024 * 1024) {
        throw new Error("Pack manifest is unexpectedly large");
      }
      return isManifest;
    },
  });

  const curseForgeBytes = selected["manifest.json"] ?? selected["./manifest.json"];
  if (curseForgeBytes) {
    const manifest = JSON.parse(strFromU8(curseForgeBytes)) as {
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

  const modrinthBytes = selected["modrinth.index.json"] ?? selected["./modrinth.index.json"];
  if (modrinthBytes) {
    const manifest = JSON.parse(strFromU8(modrinthBytes)) as {
      name?: string;
      files?: unknown[];
      dependencies?: Record<string, string>;
    };
    const dependencyNames = Object.keys(manifest.dependencies ?? {});
    const loader = ["neoforge", "forge", "fabric-loader", "quilt-loader", "paper"]
      .find((candidate) => dependencyNames.includes(candidate))
      ?? (dependencyNames.length === 1 && dependencyNames[0] === "minecraft" ? "vanilla" : "unknown");
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
