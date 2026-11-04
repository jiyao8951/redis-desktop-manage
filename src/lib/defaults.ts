import type { ConnectionConfig, Settings } from "./types";

export function createEmptyConnection(): ConnectionConfig {
  return {
    id: "",
    groupId: null,
    name: "",
    host: "127.0.0.1",
    port: 6379,
    auth: "",
    username: "",
    sslEnabled: false,
    sslLocalCertPath: "",
    sslPrivateKeyPath: "",
    sslCaCertPath: "",
    ignoreSslErrors: false,
    sshHost: "",
    sshPort: 22,
    sshUser: "",
    sshPassword: "",
    sshPrivateKey: "",
    sshAgent: false,
    sshAgentPath: "",
    askForSshPassword: false,
    keysPattern: "*",
    namespaceSeparator: ":",
    executeTimeout: 10000,
    connectionTimeout: 10000,
    dbScanLimit: 20,
    overrideClusterHost: false,
    defaultFormatter: "auto",
    iconColor: "",
    protocol: "resp2",
  };
}

export const DEFAULT_SETTINGS: Settings = {
  showNamespacesOnTop: true, // Windows default in GlobalSettings.qml
  reopenNamespacesOnReload: true,
  namespacedKeysShortName: true,
  scanLimit: 10000,
  treeItemMaxChilds: 1000,
  scanPageSize: 100, // stage requirement
  liveUpdateKeysLimit: 1000,
  liveUpdateInterval: 10,
  darkMode: "auto",
  valueSizeLimit: 1500000,
  valueEditorPageSize: 100,
  appFont: "",
  appFontSize: 12,
  valueEditorFont: "",
  valueEditorFontSize: 11,
  language: "",
};
