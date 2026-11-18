import { Check, CarFront, X } from "lucide-react";
import { useProject } from "../../core";
import { useI18n } from "../../i18n";
import { Button, Page, cx } from "../../ui";
import type { FeatureProps } from "../registry";
import { useDraftTemplate } from "./hooks";
import { draft, useDraft, WIZARD_STEPS, type WizardStep } from "./store";
import { LiveView } from "./LiveView";
import { StepTemplate } from "./StepTemplate";
import { StepAssign } from "./StepAssign";
import { StepTune } from "./StepTune";
import { StepApply } from "./StepApply";
import { tVehicle } from "./messages";
import "./vehicle.css";

function StepBar({
  step,
  canLeaveTemplate,
}: {
  step: WizardStep;
  canLeaveTemplate: boolean;
}) {
  const at = WIZARD_STEPS.indexOf(step);
  return (
    <ol className="vh-steps" aria-label={tVehicle("stepBar")}>
      {WIZARD_STEPS.map((s, i) => {
        const enabled = s === "template" || canLeaveTemplate;
        return (
          <li
            key={s}
            className={cx(
              "vh-steps__item",
              i < at && "is-done",
              i === at && "is-current",
            )}
          >
            <button
              type="button"
              disabled={!enabled}
              aria-current={i === at ? "step" : undefined}
              onClick={() => draft.setStep(s)}
              data-step={s}
            >
              <span className="vh-steps__num">
                {i < at ? <Check size={13} aria-hidden /> : i + 1}
              </span>
              <span className="vh-steps__label">{tVehicle(`steps.${s}`)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Wizard({ hasVehicle }: { hasVehicle: boolean }) {
  const { tl } = useI18n();
  const step = useDraft((s) => s.step);
  const { base, tpl } = useDraftTemplate();
  const ready = !!tpl && tpl.slots.length > 0;
  const go = (s: WizardStep) => () => draft.setStep(s);
  return (
    <Page
      title={tVehicle("wizardTitle")}
      subtitle={tpl ? tl(tpl.name) : tVehicle("subtitle")}
      icon={CarFront}
      toolbar={
        <StepBar step={ready ? step : "template"} canLeaveTemplate={ready} />
      }
      actions={
        hasVehicle ? (
          <Button
            size="sm"
            variant="ghost"
            icon={X}
            onClick={() => draft.close()}
          >
            {tVehicle("cancelWizard")}
          </Button>
        ) : undefined
      }
    >
      <div className="vh-wizard">
        {(!ready || step === "template") && (
          <StepTemplate onNext={go("assign")} />
        )}
        {ready && tpl && base && step === "assign" && (
          <StepAssign tpl={tpl} onBack={go("template")} onNext={go("tune")} />
        )}
        {ready && tpl && base && step === "tune" && (
          <StepTune
            tpl={tpl}
            base={base}
            onBack={go("assign")}
            onNext={go("apply")}
          />
        )}
        {ready && tpl && step === "apply" && (
          <StepApply tpl={tpl} onBack={go("tune")} />
        )}
      </div>
    </Page>
  );
}

export function VehicleScreen(_props: FeatureProps) {
  const hasVehicle = useProject((s) => s.project.vehicle !== null);
  const open = useDraft((s) => s.open);
  if (hasVehicle && !open) return <LiveView />;
  return <Wizard hasVehicle={hasVehicle} />;
}
