import { useState } from "react";
import Dialog from "../../components/ui/Dialog";
import Button from "../../components/ui/Button";
import { Checkbox, Field, NumberInput, Select } from "../../components/ui/fields";
import { clampInt } from "../../lib/format";
import { LANGUAGE_LABELS, resolveLanguage, useLanguage, useT, type Language } from "../../lib/i18n";
import type { Settings } from "../../lib/types";

/**
 * Mirrors the parts of src/qml/settings/GlobalSettings.qml that this build
 * binds to real behaviour (tree, live update, value editor, fonts, language).
 */
export default function SettingsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
}) {
  const t = useT();
  const currentLanguage = useLanguage();
  const [draft, setDraft] = useState<Settings>(settings);
  // "" means "not chosen yet"; the select shows the detected language.
  const language: Language = draft.language ? resolveLanguage(draft.language) : currentLanguage;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    onSave({
      ...draft,
      scanLimit: clampInt(draft.scanLimit, 1000, 500_000),
      treeItemMaxChilds: clampInt(draft.treeItemMaxChilds, 1, 100_000),
      scanPageSize: clampInt(draft.scanPageSize, 1, 1000),
      liveUpdateKeysLimit: clampInt(draft.liveUpdateKeysLimit, 100, 100_000),
      liveUpdateInterval: clampInt(draft.liveUpdateInterval, 3, 100_000),
      valueSizeLimit: clampInt(draft.valueSizeLimit, 1000, 20_000_000),
      valueEditorPageSize: clampInt(draft.valueEditorPageSize, 10, 10_000),
      appFontSize: clampInt(draft.appFontSize, 6, 48),
      valueEditorFontSize: clampInt(draft.valueEditorFontSize, 6, 48),
    });
  };

  return (
    <Dialog
      title={t("settings.title")}
      width={620}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={save}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <section className="space-y-3 rounded-md border border-border bg-surface/40 p-4">
          <h3 className="t-13 font-semibold uppercase tracking-wide text-muted">
            {t("settings.appearance")}
          </h3>
          <Field label={t("settings.language")}>
            <Select value={language} onChange={(e) => set("language", e.target.value as Language)}>
              <option value="en">{LANGUAGE_LABELS.en}</option>
              <option value="zh-CN">{LANGUAGE_LABELS["zh-CN"]}</option>
            </Select>
          </Field>
          <Field label={t("settings.darkMode")}>
            <Select
              value={draft.darkMode}
              onChange={(e) => set("darkMode", e.target.value as Settings["darkMode"])}
            >
              <option value="auto">{t("settings.darkAuto")}</option>
              <option value="on">{t("settings.darkOn")}</option>
              <option value="off">{t("settings.darkOff")}</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("settings.appFont")} hint={t("settings.appFontHint")}>
              <input
                className="h-[var(--ui-control)] w-full rounded-sm border border-border bg-base px-2 t-13 outline-none"
                value={draft.appFont}
                placeholder={t("settings.systemDefault")}
                onChange={(e) => set("appFont", e.target.value)}
              />
            </Field>
            <Field label={t("settings.appFontSize")}>
              <NumberInput
                min={6}
                max={48}
                value={draft.appFontSize}
                onChange={(e) => set("appFontSize", Number(e.target.value))}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3 rounded-md border border-border bg-surface/40 p-4">
          <h3 className="t-13 font-semibold uppercase tracking-wide text-muted">
            {t("settings.treeSection")}
          </h3>
          <div className="flex flex-col gap-2">
            <Checkbox
              checked={draft.showNamespacesOnTop}
              onChange={(v) => set("showNamespacesOnTop", v)}
              label={t("settings.showNamespaces")}
            />
            <Checkbox
              checked={draft.reopenNamespacesOnReload}
              onChange={(v) => set("reopenNamespacesOnReload", v)}
              label={t("settings.reopenNamespaces")}
            />
            <Checkbox
              checked={draft.namespacedKeysShortName}
              onChange={(v) => set("namespacedKeysShortName", v)}
              label={t("settings.shortNames")}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 pt-1">
            <Field label={t("settings.scanLimit")} hint={t("settings.scanLimitHint")}>
              <NumberInput
                min={1000}
                value={draft.scanLimit}
                onChange={(e) => set("scanLimit", Number(e.target.value))}
              />
            </Field>
            <Field label={t("settings.maxChilds")}>
              <NumberInput
                min={1}
                value={draft.treeItemMaxChilds}
                onChange={(e) => set("treeItemMaxChilds", Number(e.target.value))}
              />
            </Field>
            <Field label={t("settings.scanPageSize")}>
              <NumberInput
                min={1}
                max={1000}
                value={draft.scanPageSize}
                onChange={(e) => set("scanPageSize", Number(e.target.value))}
              />
            </Field>
            <Field label={t("settings.liveKeys")}>
              <NumberInput
                min={100}
                value={draft.liveUpdateKeysLimit}
                onChange={(e) => set("liveUpdateKeysLimit", Number(e.target.value))}
              />
            </Field>
            <Field label={t("settings.liveInterval")}>
              <NumberInput
                min={3}
                value={draft.liveUpdateInterval}
                onChange={(e) => set("liveUpdateInterval", Number(e.target.value))}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3 rounded-md border border-border bg-surface/40 p-4">
          <h3 className="t-13 font-semibold uppercase tracking-wide text-muted">
            {t("settings.valueSection")}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("settings.valueSize")} hint={t("settings.valueSizeHint")}>
              <NumberInput
                min={1000}
                value={draft.valueSizeLimit}
                onChange={(e) => set("valueSizeLimit", Number(e.target.value))}
              />
            </Field>
            <Field label={t("settings.pageSize")} hint={t("settings.pageSizeHint")}>
              <NumberInput
                min={10}
                value={draft.valueEditorPageSize}
                onChange={(e) => set("valueEditorPageSize", Number(e.target.value))}
              />
            </Field>
            <Field label={t("settings.valueFont")}>
              <input
                className="h-[var(--ui-control)] w-full rounded-sm border border-border bg-base px-2 t-13 outline-none"
                value={draft.valueEditorFont}
                placeholder={t("settings.valueFontPlaceholder")}
                onChange={(e) => set("valueEditorFont", e.target.value)}
              />
            </Field>
            <Field label={t("settings.valueFontSize")}>
              <NumberInput
                min={6}
                max={48}
                value={draft.valueEditorFontSize}
                onChange={(e) => set("valueEditorFontSize", Number(e.target.value))}
              />
            </Field>
          </div>
        </section>
      </div>
    </Dialog>
  );
}
