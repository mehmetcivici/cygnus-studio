import { useMemo, useState } from 'react';
import { Camera, CircleCheck, CircleDashed, Unplug } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Badge, Button, EmptyState, Panel, ProgressBar, toast } from '../../ui';
import { captureBus, describeError, useBus, useConnection, useProject, type CaptureProgress } from '../../core';
import { matchCards } from './match';
import { projectModelName } from './report';
import { useLiveCards } from './live';
import { tProject } from './messages';

export function SnapshotTab() {
  const { t, tl, lang } = useI18n();
  const bus = useBus();
  const phase = useConnection((s) => s.phase);
  const project = useProject((s) => s.project);
  const { views, cards } = useLiveCards();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const readable = useMemo(() => views.filter((d) => d.online && !d.unassigned && !d.conflict), [views]);
  const match = useMemo(() => matchCards(project.bus.devices, cards), [project.bus.devices, cards]);

  const capture = async (): Promise<void> => {
    if (!bus) return;
    setBusy(true);
    setFailed([]);
    setProgress({ device: 0, devices: readable.length, fraction: 0 });
    try {
      const r = await captureBus(bus, setProgress);
      setFailed(r.failed);
      toast.success(tProject('snap.done', { count: r.devices.length }), r.failed.length ? { description: tProject('snap.partial', { count: r.failed.length }) } : undefined);
    } catch (e) {
      toast.error(tProject('snap.failed'), { description: describeError(e) });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const stateOf = (i: number): { tone: 'neutral' | 'accent' | 'ok'; label: string; value: number } => {
    if (!progress) return { tone: 'neutral', label: '', value: 0 };
    if (i < progress.device) return { tone: 'ok', label: tProject('snap.cardDone'), value: 1 };
    if (i === progress.device) return { tone: 'accent', label: tProject('snap.cardReading'), value: Math.max(0, Math.min(1, progress.fraction * progress.devices - i)) };
    return { tone: 'neutral', label: tProject('snap.cardWaiting'), value: 0 };
  };

  const connected = phase === 'connected' || phase === 'lost';
  const nameOf = (uid: string): string => {
    const v = views.find((x) => x.uid48 === uid);
    return v ? v.name.trim() || tl(v.def?.name) || uid : uid;
  };

  return (
    <div className="pj-grid">
      <Panel
        title={tProject('snap.title')}
        subtitle={project.bus.capturedAt ? tProject('snap.last', { at: new Date(project.bus.capturedAt).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB') }) : tProject('snap.never')}
        actions={
          <Button variant="primary" size="sm" icon={Camera} loading={busy} disabled={!bus || phase !== 'connected' || readable.length === 0} onClick={() => void capture()} data-testid="pj-capture">
            {tProject('snap.read')}
          </Button>
        }
      >
        {!connected ? (
          <EmptyState size="sm" icon={Unplug} title={tProject('snap.noConn')} description={tProject('snap.noConnBody')} />
        ) : (
          <>
            <p className="pj-lead">{tProject('snap.lead')}</p>
            {busy && progress && (
              <div className="pj-progress">
                <ProgressBar value={progress.fraction} showPercent label={tProject('snap.overall', { done: Math.min(progress.device, progress.devices), total: progress.devices })} />
              </div>
            )}
            <ul className="pj-cards" data-testid="pj-snap-cards">
              {readable.map((v, i) => {
                const st = stateOf(i);
                const legacy = v.legacy;
                return (
                  <li key={v.uid48}>
                    <span className="pj-cards__name">{v.name.trim() || tl(v.def?.name)}</span>
                    <span className="pj-muted">{tl(v.def?.name) || '—'}</span>
                    <span className="cy-mono pj-muted">#{v.num}</span>
                    {busy ? (
                      <span className="pj-cards__state">
                        <Badge size="sm" tone={st.tone} icon={st.tone === 'ok' ? CircleCheck : st.tone === 'neutral' ? CircleDashed : undefined}>
                          {st.label}
                        </Badge>
                        <ProgressBar value={st.value} size="sm" tone={st.tone} />
                      </span>
                    ) : legacy ? (
                      <Badge size="sm">{tProject('snap.noParams')}</Badge>
                    ) : (
                      <span />
                    )}
                  </li>
                );
              })}
            </ul>
            {failed.length > 0 && (
              <div className="pj-note pj-note--warn" role="alert">
                {tProject('snap.partial', { count: failed.length })}: {failed.map(nameOf).join(', ')}
              </div>
            )}
          </>
        )}
      </Panel>
      <Panel title={tProject('snap.saved')} subtitle={tProject('snap.savedCount', { count: project.bus.devices.length })}>
        {project.bus.devices.length === 0 ? (
          <EmptyState size="sm" title={tProject('snap.empty')} description={tProject('snap.emptyBody')} />
        ) : (
          <table className="pj-table" data-testid="pj-snap-table">
            <thead>
              <tr>
                <th>{tProject('snap.col.card')}</th>
                <th className="is-num">#</th>
                <th>UID</th>
                <th>{tProject('snap.col.fw')}</th>
                <th className="is-num">{tProject('snap.col.params')}</th>
                <th>{tProject('snap.col.bus')}</th>
              </tr>
            </thead>
            <tbody>
              {project.bus.devices.map((d) => {
                const pair = match.pairs.find((p) => p.project.uid48 === d.uid48);
                const sug = match.suggestions.find((p) => p.project.uid48 === d.uid48);
                return (
                  <tr key={d.uid48}>
                    <td>
                      <strong>{d.name.trim() || projectModelName(d, lang)}</strong> <span className="pj-muted">{projectModelName(d, lang)}</span>
                    </td>
                    <td className="is-num cy-mono">{d.num}</td>
                    <td className="cy-mono pj-muted">{d.uid48}</td>
                    <td className="cy-mono">{d.fw ?? '—'}</td>
                    <td className="is-num cy-mono">{Object.keys(d.params).length}</td>
                    <td>
                      {pair ? <Badge tone="ok" size="sm">{tProject('snap.onBus')}</Badge> : sug ? <Badge tone="warn" size="sm">{tProject('snap.replaced')}</Badge> : <Badge size="sm">{tProject('snap.notOnBus')}</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
