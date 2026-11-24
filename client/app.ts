// Shared browser helpers, bundled by esbuild into /static/build/app.js.
// Page-specific scripts (inline in the EJS views) use these via `window.hg`.

/** POST JSON and return the parsed response; throws with the server's error text. */
async function postJSON<T = Record<string, unknown>>(url: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(((data.errors as string[]) || [data.error || res.statusText]).join("\n"));
  return data as T;
}

/** Live countdowns: <span data-countdown="ISO">; optional progress bar via data-start/data-progress. */
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
      if (el.dataset.style === "inline") el.textContent = end <= now ? "passed" : `${d ? d + "d " : ""}${h}h ${m}m`;
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

const hg = { postJSON, escapeHtml, startCountdowns };
declare global {
  interface Window {
    hg: typeof hg;
  }
}
window.hg = hg;

document.addEventListener("DOMContentLoaded", startCountdowns);
export {};
