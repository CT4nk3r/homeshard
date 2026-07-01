import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { requireMember } from "@/lib/auth";
import { MAX_PACK_BYTES } from "@/lib/packs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody;
    const response = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        await requireMember();
        const lower = pathname.toLowerCase();
        if (
          !pathname.startsWith("staging/packs/")
          || (!lower.endsWith(".zip") && !lower.endsWith(".mrpack") && !lower.endsWith(".json"))
        ) {
          throw new Error("Invalid pack staging path");
        }
        return {
          allowedContentTypes: [
            "application/zip",
            "application/x-zip-compressed",
            "application/octet-stream",
            "application/json",
          ],
          maximumSizeInBytes: MAX_PACK_BYTES,
          addRandomSuffix: true,
          allowOverwrite: false,
          tokenPayload: pathname,
        };
      },
    });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not authorize upload";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
