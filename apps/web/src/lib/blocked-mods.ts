export type BlockedMod = {
  filename: string;
  url: string;
  sha1?: string;
};

/**
 * Extract the CurseForge "blocked mods" that Prism could not download from an
 * agent error/reason string. The agent emits, per blocked mod:
 *
 *   Blocked mod: <name>
 *   Download: <url>
 *   Expected SHA-1: <hash>
 */
export function parseBlockedMods(text: string | null | undefined): BlockedMod[] {
  if (!text) return [];
  const pattern =
    /Blocked mod:\s*(.+?)[ \t]*\r?\nDownload:\s*(https?:\/\/\S+)(?:[ \t]*\r?\nExpected SHA-1:\s*([0-9a-fA-F]{40}))?/g;
  const mods: BlockedMod[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const filename = match[1].replace(/\u00a7./g, "").trim();
    const url = match[2].trim();
    if (!filename || !url || seen.has(url)) continue;
    seen.add(url);
    mods.push({ filename, url, sha1: match[3]?.toLowerCase() });
  }
  return mods;
}

/** Collapse a multi-line anyhow error chain into a single, tidy line. */
export function tidyErrorMessage(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Short, human-readable summary of a blocked-mods failure. */
export function blockedModsSummary(count: number, location: "activity" | "here"): string {
  const files = `${count} file${count === 1 ? "" : "s"}`;
  const them = count === 1 ? "it" : "them";
  if (location === "activity") {
    return `Manual CurseForge download required for ${files}. Open the Activity tab to download ${them} and add ${them} to the instance, then retry deploy.`;
  }
  return `Manual CurseForge download required for ${files}. Download ${them} below and add ${them} to the instance, then retry deploy.`;
}
