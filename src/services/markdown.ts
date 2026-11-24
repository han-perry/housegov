import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.setOptions({ gfm: true, breaks: true });

const allowed: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["h1", "h2", "del", "ins", "input"]),
  allowedAttributes: {
    a: ["href", "title"],
    input: ["type", "checked", "disabled"],
    th: ["align"],
    td: ["align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
};

/**
 * The WYSIWYG editor escapes "_" and "*" when you paste a bare URL
 * ("ref=ox\_sc\_act"), and marked's autolinker keeps the backslashes,
 * which breaks the link. Undo markdown escapes inside bare URLs.
 */
function unescapeUrls(md: string): string {
  return md.replace(/https?:\/\/[^\s<>()]+/g, (url) => url.replace(/\\([_*~])/g, "$1"));
}

/** Render user markdown to safe HTML. */
export function render(md: string | null | undefined): string {
  return sanitizeHtml(marked.parse(unescapeUrls(md || ""), { async: false }), allowed);
}

const inlineAllowed: sanitizeHtml.IOptions = {
  allowedTags: ["b", "i", "em", "strong", "code", "del", "a", "br"],
  allowedAttributes: { a: ["href", "title"] },
  allowedSchemes: ["http", "https", "mailto"],
};

/** Render one line of user markdown (bold, italics, links, code) with no block elements. */
export function renderInline(md: string | null | undefined): string {
  return sanitizeHtml(marked.parseInline(unescapeUrls(md || ""), { async: false }), inlineAllowed);
}

export function wordCount(text: string | null | undefined): number {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
