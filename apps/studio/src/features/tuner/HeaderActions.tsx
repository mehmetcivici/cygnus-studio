import { useState } from 'react';
import { Download, FileText, NotebookPen, Printer } from 'lucide-react';
import { useI18n, type Lang } from '../../i18n';
import { Button, Checkbox, Modal, SegmentedControl, toast } from '../../ui';
import { displayName, downloadFile, modelText, safeFileName, useProject } from '../../core';
import { useTuner } from './controller';
import { useTunerUi } from './state';
import { tunerSection, setNotes } from './project';
import { buildReport } from './report';
import { runLabelKey } from './runs';
import { tTuner } from './messages';

export function HeaderActions() {
  const [report, setReport] = useState(false);
  const [notes, setNotesOpen] = useState(false);
  const api = useTuner();
  return (
    <>
      <Button size="sm" icon={NotebookPen} onClick={() => setNotesOpen(true)}>
        {tTuner('notes.button')}
      </Button>
      <Button size="sm" icon={FileText} onClick={() => setReport(true)} disabled={api.runs.length === 0}>
        {tTuner('report.button')}
      </Button>
      {report && <ReportDialog onClose={() => setReport(false)} />}
      {notes && <NotesDialog onClose={() => setNotesOpen(false)} />}
    </>
  );
}

function NotesDialog({ onClose }: { onClose: () => void }) {
  const section = tunerSection.use();
  return (
    <Modal open onClose={onClose} title={tTuner('notes.title')} size="md" footer={<Button onClick={onClose}>{tTuner('notes.close')}</Button>}>
      <textarea className="tuner-notes" rows={10} value={section.notes} placeholder={tTuner('notes.placeholder')} onChange={(e) => setNotes(e.target.value)} />
    </Modal>
  );
}

function ReportDialog({ onClose }: { onClose: () => void }) {
  const { lang, tl } = useI18n();
  const api = useTuner();
  const selected = useTunerUi((s) => s.selected);
  const projectName = useProject((s) => s.project.name);
  const [rl, setRl] = useState<Lang>(lang);
  const initial = selected.length ? selected : api.runs.slice(-4).map((r) => r.id);
  const [ids, setIds] = useState<string[]>(initial);
  const runs = api.runs.filter((r) => ids.includes(r.id));
  const make = (): string =>
    buildReport({
      lang: rl,
      title: tTuner('report.heading'),
      deviceName: displayName(api.view, rl),
      modelName: tl(modelText(api.view)),
      loopName: api.ctx.loop.label[rl],
      unit: api.ctx.unit,
      roles: api.ctx.roles,
      runs,
      notes: tunerSection.get().notes,
      projectName,
    });
  const file = safeFileName(`${displayName(api.view, rl)}-${api.ctx.loop.key}-report`);
  const open = (): void => {
    const w = window.open('', '_blank');
    if (!w) {
      toast.warn(tTuner('report.popup'));
      downloadFile(`${file}.html`, make(), 'text/html');
      return;
    }
    w.document.open();
    w.document.write(make());
    w.document.close();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={tTuner('report.title')}
      size="md"
      footer={
        <>
          <Button icon={Download} disabled={!runs.length} onClick={() => downloadFile(`${file}.html`, make(), 'text/html')}>
            {tTuner('report.download')}
          </Button>
          <Button variant="primary" icon={Printer} disabled={!runs.length} onClick={open}>
            {tTuner('report.open')}
          </Button>
        </>
      }
    >
      <div className="tuner-report">
        <div className="tuner-row">
          <span className="tuner-field__label">{tTuner('report.lang')}</span>
          <SegmentedControl<Lang>
            size="sm"
            value={rl}
            onChange={setRl}
            ariaLabel={tTuner('report.lang')}
            options={[
              { value: 'tr', label: 'Türkçe' },
              { value: 'en', label: 'English' },
            ]}
          />
        </div>
        <p className="tuner-muted">{tTuner('report.body')}</p>
        <ul className="tuner-report__list">
          {[...api.runs].reverse().map((r) => (
            <li key={r.id}>
              <Checkbox
                checked={ids.includes(r.id)}
                onChange={(c) => setIds(c ? [...ids, r.id] : ids.filter((x) => x !== r.id))}
                label={`#${r.n} · ${tTuner(runLabelKey(r))}${r.gainSet ? ` · ${r.gainSet}` : ''}${r.note ? ` · ${r.note}` : ''}`}
              />
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
