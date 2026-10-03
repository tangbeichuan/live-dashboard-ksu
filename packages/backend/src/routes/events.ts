import { getEventsSince } from "../db";
import { authenticateToken } from "../middleware/auth";

export function handleEvents(req: Request, url: URL): Response {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const sinceRaw = url.searchParams.get("since") || "0";
  const since = /^\d+$/.test(sinceRaw) ? parseInt(sinceRaw, 10) : 0;
  const limitRaw = url.searchParams.get("limit") || "30";
  const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 30, 1), 60);

  const rows = getEventsSince.all(since, limit);
  return Response.json({ events: rows, count: rows.length });
}
