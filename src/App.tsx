import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import Toolbar from "./features/shell/Toolbar";
import TabBar from "./features/shell/TabBar";
import WelcomeTab from "./features/shell/WelcomeTab";
import QuickStartDialog from "./features/shell/QuickStartDialog";
import SettingsDialog from "./features/shell/SettingsDialog";
import LogDrawer from "./features/shell/LogDrawer";
import ServerOverview from "./features/shell/ServerOverview";
import ConnectionDialog from "./features/connections/ConnectionDialog";
import ConnectionTree from "./features/tree/ConnectionTree";
import ValueTab from "./features/value/ValueTab";
import ConsoleTab from "./features/console/ConsoleTab";
import ServerActionsTab from "./features/server/ServerActionsTab";
import { ipc } from "./lib/ipc";
import { createEmptyConnection, DEFAULT_SETTINGS } from "./lib/defaults";
import { errMessage } from "./lib/format";
import { I18nProvider, resolveLanguage, translate } from "./lib/i18n";
import type { Language, TranslateParams } from "./lib/i18n";
import type {
  ConnectionConfig,
  ConnectionGroup,
  ConnectionSummary,
  ServerActionView,
  ServerFacts,
  Settings,
} from "./lib/types";

export interface AppTab {
  id: string;
  kind: "welcome" | "server" | "key" | "console" | "server-actions";
  title: string;
  closable: boolean;
  connectionId?: string;
  facts?: ServerFacts | null;
  factsError?: string | null;
  db?: number;
  keyName?: string;
  actionView?: ServerActionView;
}

export interface LogEntry {
  id: number;
  at: number;
  level: "info" | "error";
  message: string;
}

const WELCOME_TAB: AppTab = {
  id: "welcome",
  kind: "welcome",
  title: "",
  closable: true,
};

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 640;

export default function App() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [groups, setGroups] = useState<ConnectionGroup[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tabs, setTabs] = useState<AppTab[]>([WELCOME_TAB]);
  const [activeTabId, setActiveTabId] = useState(WELCOME_TAB.id);
  const [editing, setEditing] = useState<{ config: ConnectionConfig; isNew: boolean } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickStart, setQuickStart] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [treeVisible, setTreeVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [revision, setRevision] = useState(0);
  /** Signals ConnectionTree to drop the cached view of an already-closed connection. */
  const [externalClose, setExternalClose] = useState<{ id: string; token: number } | null>(null);

  const toastTimer = useRef<number | null>(null);
  const logId = useRef(0);
  const consoleSeq = useRef(0);
  const dragging = useRef(false);
  const closeToken = useRef(0);
  /** Tab ids whose active editor holds unsaved changes. */
  const dirtyTabs = useRef<Set<string>>(new Set());

  // App renders inside the provider, so it calls the pure translator directly.
  const language: Language = resolveLanguage(settings.language);
  const t = (key: Parameters<typeof translate>[1], params?: TranslateParams) =>
    translate(language, key, params);

  const log = (message: string, level: "info" | "error" = "info") => {
    setLogs((prev) =>
      [{ id: (logId.current += 1), at: Date.now(), level, message }, ...prev].slice(0, 500),
    );
  };

  const notify = (message: string) => {
    setToast(message);
    log(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  };

  const loadLists = async () => {
    try {
      const [connectionList, groupList] = await Promise.all([
        ipc.listConnections(),
        ipc.listGroups(),
      ]);
      setConnections(connectionList);
      setGroups(groupList);
      return connectionList;
    } catch (e) {
      notify(t("app.loadConnectionsFailed", { error: errMessage(e) }));
      return [];
    }
  };

  useEffect(() => {
    void (async () => {
      const list = await loadLists();
      try {
        setSettings(await ipc.getSettings());
      } catch (e) {
        notify(t("app.loadSettingsFailed", { error: errMessage(e) }));
      }
      const dismissed = window.localStorage.getItem("resp.quickstart.dismissed");
      if (!list.length && !dismissed) setQuickStart(true);
      log(t("app.started"));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = settings.darkMode === "on" || (settings.darkMode === "auto" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    if (settings.darkMode === "auto") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
    return undefined;
  }, [settings.darkMode]);

  useEffect(() => {
    // GlobalSettings.qml appFont/appFontSize: apply live instead of on restart.
    // The size only drives the text base (--app-font); layout uses the
    // responsive tier variables so a user font change never shrinks spacing.
    document.documentElement.style.fontFamily = settings.appFont || "";
    document.documentElement.style.setProperty(
      "--app-font",
      settings.appFontSize ? `${settings.appFontSize}px` : "",
    );
  }, [settings.appFont, settings.appFontSize]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setTreeVisible((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragging.current) return;
      const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, event.clientX));
      setSidebarWidth(width);
    };
    const onUp = () => {
      dragging.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const openNewConnection = () => {
    setEditing({ config: createEmptyConnection(), isNew: true });
  };

  const openEditConnection = async (id: string) => {
    try {
      const config = await ipc.getConnection(id);
      setEditing({ config, isNew: false });
    } catch (e) {
      notify(t("app.loadConnectionFailed", { error: errMessage(e) }));
    }
  };

  const saveConnection = async (config: ConnectionConfig) => {
    try {
      const saved = await ipc.saveConnection(config);
      setEditing(null);
      setRevision((v) => v + 1);
      await loadLists();
      notify(t("app.connectionSaved", { name: saved.name }));
    } catch (e) {
      notify(t("app.saveConnectionFailed", { error: errMessage(e) }));
    }
  };

  const openServerTab = (connection: ConnectionSummary) => {
    const tabId = `server:${connection.id}`;
    setTabs((prev) => {
      if (prev.some((tab) => tab.id === tabId)) return prev;
      return [
        ...prev,
        {
          id: tabId,
          kind: "server",
          title: connection.name,
          closable: true,
          connectionId: connection.id,
          facts: null,
          factsError: null,
        },
      ];
    });
    setActiveTabId(tabId);

    void (async () => {
      try {
        const facts = await ipc.serverFacts(connection.id);
        setTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, facts } : tab)));
      } catch (e) {
        const message = errMessage(e);
        setTabs((prev) =>
          prev.map((tab) => (tab.id === tabId ? { ...tab, factsError: message } : tab)),
        );
        log(`${connection.name}: ${message}`, "error");
      }
    })();
  };

  const markTabDirty = (id: string, dirty: boolean) => {
    if (dirty) dirtyTabs.current.add(id);
    else dirtyTabs.current.delete(id);
  };

  const confirmCloseTabs = (ids: string[]) => {
    const dirty = ids.filter((id) => dirtyTabs.current.has(id));
    if (!dirty.length) return true;
    return window.confirm(t("tabbar.unsavedClose", { count: dirty.length }));
  };

  /** Removes tabs without asking; falls back to a fresh welcome tab when the bar is empty. */
  const applyCloseTabs = (ids: string[]) => {
    if (!ids.length) return;
    const doomed = new Set(ids);
    doomed.forEach((id) => dirtyTabs.current.delete(id));
    const index = tabs.findIndex((tab) => doomed.has(tab.id));
    const remaining = tabs.filter((tab) => !doomed.has(tab.id));
    setTabs(remaining.length ? remaining : [WELCOME_TAB]);
    if (doomed.has(activeTabId)) {
      setActiveTabId(
        remaining.length ? remaining[Math.min(index, remaining.length - 1)].id : WELCOME_TAB.id,
      );
    }
  };

  const closeTabs = (ids: string[]) => {
    if (!confirmCloseTabs(ids)) return false;
    applyCloseTabs(ids);
    return true;
  };

  const closeTab = (id: string) => {
    closeTabs([id]);
  };

  const closeOtherTabs = (id: string) => {
    closeTabs(tabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
  };

  const closeTabsToRight = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    closeTabs(tabs.slice(index + 1).map((tab) => tab.id));
  };

  const closeAllTabs = () => {
    closeTabs(tabs.map((tab) => tab.id));
  };

  /** Opens the welcome tab, or focuses the existing one (never duplicates it). */
  const openWelcomeTab = () => {
    setTabs((prev) => (prev.some((tab) => tab.kind === "welcome") ? prev : [WELCOME_TAB, ...prev]));
    setActiveTabId(WELCOME_TAB.id);
  };

  const connectionTabIds = (connectionId: string) =>
    tabs.filter((tab) => tab.connectionId === connectionId).map((tab) => tab.id);

  /** Closes every tab of a connection, then releases its Redis pool and tree state. */
  const closeAndDisconnect = (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab?.connectionId) return;
    const connectionId = tab.connectionId;
    const ids = connectionTabIds(connectionId);
    if (!confirmCloseTabs(ids)) return;
    const name = connections.find((item) => item.id === connectionId)?.name ?? connectionId;
    void (async () => {
      try {
        await ipc.closeConnection(connectionId);
      } catch (e) {
        log(t("tabbar.disconnectFailed", { error: errMessage(e) }), "error");
      }
      applyCloseTabs(ids);
      closeToken.current += 1;
      setExternalClose({ id: connectionId, token: closeToken.current });
      notify(t("tree.closedConnection", { name }));
    })();
  };

  const openKeyTab = (connectionId: string, db: number, keyName: string) => {
    const tabId = `key:${connectionId}:${db}:${keyName}`;
    setTabs((prev) => {
      if (prev.some((tab) => tab.id === tabId)) return prev;
      return [
        ...prev,
        {
          id: tabId,
          kind: "key" as const,
          title: keyName,
          closable: true,
          connectionId,
          db,
          keyName,
        },
      ];
    });
    setActiveTabId(tabId);
  };

  /** Every invocation creates a new console tab, like the original action. */
  const openConsoleTab = (connection: ConnectionSummary, db: number) => {
    consoleSeq.current += 1;
    const tabId = `console:${connection.id}:${db}:${consoleSeq.current}`;
    setTabs((prev) => [
      ...prev,
      {
        id: tabId,
        kind: "console" as const,
        title: t("app.consoleTab", { name: connection.name }),
        closable: true,
        connectionId: connection.id,
        db,
      },
    ]);
    setActiveTabId(tabId);
  };

  /** One Server Actions tab per connection; the tile entry just switches view. */
  const openServerActionsTab = (
    connection: ConnectionSummary,
    view: ServerActionView = "stats",
  ) => {
    const tabId = `server-actions:${connection.id}`;
    setTabs((prev) => {
      if (prev.some((tab) => tab.id === tabId)) {
        return prev.map((tab) => (tab.id === tabId ? { ...tab, actionView: view } : tab));
      }
      return [
        ...prev,
        {
          id: tabId,
          kind: "server-actions" as const,
          title: t("app.serverActionsTab", { name: connection.name }),
          closable: true,
          connectionId: connection.id,
          actionView: view,
        },
      ];
    });
    setActiveTabId(tabId);
  };

  /** Keep the tab id/title in sync after DUMP/RESTORE rename. */
  const handleKeyRenamed = (tab: AppTab, newName: string) => {
    if (tab.connectionId === undefined || tab.db === undefined) return;
    const nextId = `key:${tab.connectionId}:${tab.db}:${newName}`;
    if (dirtyTabs.current.has(tab.id)) {
      dirtyTabs.current.delete(tab.id);
      dirtyTabs.current.add(nextId);
    }
    setTabs((prev) => {
      // Renaming to an existing key means both tabs point at the same key.
      // Keep a single tab for it instead of duplicating the id.
      if (prev.some((item) => item.id === nextId && item.id !== tab.id)) {
        return prev.filter((item) => item.id !== tab.id);
      }
      return prev.map((item) =>
        item.id === tab.id ? { ...item, id: nextId, title: newName, keyName: newName } : item,
      );
    });
    setActiveTabId((prev) => (prev === tab.id ? nextId : prev));
  };

  const handleConnectionDeleted = (id: string) => {
    applyCloseTabs(connectionTabIds(id));
  };

  const importConnections = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: t("app.importFilterName"), extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    try {
      const count = await ipc.importConnections(path);
      setRevision((v) => v + 1);
      await loadLists();
      notify(t("app.imported", { count }));
    } catch (e) {
      notify(t("app.importFailed", { error: errMessage(e) }));
    }
  };

  const exportConnections = async () => {
    const path = await save({
      defaultPath: "connections.json",
      filters: [{ name: t("app.importFilterName"), extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await ipc.exportConnections(path);
      notify(t("app.exported", { path }));
    } catch (e) {
      notify(t("app.exportFailed", { error: errMessage(e) }));
    }
  };

  const saveSettings = async (next: Settings) => {
    try {
      setSettings(await ipc.updateSettings(next));
      setSettingsOpen(false);
      notify(t("app.settingsSaved"));
    } catch (e) {
      notify(t("app.saveSettingsFailed", { error: errMessage(e) }));
    }
  };

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? WELCOME_TAB;
  const serverConnection =
    activeTab.connectionId !== undefined
      ? connections.find((item) => item.id === activeTab.connectionId)
      : undefined;

  return (
    <I18nProvider language={language}>
      <div className="flex h-full flex-col bg-win">
        <Toolbar
          onAddConnection={openNewConnection}
          onImport={() => void importConnections()}
          onExport={() => void exportConnections()}
          onToggleTree={() => setTreeVisible((v) => !v)}
          onOpenWelcome={openWelcomeTab}
          onOpenLog={() => setLogOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <TabBar
          tabs={tabs}
          activeId={activeTabId}
          onActivate={setActiveTabId}
          onClose={closeTab}
          onCloseOthers={closeOtherTabs}
          onCloseRight={closeTabsToRight}
          onCloseAll={closeAllTabs}
          onDisconnect={closeAndDisconnect}
        />

        <div className="relative flex min-h-0 flex-1">
          {treeVisible ? (
            <>
              <aside
                className="flex min-h-0 shrink-0 flex-col border-r border-border bg-base"
                style={{ width: sidebarWidth }}
              >
                <ConnectionTree
                  connections={connections}
                  groups={groups}
                  settings={settings}
                  revision={revision}
                  onAddConnection={openNewConnection}
                  onEditConnection={(id) => void openEditConnection(id)}
                  onOpenServerTab={openServerTab}
                  onOpenKey={openKeyTab}
                  onOpenConsole={openConsoleTab}
                  onOpenServerActions={openServerActionsTab}
                  onDeleteConnection={handleConnectionDeleted}
                  onBeforeCloseConnection={(id) => confirmCloseTabs(connectionTabIds(id))}
                  onConnectionClosed={(id) => applyCloseTabs(connectionTabIds(id))}
                  externalClose={externalClose}
                  onConnectionsChanged={() => {
                    setRevision((v) => v + 1);
                    void loadLists();
                  }}
                  onGroupsChanged={() => {
                    void loadLists();
                  }}
                  onNotify={notify}
                  onLog={log}
                />
              </aside>
              <div
                className="w-[4px] shrink-0 cursor-col-resize bg-border/30 transition-colors hover:bg-highlight/50 active:bg-highlight/60"
                onMouseDown={() => {
                  dragging.current = true;
                }}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("app.resizeTree")}
              />
            </>
          ) : null}

          <main className="relative min-w-0 flex-1 overflow-hidden">
            {activeTab.kind === "welcome" ? (
              <WelcomeTab onAddConnection={openNewConnection} />
            ) : activeTab.kind === "console" &&
              activeTab.connectionId !== undefined &&
              activeTab.db !== undefined ? (
              <ConsoleTab
                connectionId={activeTab.connectionId}
                connectionName={
                  connections.find((c) => c.id === activeTab.connectionId)?.name ??
                  activeTab.connectionId
                }
                initialDb={activeTab.db}
                fontFamily={settings.appFont || undefined}
                fontSize={settings.appFontSize || undefined}
                onNotify={notify}
                onLog={log}
              />
            ) : activeTab.kind === "server-actions" && activeTab.connectionId !== undefined ? (
              <ServerActionsTab
                connectionId={activeTab.connectionId}
                connectionName={
                  connections.find((c) => c.id === activeTab.connectionId)?.name ??
                  activeTab.connectionId
                }
                initialView={activeTab.actionView ?? "stats"}
                onNotify={notify}
                onLog={log}
              />
            ) : activeTab.kind === "key" &&
              activeTab.connectionId !== undefined &&
              activeTab.db !== undefined &&
              activeTab.keyName !== undefined ? (
              <ValueTab
                connectionId={activeTab.connectionId}
                connectionName={
                  connections.find((c) => c.id === activeTab.connectionId)?.name ??
                  activeTab.connectionId
                }
                db={activeTab.db}
                keyName={activeTab.keyName}
                settings={settings}
                onNotify={notify}
                onLog={log}
                onRename={(newName) => handleKeyRenamed(activeTab, newName)}
                onDirtyChange={(dirty) => markTabDirty(activeTab.id, dirty)}
                onClose={() => closeTab(activeTab.id)}
              />
            ) : serverConnection && activeTab.kind === "server" ? (
              <ServerOverview
                name={activeTab.title}
                facts={activeTab.facts ?? null}
                error={activeTab.factsError ?? null}
                onOpenView={(view) => openServerActionsTab(serverConnection, view)}
              />
            ) : null}
          </main>

          {logOpen ? (
            <LogDrawer
              entries={logs}
              onClose={() => setLogOpen(false)}
              onClear={() => setLogs([])}
            />
          ) : null}
        </div>

        {toast ? (
          <div
            className="pointer-events-none fixed bottom-4 left-1/2 z-50 max-w-[min(600px,80vw)] -translate-x-1/2 rounded-md border border-border bg-base px-3.5 py-2.5 t-13 leading-5 text-text shadow-2xl"
            role="status"
            aria-live="polite"
          >
            {toast}
          </div>
        ) : null}

        {editing ? (
          <ConnectionDialog
            initial={editing.config}
            isNew={editing.isNew}
            onSave={(config) => void saveConnection(config)}
            onClose={() => setEditing(null)}
            onNotify={notify}
          />
        ) : null}

        {settingsOpen ? (
          <SettingsDialog
            settings={settings}
            onSave={(next) => void saveSettings(next)}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}

        {quickStart ? (
          <QuickStartDialog
            onClose={() => {
              window.localStorage.setItem("resp.quickstart.dismissed", "1");
              setQuickStart(false);
            }}
            onConnect={openNewConnection}
          />
        ) : null}
      </div>
    </I18nProvider>
  );
}
