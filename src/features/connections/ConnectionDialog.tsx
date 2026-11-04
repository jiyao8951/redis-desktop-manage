import { useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Dialog from "../../components/ui/Dialog";
import Button from "../../components/ui/Button";
import FilePathInput from "../../components/ui/FilePathInput";
import { Checkbox, NumberInput, Radio, Select, TextInput } from "../../components/ui/fields";
import { ipc } from "../../lib/ipc";
import { createEmptyConnection } from "../../lib/defaults";
import { clampInt, errMessage } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ConnectionConfig, TestResult } from "../../lib/types";

type Tab = "wizard" | "basic" | "advanced";

const GUIDE_TILES: { label: MessageLabel; url: string }[] = [
  {
    label: "conn.guide.local",
    url: "http://docs.resp.app/en/latest/quick-start/#connect-to-a-local-or-public-redis-server",
  },
  {
    label: "conn.guide.tls",
    url: "http://docs.resp.app/en/latest/quick-start/#connect-to-a-public-redis-server-with-ssl",
  },
  {
    label: "conn.guide.ssh",
    url: "http://docs.resp.app/en/latest/quick-start/#connect-to-private-redis-server-via-ssh-tunnel",
  },
  {
    label: "conn.guide.unix",
    url: "http://docs.resp.app/en/latest/quick-start/#connect-to-a-unix-socket",
  },
  {
    label: "conn.guide.digitalOcean",
    url: "http://docs.resp.app/en/latest/quick-start/#digital-ocean-managed-redis",
  },
  {
    label: "conn.guide.azure",
    url: "http://docs.resp.app/en/latest/quick-start/#microsoft-azure-redis-cache",
  },
  {
    label: "conn.guide.aws",
    url: "http://docs.resp.app/en/latest/quick-start/#aws-elasticache",
  },
  {
    label: "conn.guide.heroku",
    url: "http://docs.resp.app/en/latest/quick-start/#heroku-redis",
  },
];

type MessageLabel = Parameters<ReturnType<typeof useT>>[0];

/**
 * Rebuild of src/qml/connections/ConnectionSettignsDialog.qml.
 * Every visible field and its label order is kept; the only additions are the
 * RESP protocol selector (required for Redis 8) and the group is not shown
 * here (the original assigns groups through the tree "regroup" mode).
 */
export default function ConnectionDialog({
  initial,
  isNew,
  onSave,
  onClose,
  onNotify,
}: {
  initial: ConnectionConfig;
  isNew: boolean;
  onSave: (config: ConnectionConfig) => void;
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<ConnectionConfig>(initial);
  const [tab, setTab] = useState<Tab>(isNew ? "wizard" : "basic");
  const [url, setUrl] = useState("");
  const [sshEnabled, setSshEnabled] = useState(Boolean(initial.sshHost));
  const [useSshKey, setUseSshKey] = useState(Boolean(initial.sshPrivateKey));
  const [useSshPassword, setUseSshPassword] = useState(
    Boolean(initial.sshPassword) || initial.askForSshPassword,
  );
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const set = <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const cleanForSave = (): ConnectionConfig => {
    const next: ConnectionConfig = { ...draft, port: clampInt(draft.port, 1, 10_000_000) };
    if (draft.sshAgent) {
      next.sshPrivateKey = "";
      next.sshPassword = "";
    } else {
      next.sshAgentPath = "";
      if (!useSshKey) next.sshPrivateKey = "";
      if (!useSshPassword) next.sshPassword = "";
    }
    if (!sshEnabled) {
      next.sshHost = "";
    }
    return next;
  };

  const validate = (): boolean => {
    const errors: string[] = [];
    if (!draft.name.trim()) errors.push("name");
    if (!draft.host.trim()) errors.push("address");
    if (!draft.keysPattern.trim()) errors.push("keysPattern");
    if (!draft.namespaceSeparator) errors.push("namespaceSeparator");
    if (sshEnabled && !draft.sshHost.trim()) errors.push("sshAddress");
    if (sshEnabled && !draft.sshUser.trim()) errors.push("sshUser");
    const ok = errors.length === 0;
    setInvalid(!ok);
    return ok;
  };

  const doSave = () => {
    if (!validate()) return;
    onSave(cleanForSave());
  };

  const doTest = async () => {
    if (!validate()) return;
    setBusy(true);
    setTestResult(null);
    try {
      const result = await ipc.testConnection(cleanForSave());
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, message: errMessage(e), warning: null, facts: null });
    } finally {
      setBusy(false);
    }
  };

  const importUrl = async () => {
    try {
      const parsed = await ipc.parseRedisUrl(url);
      setDraft((d) => ({
        ...parsed,
        id: d.id,
        groupId: d.groupId,
        name: d.name || parsed.name,
      }));
      setSshEnabled(Boolean(parsed.sshHost));
      setTab("basic");
    } catch (e) {
      setTestResult({ success: false, message: errMessage(e), warning: null, facts: null });
      setInvalid(true);
    }
  };

  return (
    <Dialog
      title={isNew ? t("conn.titleNew") : t("conn.titleEdit", { name: initial.name })}
      width={860}
      onClose={onClose}
    >
      <div className="flex gap-4 border-b border-border pb-2 text-[12px]">
        {isNew ? (
          <TabButton active={tab === "wizard"} onClick={() => setTab("wizard")}>
            {t("conn.tabWizard")}
          </TabButton>
        ) : null}
        <TabButton active={tab === "basic"} onClick={() => setTab("basic")}>
          {t("conn.tabBasic")}
        </TabButton>
        <TabButton active={tab === "advanced"} onClick={() => setTab("advanced")}>
          {t("conn.tabAdvanced")}
        </TabButton>
      </div>

      <div className="min-h-[420px] pt-4">
        {tab === "wizard" ? (
          <div className="space-y-5">
            <h3 className="text-[13px] font-semibold">{t("conn.urlHeading")}</h3>
            <div className="flex gap-2">
              <TextInput
                value={url}
                placeholder="redis://localhost:6379"
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void importUrl();
                }}
              />
              <Button onClick={() => void importUrl()} disabled={!url.trim()}>
                {t("conn.import")}
              </Button>
            </div>
            <p className="text-[12px]">
              {t("conn.urlHelp")}{" "}
              <button
                type="button"
                className="text-highlight underline"
                onClick={() =>
                  void openUrl("https://www.iana.org/assignments/uri-schemes/prov/redis")
                }
              >
                redis://
              </button>
              ,{" "}
              <button
                type="button"
                className="text-highlight underline"
                onClick={() =>
                  void openUrl("https://www.iana.org/assignments/uri-schemes/prov/rediss")
                }
              >
                rediss://
              </button>
            </p>

            <h3 className="text-[13px] font-semibold">{t("conn.guides")}</h3>
            <div className="grid grid-cols-4 gap-2">
              {GUIDE_TILES.map((tile) => (
                <button
                  key={tile.label}
                  type="button"
                  title={tile.url}
                  className="flex h-[90px] items-center justify-center rounded-sm border border-border bg-base px-2 text-center text-[12px] hover:bg-surface"
                  onClick={() => void openUrl(tile.url)}
                >
                  {t(tile.label)}
                </button>
              ))}
            </div>

            <div className="space-y-1 pt-2">
              <h3 className="text-[13px] font-semibold">{t("conn.cannotConnect")}</h3>
              <p className="text-[12px]">
                <button
                  className="text-highlight underline"
                  onClick={() => void openUrl("https://docs.resp.app/en/latest/quick-start/")}
                >
                  {t("conn.readDocs")}
                </button>
                ,{" "}
                <button
                  className="text-highlight underline"
                  onClick={() => void openUrl("mailto:support@resp.app")}
                >
                  {t("conn.contactSupport")}
                </button>{" "}
                {t("conn.orAsk")}{" "}
                <button
                  className="text-highlight underline"
                  onClick={() => void openUrl("https://t.me/RedisDesktopManager")}
                >
                  {t("conn.telegram")}
                </button>
              </p>
            </div>

            <div className="space-y-1">
              <h3 className="text-[13px] font-semibold">{t("conn.noRedis")}</h3>
              <button
                className="text-[12px] text-highlight underline"
                onClick={() =>
                  void openUrl(
                    "https://redis.com/try-free/?utm_source=respapp&utm_medium=app&utm_campaign=newconn",
                  )
                }
              >
                {t("conn.redisCloud")}
              </button>
            </div>

            <div className="flex justify-end pt-2">
              <Button onClick={() => setTab("basic")}>{t("conn.skip")}</Button>
            </div>
          </div>
        ) : null}

        {tab === "basic" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-[130px_1fr] items-center gap-x-3 gap-y-2">
              <span className="text-[12px]">{t("conn.name")}</span>
              <TextInput
                value={draft.name}
                placeholder={t("conn.namePlaceholder")}
                autoFocus={isNew}
                onChange={(e) => set("name", e.target.value)}
              />

              <span className="text-[12px]">{t("conn.address")}</span>
              <div className="flex items-center gap-1">
                <TextInput
                  value={draft.host}
                  placeholder={t("conn.hostPlaceholder")}
                  onChange={(e) => set("host", e.target.value)}
                />
                <span>:</span>
                <NumberInput
                  className="w-[110px]"
                  min={1}
                  max={10_000_000}
                  value={draft.port}
                  onChange={(e) => set("port", Number(e.target.value))}
                />
              </div>
            </div>

            {!sshEnabled && !draft.sslEnabled && draft.host.toLowerCase() === "localhost" ? (
              <p className="text-[12px] text-muted">{t("conn.localhostHint")}</p>
            ) : null}

            <div className="grid grid-cols-[130px_1fr] items-center gap-x-3 gap-y-2">
              <span className="text-[12px]">{t("conn.password")}</span>
              <TextInput
                type="password"
                value={draft.auth}
                placeholder={t("conn.passwordPlaceholder")}
                onChange={(e) => set("auth", e.target.value)}
              />
              <span className="text-[12px]">{t("conn.username")}</span>
              <TextInput
                value={draft.username}
                placeholder={t("conn.usernamePlaceholder")}
                onChange={(e) => set("username", e.target.value)}
              />
            </div>

            <h3 className="pt-1 text-[13px] font-semibold">{t("conn.security")}</h3>
            <div className="flex gap-6">
              <Radio
                checked={draft.sslEnabled && !sshEnabled}
                onChange={() => set("sslEnabled", !(draft.sslEnabled && !sshEnabled))}
                label={t("conn.ssl")}
              />
              <Radio
                checked={sshEnabled}
                onChange={() => setSshEnabled((v) => !v)}
                label={t("conn.ssh")}
              />
            </div>

            {draft.sslEnabled && !sshEnabled ? (
              <div className="grid grid-cols-[130px_1fr] items-center gap-x-3 gap-y-2">
                <span className="text-[12px]">{t("conn.publicKey")}</span>
                <FilePathInput
                  path={draft.sslLocalCertPath}
                  placeholder={t("conn.publicKeyPlaceholder")}
                  filters={[{ name: t("conn.filterPublicKey"), extensions: ["pem", "crt"] }]}
                  onChange={(v) => set("sslLocalCertPath", v)}
                />
                <span className="text-[12px]">{t("conn.privateKey")}</span>
                <FilePathInput
                  path={draft.sslPrivateKeyPath}
                  placeholder={t("conn.privateKeyPlaceholder")}
                  filters={[{ name: t("conn.filterPrivateKey"), extensions: ["pem", "key"] }]}
                  onChange={(v) => set("sslPrivateKeyPath", v)}
                />
                <span className="text-[12px]">{t("conn.authority")}</span>
                <FilePathInput
                  path={draft.sslCaCertPath}
                  placeholder={t("conn.authorityPlaceholder")}
                  filters={[{ name: t("conn.filterAuthority"), extensions: ["pem", "crt"] }]}
                  onChange={(v) => set("sslCaCertPath", v)}
                />
                <span className="text-[12px]">{t("conn.strictMode")}</span>
                <Checkbox
                  checked={!draft.ignoreSslErrors}
                  onChange={(v) => set("ignoreSslErrors", !v)}
                  label=""
                />
              </div>
            ) : null}

            {sshEnabled ? (
              <div className="space-y-3 rounded-sm border border-border p-3">
                <div className="grid grid-cols-[130px_1fr] items-center gap-x-3 gap-y-2">
                  <span className="text-[12px]">{t("conn.sshAddress")}</span>
                  <div className="flex items-center gap-1">
                    <TextInput
                      value={draft.sshHost}
                      placeholder={t("conn.sshHostPlaceholder")}
                      onChange={(e) => set("sshHost", e.target.value)}
                    />
                    <span>:</span>
                    <NumberInput
                      className="w-[100px]"
                      min={1}
                      max={65535}
                      value={draft.sshPort}
                      onChange={(e) => set("sshPort", Number(e.target.value))}
                    />
                  </div>
                  <span className="text-[12px]">{t("conn.sshUser")}</span>
                  <TextInput
                    value={draft.sshUser}
                    placeholder={t("conn.sshUserPlaceholder")}
                    onChange={(e) => set("sshUser", e.target.value)}
                  />
                </div>

                <Checkbox
                  checked={draft.sshAgent}
                  onChange={(v) => set("sshAgent", v)}
                  label={t("conn.useAgent")}
                />
                <FilePathInput
                  path={draft.sshAgentPath}
                  placeholder={t("conn.agentPathPlaceholder")}
                  filters={[{ name: t("conn.filterSshAgent"), extensions: ["exe", "*"] }]}
                  onChange={(v) => set("sshAgentPath", v)}
                />

                <div className="rounded-sm border border-border p-2">
                  <Checkbox
                    checked={useSshKey}
                    onChange={setUseSshKey}
                    disabled={draft.sshAgent}
                    label={t("conn.privateKeyLabel")}
                  />
                  <div className={useSshKey && !draft.sshAgent ? "" : "opacity-50"}>
                    <FilePathInput
                      path={draft.sshPrivateKey}
                      placeholder={t("conn.privateKeyPathPlaceholder")}
                      filters={[
                        { name: t("conn.filterSshPrivateKey"), extensions: ["pem", "key"] },
                      ]}
                      onChange={(v) => set("sshPrivateKey", v)}
                    />
                  </div>
                </div>

                <div className="rounded-sm border border-border p-2">
                  <Checkbox
                    checked={useSshPassword}
                    onChange={setUseSshPassword}
                    disabled={draft.sshAgent}
                    label={useSshKey ? t("conn.passphrase") : t("conn.passwordLabel")}
                  />
                  <div className="mt-1 flex items-center gap-2">
                    <TextInput
                      type="password"
                      value={draft.sshPassword}
                      disabled={!useSshPassword || draft.askForSshPassword || draft.sshAgent}
                      placeholder={
                        useSshKey
                          ? t("conn.passphrasePlaceholder")
                          : draft.askForSshPassword
                            ? t("conn.passwordPromptPlaceholder")
                            : t("conn.sshPasswordPlaceholder")
                      }
                      onChange={(e) => set("sshPassword", e.target.value)}
                    />
                    <Checkbox
                      checked={draft.askForSshPassword}
                      onChange={(v) => set("askForSshPassword", v)}
                      label={t("conn.askPassword")}
                    />
                  </div>
                </div>

                <Checkbox
                  checked={draft.sslEnabled}
                  onChange={(v) => set("sslEnabled", v)}
                  label={t("conn.tlsOverSsh")}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "advanced" ? (
          <div className="grid grid-cols-[190px_1fr] items-center gap-x-3 gap-y-3">
            <h3 className="col-span-2 text-[13px] font-semibold">{t("conn.keysLoading")}</h3>
            <span className="text-[12px]">{t("conn.defaultFilter")}</span>
            <TextInput
              value={draft.keysPattern}
              placeholder={t("conn.defaultFilterPlaceholder")}
              onChange={(e) => set("keysPattern", e.target.value)}
            />
            <span className="text-[12px]">{t("conn.namespaceSeparator")}</span>
            <TextInput
              value={draft.namespaceSeparator}
              placeholder={t("conn.namespaceSeparatorPlaceholder")}
              onChange={(e) => set("namespaceSeparator", e.target.value)}
            />

            <h3 className="col-span-2 pt-1 text-[13px] font-semibold">{t("conn.timeouts")}</h3>
            <span className="text-[12px]">{t("conn.connectionTimeout")}</span>
            <NumberInput
              min={10}
              max={100000}
              value={draft.executeTimeout / 1000}
              onChange={(e) => set("executeTimeout", Number(e.target.value) * 1000)}
            />
            <span className="text-[12px]">{t("conn.executionTimeout")}</span>
            <NumberInput
              min={10}
              max={100000}
              value={draft.connectionTimeout / 1000}
              onChange={(e) => set("connectionTimeout", Number(e.target.value) * 1000)}
            />
            <span className="text-[12px]">{t("conn.dbDiscovery")}</span>
            <NumberInput
              min={1}
              max={100000}
              value={draft.dbScanLimit}
              onChange={(e) => set("dbScanLimit", Number(e.target.value))}
            />

            <h3 className="col-span-2 pt-1 text-[13px] font-semibold">{t("conn.cluster")}</h3>
            <span className="text-[12px]">{t("conn.overrideClusterHost")}</span>
            <Checkbox
              checked={draft.overrideClusterHost}
              onChange={(v) => set("overrideClusterHost", v)}
              label=""
            />

            <h3 className="col-span-2 pt-1 text-[13px] font-semibold">{t("conn.formatters")}</h3>
            <span className="text-[12px]">{t("conn.defaultFormatter")}</span>
            <Select
              value={
                draft.defaultFormatter === "auto"
                  ? "auto"
                  : draft.defaultFormatter === "last_selected"
                    ? "last_selected"
                    : "auto"
              }
              onChange={(e) => set("defaultFormatter", e.target.value)}
            >
              <option value="auto">{t("conn.formatterAuto")}</option>
              <option value="last_selected">{t("conn.formatterLast")}</option>
            </Select>

            <h3 className="col-span-2 pt-1 text-[13px] font-semibold">{t("conn.appearance")}</h3>
            <span className="text-[12px]">{t("conn.iconColor")}</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={draft.iconColor || "#c6302b"}
                className="h-7 w-12 rounded-sm border border-border bg-base"
                onChange={(e) => set("iconColor", e.target.value)}
              />
              <Button onClick={() => set("iconColor", "")}>{t("conn.reset")}</Button>
            </div>

            <h3 className="col-span-2 pt-1 text-[13px] font-semibold">
              {t("conn.protocolSection")}
            </h3>
            <span className="text-[12px]">{t("conn.respProtocol")}</span>
            <Select
              value={draft.protocol}
              onChange={(e) => set("protocol", e.target.value as ConnectionConfig["protocol"])}
            >
              <option value="resp2">{t("conn.resp2")}</option>
              <option value="resp3">{t("conn.resp3")}</option>
            </Select>
          </div>
        ) : null}
      </div>

      {testResult ? (
        <div
          className={`mt-3 rounded-sm border p-2 text-[12px] ${
            testResult.success ? "border-success/60 text-success" : "border-danger/60 text-danger"
          }`}
        >
          {testResult.message}
          {testResult.warning ? <div className="mt-1 text-muted">{testResult.warning}</div> : null}
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
        <Button onClick={() => void doTest()} disabled={busy}>
          {busy ? t("conn.testing") : t("conn.test")}
        </Button>
        {!isNew ? (
          <Button onClick={() => void openUrl("http://docs.resp.app/en/latest/quick-start/")}>
            {t("conn.quickStart")}
          </Button>
        ) : null}
        <div className="flex-1" />
        {invalid ? <span className="text-[12px] text-danger">{t("conn.invalid")}</span> : null}
        <Button variant="primary" onClick={doSave}>
          {t("common.ok")}
        </Button>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
      </div>

      {isNew ? (
        <button
          type="button"
          className="mt-2 text-[11px] text-muted underline"
          onClick={() => {
            setDraft(createEmptyConnection());
            onNotify(t("conn.resetDone"));
          }}
        >
          {t("conn.resetSettings")}
        </button>
      ) : null}
    </Dialog>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`border-b-2 px-2 pb-1 ${
        active ? "border-accent text-text" : "border-transparent text-muted hover:text-text"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
