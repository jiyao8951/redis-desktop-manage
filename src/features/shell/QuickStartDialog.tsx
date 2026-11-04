import { openUrl } from "@tauri-apps/plugin-opener";
import Dialog from "../../components/ui/Dialog";
import Button from "../../components/ui/Button";
import { useT } from "../../lib/i18n";

/**
 * Mirrors src/qml/QuickStartDialog.qml: shown when no connections exist.
 */
export default function QuickStartDialog({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: () => void;
}) {
  const t = useT();
  return (
    <Dialog title={t("quickstart.title")} width={750} onClose={onClose}>
      <div className="flex min-h-[110px] flex-col items-center justify-center gap-7 py-2">
        <p className="text-center text-[16px]">{t("quickstart.message")}</p>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              onConnect();
            }}
          >
            {t("quickstart.connect")}
          </Button>
          <Button onClick={() => void openUrl("http://docs.resp.app/en/latest/quick-start/")}>
            {t("quickstart.docs")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
