/**
 * Rich text / markdown editor (Toast UI). Loaded only on pages that edit text.
 *
 *   <textarea name="full_text" hidden>…markdown…</textarea>
 *   <div data-md-editor="full_text" data-height="320px"></div>
 *
 * The editor keeps the named textarea in sync, so plain form posts work, and
 * dispatches `input` on it so pages can react (word counts, live diffs).
 */
import Editor from "@toast-ui/editor";
import "@toast-ui/editor/dist/toastui-editor.css";

type EditorEl = HTMLElement & { _editor?: Editor };

function mountEditors(root: ParentNode = document): Editor[] {
  return [...root.querySelectorAll<EditorEl>("[data-md-editor]")].map((el) => {
    const input = document.querySelector<HTMLTextAreaElement>(`textarea[name="${el.dataset.mdEditor}"]`);
    const editor = new Editor({
      el,
      height: el.dataset.height || "300px",
      initialEditType: el.dataset.mode === "markdown" ? "markdown" : "wysiwyg",
      previewStyle: "tab",
      usageStatistics: false,
      initialValue: input?.value ?? "",
      toolbarItems: [["heading", "bold", "italic", "strike"], ["ul", "ol", "quote"], ["table", "link"], ["code"]],
    });
    const sync = () => {
      if (!input) return;
      input.value = editor.getMarkdown();
      input.dispatchEvent(new Event("input"));
    };
    editor.on("change", sync);
    el.closest("form")?.addEventListener("submit", sync);
    el._editor = editor;
    return editor;
  });
}

declare global {
  interface Window {
    hgEditors: Editor[];
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.hgEditors = mountEditors();
});
