import { openUrl } from "@tauri-apps/plugin-opener";
import Dialog from "../../components/ui/Dialog";
import Button from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
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
      <div className="flex min-h-[110px] flex-col items-center justify-center gap-6 py-2">
        <p className="max-w-[520px] text-center text-[14px] leading-relaxed text-text">
          {t("quickstart.message")}
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              onConnect();
            }}
          >
            <Icon name="plus" className="h-3.5 w-3.5" />
            {t("quickstart.connect")}
          </Button>
          <Button onClick={() => void openUrl("http://docs.resp.app/en/latest/quick-start/")}>
            <Icon name="help" className="h-3.5 w-3.5" />
            {t("quickstart.docs")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
