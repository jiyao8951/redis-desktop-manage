import { useState } from "react";
import Button from "../../components/ui/Button";
import DangerDialog from "../../components/ui/DangerDialog";
import Dialog from "../../components/ui/Dialog";
import { Checkbox, Field, NumberInput, Select, TextInput } from "../../components/ui/fields";
import { ipc } from "../../lib/ipc";
import { errMessage } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ConnectionSummary } from "../../lib/types";

interface BulkTtlDialogProps {
  connectionId: string;
  dbIndex: number;
  connectionName: string;
  defaultPattern: string;
  scanLimit: number;
  /** Current key count of the target DB, when known. */
  dbKeyCount?: number | null;
  onClose: () => void;
  onDone: (changed: number) => void;
  onNotify: (message: string) => void;
}

/**
 * "Set TTL for multiple keys" (BulkOperationsDialog "ttl" state). The original
 * applies EXPIRE to every key matching the pattern and lets the user enter
 * -1..10,000,000 seconds.
 */
export function BulkTtlDialog({
  connectionId,
  dbIndex,
  connectionName,
  defaultPattern,
  scanLimit,
  dbKeyCount,
  onClose,
  onDone,
  onNotify,
}: BulkTtlDialogProps) {
  const t = useT();
  const [pattern, setPattern] = useState(defaultPattern || "*");
  const [ttl, setTtl] = useState("0");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const seconds = Number(ttl);
  const ttlValid = Number.isFinite(seconds) && Number.isInteger(seconds);

  const submit = () => {
    if (!ttlValid) {
      onNotify(t("bulk.ttlInvalid"));
      return;
    }
    setConfirming(true);
  };

  const apply = async () => {
    if (!ttlValid) return;
    setBusy(true);
    try {
      const changed = await ipc.setTtlByPattern({
        connectionId,
        db: dbIndex,
        pattern,
        ttl: seconds,
        limit: scanLimit,
      });
      onDone(changed);
      onClose();
    } catch (error) {
      onNotify(errMessage(error));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
    <Dialog
      title={t("bulk.title")}
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {t("bulk.setTtl")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="t-15 font-medium">{t("bulk.ttlTitle")}</p>
        <div className="grid grid-cols-[170px_1fr] items-center gap-2 t-13">
          <span className="text-muted">{t("bulk.server")}</span>
          <span>{connectionName}</span>
          <span className="text-muted">{t("bulk.database")}</span>
          <span>{dbIndex}</span>
        </div>
        <Field label={t("bulk.pattern")}>
          <TextInput value={pattern} onChange={(event) => setPattern(event.target.value)} />
        </Field>
        <Field label={t("bulk.ttl")} hint={t("bulk.ttlHint")}>
          <NumberInput value={ttl} onChange={(event) => setTtl(event.target.value)} />
        </Field>
      </div>
    </Dialog>
    {confirming ? (
      <DangerDialog
        title={t("danger.bulkTtlTitle")}
        description={t("danger.bulkTtlDescription", { pattern, ttl: seconds })}
        serverName={connectionName}
        database={dbIndex}
        keyCount={dbKeyCount}
        requireText={connectionName}
        confirmLabel={t("bulk.setTtl")}
        busy={busy}
        onConfirm={() => void apply()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      />
    ) : null}
    </>
  );
}

interface CopyKeysDialogProps {
  sourceConnectionId: string;
  sourceDb: number;
  sourceName: string;
  connections: ConnectionSummary[];
  defaultPattern: string;
  scanLimit: number;
  onClose: () => void;
  onDone: (copied: number) => void;
  onNotify: (message: string) => void;
}

/**
 * "Copy keys to another database" (BulkOperationsDialog "copy_keys" state):
 * DUMP on the source connection, RESTORE on the destination. REPLACE is opt-in
 * because RESTORE fails with BUSYKEY when a target key exists.
 */
export function CopyKeysDialog({
  sourceConnectionId,
  sourceDb,
  sourceName,
  connections,
  defaultPattern,
  scanLimit,
  onClose,
  onDone,
  onNotify,
}: CopyKeysDialogProps) {
  const t = useT();
  const [pattern, setPattern] = useState(defaultPattern || "*");
  const [targetId, setTargetId] = useState(
    connections.find((item) => item.id !== sourceConnectionId)?.id ?? sourceConnectionId,
  );
  const [targetDb, setTargetDb] = useState("0");
  const [ttl, setTtl] = useState("0");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const submit = () => {
    if (!targetId) {
      onNotify(t("bulk.selectTarget"));
      return;
    }
    const db = Number(targetDb);
    const seconds = Number(ttl);
    if (!Number.isInteger(db) || db < 0) {
      onNotify(t("bulk.dbInvalid"));
      return;
    }
    if (!Number.isFinite(seconds)) {
      onNotify(t("bulk.ttlInvalid"));
      return;
    }
    setConfirming(true);
  };

  const apply = async () => {
    const db = Number(targetDb);
    const seconds = Number(ttl);
    setBusy(true);
    try {
      const copied = await ipc.copyKeys({
        sourceConnectionId,
        sourceDb,
        pattern,
        targetConnectionId: targetId,
        targetDb: db,
        ttl: seconds,
        replace,
        limit: scanLimit,
      });
      onDone(copied);
      onClose();
    } catch (error) {
      onNotify(errMessage(error));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const targetName = connections.find((item) => item.id === targetId)?.name ?? targetId;
  const targetDbNumber = Number(targetDb);

  return (
    <>
    <Dialog
      title={t("bulk.title")}
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {t("bulk.copy")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="t-15 font-medium">{t("bulk.copyTitle")}</p>
        <div className="grid grid-cols-[190px_1fr] items-center gap-2 t-13">
          <span className="text-muted">{t("bulk.server")}</span>
          <span>{sourceName}</span>
          <span className="text-muted">{t("bulk.database")}</span>
          <span>{sourceDb}</span>
        </div>
        <Field label={t("bulk.pattern")}>
          <TextInput value={pattern} onChange={(event) => setPattern(event.target.value)} />
        </Field>
        <Field label={t("bulk.targetServer")}>
          <Select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            {connections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("bulk.targetDb")}>
          <NumberInput
            value={targetDb}
            min={0}
            onChange={(event) => setTargetDb(event.target.value)}
          />
        </Field>
        <Field label={t("bulk.ttl")} hint={t("bulk.copyTtlHint")}>
          <NumberInput value={ttl} onChange={(event) => setTtl(event.target.value)} />
        </Field>
        <Checkbox checked={replace} onChange={setReplace} label={t("bulk.replace")} />
      </div>
    </Dialog>
    {confirming ? (
      <DangerDialog
        title={t("danger.copyKeysTitle")}
        description={`${t("danger.copyKeysDescription", {
          pattern,
          source: `${sourceName} db${sourceDb}`,
          target: `${targetName} db${Number.isInteger(targetDbNumber) ? targetDbNumber : targetDb}`,
        })}${replace ? `\n\n${t("danger.copyReplaceWarning")}` : ""}`}
        serverName={targetName}
        database={Number.isInteger(targetDbNumber) ? targetDbNumber : null}
        requireText={replace ? targetName : null}
        confirmLabel={t("bulk.copy")}
        busy={busy}
        onConfirm={() => void apply()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      />
    ) : null}
    </>
  );
}
