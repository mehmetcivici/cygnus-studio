import { useMemo, useState } from 'react';
import { CircleCheck, CircleX, Lightbulb, TriangleAlert, Wand2 } from 'lucide-react';
import type { ResolveOutcome, ResolveStep } from '@cygnus/protocol';
import { useI18n } from '../../i18n';
import { Badge, Button, Checkbox, IconButton, Modal, NumberField, toast } from '../../ui';
import { ModelIcon, describeError, modelText, useBus, useUnresolved, type DeviceView } from '../../core';
import { tBus } from './messages';
import { identify } from './parts';

function UnresolvedItem({ device }: { device: DeviceView }) {
  const { tl } = useI18n();
  const bus = useBus();
  const suggested = bus?.suggestNumber(device.devType) ?? null;
  const [num, setNum] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const value = num ?? suggested;
  const assign = async (): Promise<void> => {
    if (!bus || value === null) return;
    setBusy(true);
    try {
      await bus.assignId(device.uid48, value, { persist: true });
      toast.success(tBus('unresolved.assigned', { num: value }));
      setNum(null);
    } catch (e) {
      toast.error(tBus('unresolved.assignFailed'), { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="bus-unres__item">
      <ModelIcon def={device.def} size={16} />
      <span className="bus-unres__model">{tl(modelText(device))}</span>
      <span className="bus-unres__uid cy-mono">{device.uid48}</span>
      {device.unassigned ? (
        <Badge size="sm" tone="warn">
          {tBus('unresolved.unassigned')}
        </Badge>
      ) : (
        <Badge size="sm" tone="danger">
          {tBus('unresolved.conflict', { num: device.num })}
        </Badge>
      )}
      <span className="bus-unres__spacer" />
      <IconButton size="sm" icon={Lightbulb} active={device.flags.identify} label={tBus('card.identify')} onClick={() => identify(device)} disabled={!device.online} />
      <NumberField value={value} onCommit={setNum} integer min={1} max={62} size="sm" width={84} ariaLabel={tBus('unresolved.assign')} />
      <Button size="sm" onClick={() => void assign()} loading={busy} disabled={value === null || !device.online}>
        {tBus('unresolved.assign')}
      </Button>
    </li>
  );
}

function ResolveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, tl } = useI18n();
  const bus = useBus();
  const [persist, setPersist] = useState(true);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResolveOutcome[] | null>(null);
  // The plan is computed when the dialog opens and shown unchanged while it runs.
  const plan: ResolveStep[] = useMemo(() => (open && bus ? bus.planResolve() : []), [open, bus]);
  const rows = results ?? plan;
  const close = (): void => {
    if (running) return;
    setResults(null);
    onClose();
  };
  const run = async (): Promise<void> => {
    if (!bus) return;
    setRunning(true);
    try {
      const out = await bus.resolveAll({ persist });
      setResults(out);
      const failed = out.filter((o) => !o.ok).length;
      if (failed) toast.warn(tBus('resolve.failed', { count: failed }));
      else toast.success(tBus('resolve.done', { count: out.length }));
    } catch (e) {
      toast.error(tBus('resolve.error'), { description: describeError(e) });
    } finally {
      setRunning(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={close}
      dismissible={!running}
      size="lg"
      title={tBus('resolve.title')}
      footer={
        results ? (
          <Button variant="primary" onClick={close}>
            {tBus('resolve.ok')}
          </Button>
        ) : (
          <>
            <Checkbox checked={persist} onChange={setPersist} label={tBus('resolve.persist')} />
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={close} disabled={running}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" icon={Wand2} onClick={() => void run()} loading={running} disabled={plan.length === 0}>
              {running ? tBus('resolve.running') : tBus('resolve.run')}
            </Button>
          </>
        )
      }
    >
      {plan.length === 0 && !results ? (
        <p>{tBus('resolve.empty')}</p>
      ) : (
        <>
          <p className="bus-resolve__intro">{tBus('resolve.intro')}</p>
          <table className="bus-resolve">
            <thead>
              <tr>
                <th>{tBus('resolve.board')}</th>
                <th>{tBus('resolve.uid')}</th>
                <th className="is-num">{tBus('resolve.from')}</th>
                <th className="is-num">{tBus('resolve.to')}</th>
                {results && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const d = s.device;
                const keep = s.to === s.from && !d.unassigned;
                const outcome = results ? (s as ResolveOutcome) : null;
                return (
                  <tr key={s.uid48} className={keep ? 'is-keep' : undefined}>
                    <td>
                      <span className="bus-resolve__board">
                        <ModelIcon def={d.def} size={15} />
                        {d.def ? tl(d.def.name) : `Model ${d.model}`}
                      </span>
                    </td>
                    <td className="cy-mono">{s.uid48}</td>
                    <td className="is-num cy-mono">{s.from === 63 ? <Badge size="sm" tone="warn">{tBus('unresolved.unassigned')}</Badge> : `#${s.from}`}</td>
                    <td className="is-num cy-mono">
                      {s.to === null ? <Badge size="sm" tone="danger">{tBus('resolve.noFree')}</Badge> : keep ? <span className="bus-resolve__keep">#{s.to} · {tBus('resolve.keep')}</span> : <strong>#{s.to}</strong>}
                    </td>
                    {outcome && (
                      <td>
                        {outcome.ok ? (
                          <CircleCheck size={16} className="bus-resolve__ok" aria-label={tBus('resolve.ok')} />
                        ) : (
                          <span className="bus-resolve__err" title={outcome.error ? describeError(outcome.error) : undefined}>
                            <CircleX size={16} aria-hidden /> {outcome.error ? describeError(outcome.error) : tBus('resolve.error')}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}

/** Strip above the board grid while any board is unassigned or in conflict. */
export function UnresolvedStrip() {
  const unresolved = useUnresolved();
  const [open, setOpen] = useState(false);
  return (
    <>
      {unresolved.length > 0 && (
        <section className="bus-unres" aria-label={tBus('unresolved.title')}>
          <header className="bus-unres__head">
            <TriangleAlert size={18} aria-hidden />
            <div className="bus-unres__titles">
              <h2>
                {tBus('unresolved.title')} <Badge tone="warn">{unresolved.length}</Badge>
              </h2>
              <p>{tBus('unresolved.body')}</p>
            </div>
            <Button variant="primary" icon={Wand2} onClick={() => setOpen(true)}>
              {tBus('unresolved.autoResolve')}
            </Button>
          </header>
          <ul className="bus-unres__list">
            {unresolved.map((d) => (
              <UnresolvedItem key={d.uid48} device={d} />
            ))}
          </ul>
        </section>
      )}
      {/* Outside the strip: it keeps showing the results after the last board is resolved. */}
      <ResolveDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
