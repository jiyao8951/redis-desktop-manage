import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import Button from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { useT } from "../../lib/i18n";

/**
 * Original welcome page rebuilt with facts about this application only:
 * name, version, supported Redis version, implemented capabilities and a
 * quick-start entry point.
 */
export default function WelcomeTab({ onAddConnection }: { onAddConnection: () => void }) {
  const t = useT();
  const [version, setVersion] = useState("");

  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
    <div className="flex h-full items-center justify-center overflow-auto bg-surface/30 p-4 sm:p-6">
      <div className="w-full min-w-0 max-w-[640px]">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-accent text-[20px] font-bold text-white">
            R
          </div>
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold leading-tight">
              Redis Desktop Manager
              {version ? (
                <span className="ml-1.5 font-mono t-13 font-normal text-muted">
                  v{version}
                </span>
              ) : null}
            </h1>
            <p className="t-13 text-muted">{t("welcome.subtitle")}</p>
          </div>
        </div>

        <div className="rounded-md border border-border bg-base p-4 t-14 leading-[1.55] shadow-sm">
          <p className="text-muted">{t("welcome.redisSupport")}</p>

          <h2 className="mb-2 mt-4 t-13 font-semibold uppercase tracking-wide text-muted">
            {t("welcome.featuresTitle")}
          </h2>
          <ul className="grid gap-x-4 gap-y-1.5 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
            {features.map((feature) => (
              <li key={feature} className="flex items-start gap-1.5">
                <span className="mt-[1px] shrink-0 text-success">
                  <Icon name="check" className="h-3.5 w-3.5" />
                </span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4 rounded-md border border-border bg-base p-4 shadow-sm">
          <h2 className="mb-1 t-14 font-semibold">{t("welcome.quickStart")}</h2>
          <p className="mb-3 t-13 text-muted">{t("welcome.quickStartHint")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={onAddConnection}>
              <Icon name="plus" className="h-3.5 w-3.5" />
              {t("toolbar.addConnection")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
