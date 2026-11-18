import { useState } from 'react';
import { PType, paramByKey, type ParamDef } from '@cygnus/protocol';
import { useI18n } from '../../i18n';
import { Badge, FormRow, NumberField, Select, Spinner, Toggle, toast } from '../../ui';
import { describeError } from '../errors';
import { fromDisplayUnit, toDisplayUnit, useSettings } from '../settings';
import { useDevice, useParam } from '../store/hooks';
import { useParamDraft } from './paramDraft';

export interface ParamFieldProps {
  uid48: string;
  /** Catalog parameter key, e.g. `vel.kp`. */
  paramKey: string;
  /**
   * `staged`: edits wait for the surrounding ParamForm's Apply (default inside a ParamForm).
   * `immediate`: every commit is written to the board at once (default standalone).
   */
  mode?: 'staged' | 'immediate';
  /** Show the catalog key under the label (default true). */
  showKey?: boolean;
  /** Hide the help line. */
  compact?: boolean;
  layout?: 'horizontal' | 'vertical';
  /** Force read-only (in addition to the catalog flag). */
  readOnly?: boolean;
  /** Called after an immediate write succeeded. */
  onApplied?: (value: number) => void;
}

function sameValue(a: number | undefined, b: number | undefined, def: ParamDef): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (def.ptype === PType.F32) return Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6);
  return a === b;
}

export function isParamChanged(def: ParamDef, value: number | undefined): boolean {
  return value !== undefined && !sameValue(value, def.default, def);
}

/** One board parameter as a form row; control, unit, limits and flags come from the catalog. */
export function ParamField({ uid48, paramKey, mode, showKey = true, compact, layout, readOnly, onApplied }: ParamFieldProps) {
  const { t, tl, fmtNumber } = useI18n();
  const dev = useDevice(uid48);
  const p = useParam(uid48, paramKey);
  const draftApi = useParamDraft(uid48);
  const units = { angleUnit: useSettings((s) => s.angleUnit), tempUnit: useSettings((s) => s.tempUnit) };
  const [pending, setPending] = useState<number | undefined>(undefined);
  const [writeError, setWriteError] = useState<string | null>(null);
  const def = p.def ?? (dev?.def ? paramByKey(dev.def, paramKey) : undefined);
  if (!def || !dev) return null;

  const staged = (mode ?? (draftApi ? 'staged' : 'immediate')) === 'staged' && draftApi !== null;
  const draft = staged ? draftApi.drafts[paramKey] : undefined;
  const applying = staged ? draftApi.applying.has(paramKey) : pending !== undefined;
  const shown = draft ?? pending ?? p.value;
  const dirty = draft !== undefined && !sameValue(draft, p.value, def);
  const locked = !!def.lockedWhileEnabled && dev.flags.enabled;
  const ro = !!def.readOnly || !!readOnly;
  const disabled = !dev.online || locked || dev.unassigned || dev.conflict;

  const commit = async (v: number): Promise<void> => {
    if (def.minNonZero && v > 0 && v < def.minNonZero) {
      setWriteError(t('core.param.minNonZero', { min: fmtNumber(def.minNonZero, def.digits) }));
      return;
    }
    setWriteError(null);
    if (staged) {
      draftApi.setDraft(paramKey, sameValue(v, p.value, def) ? undefined : v);
      return;
    }
    setPending(v);
    try {
      const got = await dev.handle.setParam(paramKey, v);
      onApplied?.(got);
    } catch (e) {
      const msg = describeError(e);
      setWriteError(msg);
      toast.error(t('core.param.writeFailed', { name: tl(def.label) }), { description: msg, id: `param-${uid48}-${paramKey}` });
    } finally {
      setPending(undefined);
    }
  };

  const error = (staged ? draftApi.errors[paramKey] : undefined) ?? writeError ?? (p.error ? describeError(p.error) : null);
  const disp = (v: number): number => toDisplayUnit(v, def.unit, units).value;
  const unit = toDisplayUnit(0, def.unit, units).unit;
  const converted = unit !== def.unit;

  let control;
  if (def.ptype === PType.BOOL) {
    control = <Toggle checked={(shown ?? 0) !== 0} onChange={(c) => void commit(c ? 1 : 0)} disabled={disabled || ro || shown === undefined} ariaLabel={tl(def.label)} />;
  } else if (def.ptype === PType.ENUM && def.options) {
    control = (
      <Select<number>
        value={shown ?? null}
        options={def.options.map((o) => ({ value: o.value, label: tl(o.label) }))}
        onChange={(v) => void commit(v)}
        disabled={disabled || ro}
        placeholder={p.loading ? t('common.loading') : '—'}
        width={200}
        ariaLabel={tl(def.label)}
        size="sm"
      />
    );
  } else {
    const integer = def.ptype === PType.U32 || def.ptype === PType.I32;
    const lo = disp(def.min);
    const hi = disp(def.max);
    control = (
      <NumberField
        value={shown === undefined ? null : disp(shown)}
        onCommit={(v) => void commit(converted ? fromDisplayUnit(v, def.unit, units) : v)}
        unit={unit}
        min={Math.min(lo, hi)}
        max={Math.max(lo, hi)}
        step={converted ? Math.abs(disp(def.step) - disp(0)) || undefined : def.step}
        digits={converted ? Math.max(0, def.digits - 1) : def.digits}
        integer={integer && !converted}
        dirty={dirty}
        disabled={disabled}
        readOnly={ro}
        placeholder={p.loading ? '…' : '—'}
        size="sm"
        width={150}
        ariaLabel={tl(def.label)}
      />
    );
  }

  const badges = (
    <>
      {applying && <Spinner size={12} label={t('core.param.applying')} />}
      {def.readOnly && (
        <Badge size="sm" tone="neutral" variant="outline">
          {t('common.readOnly')}
        </Badge>
      )}
      {def.rebootRequired && (
        <Badge size="sm" tone="caution" variant="outline" title={t('core.param.rebootHelp')}>
          {t('common.rebootRequired')}
        </Badge>
      )}
      {def.lockedWhileEnabled && (
        <Badge size="sm" tone={locked ? 'warn' : 'neutral'} variant={locked ? 'soft' : 'outline'} title={t('core.param.lockedHelp')}>
          {t('common.lockedWhileEnabled')}
        </Badge>
      )}
      {def.advanced && (
        <Badge size="sm" tone="accent" variant="outline">
          {t('common.advanced')}
        </Badge>
      )}
    </>
  );

  const defaultText = def.options
    ? tl(def.options.find((o) => o.value === def.default)?.label)
    : def.ptype === PType.BOOL
      ? t(def.default ? 'common.on' : 'common.off')
      : `${fmtNumber(disp(def.default), converted ? Math.max(0, def.digits - 1) : def.digits)}${unit ? ` ${unit}` : ''}`;

  return (
    <FormRow
      label={tl(def.label)}
      help={compact ? undefined : tl(def.help)}
      meta={showKey ? def.key : undefined}
      dirty={dirty}
      error={error ?? undefined}
      badges={badges}
      layout={layout}
      disabled={disabled}
      onReset={ro ? undefined : () => void commit(def.default)}
      isDefault={shown === undefined || sameValue(shown, def.default, def)}
      defaultText={defaultText}
    >
      {control}
    </FormRow>
  );
}
