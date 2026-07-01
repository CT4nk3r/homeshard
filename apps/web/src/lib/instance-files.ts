import path from "node:path";

// The web container mounts these host directories read-only (identity mounts,
// same path as on the host) so it can serve pack and mod files for download.
export function instancesRoot(): string {
  return process.env.HOMESHARD_ACTIVE_ROOT ?? "/srv/homeshard/instances";
}

export function coldRoot(): string {
  return process.env.HOMESHARD_COLD_ROOT ?? "/srv/homeshard/cold";
}

// Resolve an instance's live mods directory, ensuring the id can't escape the
// instances root via path traversal.
export function instanceModsDir(instanceId: string): string {
  const root = path.resolve(instancesRoot());
  const dir = path.resolve(root, instanceId, "mods");
  if (dir !== path.join(root, instanceId, "mods") || !dir.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid instance id");
  }
  return dir;
}

// Validate that a stored cold-storage pack path resolves inside cold storage
// before we stream it to a client.
export function resolveColdPackPath(coldPath: string): string {
  const root = path.resolve(coldRoot());
  const resolved = path.resolve(coldPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid pack path");
  }
  return resolved;
}

// Strip anything that could break a Content-Disposition filename or point
// outside the intended name.
export function safeDownloadName(name: string, fallback = "download"): string {
  const base = path.basename(name).replace(/[\u0000-\u001f"\\]/g, "").trim();
  return base.length ? base : fallback;
}

export function packContentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  // CurseForge .zip and Modrinth .mrpack are both zip containers.
  return "application/zip";
}
