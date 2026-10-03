import { appendFileSync, mkdirSync } from "node:fs";
import { authenticateToken } from "../middleware/auth";

const MAX_B64 = 200_000;
const DIR = process.env.DIAG_DIR || "/opt/live-dashboard/data";

export async function handleDiag(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const tag = typeof body.tag === "string" ? body.tag.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) : "";
  const b64 = typeof body.b64 === "string" ? body.b64 : "";
  if (!tag || !b64) return Response.json({ error: "tag and b64 required" }, { status: 400 });
  if (b64.length > MAX_B64) return Response.json({ error: "too large" }, { status: 413 });

  let text: string;
  try { text = Buffer.from(b64, "base64").toString("utf8"); } catch { return Response.json({ error: "bad base64" }, { status: 400 }); }

  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(`${DIR}/diag-${tag}.log`, `\n===== ${new Date().toISOString()} device=${device.device_id} part=${body.part ?? ""} =====\n${text}\n`);
    return Response.json({ ok: true, bytes: text.length });
  } catch {
    return Response.json({ error: "write failed" }, { status: 500 });
  }
}
