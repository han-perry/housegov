/**
 * Visual org chart (d3-org-chart): pan/zoom, collapsible branches, and a
 * details panel when you click a role. Data comes from the server as a flat
 * list of {id, parentId, role, users} parsed from the text definition.
 */
import { OrgChart } from "d3-org-chart";

interface OrgDatum {
  id: string;
  parentId: string | null;
  role: string;
  users: string[];
  heading: boolean;
  root?: boolean;
}

const esc = (s: string) => window.hg.escapeHtml(s);
const initials = (u: string) => u.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();

function nodeHtml(d: OrgDatum, w: number, h: number): string {
  const kind = d.root ? "org-node-root" : d.heading ? "org-node-heading" : "";
  const people = d.users.length
    ? d.users.map((u) => `<div class="org-person"><span class="org-avatar">${esc(initials(u))}</span>${esc(u)}</div>`).join("")
    : d.heading || d.root
      ? ""
      : `<div class="org-vacant">Vacant</div>`;
  return `<div class="org-node ${kind}" style="width:${w}px;height:${h}px"><div class="org-role">${esc(d.role)}</div>${people}</div>`;
}

function mount(container: HTMLElement) {
  const source = document.getElementById("orgchart-data") as HTMLTextAreaElement | null;
  if (!source) return;
  const data: OrgDatum[] = JSON.parse(source.value);
  if (data.length < 2) return;
  const domain = container.dataset.mailDomain || "";
  const details = document.getElementById("org-details");

  const chart = new OrgChart<OrgDatum>()
    .container(container)
    .data(data)
    .svgHeight(container.clientHeight)
    .nodeWidth(() => 220)
    .nodeHeight((n: { data: OrgDatum }) => (n.data.root || n.data.heading ? 56 : 46 + Math.max(1, n.data.users.length) * 26))
    .childrenMargin(() => 56)
    .siblingsMargin(() => 22)
    .compactMarginBetween(() => 22)
    .compactMarginPair(() => 60)
    .compact(false)
    .initialExpandLevel(99)
    .linkUpdate(function (this: SVGPathElement) {
      this.setAttribute("stroke", "#a1a1aa");
      this.setAttribute("stroke-width", "1.5");
    })
    .nodeContent((n: { data: OrgDatum; width: number; height: number }) => nodeHtml(n.data, n.width, n.height))
    .onNodeClick((n: { data: OrgDatum } | string) => {
      // The callback receives the node in v3 (older versions pass the id).
      const d = typeof n === "string" ? data.find((x) => x.id === n) : n.data;
      if (!details || !d || d.root) return;
      details.innerHTML =
        `<div class="meta text-uppercase">${esc(d.role)}</div>` +
        (d.users.length
          ? d.users.map((u) => `<div class="mt-1"><b>${esc(u)}</b><br><a href="mailto:${esc(u)}@${esc(domain)}">${esc(u)}@${esc(domain)}</a></div>`).join("")
          : `<div class="text-secondary small">${d.heading ? "Group" : "This position is vacant."}</div>`);
      details.classList.remove("d-none");
    })
    .duration(0) // first paint is instant; animate later interactions
    .render();
  chart.fit({ animate: false });
  chart.duration(350);

  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener("click", fn);
  on("org-fit", () => chart.fit());
  on("org-expand", () => chart.expandAll().fit());
  on("org-collapse", () => chart.collapseAll().fit());
  on("org-layout", () => {
    const next = (chart.layout() as string) === "top" ? "left" : "top";
    chart.layout(next).render().fit();
  });
  window.addEventListener("resize", () => chart.svgHeight(container.clientHeight).render().fit());
}

const el = document.getElementById("orgchart");
if (el) mount(el);
