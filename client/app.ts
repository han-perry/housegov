// Shared browser helpers, bundled by esbuild into /static/build/app.js.
// Page-specific scripts (inline in the EJS views) use these via `window.hg`.

/** The app's base path ("" or e.g. "/housegov"), from <html data-base>. */
const base = document.documentElement.dataset.base || "";

/** Prefix a root-relative path with the base path (once). */
function url(p: string): string {
  if (!base || !p.startsWith("/") || p.startsWith("//") || p === base || p.startsWith(base + "/")) return p;
  return base + p;
}

/** POST JSON and return the parsed response; throws with the server's error text. */
async function postJSON<T = Record<string, unknown>>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(url(path), {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(((data.errors as string[]) || [data.error || res.statusText]).join("\n"));
  return data as T;
}

/**
 * Live countdowns: <span data-countdown="ISO">, ticking every second.
 * data-style="inline" gives "2d 4h 05m 09s" (leading zero units dropped);
 * data-done is the text shown when it reaches zero (default "passed").
 * Optional progress bar via data-start/data-progress. Times are fixed at page
 * load: if a poll or meeting is rescheduled, a reload picks up the new time.
 */
function startCountdowns(): void {
  const els = document.querySelectorAll<HTMLElement>("[data-countdown]");
  if (!els.length) return;
  const tick = () => {
    const now = Date.now();
    els.forEach((el) => {
      const end = new Date(el.dataset.countdown!).getTime();
      let s = Math.max(0, Math.floor((end - now) / 1000));
      const d = Math.floor(s / 86400);
      s %= 86400;
      const h = Math.floor(s / 3600);
      s %= 3600;
      const m = Math.floor(s / 60);
      s %= 60;
      if (el.dataset.style === "inline") {
        const pad = (n: number) => String(n).padStart(2, "0");
        el.textContent = end <= now ? el.dataset.done || "passed" : d ? `${d}d ${h}h ${pad(m)}m ${pad(s)}s` : h ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
      }
      else el.innerHTML = `${d}<small>d</small>${h}<small>h</small>${m}<small>m</small>${s}<small>s</small>`;
      const bar = el.dataset.progress ? document.getElementById(el.dataset.progress) : null;
      if (bar && el.dataset.start) {
        const start = new Date(el.dataset.start).getTime();
        const pct = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
        bar.style.width = pct.toFixed(1) + "%";
        bar.setAttribute("aria-valuenow", pct.toFixed(0));
      }
    });
  };
  tick();
  setInterval(tick, 1000);
}

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const hg = { base, url, postJSON, escapeHtml, startCountdowns };
declare global {
  interface Window {
    hg: typeof hg;
  }
}
window.hg = hg;

document.addEventListener("DOMContentLoaded", startCountdowns);
export {};
