import type { JSX } from "react";
import {
  Activity,
  Alert,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Edit,
  Export,
  Eye,
  Filter,
  Folder,
  Group,
  Help,
  Import,
  Key,
  Log,
  More,
  Plus,
  Refresh,
  Search,
  Server,
  Settings,
  Sidebar,
  Terminal,
  Trash,
  Unload,
  X,
} from "./icons";

export type IconName =
  | "activity"
  | "alert"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "copy"
  | "database"
  | "edit"
  | "export"
  | "eye"
  | "filter"
  | "folder"
  | "group"
  | "help"
  | "import"
  | "key"
  | "log"
  | "more"
  | "plus"
  | "refresh"
  | "search"
  | "server"
  | "settings"
  | "sidebar"
  | "terminal"
  | "trash"
  | "unload"
  | "x";

const MAP: Record<IconName, () => JSX.Element> = {
  activity: Activity,
  alert: Alert,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  copy: Copy,
  database: Database,
  edit: Edit,
  export: Export,
  eye: Eye,
  filter: Filter,
  folder: Folder,
  group: Group,
  help: Help,
  import: Import,
  key: Key,
  log: Log,
  more: More,
  plus: Plus,
  refresh: Refresh,
  search: Search,
  server: Server,
  settings: Settings,
  sidebar: Sidebar,
  terminal: Terminal,
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
