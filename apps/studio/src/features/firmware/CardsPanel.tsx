import { useEffect, useMemo, useState } from 'react';
import { Ban, Cpu, Play, RotateCcw, Wrench, X } from 'lucide-react';
import { Button, Checkbox, EmptyState, Panel } from '../../ui';
import { DeviceBadge, useConnection } from '../../core';
import { fmtVersion, imageVersion, rowStatus } from './logic';
import { useFwRows, type FwRow } from './rows';
import { useFwSafety } from './safety';
import { abortUpdate, useFwLibrary, useFwUpdate } from './store';
import { BatchDialog, FlashDialog, type FlashMode } from './FlashDialog';
import { RunBlock, SafetyNotes, StatusBadge } from './parts';
import { tFirmware } from './messages';

interface Dialog {
  kind: 'flash' | 'batch';
  mode: FlashMode;
  uid48?: string;
  imageId?: string;
  rows?: FwRow[];
}

function Row({ row, selected, onSelect, busy, blocked, open }: { row: FwRow; selected: boolean; onSelect: (v: boolean) => void; busy: boolean; blocked: boolean; open: (d: Dialog) => void }) {
  const run = useFwUpdate((s) => s.runs[row.view.uid48]);
  const { status, best } = row.assessment;
  const active = run?.state === 'running' || run?.state === 'queued';
  const uid48 = row.view.uid48;
  let action = null;
  if (!active && !busy) {
    if (status === 'bootloader') {
      action = (
        <Button size="sm" variant="danger" icon={Wrench} disabled={blocked} onClick={() => open({ kind: 'flash', mode: 'recover', uid48 })}>
          {tFirmware('act.recover')}
        </Button>
      );
    } else if (run && (run.state === 'failed' || run.state === 'aborted') && row.compatible.length > 0) {
      action = (
        <Button size="sm" icon={RotateCcw} disabled={blocked} onClick={() => open({ kind: 'flash', mode: 'update', uid48, imageId: run.imageId })}>
          {tFirmware('act.retry')}
        </Button>
      );
    } else if (status === 'updateAvailable') {
      action = (
        <Button size="sm" variant="primary" icon={Play} disabled={blocked} onClick={() => open({ kind: 'flash', mode: 'update', uid48 })}>
          {tFirmware('act.update')}
        </Button>
      );
    } else if ((status === 'upToDate' || status === 'ahead') && row.compatible.length > 0) {
      action = (
        <Button size="sm" variant="ghost" disabled={blocked} onClick={() => open({ kind: 'flash', mode: 'pick', uid48 })}>
          {tFirmware('act.pick')}
        </Button>
      );
    }
  }
  return (
    <li className={run ? 'fw-row has-run' : 'fw-row'} data-testid={`fw-row-${uid48}`} data-status={rowStatus(status, run?.state)}>
      <div className="fw-row__main">
        <Checkbox checked={selected} onChange={onSelect} ariaLabel={tFirmware('cards.selectAll')} disabled={active || status === 'legacy'} />
        <div className="fw-row__card">
          <DeviceBadge device={row.view} />
        </div>
        <div className="fw-row__ver cy-mono">{fmtVersion(row.view.fw)}</div>
        <div className="fw-row__img cy-mono">
          {best ? (
            <>
              {fmtVersion(imageVersion(best.header))}
              {row.compatible.length > 1 && <span className="fw-row__more">+{row.compatible.length - 1}</span>}
            </>
          ) : (
            <span className="fw-row__none">{tFirmware('cards.imageNone')}</span>
          )}
        </div>
        <div className="fw-row__status">
          <StatusBadge status={rowStatus(status, run?.state)} />
        </div>
        <div className="fw-row__act">{action}</div>
      </div>
      {run && <RunBlock run={run} />}
    </li>
  );
}

export function CardsPanel() {
  const phase = useConnection((s) => s.phase);
  const { rows, unresolved } = useFwRows();
  const images = useFwLibrary((s) => s.images);
  const running = useFwUpdate((s) => s.running);
  const safety = useFwSafety();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    if (!running) setCancelling(false);
  }, [running]);

  const updatable = useMemo(() => rows.filter((r) => r.assessment.status === 'updateAvailable' || r.assessment.status === 'bootloader'), [rows]);
  const selectedRows = rows.filter((r) => selected.has(r.view.uid48));
  const blocked = safety.driveActive || phase !== 'connected';
  const toggleAll = (on: boolean): void => setSelected(on ? new Set(rows.filter((r) => r.assessment.status !== 'legacy').map((r) => r.view.uid48)) : new Set());

  if (phase === 'idle' || phase === 'error') {
    return (
      <Panel title={tFirmware('cards.title')} icon={Cpu}>
        <EmptyState size="sm" icon={Ban} title={tFirmware('cards.noConn')} description={tFirmware('cards.noConnBody')} />
      </Panel>
    );
  }

  const dlgRow = dialog?.uid48 ? rows.find((r) => r.view.uid48 === dialog.uid48) : undefined;
  return (
    <Panel
      title={tFirmware('cards.title')}
      subtitle={rows.length}
      icon={Cpu}
      actions={
        running ? (
          <Button size="sm" variant="danger" icon={X} loading={cancelling} onClick={() => { setCancelling(true); abortUpdate(); }} data-testid="fw-cancel">
            {cancelling ? tFirmware('act.cancelling') : tFirmware('act.cancel')}
          </Button>
        ) : (
          <>
            {selectedRows.length > 0 && (
              <Button size="sm" disabled={blocked} onClick={() => setDialog({ kind: 'batch', mode: 'update', rows: selectedRows })} data-testid="fw-update-selected">
                {tFirmware('act.updateSelected', { count: selectedRows.length })}
              </Button>
            )}
            <Button size="sm" variant="primary" icon={Play} disabled={blocked || images.length === 0 || updatable.length === 0} onClick={() => setDialog({ kind: 'batch', mode: 'update', rows })} data-testid="fw-update-all">
              {tFirmware('act.updateAll')}
            </Button>
          </>
        )
      }
    >
      {(safety.driveActive || safety.lowVoltage || safety.enabledBoards > 0) && (
        <div className="fw-banners">
          <SafetyNotes safety={safety} lowOk onLowOk={() => undefined} />
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState size="sm" icon={Cpu} title={tFirmware('cards.empty')} description={tFirmware('cards.emptyBody')} />
      ) : (
        <>
          <div className="fw-head" role="presentation">
            <Checkbox
              checked={selected.size > 0 && selected.size >= rows.filter((r) => r.assessment.status !== 'legacy').length}
              indeterminate={selected.size > 0 && selected.size < rows.filter((r) => r.assessment.status !== 'legacy').length}
              onChange={toggleAll}
              ariaLabel={tFirmware('cards.selectAll')}
              disabled={running}
            />
            <span>{tFirmware('cards.col.card')}</span>
            <span>{tFirmware('cards.col.installed')}</span>
            <span>{tFirmware('cards.col.image')}</span>
            <span>{tFirmware('cards.col.status')}</span>
            <span />
          </div>
          <ul className="fw-rows">
            {rows.map((r) => (
              <Row
                key={r.view.uid48}
                row={r}
                selected={selected.has(r.view.uid48)}
                onSelect={(v) => setSelected((s) => { const n = new Set(s); if (v) n.add(r.view.uid48); else n.delete(r.view.uid48); return n; })}
                busy={running}
                blocked={blocked}
                open={setDialog}
              />
            ))}
          </ul>
        </>
      )}
      {unresolved > 0 && <div className="fw-foot">{tFirmware('cards.unresolved', { count: unresolved })}</div>}
      {dialog?.kind === 'flash' && dlgRow && <FlashDialog row={dlgRow} mode={dialog.mode} imageId={dialog.imageId} safety={safety} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'batch' && dialog.rows && <BatchDialog rows={dialog.rows} images={images} safety={safety} onClose={() => setDialog(null)} />}
    </Panel>
  );
}
