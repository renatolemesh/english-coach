/** FastAPI-style error bodies: {"detail": "..."} with the status' reason phrase by default. */
import { STATUS_CODES } from "node:http";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function httpError(c: Context, status: ContentfulStatusCode, detail?: string): Response {
  return c.json({ detail: detail ?? STATUS_CODES[status] ?? "Error" }, status);
}
