import type { JSX } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Edit,
  Eye,
  Filter,
  Folder,
  Group,
  Key,
  Lock,
  Log,
  Plus,
  Refresh,
  Search,
  Settings,
  Trash,
  Unload,
  X,
} from "./icons";

export type IconName =
  | "chevron-down"
  | "chevron-right"
  | "copy"
  | "database"
  | "edit"
  | "eye"
  | "filter"
  | "folder"
  | "group"
  | "key"
  | "lock"
  | "log"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "trash"
  | "unload"
  | "x";

const MAP: Record<IconName, () => JSX.Element> = {
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  copy: Copy,
  database: Database,
  edit: Edit,
  eye: Eye,
  filter: Filter,
  folder: Folder,
  group: Group,
  key: Key,
  lock: Lock,
  log: Log,
  plus: Plus,
  refresh: Refresh,
  search: Search,
  settings: Settings,
  trash: Trash,
  unload: Unload,
  x: X,
};

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const Cmp = MAP[name];
  return (
    <span className={className} aria-hidden="true">
      {Cmp()}
    </span>
  );
}
