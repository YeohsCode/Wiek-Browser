export interface RunRelation {
  run_id: string;
  derived_from: string | null;
}

export interface RunTreeNode<T extends RunRelation> {
  item: T;
  children: RunTreeNode<T>[];
}

export interface RunTreeRow<T extends RunRelation> {
  item: T;
  depth: number;
  childCount: number;
}

// Build once from the persisted run relation. Input order is preserved for roots and
// siblings, so each endpoint remains the owner of newest-first ordering. A child whose
// parent is absent from the current projection stays a root and remains accessible.
export function buildRunForest<T extends RunRelation>(items: readonly T[]): RunTreeNode<T>[] {
  const nodes = new Map<string, RunTreeNode<T>>(
    items.map((item) => [item.run_id, { item, children: [] }]),
  );
  const roots: RunTreeNode<T>[] = [];
  for (const item of items) {
    const node = nodes.get(item.run_id)!;
    const parent = item.derived_from ? nodes.get(item.derived_from) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function flattenRunForest<T extends RunRelation>(
  roots: readonly RunTreeNode<T>[],
  expanded: ReadonlySet<string>,
  expandAll = false,
): RunTreeRow<T>[] {
  const rows: RunTreeRow<T>[] = [];
  const append = (node: RunTreeNode<T>, depth: number): void => {
    rows.push({ item: node.item, depth, childCount: node.children.length });
    if (expandAll || expanded.has(node.item.run_id)) {
      for (const child of node.children) append(child, depth + 1);
    }
  };
  for (const root of roots) append(root, 0);
  return rows;
}
