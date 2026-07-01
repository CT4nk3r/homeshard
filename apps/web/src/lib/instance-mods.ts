import { createHash } from "node:crypto";
import path from "node:path";

export const MAX_INSTANCE_MOD_BYTES = 128 * 1024 * 1024;

export type ExtraModSource =
  | {
      kind: "local";
      path: string;
      originalName: string;
      sizeBytes: number;
      sha256: string;
    }
  | {
      kind: "url";
      url: string;
      originalName: string;
    };

export function safeJarName(name: string) {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._+-]+/g, "-");
  if (!base.toLowerCase().endsWith(".jar")) throw new Error("Mods must be .jar files");
  return base.slice(0, 160);
}

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
