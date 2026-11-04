import { useState } from "react";

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

  const submit = async () => {
    if (!name.trim()) {
      onNotify(t("addKey.nameRequired"));
      return;
    }
    if ((keyType === "list" || keyType === "set") && !members.trim()) {
      onNotify(t("addKey.membersRequired"));
      return;
    }
    let existing = false;
    try {
      await ipc.keyValueInfo({ connectionId, db, key: name.trim() });
      existing = true;
      if (!window.confirm(t("addKey.overwrite"))) {
        return;
      }
    } catch {
      // TYPE returned "none": the key is free.
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
      if (existing) {
        await ipc.deleteKey({ connectionId, db, key: name.trim() });
      }
      await ipc.createKey({ connectionId, db, request });
      onCreated();
      onClose();
    } catch (error) {
      onNotify(errMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[480px] rounded border border-border bg-surface p-4 text-sm text-text">
        <h2 className="mb-3 text-base font-medium">{t("tree.addNewKey")}</h2>
        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-muted">{t("addKey.name")}</span>
          <input
            className="w-full rounded border border-border bg-base px-2 py-1 outline-none"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-muted">{t("addKey.type")}</span>
          <select
            className="w-full rounded border border-border bg-base px-2 py-1 outline-none"
            value={keyType}
            onChange={(event) => setKeyType(event.target.value as (typeof KEY_TYPES)[number])}
          >
            {KEY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        {keyType === "hash" ? (
          <label className="mb-2 block">
            <span className="mb-1 block text-xs text-muted">{t("addKey.field")}</span>
            <input
              className="w-full rounded border border-border bg-base px-2 py-1 outline-none"
              value={field}
              onChange={(event) => setField(event.target.value)}
            />
          </label>
        ) : null}
        {keyType === "zset" ? (
          <label className="mb-2 block">
            <span className="mb-1 block text-xs text-muted">{t("addKey.score")}</span>
            <input
              className="w-full rounded border border-border bg-base px-2 py-1 outline-none"
              value={score}
              onChange={(event) => setScore(event.target.value)}
            />
          </label>
        ) : null}
        {keyType === "list" || keyType === "set" ? (
          <label className="mb-2 block">
            <span className="mb-1 block text-xs text-muted">{t("addKey.members")}</span>
            <textarea
              className="h-24 w-full resize-none rounded border border-border bg-base px-2 py-1 font-mono text-xs outline-none"
              value={members}
              onChange={(event) => setMembers(event.target.value)}
            />
          </label>
        ) : keyType === "stream" ? (
          <>
            <label className="mb-2 block">
              <span className="mb-1 block text-xs text-muted">{t("addKey.entryId")}</span>
              <input
                className="w-full rounded border border-border bg-base px-2 py-1 outline-none"
                value={streamId}
                onChange={(event) => setStreamId(event.target.value)}
              />
            </label>
            <label className="mb-2 block">
              <span className="mb-1 block text-xs text-muted">{t("addKey.entry")}</span>
              <textarea
                className="h-24 w-full resize-none rounded border border-border bg-base px-2 py-1 font-mono text-xs outline-none"
                placeholder='{"field":"value"}'
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="mb-2 block">
            <span className="mb-1 block text-xs text-muted">{t("common.value")}</span>
            <textarea
              className="h-24 w-full resize-none rounded border border-border bg-base px-2 py-1 font-mono text-xs outline-none"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-border px-3 py-1"
            onClick={onClose}
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="rounded border border-accent bg-accent px-3 py-1 text-base"
            onClick={() => void submit()}
            disabled={busy}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
