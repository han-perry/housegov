/**
 * Org chart, edited as indented text:
 *
 *   House Chair: perryh
 *     Secretary: alice
 *     Treasurer: bob, carol
 *   President: dave
 *
 * Two spaces (or a tab) per level. "Role: user1, user2"; a line with no
 * colon is a group heading.
 */
import { Router } from "express";
import * as db from "../db";
import { requirePerm } from "../auth";
import { GOVPERMS } from "../auth/permissions";

const router = Router();

export interface OrgNode {
  role: string;
  users: string[];
  children: OrgNode[];
}

export function parseOrgChart(text: string): OrgNode[] {
  const roots: OrgNode[] = [];
  const stack: { depth: number; node: OrgNode }[] = [];
  for (const raw of text.replace(/\t/g, "  ").split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const depth = Math.floor((raw.length - raw.trimStart().length) / 2);
    const [role, users = ""] = raw.trim().split(/:(.*)/s);
    const node: OrgNode = {
      role: role.trim(),
      users: users.split(",").map((u) => u.trim()).filter(Boolean),
      children: [],
    };
    while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
    (stack.length ? stack.at(-1)!.node.children : roots).push(node);
    stack.push({ depth, node });
  }
  return roots;
}

/** Flatten to the {id, parentId} rows d3-org-chart wants, under one synthetic root. */
export function flatten(roots: OrgNode[], rootLabel = "House Government") {
  const rows: { id: string; parentId: string | null; role: string; users: string[]; heading: boolean; root?: boolean }[] = [
    { id: "root", parentId: null, role: rootLabel, users: [], heading: true, root: true },
  ];
  const walk = (nodes: OrgNode[], parentId: string) =>
    nodes.forEach((n, i) => {
      const id = `${parentId}.${i}`;
      rows.push({ id, parentId, role: n.role, users: n.users, heading: !n.users.length && n.children.length > 0 });
      walk(n.children, id);
    });
  walk(roots, "root");
  return rows;
}

router.get("/", async (req, res) => {
  const text = (await db.setting("orgchart", "")) || "";
  const tree = parseOrgChart(text);
  res.render("orgchart/view", { title: "Org Chart", tree, rows: flatten(tree), text });
});

router.post("/", requirePerm(GOVPERMS.MANAGE), async (req, res) => {
  await db.setSetting("orgchart", String(req.body.text ?? ""));
  req.flash("success", "Org chart updated.");
  res.redirect("/orgchart");
});

export default router;
