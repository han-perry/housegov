declare module "*.css";

// d3-org-chart ships no types; this covers the chainable API we use.
declare module "d3-org-chart" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Fn = (...args: any[]) => any;
  export class OrgChart<T = unknown> {
    container(el: HTMLElement | string): this;
    data(d: T[]): this;
    svgHeight(h: number): this;
    nodeWidth(f: Fn): this;
    nodeHeight(f: Fn): this;
    childrenMargin(f: Fn): this;
    siblingsMargin(f: Fn): this;
    compactMarginBetween(f: Fn): this;
    compactMarginPair(f: Fn): this;
    compact(on: boolean): this;
    initialExpandLevel(n: number): this;
    linkUpdate(f: Fn): this;
    nodeContent(f: Fn): this;
    onNodeClick(f: Fn): this;
    layout(): string;
    layout(l: "top" | "left" | "bottom" | "right"): this;
    render(): this;
    fit(opts?: { animate?: boolean }): this;
    duration(ms: number): this;
    expandAll(): this;
    collapseAll(): this;
  }
}
