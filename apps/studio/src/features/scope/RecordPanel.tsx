import { useEffect, useState } from 'react';
import { Circle, FileDown, FolderOpen, LineChart, Square, Trash2 } from 'lucide-react';
import { downloadFile, pickFile, sessionRecorder, useRecorder, type RecordChannel } from '../../core';
import { fmtNumber, useI18n } from '../../i18n';
import { Badge, Button, Panel, toast } from '../../ui';
import { tScope } from './messages';
import { parseRecording, recordingFileName, type ParsedRecording } from './recording';
import type { PlotSignal } from './types';

export interface RecordPanelProps {
  signals: readonly PlotSignal[];
  /** Shows a recording in the chart (name is the file name or a label). */
  onOpen: (name: string, rec: ParsedRecording) => void;
}

function fmtDuration(ms: number, lang: 'tr' | 'en'): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${fmtNumber(s - m * 60, 1, { lang }).padStart(4, '0')}` : `${fmtNumber(s, 1, { lang })} s`;
}

export function RecordPanel({ signals, onOpen }: RecordPanelProps) {
  const { lang } = useI18n();
  const rec = useRecorder();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!rec.recording) return;
    const h = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(h);
  }, [rec.recording]);

  const channels: RecordChannel[] = signals.filter((s) => s.present).map((s) => ({ uid48: s.uid48, key: s.key, label: s.label, unit: s.unit || undefined }));
  const hasTake = rec.startedAt !== null && rec.samples > 0;
  const elapsed = rec.startedAt === null ? 0 : (rec.recording ? now : (rec.stoppedAt ?? now)) - rec.startedAt;

  const open = (name: string, text: string): void => {
    const parsed = parseRecording(text);
    if (parsed) onOpen(name, parsed);
    else toast.error(tScope('fileUnreadable'));
  };

  const openFile = async (): Promise<void> => {
    const f = await pickFile('.csv,.json,text/csv,application/json');
    if (f) open(f.name, await f.text());
  };

  return (
    <Panel
      title={tScope('record')}
      actions={rec.recording ? <Badge tone="danger">{tScope('recording')}</Badge> : hasTake ? <Badge tone="ok">{tScope('recorded')}</Badge> : undefined}
    >
      <div className="scope-form">
        <div className="scope-rec__counters cy-mono">
          <span>
            <small>{tScope('duration')}</small>
            {fmtDuration(elapsed, lang)}
          </span>
          <span>
            <small>{tScope('samples')}</small>
            {fmtNumber(rec.samples, 0, { lang })}
          </span>
        </div>
        <div className="scope-form__actions">
          {rec.recording ? (
            <Button size="sm" variant="danger" icon={Square} onClick={() => sessionRecorder.stop()}>
              {tScope('recStop')}
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={Circle} disabled={channels.length === 0} onClick={() => sessionRecorder.start(channels)}>
              {tScope('recStart')}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void openFile()}>
            {tScope('openFile')}
          </Button>
        </div>
        {channels.length === 0 && !rec.recording && <p className="scope-side__hint">{tScope('recNoSignals')}</p>}
        {hasTake && (
          <div className="scope-rec__export">
            <Button size="sm" icon={FileDown} disabled={rec.recording} onClick={() => downloadFile(recordingFileName('csv'), sessionRecorder.toCSV(), 'text/csv')}>
              CSV
            </Button>
            <Button size="sm" icon={FileDown} disabled={rec.recording} onClick={() => downloadFile(recordingFileName('json'), sessionRecorder.toJSON({ app: 'cygnus-studio' }), 'application/json')}>
              JSON
            </Button>
            <Button size="sm" icon={LineChart} disabled={rec.recording} onClick={() => open(recordingFileName('json'), sessionRecorder.toJSON())}>
              {tScope('inspect')}
            </Button>
            <Button size="sm" variant="ghost" icon={Trash2} disabled={rec.recording} onClick={() => sessionRecorder.clear()}>
              {tScope('discard')}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
