import { createHash } from "node:crypto";
import path from "node:path";
export { inspectPack, inspectPrismModlist, serverTypeFromLoader } from "./pack-inspection";
export type { DetectedServerType, PackSummary } from "./pack-inspection";
import type { PackSummary } from "./pack-inspection";

export const MAX_PACK_BYTES = 250 * 1024 * 1024;

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
