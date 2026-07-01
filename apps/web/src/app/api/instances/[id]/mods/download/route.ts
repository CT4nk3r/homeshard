import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Zip, ZipPassThrough } from "fflate";
import { NextResponse } from "next/server";
import { requireMember } from "@/lib/auth";
import { instanceModsDir, safeDownloadName } from "@/lib/instance-files";
import { getInstanceDetail } from "@/lib/instances";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireMember();
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid instance id" }, { status: 400 });
    }

    const instance = await getInstanceDetail(id);
    if (!instance) {
      return NextResponse.json({ error: "Instance not found" }, { status: 404 });
    }

    const modsDir = instanceModsDir(id);
    let jars: string[] = [];
    try {
      jars = (await readdir(modsDir)).filter((name) => name.toLowerCase().endsWith(".jar")).sort();
    } catch {
      jars = [];
    }
    if (!jars.length) {
      return NextResponse.json(
        { error: "This instance has no installed mods to download yet." },
        { status: 404 },
      );
    }

    const filename = `${safeDownloadName(instance.name, "instance").replace(/\.[^.]+$/, "")}-mods.zip`;
    const body = zipModsStream(modsDir, jars);
    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not export mods";
    return NextResponse.json({ error: message }, { status: message === "FORBIDDEN" ? 403 : 400 });
  }
}

// Stream the mod jars into a zip. Jars are already compressed, so entries are
// stored (ZipPassThrough) rather than deflated to save CPU. Reads honor stream
// backpressure so a slow client can't balloon memory on a large mod folder.
function zipModsStream(modsDir: string, jars: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const zip = new Zip((error, chunk, final) => {
        if (error) {
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
        if (final) controller.close();
      });

      (async () => {
        for (const jar of jars) {
          const entry = new ZipPassThrough(jar);
          zip.add(entry);
          const source = createReadStream(path.join(modsDir, jar));
          for await (const chunk of source) {
            entry.push(new Uint8Array(chunk as Buffer), false);
            while ((controller.desiredSize ?? 1) <= 0) {
              await sleep(10);
            }
          }
          entry.push(new Uint8Array(0), true);
        }
        zip.end();
      })().catch((error) => controller.error(error));
    },
  });
}
