import { openUrl } from "@tauri-apps/plugin-opener";
import Button from "../../components/ui/Button";
import { useT } from "../../lib/i18n";

/**
 * Replaces the original RedisInsight migration notice with facts about this
 * rebuild only: application name, version, supported Redis version, the
 * implemented capabilities and a quick-start entry point.
 */
export default function WelcomeTab({ onAddConnection }: { onAddConnection: () => void }) {
  const t = useT();
  const features = [
    t("welcome.feature.connections"),
    t("welcome.feature.tree"),
    t("welcome.feature.values"),
    t("welcome.feature.console"),
    t("welcome.feature.actions"),
    t("welcome.feature.live"),
    t("welcome.feature.language"),
  ];

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-6">
      <div className="w-full max-w-[620px]">
        <div className="flex gap-4">
          <div className="flex h-[50px] w-[50px] shrink-0 items-center justify-center rounded bg-accent text-[22px] font-bold text-white">
            R
          </div>
          <div className="space-y-4 text-[13px] leading-[1.5]">
            <div>
              <h1 className="text-[24px] font-normal leading-tight">
                <b>RESP</b>.app 1.0.0
              </h1>
              <p className="text-muted">{t("welcome.subtitle")}</p>
            </div>

            <p>{t("welcome.redisSupport")}</p>

            <div>
              <h2 className="mb-1 text-[13px] font-semibold">{t("welcome.featuresTitle")}</h2>
              <ul className="list-disc pl-5">
                {features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
            </div>

            <div className="rounded border border-border bg-surface p-3">
              <h2 className="mb-1 text-[13px] font-semibold">{t("welcome.quickStart")}</h2>
              <p className="mb-2">{t("welcome.quickStartHint")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={onAddConnection}>
                  {t("toolbar.addConnection")}
                </Button>
                <Button onClick={() => void openUrl("https://docs.resp.app/")}>
                  {t("welcome.docs")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
