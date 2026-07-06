import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { inspectPack, serverTypeFromLoader } from "./pack-inspection.ts";

test("reads Minecraft and Fabric versions from a CurseForge archive", () => {
  const bytes = zipSync({
    "manifest.json": strToU8(JSON.stringify({
      name: "A Fabric Pack",
      manifestType: "minecraftModpack",
      minecraft: {
        version: "1.21.1",
        modLoaders: [{ id: "fabric-0.16.14", primary: true }],
      },
      files: [{ projectID: 1, fileID: 2 }],
    })),
  });

  const summary = inspectPack(bytes);
  assert.equal(summary.minecraftVersion, "1.21.1");
  assert.equal(serverTypeFromLoader(summary.loader), "FABRIC");
});

test("prefers NeoForge from Modrinth dependencies regardless of key order", () => {
  const bytes = zipSync({
    "modrinth.index.json": strToU8(JSON.stringify({
      formatVersion: 1,
      name: "A NeoForge Pack",
      dependencies: { minecraft: "1.21.4", neoforge: "21.4.123" },
      files: [],
    })),
  });

  const summary = inspectPack(bytes);
  assert.equal(summary.minecraftVersion, "1.21.4");
  assert.equal(serverTypeFromLoader(summary.loader), "NEOFORGE");
});

test("maps Forge without confusing it with NeoForge", () => {
  assert.equal(serverTypeFromLoader("forge-47.3.0"), "FORGE");
  assert.equal(serverTypeFromLoader("neoforge-21.1.0"), "NEOFORGE");
  assert.equal(serverTypeFromLoader("quilt-loader"), null);
});
