// A folder tree built from the changed files of a diff. Pure functions, no screen code.

export interface TreeFileInput { path: string; additions: number | null; deletions: number | null }

export interface TreeNode {
  kind: "dir" | "file";
  /** What the row shows. A folder holding only one folder shows both: "src/app". */
  name: string;
  /** Folder path (no trailing slash) or file path. Unique. */
  path: string;
  additions: number;
  deletions: number;
  /** Files below this folder, 1 for a file. */
  files: number;
  children: TreeNode[];
}

/** Folders first, then files, each A to Z. */
const order = (a: TreeNode, b: TreeNode) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1);

export function buildTree(files: readonly TreeFileInput[]): TreeNode[] {
  const root: TreeNode = { kind: "dir", name: "", path: "", additions: 0, deletions: 0, files: 0, children: [] };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let at = root;
    const chain: TreeNode[] = [root];
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const last = i === parts.length - 1;
      let next = at.children.find((c) => c.path === path && c.kind === (last ? "file" : "dir"));
      if (!next) {
        next = { kind: last ? "file" : "dir", name: part, path, additions: 0, deletions: 0, files: 0, children: [] };
        at.children.push(next);
      }
      at = next;
      chain.push(next);
    });
    for (const n of chain) {
      n.additions += f.additions ?? 0;
      n.deletions += f.deletions ?? 0;
      n.files += 1;
    }
  }
  const finish = (nodes: TreeNode[]): TreeNode[] => {
    for (let i = 0; i < nodes.length; i++) {
      let n = nodes[i]!;
      // Join a chain of folders that each hold one folder.
      while (n.kind === "dir" && n.children.length === 1 && n.children[0]!.kind === "dir") {
        const only = n.children[0]!;
        n = { ...only, name: `${n.name}/${only.name}` };
      }
      nodes[i] = { ...n, children: finish(n.children) };
    }
    return nodes.sort(order);
  };
  return finish(root.children);
}

export interface TreeRow { node: TreeNode; depth: number }

/** The rows that are visible: children of a folder only when it is open. */
export function visibleRows(nodes: readonly TreeNode[], open: ReadonlySet<string>, depth = 0): TreeRow[] {
  return nodes.flatMap((node) => [{ node, depth }, ...(node.kind === "dir" && open.has(node.path) ? visibleRows(node.children, open, depth + 1) : [])]);
}

/** The path of every folder, so a tree can start fully open. */
export function allFolders(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "dir" ? [n.path, ...allFolders(n.children)] : []));
}
