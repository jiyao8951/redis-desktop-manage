/**
 * Client-side key tree builder. It reproduces the "single namespaced key"
 * heuristic from src/modules/connections-tree/keysrendering.cpp:
 * a segment becomes a namespace only when the next key also contains that
 * namespace path; otherwise the full key is rendered at the current level.
 */

export interface TreeNode {
  kind: "namespace" | "key";
  id: string;
  /** Segment shown in the tree. */
  name: string;
  /** Namespace path, or the full key for key nodes. */
  full: string;
  children: TreeNode[];
  /** Number of key nodes below this namespace (loaded sample only). */
  keyCount: number;
  /** True when this namespace has its own SCAN page applied. */
  loaded: boolean;
  loading: boolean;
}

export interface LoadedNamespace {
  keys: string[];
  cursor: string;
  loaded: boolean;
  loading: boolean;
}

export type NamespaceData = Record<string, LoadedNamespace>;

function keyNode(
  dbKey: string,
  key: string,
  parentFull: string,
  separator: string,
  shortNames: boolean,
): TreeNode {
  const display =
    parentFull && shortNames && separator ? key.slice(parentFull.length + separator.length) : key;
  return {
    kind: "key",
    id: `key:${dbKey}:${key}`,
    name: display || key,
    full: key,
    children: [],
    keyCount: 0,
    loaded: true,
    loading: false,
  };
}

export function buildChildren(
  dbKey: string,
  parentFull: string,
  keys: string[],
  separator: string,
  shortNames: boolean,
  nsData: NamespaceData,
  showNamespacesOnTop: boolean,
): TreeNode[] {
  const sorted = keys.slice().sort();
  const children: TreeNode[] = [];
  let i = 0;

  while (i < sorted.length) {
    const key = sorted[i];
    let rest = key;
    if (parentFull) {
      const prefix = separator ? `${parentFull}${separator}` : parentFull;
      if (!key.startsWith(prefix)) {
        i += 1;
        continue;
      }
      rest = key.slice(prefix.length);
    }
    if (!rest) {
      i += 1;
      continue;
    }

    const sepPos = separator ? rest.indexOf(separator) : -1;
    if (sepPos === -1) {
      children.push(keyNode(dbKey, key, parentFull, separator, shortNames));
      i += 1;
      continue;
    }

    const nsName = rest.slice(0, sepPos);
    const nsFull = parentFull && separator ? `${parentFull}${separator}${nsName}` : nsName;
    const nextKey = sorted[i + 1] ?? "";

    // A namespace-like segment with no sibling key stays a plain key.
    if (!nextKey || !nextKey.includes(nsFull)) {
      children.push(keyNode(dbKey, key, parentFull, separator, shortNames));
      i += 1;
      continue;
    }

    const group: string[] = [];
    while (i < sorted.length) {
      const candidate = sorted[i];
      if (candidate === nsFull || candidate.startsWith(`${nsFull}${separator}`)) {
        group.push(candidate);
        i += 1;
      } else {
        break;
      }
    }
    if (!group.length) {
      children.push(keyNode(dbKey, key, parentFull, separator, shortNames));
      i += 1;
      continue;
    }

    // A namespace page loaded from its own SCAN replaces the sample derived
    // from the parent page.
    const page = nsData[nsFull];
    const sourceKeys = page?.loaded ? page.keys : group;
    const sub = buildChildren(
      dbKey,
      nsFull,
      sourceKeys,
      separator,
      shortNames,
      nsData,
      showNamespacesOnTop,
    );
    children.push({
      kind: "namespace",
      id: `ns:${dbKey}:${nsFull}`,
      name: nsName,
      full: nsFull,
      children: sub,
      keyCount: countKeys(sub),
      loaded: Boolean(page?.loaded),
      loading: Boolean(page?.loading),
    });
  }

  if (showNamespacesOnTop) {
    children.sort((a, b) => {
      if (a.kind === b.kind) return a.name.localeCompare(b.name);
      return a.kind === "namespace" ? -1 : 1;
    });
  }
  return children;
}

export function countKeys(nodes: TreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === "key") count += 1;
    else count += countKeys(node.children);
  }
  return count;
}

export interface FlatNodeRow {
  rowKind: "node";
  node: TreeNode;
  depth: number;
}

export interface FlatLoadMoreRow {
  rowKind: "loadmore";
  /** Namespace full path, or null for the database root. */
  namespace: string | null;
  depth: number;
  id: string;
}

export type FlatKeyRow = FlatNodeRow | FlatLoadMoreRow;

export function flattenNodes(
  nodes: TreeNode[],
  expanded: Set<string>,
  hasMore: (namespace: string | null) => boolean,
  depth = 0,
  out: FlatKeyRow[] = [],
): FlatKeyRow[] {
  for (const node of nodes) {
    out.push({ rowKind: "node", node, depth });
    if (node.kind === "namespace" && expanded.has(node.id)) {
      flattenNodes(node.children, expanded, hasMore, depth + 1, out);
      if (hasMore(node.full)) {
        out.push({
          rowKind: "loadmore",
          namespace: node.full,
          depth: depth + 1,
          id: `more:${node.full}`,
        });
      }
    }
  }
  return out;
}
