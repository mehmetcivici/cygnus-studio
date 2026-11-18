import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Play, Send, Square, TriangleAlert } from 'lucide-react';
import { Cls, decodeId, type CanIdFields, type CygnusBus } from '@cygnus/protocol';
import { ArmButton, displayName, useDevices, useDrive, useDriveSession } from '../../core';
import { useI18n } from '../../i18n';
import { Badge, Button, ConfirmDialog, NumberField, Select, TextField, Toggle, Tooltip, cx, toast } from '../../ui';
import {
  CLASS_NAMES,
  DEVTYPE_CHOICES,
  FIELD_BITS,
  FIELD_ORDER,
  KNOWN_CLASSES,
  bytesHex,
  composeId,
  ctrlGate,
  idHex,
  invalidFields,
  parseHexId,
  parseSend,
  periodicLimitMs,
  sendRisks,
  type FieldKey,
  type SendError,
} from './ids';
import { tCanMonitor } from './messages';

interface Sent {
  id: number;
  data: Uint8Array;
  fd: boolean;
  brs: boolean;
}

const MAX_HISTORY = 12;
const FIELD_LABEL: Record<FieldKey, string> = { devType: 'DEVTYPE', mfr: 'MFR', cls: 'CLASS', index: 'INDEX', num: 'NUM' };
const START: CanIdFields = { devType: 2, mfr: 8, cls: Cls.SYS_REQ, index: 3, num: 1 };

export interface SendPanelProps {
  bus: CygnusBus | null;
  connected: boolean;
}

/** Raw frame sender (advanced mode): id builder, one-shot and periodic send, history. */
export const SendPanel = memo(function SendPanel({ bus, connected }: SendPanelProps) {
  const { t, lang } = useI18n();
  const devices = useDevices();
  const estop = useDrive((s) => s.estopLatched);
  const [fields, setFields] = useState<CanIdFields>(START);
  const [idText, setIdText] = useState(() => idHex(composeId(START)));
  const [dataText, setDataText] = useState('00');
  const [fd, setFd] = useState(false);
  const [brs, setBrs] = useState(false);
  const [periodMs, setPeriodMs] = useState(100);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [history, setHistory] = useState<Sent[]>([]);
  const [confirm, setConfirm] = useState<null | { run: () => void }>(null);
  const timer = useRef<number | null>(null);
  const limit = useRef<number | null>(null);
  const fdCapable = bus?.transport.info.fd ?? false;

  const parsed = parseSend(idText, dataText, fd, brs);
  const id = parseHexId(idText);
  const risks = id === null ? [] : sendRisks(id);
  const bad = invalidFields(fields);
  const gate = ctrlGate(id, devices);
  const isCtrl = gate.kind !== 'none';
  // CTRL frames go through the shared drive session of the board they address, like every screen that moves something.
  const { session, armed, busyOwner } = useDriveSession('canmon', gate.kind === 'target' ? gate.uid48 : null);
  const blocked = (risks.length > 0 && estop) || gate.kind === 'blocked' || (isCtrl && !armed);
  const canSend = connected && parsed.ok && !blocked;

  const stop = useCallback((): void => {
    if (timer.current !== null) clearInterval(timer.current);
    if (limit.current !== null) clearTimeout(limit.current);
    timer.current = null;
    limit.current = null;
    setRunning(false);
  }, []);
  useEffect(() => stop, [stop]);
  useEffect(() => stop(), [bus, estop, connected, idText, dataText, stop]);
  // Every cut-off of the session (release, focus loss, board fault or loss, E-STOP) ends periodic CTRL at once.
  useEffect(() => session?.onDisarm(() => stop()), [session, stop]);
  useEffect(() => {
    if (isCtrl && !armed) stop();
  }, [isCtrl, armed, stop]);
  // Periodic frames stop when the window loses focus, like every actuating screen.
  useEffect(() => {
    const off = (): void => stop();
    window.addEventListener('blur', off);
    document.addEventListener('visibilitychange', off);
    return () => {
      window.removeEventListener('blur', off);
      document.removeEventListener('visibilitychange', off);
    };
  }, [stop]);

  const setId = (text: string): void => {
    setIdText(text);
    const v = parseHexId(text);
    if (v !== null) setFields(decodeId(v));
  };
  const setField = (k: FieldKey, v: number): void => {
    const next = { ...fields, [k]: v };
    setFields(next);
    if (invalidFields(next).length === 0) setIdText(idHex(composeId(next)));
  };
  const loadSent = (s: Sent): void => {
    setId(idHex(s.id));
    setDataText(bytesHex(s.data));
    setFd(s.fd);
    setBrs(s.brs);
  };

  const guarded = (run: () => void): void => {
    if (risks.length > 0) setConfirm({ run });
    else run();
  };

  const sendOnce = (): void => {
    if (!bus || !parsed.ok) return;
    if (isCtrl && !session?.armed) return;
    bus.send(parsed.frame);
    setCount((n) => n + 1);
    setHistory((h) => [{ ...parsed.frame }, ...h.filter((x) => !(x.id === parsed.frame.id && bytesHex(x.data) === bytesHex(parsed.frame.data)))].slice(0, MAX_HISTORY));
  };

  const start = (): void => {
    if (!bus || !parsed.ok) return;
    const frame = parsed.frame;
    stop();
    sendOnce();
    if (isCtrl && !session?.armed) return;
    timer.current = window.setInterval(() => {
      if (isCtrl && !session?.armed) return stop();
      bus.send(frame);
    }, Math.max(10, periodMs));
    const maxMs = periodicLimitMs(isCtrl);
    limit.current = window.setTimeout(() => {
      stop();
      if (isCtrl) session?.disarm('released');
      toast.info(tCanMonitor('send.limitReached', { s: maxMs / 1000 }));
    }, maxMs);
    setRunning(true);
  };

  const errText = (e: SendError): string => tCanMonitor(`send.error.${e}`);
  const riskText = risks.map((r) => tCanMonitor(`send.risk.${r}`)).join(' · ');

  return (
    <section className="canmon-send" aria-label={tCanMonitor('send.title')}>
      <header className="canmon-send__head">
        <Send size={15} aria-hidden />
        <h2>{tCanMonitor('send.title')}</h2>
        <Badge tone="warn" size="sm">
          {t('common.advanced')}
        </Badge>
        <span className="canmon-send__spacer" />
        {count > 0 && <span className="canmon-send__count cy-mono">{tCanMonitor('send.sent', { n: count })}</span>}
      </header>

      <div className="canmon-send__grid">
        <div className="canmon-send__col">
          <div className="canmon-send__label">{tCanMonitor('send.builder')}</div>
          <div className="canmon-send__fields">
            {FIELD_ORDER.map((k) => (
              <label key={k} className={cx('canmon-field', bad.includes(k) && 'is-bad')}>
                <span>
                  {FIELD_LABEL[k]} <small className="cy-mono">{FIELD_BITS[k].hi - FIELD_BITS[k].lo + 1}b</small>
                </span>
                {k === 'devType' ? (
                  <Select<number>
                    size="sm"
                    value={fields.devType}
                    ariaLabel="DEVTYPE"
                    onChange={(v) => setField('devType', v)}
                    options={[
                      ...DEVTYPE_CHOICES.map((c) => ({ value: c.value, label: `${c.value} · ${c.name}` })),
                      ...(DEVTYPE_CHOICES.some((c) => c.value === fields.devType) ? [] : [{ value: fields.devType, label: String(fields.devType) }]),
                    ]}
                  />
                ) : k === 'cls' ? (
                  <Select<number>
                    size="sm"
                    value={fields.cls}
                    ariaLabel="CLASS"
                    onChange={(v) => setField('cls', v)}
                    options={[
                      ...KNOWN_CLASSES.map((c) => ({ value: c, label: `0x${c.toString(16).toUpperCase()} · ${CLASS_NAMES[c] ?? ''}` })),
                      ...(KNOWN_CLASSES.includes(fields.cls) ? [] : [{ value: fields.cls, label: `0x${fields.cls.toString(16).toUpperCase()}` }]),
                    ]}
                  />
                ) : (
                  <NumberField size="sm" value={fields[k]} onCommit={(v) => setField(k, v)} min={0} max={(1 << (FIELD_BITS[k].hi - FIELD_BITS[k].lo + 1)) - 1} integer showErrorText={false} width="100%" ariaLabel={FIELD_LABEL[k]} />
                )}
              </label>
            ))}
          </div>
          <div className="canmon-send__target">
            <Select<string>
              size="sm"
              value={null}
              placeholder={tCanMonitor('send.pickCard')}
              ariaLabel={tCanMonitor('send.pickCard')}
              onChange={(uid) => {
                const d = devices.find((x) => x.uid48 === uid);
                if (d) {
                  const next = { ...fields, devType: d.devType, num: d.num };
                  setFields(next);
                  setIdText(idHex(composeId(next)));
                }
              }}
              options={devices.filter((d) => !d.legacy).map((d) => ({ value: d.uid48, label: `${displayName(d, lang)} · #${d.num}` }))}
            />
          </div>
        </div>

        <div className="canmon-send__col canmon-send__col--wide">
          <div className="canmon-send__label">{tCanMonitor('send.raw')}</div>
          <div className="canmon-send__row">
            <label className="canmon-field canmon-field--id">
              <span>{tCanMonitor('col.id')}</span>
              <TextField size="sm" mono value={idText} onChange={setId} error={id === null} aria-label={tCanMonitor('col.id')} block />
            </label>
            <label className="canmon-field canmon-field--data">
              <span>{tCanMonitor('send.data')}</span>
              <TextField size="sm" mono value={dataText} onChange={setDataText} error={!parsed.ok && parsed.error !== 'badId'} aria-label={tCanMonitor('send.data')} placeholder="01 02 03" block />
            </label>
            <div className="canmon-send__toggles">
              <Tooltip content={fdCapable ? tCanMonitor('send.fd') : tCanMonitor('send.noFd')}>
                <span>
                  <Toggle size="sm" checked={fd && fdCapable} disabled={!fdCapable} onChange={setFd} label="FD" />
                </span>
              </Tooltip>
              <Toggle size="sm" checked={brs && fd} disabled={!fd || !fdCapable} onChange={setBrs} label="BRS" />
            </div>
          </div>
          {!parsed.ok && <div className="canmon-send__error">{errText(parsed.error)}</div>}

          {risks.length > 0 && (
            <div className="canmon-send__warn" role="alert">
              <TriangleAlert size={16} aria-hidden />
              <div>
                <strong>{tCanMonitor('send.warn')}</strong>
                <span>{riskText}</span>
                {estop && <span>{tCanMonitor('send.estop')}</span>}
                {gate.kind === 'blocked' && <span>{tCanMonitor(`send.ctrlBlocked.${gate.reason}`)}</span>}
                {gate.kind === 'target' && <span>{tCanMonitor('send.ctrlArm')}</span>}
                {busyOwner && <span>{tCanMonitor('send.busy', { owner: busyOwner })}</span>}
              </div>
              {gate.kind === 'target' && <ArmButton session={session} />}
            </div>
          )}

          <div className="canmon-send__actions">
            <Button size="sm" variant={risks.length ? 'danger' : 'primary'} icon={Send} disabled={!canSend} onClick={() => guarded(sendOnce)}>
              {tCanMonitor('send.once')}
            </Button>
            <span className="canmon-send__periodic">
              <NumberField size="sm" value={periodMs} onCommit={setPeriodMs} unit="ms" min={10} max={10000} integer width={104} disabled={running} ariaLabel={tCanMonitor('send.period')} />
              {running ? (
                <Button size="sm" variant="secondary" icon={Square} onClick={stop}>
                  {tCanMonitor('send.stop')}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" icon={Play} disabled={!canSend} onClick={() => guarded(start)}>
                  {tCanMonitor('send.periodic')}
                </Button>
              )}
            </span>
            {!connected && <span className="canmon-send__hint">{tCanMonitor('send.noLink')}</span>}
            {connected && <span className="canmon-send__hint">{tCanMonitor(isCtrl ? 'send.limitCtrl' : 'send.limit', { s: periodicLimitMs(isCtrl) / 1000 })}</span>}
          </div>
        </div>

        <div className="canmon-send__col">
          <div className="canmon-send__label">{tCanMonitor('send.history')}</div>
          {history.length === 0 ? (
            <div className="canmon-send__hint">{tCanMonitor('send.historyEmpty')}</div>
          ) : (
            <ul className="canmon-send__history">
              {history.map((h, i) => (
                <li key={i}>
                  <button type="button" className="cy-mono" onClick={() => loadSent(h)} title={tCanMonitor('send.reload')}>
                    <b>{idHex(h.id)}</b>
                    <span>{bytesHex(h.data) || '—'}</span>
                    {h.fd && <small>FD{h.brs ? '·BRS' : ''}</small>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        tone="danger"
        title={tCanMonitor('send.confirmTitle')}
        message={
          <>
            <p>{tCanMonitor('send.warn')}</p>
            <p>{riskText}</p>
            <p className="cy-mono">
              0x{id !== null ? idHex(id) : ''} # {parsed.ok ? bytesHex(parsed.frame.data) : ''}
            </p>
          </>
        }
        confirmLabel={tCanMonitor('send.confirm')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          c?.run();
          if (c) toast.warn(tCanMonitor('send.sentToast'));
        }}
      />
    </section>
  );
});
