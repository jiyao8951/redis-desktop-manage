import { useState, type ReactNode } from "react";
import Dialog from "../../components/ui/Dialog";
import Button from "../../components/ui/Button";
import FilePathInput from "../../components/ui/FilePathInput";
import { Checkbox, NumberInput, Radio, Select, TextInput } from "../../components/ui/fields";
import { Icon } from "../../components/ui/Icon";
import { ipc } from "../../lib/ipc";
import { createEmptyConnection } from "../../lib/defaults";
import { clampInt, errMessage } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ConnectionConfig, TestResult } from "../../lib/types";

type Tab = "basic" | "advanced";

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
  const [tab, setTab] = useState<Tab>("basic");
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

  const footer = (
    <div className="flex w-full items-center gap-2">
      <Button onClick={() => void doTest()} disabled={busy}>
        {busy ? t("conn.testing") : t("conn.test")}
      </Button>
      {isNew ? (
        <button
          type="button"
          className="t-12 text-muted underline-offset-2 hover:text-text hover:underline"
          onClick={() => {
            setDraft(createEmptyConnection());
            onNotify(t("conn.resetDone"));
          }}
        >
          {t("conn.resetSettings")}
        </button>
      ) : null}
      <div className="flex-1" />
      {invalid ? <span className="t-13 text-danger">{t("conn.invalid")}</span> : null}
      <Button onClick={onClose}>{t("common.cancel")}</Button>
      <Button variant="primary" onClick={doSave}>
        {t("common.ok")}
      </Button>
    </div>
  );

  return (
    <Dialog
      title={isNew ? t("conn.titleNew") : t("conn.titleEdit", { name: initial.name })}
      width={860}
      onClose={onClose}
      footer={footer}
    >
      <div className="mb-4 inline-flex rounded-md border border-border bg-surface p-1 t-13">
        <TabButton active={tab === "basic"} onClick={() => setTab("basic")}>
          {t("conn.tabBasic")}
        </TabButton>
        <TabButton active={tab === "advanced"} onClick={() => setTab("advanced")}>
          {t("conn.tabAdvanced")}
        </TabButton>
      </div>

      {testResult ? (
        <div
          className={`mb-4 rounded-md border p-3 t-13 ${
            testResult.success ? "border-success/50 bg-success/5" : "border-danger/50 bg-danger/5"
          }`}
        >
          <div
            className={`flex items-center gap-1.5 font-medium ${
              testResult.success ? "text-success" : "text-danger"
            }`}
          >
            <Icon name={testResult.success ? "check" : "alert"} />
            {testResult.success ? t("conn.testSuccess") : t("conn.testFailed")}
          </div>
          {testResult.message ? (
            <div className="mt-1.5 whitespace-pre-wrap text-text/90">{testResult.message}</div>
          ) : null}
          {testResult.warning ? (
            <div className="mt-1.5 whitespace-pre-wrap text-muted">{testResult.warning}</div>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-[420px]">
        {tab === "basic" ? (
          <div className="space-y-4">
            <Section title={t("conn.groupEndpoint")}>
              <div className="grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-2">
                <span className="t-13 text-muted">{t("conn.name")}</span>
                <TextInput
                  value={draft.name}
                  placeholder={t("conn.namePlaceholder")}
                  autoFocus={isNew}
                  onChange={(e) => set("name", e.target.value)}
                />

                <span className="t-13 text-muted">{t("conn.address")}</span>
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
                <p className="mt-2 t-13 text-muted">{t("conn.localhostHint")}</p>
              ) : null}
            </Section>

            <Section title={t("conn.groupAuth")}>
              <div className="grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-2">
                <span className="t-13 text-muted">{t("conn.password")}</span>
                <TextInput
                  type="password"
                  value={draft.auth}
                  placeholder={t("conn.passwordPlaceholder")}
                  onChange={(e) => set("auth", e.target.value)}
                />
                <span className="t-13 text-muted">{t("conn.username")}</span>
                <TextInput
                  value={draft.username}
                  placeholder={t("conn.usernamePlaceholder")}
                  onChange={(e) => set("username", e.target.value)}
                />
              </div>
            </Section>

            <Section title={t("conn.security")}>
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
                <div className="mt-3 grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-2">
                  <span className="t-13 text-muted">{t("conn.publicKey")}</span>
                  <FilePathInput
                    path={draft.sslLocalCertPath}
                    placeholder={t("conn.publicKeyPlaceholder")}
                    filters={[{ name: t("conn.filterPublicKey"), extensions: ["pem", "crt"] }]}
                    onChange={(v) => set("sslLocalCertPath", v)}
                  />
                  <span className="t-13 text-muted">{t("conn.privateKey")}</span>
                  <FilePathInput
                    path={draft.sslPrivateKeyPath}
                    placeholder={t("conn.privateKeyPlaceholder")}
                    filters={[{ name: t("conn.filterPrivateKey"), extensions: ["pem", "key"] }]}
                    onChange={(v) => set("sslPrivateKeyPath", v)}
                  />
                  <span className="t-13 text-muted">{t("conn.authority")}</span>
                  <FilePathInput
                    path={draft.sslCaCertPath}
                    placeholder={t("conn.authorityPlaceholder")}
                    filters={[{ name: t("conn.filterAuthority"), extensions: ["pem", "crt"] }]}
                    onChange={(v) => set("sslCaCertPath", v)}
                  />
                  <span className="t-13 text-muted">{t("conn.strictMode")}</span>
                  <Checkbox
                    checked={!draft.ignoreSslErrors}
                    onChange={(v) => set("ignoreSslErrors", !v)}
                    label=""
                  />
                </div>
              ) : null}

              {sshEnabled ? (
                <div className="mt-3 space-y-3 rounded-md border border-border bg-base p-3">
                  <div className="grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-2">
                    <span className="t-13 text-muted">{t("conn.sshAddress")}</span>
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
                    <span className="t-13 text-muted">{t("conn.sshUser")}</span>
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

                  <div className="rounded-md border border-border p-2">
                    <Checkbox
                      checked={useSshKey}
                      onChange={setUseSshKey}
                      disabled={draft.sshAgent}
                      label={t("conn.privateKeyLabel")}
                    />
                    <div className={`mt-2 ${useSshKey && !draft.sshAgent ? "" : "opacity-50"}`}>
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

                  <div className="rounded-md border border-border p-2">
                    <Checkbox
                      checked={useSshPassword}
                      onChange={setUseSshPassword}
                      disabled={draft.sshAgent}
                      label={useSshKey ? t("conn.passphrase") : t("conn.passwordLabel")}
                    />
                    <div className="mt-2 flex items-center gap-2">
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
            </Section>
          </div>
        ) : null}

        {tab === "advanced" ? (
          <div className="space-y-4">
            <Section title={t("conn.keysLoading")}>
              <div className="grid grid-cols-[150px_1fr] items-center gap-x-3 gap-y-2">
                <span className="t-13 text-muted">{t("conn.defaultFilter")}</span>
                <TextInput
                  value={draft.keysPattern}
                  placeholder={t("conn.defaultFilterPlaceholder")}
                  onChange={(e) => set("keysPattern", e.target.value)}
                />
                <span className="t-13 text-muted">{t("conn.namespaceSeparator")}</span>
                <TextInput
                  value={draft.namespaceSeparator}
                  placeholder={t("conn.namespaceSeparatorPlaceholder")}
                  onChange={(e) => set("namespaceSeparator", e.target.value)}
                />
              </div>
            </Section>

            <Section title={t("conn.timeouts")}>
              <div className="grid grid-cols-[150px_110px_1fr] items-center gap-x-3 gap-y-2">
                <span className="t-13 text-muted">{t("conn.connectionTimeout")}</span>
                <NumberInput
                  min={10}
                  max={100000}
                  value={draft.connectionTimeout / 1000}
                  onChange={(e) => set("connectionTimeout", Number(e.target.value) * 1000)}
                />
                <span className="t-12 text-muted">{t("conn.seconds")}</span>
                <span className="t-13 text-muted">{t("conn.executionTimeout")}</span>
                <NumberInput
                  min={10}
                  max={100000}
                  value={draft.executeTimeout / 1000}
                  onChange={(e) => set("executeTimeout", Number(e.target.value) * 1000)}
                />
                <span className="t-12 text-muted">{t("conn.seconds")}</span>
                <span className="t-13 text-muted">{t("conn.dbDiscovery")}</span>
                <NumberInput
                  min={1}
                  max={100000}
                  value={draft.dbScanLimit}
                  onChange={(e) => set("dbScanLimit", Number(e.target.value))}
                />
                <span />
              </div>
            </Section>

            <Section title={t("conn.cluster")}>
              <Checkbox
                checked={draft.overrideClusterHost}
                onChange={(v) => set("overrideClusterHost", v)}
                label={t("conn.overrideClusterHost")}
              />
            </Section>

            <Section title={t("conn.protocolSection")}>
              <div className="grid grid-cols-[150px_1fr] items-center gap-x-3 gap-y-2">
                <span className="t-13 text-muted">{t("conn.respProtocol")}</span>
                <Select
                  value={draft.protocol}
                  onChange={(e) =>
                    set("protocol", e.target.value as ConnectionConfig["protocol"])
                  }
                >
                  <option value="resp2">{t("conn.resp2")}</option>
                  <option value="resp3">{t("conn.resp3")}</option>
                </Select>
                <span className="t-13 text-muted">{t("conn.defaultFormatter")}</span>
                <Select
                  value={
                    draft.defaultFormatter === "last_selected" ? "last_selected" : "auto"
                  }
                  onChange={(e) => set("defaultFormatter", e.target.value)}
                >
                  <option value="auto">{t("conn.formatterAuto")}</option>
                  <option value="last_selected">{t("conn.formatterLast")}</option>
                </Select>
              </div>
            </Section>

            <Section title={t("conn.appearance")}>
              <div className="flex items-center gap-3">
                <span className="t-13 text-muted">{t("conn.iconColor")}</span>
                <input
                  type="color"
                  value={draft.iconColor || "#c6302b"}
                  className="h-7 w-12 cursor-pointer rounded-sm border border-border bg-base"
                  onChange={(e) => set("iconColor", e.target.value)}
                />
                <Button onClick={() => set("iconColor", "")}>{t("conn.reset")}</Button>
              </div>
            </Section>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-surface/40 p-4">
      <h3 className="mb-3 t-13 font-semibold uppercase tracking-wide text-muted">
        {title}
      </h3>
      {children}
    </section>
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
      className={`rounded-sm px-3 py-1.5 transition-colors ${
        active
          ? "bg-base text-text shadow-sm"
          : "text-muted hover:bg-base/60 hover:text-text"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
