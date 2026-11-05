import { useState } from "react";

import Button from "../../components/ui/Button";
import Dialog from "../../components/ui/Dialog";
import { Select, TextInput } from "../../components/ui/fields";
import { ipc } from "../../lib/ipc";
import { errMessage } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { NewKeyRequest } from "../../lib/types";

const KEY_TYPES = ["string", "hash", "list", "set", "zset", "stream"] as const;

interface AddKeyDialogProps {
  connectionId: string;
  db: number;
  /** Namespace prefix for "Add New Key" from a namespace row. */
  initialName?: string;
  onClose: () => void;
  onCreated: () => void;
  onNotify: (message: string) => void;
}

/**
 * AddKeyDialog equivalent, wired to `create_key` (SET/HSETNX/SADD/ZADD/
 * LPUSH/XADD). Existing keys require an explicit overwrite confirmation.
 */
export default function AddKeyDialog({
  connectionId,
  db,
  initialName = "",
  onClose,
  onCreated,
  onNotify,
}: AddKeyDialogProps) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const [keyType, setKeyType] = useState<(typeof KEY_TYPES)[number]>("string");
  const [value, setValue] = useState("");
  const [field, setField] = useState("");
  const [score, setScore] = useState("0");
  const [members, setMembers] = useState("");
  const [streamId, setStreamId] = useState("*");
  const [busy, setBusy] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const submit = async (overwrite = false) => {
    if (!name.trim()) {
      onNotify(t("addKey.nameRequired"));
      return;
    }
    if ((keyType === "list" || keyType === "set") && !members.trim()) {
      onNotify(t("addKey.membersRequired"));
      return;
    }
    if (!overwrite) {
      try {
        await ipc.keyValueInfo({ connectionId, db, key: name.trim() });
        setConfirmOverwrite(true);
        return;
      } catch {
        // TYPE returned "none": the key is free.
      }
    }
    const request: NewKeyRequest = {
      key: name.trim(),
      keyType,
      value,
      field: keyType === "hash" ? field : null,
      score: keyType === "zset" ? Number.parseFloat(score) || 0 : null,
      members:
        keyType === "list" || keyType === "set"
          ? members
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
          : null,
      id: keyType === "stream" ? streamId || "*" : null,
    };
    setBusy(true);
    try {
      // Confirmed overwrite: DEL first so HSETNX/LPUSH/SADD/ZADD replace
      // instead of appending to the previous key of another type.
      if (overwrite) {
        await ipc.deleteKey({ connectionId, db, key: name.trim() });
      }
      await ipc.createKey({ connectionId, db, request });
      onCreated();
      onClose();
    } catch (error) {
      onNotify(t("common.operationFailed", { error: errMessage(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t("tree.addNewKey")}
      width={480}
      onClose={onClose}
      footer={
        confirmOverwrite ? (
          <>
            <Button variant="secondary" onClick={() => setConfirmOverwrite(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void submit(true)} disabled={busy}>
              {t("addKey.overwriteAction")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void submit(false)} disabled={busy}>
              {busy ? t("common.saving") : t("common.save")}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        {confirmOverwrite ? (
          <div className="rounded-md border border-danger/50 bg-danger/5 p-3 t-13 text-text">
            {t("addKey.existsWarning", { name: name.trim() })}
          </div>
        ) : null}
        <label className="block t-13">
          <span className="mb-1 block text-muted">{t("addKey.name")}</span>
          <TextInput value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <label className="block t-13">
          <span className="mb-1 block text-muted">{t("addKey.type")}</span>
          <Select
            value={keyType}
            onChange={(event) => setKeyType(event.target.value as (typeof KEY_TYPES)[number])}
          >
            {KEY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </Select>
        </label>
        {keyType === "hash" ? (
          <label className="block t-13">
            <span className="mb-1 block text-muted">{t("addKey.field")}</span>
            <TextInput value={field} onChange={(event) => setField(event.target.value)} />
          </label>
        ) : null}
        {keyType === "zset" ? (
          <label className="block t-13">
            <span className="mb-1 block text-muted">{t("addKey.score")}</span>
            <TextInput value={score} onChange={(event) => setScore(event.target.value)} />
          </label>
        ) : null}
        {keyType === "list" || keyType === "set" ? (
          <label className="block t-13">
            <span className="mb-1 block text-muted">{t("addKey.members")}</span>
            <textarea
              className="h-24 w-full resize-none rounded-sm border border-border bg-base px-2 py-1 font-mono t-13 text-text outline-none hover:border-muted/50 focus:border-highlight/60"
              value={members}
              onChange={(event) => setMembers(event.target.value)}
            />
          </label>
        ) : keyType === "stream" ? (
          <>
            <label className="block t-13">
              <span className="mb-1 block text-muted">{t("addKey.entryId")}</span>
              <TextInput value={streamId} onChange={(event) => setStreamId(event.target.value)} />
            </label>
            <label className="block t-13">
              <span className="mb-1 block text-muted">{t("addKey.entry")}</span>
              <textarea
                className="h-24 w-full resize-none rounded-sm border border-border bg-base px-2 py-1 font-mono t-13 text-text outline-none hover:border-muted/50 focus:border-highlight/60"
                placeholder='{"field":"value"}'
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="block t-13">
            <span className="mb-1 block text-muted">{t("common.value")}</span>
            <textarea
              className="h-24 w-full resize-none rounded-sm border border-border bg-base px-2 py-1 font-mono t-13 text-text outline-none hover:border-muted/50 focus:border-highlight/60"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        )}
      </div>
    </Dialog>
  );
}
