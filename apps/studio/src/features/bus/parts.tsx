import { memo, useEffect, useRef, useState } from 'react';
import { ArrowRight, Lightbulb, Pencil, X } from 'lucide-react';
import { signalByKey } from '@cygnus/protocol';
import { useI18n } from '../../i18n';
import { IconButton, toast, cx } from '../../ui';
import { connection, describeError, formatSignal, modelText, primarySignals, selectDevice, useSettings, useSignals, type DeviceView } from '../../core';
import { navigate } from '../../app/nav';
import { tBus } from './messages';

const NAME_BYTES = 21;
const encoder = new TextEncoder();

/** Board name with in-place rename (Enter saves, Esc cancels). */
export function RenameName({ device, className }: { device: DeviceView; className?: string }) {
  const { lang, tl } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const canRename = device.handle.capabilities.rename && device.online && !device.unassigned && !device.conflict;
  const placeholder = device.def || device.legacy ? tl(modelText(device)) : tBus('card.unnamed');
  const commit = async (): Promise<void> => {
    const name = value.trim();
    if (name === device.name) {
      setEditing(false);
      return;
    }
    if (encoder.encode(name).length > NAME_BYTES) {
      toast.warn(tBus('card.nameTooLong'));
      return;
    }
    setBusy(true);
    try {
      await device.handle.rename(name);
      toast.success(tBus('card.renamed'), { id: `rename-${device.uid48}` });
      setEditing(false);
    } catch (e) {
      toast.error(tBus('card.renameFailed'), { description: describeError(e, lang) });
    } finally {
      setBusy(false);
    }
  };
  if (editing) {
    return (
      <input
        ref={input}
        className={cx('bus-rename', className)}
        value={value}
        disabled={busy}
        maxLength={40}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') {
            setValue(device.name);
            setEditing(false);
          }
        }}
        aria-label={tBus('card.rename')}
      />
    );
  }
  return (
    <span className={cx('bus-name', className)}>
      <span className={cx('bus-name__text', !device.name && 'is-placeholder')} title={device.name || placeholder}>
        {device.name || placeholder}
      </span>
      {canRename && (
        <button
          type="button"
          className="bus-name__edit"
          onClick={(e) => {
            e.stopPropagation();
            setValue(device.name);
            setEditing(true);
          }}
          aria-label={tBus('card.rename')}
          title={tBus('card.rename')}
        >
          <Pencil size={12} aria-hidden />
        </button>
      )}
    </span>
  );
}

/** The 2–3 headline signals of a board, live (≤ 20 Hz, only this component re-renders). */
export const LiveValues = memo(function LiveValues({ device, compact }: { device: DeviceView; compact?: boolean }) {
  const { lang, tl } = useI18n();
  const keys = primarySignals(device.def);
  const live = device.online && !device.unassigned && !device.conflict;
  const values = useSignals(live ? device.uid48 : null, keys);
  const angleUnit = useSettings((s) => s.angleUnit);
  const tempUnit = useSettings((s) => s.tempUnit);
  if (!device.def || keys.length === 0) return null;
  return (
    <div className={cx('bus-live', compact && 'is-compact')}>
      {keys.map((k) => {
        const sig = signalByKey(device.def!, k);
        const f = formatSignal(sig, values[k] ?? NaN, lang, { angleUnit, tempUnit });
        return (
          <div key={k} className="bus-live__item">
            <span className="bus-live__label">{sig ? tl(sig.label) : k}</span>
            <span className="bus-live__value">
              <span className="cy-mono">{f.text}</span>
              {f.unit && <span className="bus-live__unit">{f.unit}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
});

export function identify(device: DeviceView): void {
  if (device.unassigned || device.conflict) {
    connection.current?.identifyByUid(device.uid48, 5);
    return;
  }
  device.handle.identify(5).catch((e: unknown) => toast.error(tBus('card.identify'), { description: describeError(e) }));
}

export function openDevice(device: DeviceView): void {
  selectDevice(device.uid48);
  navigate('device', { device: device.uid48 });
}

/** Identify / open / forget buttons shared by card and row. */
export function DeviceActions({ device }: { device: DeviceView }) {
  const canIdentify = device.online && (device.handle.capabilities.identify || device.unassigned || device.conflict);
  return (
    <div className="bus-actions" onClick={(e) => e.stopPropagation()}>
      {device.online ? (
        <IconButton
          size="sm"
          icon={Lightbulb}
          active={device.flags.identify}
          label={device.flags.identify ? tBus('card.identifying') : tBus('card.identify')}
          disabled={!canIdentify}
          onClick={() => identify(device)}
        />
      ) : (
        <IconButton size="sm" icon={X} label={tBus('card.forget')} onClick={() => connection.current?.forget(device.uid48)} />
      )}
      <IconButton size="sm" icon={ArrowRight} label={tBus('card.open')} onClick={() => openDevice(device)} disabled={device.unassigned || device.conflict} />
    </div>
  );
}
