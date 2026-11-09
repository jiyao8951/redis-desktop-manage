import type { ConsoleReply } from "../../lib/types";

/** Runs one command on the current connection (no console output, no history). */
export type ConsoleExec = (command: string) => Promise<ConsoleReply>;

export interface CommandCatalog {
  /** Lowercase command names, alphabetically sorted. */
  names: string[];
  /** Which introspection command produced the list. */
  source: "docs" | "info" | "list" | "none";
  /** Server version used as part of the cache key ("" when unknown). */
  version: string;
}

const NAME_PATTERN = /^[a-z][a-z0-9._-]*$/i;

/** Cache scoped to connection id (which already changes when a tab reconnects). */
const catalogCache = new Map<string, Promise<CommandCatalog>>();
const argsCache = new Map<string, Promise<string[] | null>>();

function catalogKey(connectionId: string): string {
  return connectionId;
}

function argsKey(connectionId: string, name: string): string {
  return `${connectionId}::${name}`;
}

/**
 * Names are the only top-level scalar strings in `COMMAND DOCS` output: the
 * docs values (summary, since, …) are arrays/maps and therefore always indented
 * beneath the name entry, in both RESP2 and RESP3.
 */
function extractDocsNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^\d+\)\s+"([^"]+)"(\s*=>.*)?$/.exec(line);
    if (!match) continue;
    const name = match[1];
    if (NAME_PATTERN.test(name)) names.push(name.toLowerCase());
  }
  return names;
}

/** `COMMAND INFO` blocks start with `N) 1) "name"` followed by arity, flags… */
function extractInfoNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^\d+\)\s+1\)\s+"([^"]+)"/.exec(line);
    if (!match) continue;
    if (NAME_PATTERN.test(match[1])) names.push(match[1].toLowerCase());
  }
  return names;
}

/** `COMMAND LIST` is a plain array: `1) "get"`. */
function extractListNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^\d+\)\s+"([^"]+)"$/.exec(line);
    if (!match) continue;
    if (NAME_PATTERN.test(match[1])) names.push(match[1].toLowerCase());
  }
  return names;
}

function uniqueSorted(names: string[]): string[] {
  return Array.from(new Set(names)).sort();
}

async function fetchCatalog(exec: ConsoleExec): Promise<Omit<CommandCatalog, "version">> {
  const docs = await exec("COMMAND DOCS");
  if (!docs.error) {
    const names = uniqueSorted(extractDocsNames(docs.output));
    if (names.length > 20) return { names, source: "docs" };
  }

  const info = await exec("COMMAND INFO");
  if (!info.error) {
    const names = uniqueSorted(extractInfoNames(info.output));
    if (names.length > 20) return { names, source: "info" };
  }

  const list = await exec("COMMAND LIST");
  if (!list.error) {
    const names = uniqueSorted(extractListNames(list.output));
    if (names.length > 0) return { names, source: "list" };
  }

  return { names: [], source: "none" };
}

async function detectVersion(exec: ConsoleExec): Promise<string> {
  try {
    const reply = await exec("INFO SERVER");
    if (reply.error) return "";
    return /^redis_version:(\S+)/m.exec(reply.output)?.[1] ?? "";
  } catch {
    return "";
  }
}

/**
 * Loads the command list used by autocompletion. The list always comes from the
 * server (`COMMAND DOCS`, falling back to `COMMAND INFO`/`COMMAND LIST`); it is
 * never hard-coded. Results are cached in memory per connection so switching
 * connections cannot leak another server's command set.
 */
export function loadCommandCatalog(connectionId: string, exec: ConsoleExec): Promise<CommandCatalog> {
  const key = catalogKey(connectionId);
  const cached = catalogCache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const version = await detectVersion(exec);
    const fetched = await fetchCatalog(exec);
    return { ...fetched, version };
  })();

  catalogCache.set(key, pending);
  pending.catch(() => catalogCache.delete(key));
  return pending;
}

/**
 * Extracts argument names from `COMMAND DOCS <name>`. The console reply is
 * redis-cli formatted text, so both RESP2 (key/value on separate lines) and
 * RESP3 (`"name" => "key"`) layouts are handled. Returns null when the server
 * offers no documentation for the command.
 */
export function parseArgumentNames(output: string): string[] | null {
  const lines = output.split("\n");
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\d+\)\s*"arguments"/.test(lines[index])) {
      start = index;
      break;
    }
  }
  if (start < 0) return null;

  const region: string[] = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    // A new top-level docs key ends the arguments block.
    if (/^\d+\)\s*"/.test(line)) break;
    if (/^\s*\d+\)\s*"subcommands"/.test(line)) break;
    region.push(line);
  }

  const text = region.join("\n");
  const names: string[] = [];
  const add = (value: string) => {
    if (value && !names.includes(value)) names.push(value);
  };

  for (const match of text.matchAll(/"name"\s*=>\s*"([^"]*)"/g)) add(match[1]);
  if (names.length > 0) return names;

  for (const match of text.matchAll(/\d+\)\s*"name"\s*\n\s*\d+\)\s*"([^"]*)"/g)) {
    add(match[1]);
  }
  return names.length > 0 ? names : null;
}

/** Lazily loads (and caches) the documented argument names of one command. */
export function loadCommandArguments(
  connectionId: string,
  name: string,
  exec: ConsoleExec,
): Promise<string[] | null> {
  const key = argsKey(connectionId, name);
  const cached = argsCache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const reply = await exec(`COMMAND DOCS ${name}`);
    if (reply.error) return null;
    return parseArgumentNames(reply.output);
  })();

  argsCache.set(key, pending);
  pending.catch(() => argsCache.delete(key));
  return pending;
}
