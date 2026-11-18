import { useEffect, useRef, useState } from 'react';
import { Copy, Hash, Lightbulb, Pencil, Power, Save, TriangleAlert } from 'lucide-react';
import { NUM_MAX, NUM_MIN, isCyError } from '@cygnus/protocol';
import { useI18n } from '../../i18n';
import { Badge, Button, Checkbox, IconButton, Modal, NumberField, StatusDot, toast, cx } from '../../ui';
import { ModelIcon, connection, describeError, fmtFw, modelText, useDevices, type DeviceView } from '../../core';
import { rebootDevice, saveDevice } from './ops';
import { tDevice } from './messages';

const NAME_BYTES = 21;
const encoder = new TextEncoder();

function NameEditor({ device }: { device: DeviceView }) {
  const { tl, lang } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const canRename = device.handle.capabilities.rename && device.online && !device.unassigned && !device.conflict;
  const placeholder = tl(modelText(device));
  const commit = async (): Promise<void> => {
    const name = value.trim();
    if (name === device.name) {
      setEditing(false);
      return;
    }
    if (encoder.encode(name).length > NAME_BYTES) {
      toast.warn(tDevice('head.nameTooLong', { max: NAME_BYTES }));
      return;
    }
    setBusy(true);
    try {
      await device.handle.rename(name);
      toast.success(tDevice('head.renamed'), { description: tDevice('head.renamedHint'), id: `rename-${device.uid48}` });
      setEditing(false);
    } catch (e) {
      toast.error(tDevice('head.renameFailed'), { description: describeError(e, lang) });
    } finally {
      setBusy(false);
    }
  };
  if (editing) {
    return (
      <input
        ref={input}
        className="dv-head__rename"
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
        aria-label={tDevice('head.rename')}
      />
    );
  }
  return (
    <h2 className="dv-head__name">
      <span className={cx(!device.name && 'is-placeholder')}>{device.name || placeholder}</span>
      {canRename && (
        <IconButton
          size="sm"
          variant="ghost"
          icon={Pencil}
          label={tDevice('head.rename')}
          onClick={() => {
            setValue(device.name);
            setEditing(true);
          }}
        />
      )}
    </h2>
  );
}

function NumberDialog({ device, onClose }: { device: DeviceView; onClose: () => void }) {
  const { t, lang } = useI18n();
  const bus = connection.current;
  const suggestion = bus?.suggestNumber(device.devType) ?? null;
  const [num, setNum] = useState(device.num);
  const [persist, setPersist] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const devices = useDevices();
  const taken = devices.some((d) => d.uid48 !== device.uid48 && d.devType === device.devType && d.num === num && !d.unassigned);
  const assign = async (): Promise<void> => {
    if (!bus) return;
    setBusy(true);
    setError(null);
    try {
      await bus.assignId(device.uid48, num, { persist });
      toast.success(tDevice('head.numberChanged', { num }));
      onClose();
    } catch (e) {
      setError(isCyError(e) && e.reason === 'number_taken' ? tDevice('head.numberTaken', { num }) : describeError(e, lang));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      dismissible={!busy}
      title={tDevice('head.numberTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={num === device.num || taken || !device.online} onClick={() => void assign()}>
            {tDevice('head.numberApply')}
          </Button>
        </>
      }
    >
      <div className="dv-dialog">
        <p className="dv-note">{tDevice('head.numberHelp')}</p>
        <div className="dv-control__row">
          <span className="dv-field-label">{tDevice('head.number')}</span>
          <NumberField value={num} onCommit={(v) => setNum(Math.round(v))} min={NUM_MIN} max={NUM_MAX} integer size="md" width={110} ariaLabel={tDevice('head.number')} error={taken ? tDevice('head.numberTaken', { num }) : undefined} />
          {suggestion !== null && suggestion !== num && (
            <Button size="sm" variant="ghost" onClick={() => setNum(suggestion)}>
              {tDevice('head.numberSuggest', { num: suggestion })}
            </Button>
          )}
        </div>
        <Checkbox checked={persist} onChange={setPersist} label={tDevice('head.numberPersist')} />
        {error && <p className="dv-note dv-errtext">{error}</p>}
      </div>
    </Modal>
  );
}

function RebootDialog({ device, onClose }: { device: DeviceView; onClose: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const run = async (save: boolean): Promise<void> => {
    setBusy(true);
    const ok = !save || (await saveDevice(device.handle, true));
    setBusy(false);
    onClose();
    // The screen shows the rebooting state; the dialog need not wait for the board.
    if (ok) void rebootDevice(device.handle);
  };
  const unsaved = device.flags.unsaved;
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      dismissible={!busy}
      title={tDevice('head.rebootTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy} data-autofocus="">
            {t('common.cancel')}
          </Button>
          {unsaved && (
            <Button variant="secondary" icon={Save} disabled={busy} onClick={() => void run(true)}>
              {tDevice('head.saveReboot')}
            </Button>
          )}
          <Button variant={unsaved ? 'danger' : 'primary'} icon={Power} loading={busy} onClick={() => void run(false)}>
            {unsaved ? tDevice('head.rebootDiscard') : tDevice('head.reboot')}
          </Button>
        </>
      }
    >
      <div className="dv-dialog">
        <p>{tDevice('head.rebootBody')}</p>
        {unsaved && (
          <p className="dv-warntext">
            <TriangleAlert size={14} aria-hidden /> {tDevice('head.rebootUnsaved')}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Identity, state flags and the board-level actions (identify, number, reboot). */
export function DeviceHeader({ device }: { device: DeviceView }) {
  const { tl, lang } = useI18n();
  const [numOpen, setNumOpen] = useState(false);
  const [rebootOpen, setRebootOpen] = useState(false);
  const caps = device.handle.capabilities;
  const resolved = !device.unassigned && !device.conflict;
  const identify = (): void => {
    if (!resolved) {
      connection.current?.identifyByUid(device.uid48, 5);
      return;
    }
    device.handle.identify(5).catch((e: unknown) => toast.error(tDevice('head.identifyFailed'), { description: describeError(e, lang) }));
  };
  const copyUid = (): void => {
    void navigator.clipboard?.writeText(device.uid48).then(() => toast.info(tDevice('head.uidCopied'), { id: 'uid-copy' }));
  };
  const catalogRev = device.def?.catalogRev;
  return (
    <header className={cx('dv-head', `is-${device.status}`, device.flags.identify && 'is-identify')}>
      <div className="dv-head__main">
        <ModelIcon def={device.def} boxed size={24} />
        <div className="dv-head__titles">
          <div className="dv-head__row">
            <StatusDot status={device.status} size={10} />
            <NameEditor device={device} />
          </div>
          <div className="dv-head__meta">
            <span className="dv-head__model">{tl(modelText(device))}</span>
            <span className="dv-head__sep" />
            {caps.assignId && resolved ? (
              <button type="button" className="dv-head__num cy-mono" onClick={() => setNumOpen(true)} disabled={!device.online} title={tDevice('head.numberTitle')}>
                <Hash size={12} aria-hidden />
                {device.num}
                <Pencil size={11} aria-hidden className="dv-head__num-edit" />
              </button>
            ) : (
              <span className={cx('dv-head__num cy-mono', !resolved && 'is-bad')}>#{device.unassigned ? '—' : device.num}</span>
            )}
            <span className="dv-head__sep" />
            <span className="cy-mono" title={tDevice('head.fw')}>
              fw {device.fw ? fmtFw(device.fw) : '—'}
            </span>
            {device.hwRev !== null && (
              <span className="cy-mono" title={tDevice('head.hw')}>
                hw {device.hwRev}
              </span>
            )}
            <span className="dv-head__sep" />
            <button type="button" className="dv-head__uid cy-mono" onClick={copyUid} title={tDevice('head.copyUid')}>
              {device.uid48}
              <Copy size={11} aria-hidden />
            </button>
          </div>
        </div>
        <div className="dv-head__flags">
          {!device.online && <Badge tone="neutral">{tDevice('flag.offline')}</Badge>}
          {device.bootloader && <Badge tone="accent">{tDevice('flag.bootloader')}</Badge>}
          {device.flags.enabled && (
            <Badge tone="danger" variant="solid">
              {tDevice('flag.enabled')}
            </Badge>
          )}
          {device.flags.unsaved && (
            <Badge tone="caution" variant="outline">
              {tDevice('flag.unsaved')}
            </Badge>
          )}
          {(device.flags.warning || device.faults.warn !== 0) && <Badge tone="warn">{tDevice('flag.warning')}</Badge>}
          {device.faults.active !== 0 && (
            <Badge tone="danger">{tDevice('flag.fault')}</Badge>
          )}
        </div>
        <div className="dv-head__actions">
          <Button size="sm" variant="secondary" icon={Lightbulb} onClick={identify} disabled={!device.online || !(caps.identify || !resolved)} className={cx(device.flags.identify && 'is-active')}>
            {device.flags.identify ? tDevice('head.identifying') : tDevice('head.identify')}
          </Button>
          <Button size="sm" variant="secondary" icon={Power} onClick={() => setRebootOpen(true)} disabled={!device.online || !resolved || !caps.commands || device.flags.enabled} title={device.flags.enabled ? tDevice('settings.lockedEnabled') : undefined}>
            {tDevice('head.reboot')}
          </Button>
        </div>
      </div>
      {device.catalogStatus !== 'ok' && (
        <div className="dv-strip dv-strip--caution">
          <TriangleAlert size={15} aria-hidden />
          <span>
            {device.catalogStatus === 'unknownModel'
              ? tDevice('head.unknownModel', { model: device.model })
              : tDevice('head.newerCatalog', { ours: catalogRev ?? '?' })}
          </span>
        </div>
      )}
      {numOpen && <NumberDialog device={device} onClose={() => setNumOpen(false)} />}
      {rebootOpen && <RebootDialog device={device} onClose={() => setRebootOpen(false)} />}
    </header>
  );
}
