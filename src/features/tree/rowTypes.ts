import type { ConnectionGroup, ConnectionSummary } from "../../lib/types";
import type { TreeNode } from "./treeModel";

/** State kept for one database row in the sidebar. */
export interface DbView {
  index: number;
  keys: number;
  filter: string;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  expanded: boolean;
  /** Accumulated SCAN keys for the database root. */
  rootKeys: string[];
  /** SCAN cursor for the next root page; "0" means exhausted. */
  cursor: string;
  /** Namespace pages loaded on demand, keyed by namespace full path. */
  nsData: Record<string, { keys: string[]; cursor: string; loaded: boolean; loading: boolean }>;
}

export interface ServerView {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  expanded: boolean;
  databases: DbView[];
}

export type TreeRowData =
  | { kind: "group"; id: string; group: ConnectionGroup; depth: number }
  | {
      kind: "server";
      id: string;
      connection: ConnectionSummary;
      view: ServerView;
      depth: number;
    }
  | {
      kind: "database";
      id: string;
      connection: ConnectionSummary;
      db: DbView;
      depth: number;
    }
  | {
      kind: "filter";
      id: string;
      connection: ConnectionSummary;
      db: DbView;
      depth: number;
    }
  | {
      kind: "node";
      id: string;
      connectionId: string;
      dbKey: string;
      dbIndex: number;
      node: TreeNode;
      depth: number;
    }
  | {
      kind: "loadmore";
      id: string;
      connectionId: string;
      dbKey: string;
      dbIndex: number;
      namespace: string | null;
      depth: number;
    };

export function dbKeyOf(connectionId: string, db: number): string {
  return `${connectionId}:${db}`;
}
