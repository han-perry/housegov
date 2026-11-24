import type { Request } from "express";

export const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;

export const intParam = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};

export const str = (v: unknown): string => (typeof v === "string" ? v : "").trim();

/** Only allow same-site relative redirects. */
export function safeReturn(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : fallback;
}

export const back = (req: Request, fallback: string) => safeReturn(new URL(req.get("Referer") || fallback, "http://x").pathname, fallback);

export const wantsJson = (req: Request) => req.accepts(["html", "json"]) === "json";

/** <input type="datetime-local"> → Date (interpreted in server local time). */
export const fromLocalInput = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};
