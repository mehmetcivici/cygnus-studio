import { useState } from 'react';
import { FilePlus2, FolderOpen, Save } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Badge, Button, ConfirmDialog, Panel, TextField, toast } from '../../ui';
import { newProject, openProjectFromDisk, saveProjectToDisk, setProjectName, setProjectNotes, useProject } from '../../core';
import { clearSaved, markSaved, useSaveInfo } from './saveInfo';
import { sectionOwner, sectionShape } from './live';
import { tProject } from './messages';
import { repairVehicleConfig } from '../vehicle/model';

const KNOWN_OWNERS = ['tuner', 'scope', 'vehicle', 'canmon', 'device', 'bus'];

export function FileTab() {
  const { t, lang, fmtNumber } = useI18n();
  const project = useProject((s) => s.project);
  const dirty = useProject((s) => s.dirty);
  const fileName = useProject((s) => s.fileName);
  const savedAt = useSaveInfo((s) => s.savedAt);
  const [confirm, setConfirm] = useState<'new' | 'open' | null>(null);
  const when = (iso: string | number | null): string => (iso === null ? '—' : new Date(iso).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB'));

  const doOpen = async (): Promise<void> => {
    const r = await openProjectFromDisk();
    if (r === null) return;
    if (r.ok) {
      clearSaved();
      toast.success(tProject('file.opened'));
    } else toast.error(tProject('file.openFailed'), { description: tProject(`file.error.${r.error}`) + (r.detail ? ` (${r.detail})` : '') });
  };
  const ask = (what: 'new' | 'open'): void => {
    if (dirty) setConfirm(what);
    else void run(what);
  };
  const run = async (what: 'new' | 'open'): Promise<void> => {
    setConfirm(null);
    if (what === 'new') {
      newProject('');
      clearSaved();
    } else await doOpen();
  };
  const save = (): void => {
    if (!saveProjectToDisk()) return;
    markSaved();
    toast.success(tProject('file.saved'));
  };

  const devices = project.bus.devices.length;
  const sections = Object.entries(project.sections);
  const rows: Array<{ id: string; label: string; summary: string; empty: boolean }> = [
    { id: 'bus', label: tProject('sum.bus'), summary: devices ? tProject('sum.busValue', { count: devices, at: when(project.bus.capturedAt) }) : tProject('sum.none'), empty: devices === 0 },
    { id: 'vehicle', label: tProject('sum.vehicle'), summary: project.vehicle ? `${project.vehicle.name || project.vehicle.templateId} · ${tProject('sum.slots', { count: Object.keys(repairVehicleConfig(project.vehicle).config.bindings).length })}` : tProject('sum.none'), empty: !project.vehicle },
    { id: 'notes', label: tProject('sum.notes'), summary: project.notes.trim() ? tProject('sum.chars', { count: project.notes.length }) : tProject('sum.none'), empty: !project.notes.trim() },
    ...sections.map(([id, v]) => {
      const owner = sectionOwner(id);
      const shape = sectionShape(v);
      return {
        id,
        label: KNOWN_OWNERS.includes(owner) ? t(`project.sum.owner.${owner}`) : id,
        summary: shape.kind === 'list' ? tProject('sum.items', { count: shape.count }) : shape.kind === 'object' ? tProject('sum.keys', { count: shape.count }) : shape.count ? tProject('sum.value') : tProject('sum.none'),
        empty: shape.count === 0,
      };
    }),
  ];

  return (
    <div className="pj-grid">
      <Panel
        title={tProject('file.title')}
        actions={
          <>
            <Button size="sm" icon={FilePlus2} onClick={() => ask('new')} data-testid="pj-new">
              {tProject('file.new')}
            </Button>
            <Button size="sm" icon={FolderOpen} onClick={() => ask('open')} data-testid="pj-open">
              {tProject('file.open')}
            </Button>
            <Button size="sm" variant="primary" icon={Save} onClick={save} data-testid="pj-save">
              {tProject('file.save')}
            </Button>
          </>
        }
      >
        <div className="pj-form">
          <label className="pj-field">
            <span>{tProject('file.name')}</span>
            <TextField value={project.name} onChange={setProjectName} placeholder={tProject('file.namePlaceholder')} block aria-label={tProject('file.name')} data-testid="pj-name" />
          </label>
          <label className="pj-field">
            <span>{tProject('file.notes')}</span>
            <textarea className="pj-textarea" value={project.notes} onChange={(e) => setProjectNotes(e.target.value)} placeholder={tProject('file.notesPlaceholder')} rows={6} data-testid="pj-notes" />
          </label>
          <dl className="pj-meta">
            <div>
              <dt>{tProject('file.state')}</dt>
              <dd>
                {dirty ? (
                  <Badge tone="warn" data-testid="pj-dirty">
                    {tProject('file.dirty')}
                  </Badge>
                ) : (
                  <Badge tone="ok">{tProject('file.clean')}</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt>{tProject('file.fileName')}</dt>
              <dd className="cy-mono">{fileName ?? '—'}</dd>
            </div>
            <div>
              <dt>{tProject('file.lastSaved')}</dt>
              <dd data-testid="pj-saved-at">{when(savedAt)}</dd>
            </div>
            <div>
              <dt>{tProject('file.modified')}</dt>
              <dd>{when(project.modifiedAt)}</dd>
            </div>
            <div>
              <dt>{tProject('file.created')}</dt>
              <dd>{when(project.createdAt)}</dd>
            </div>
            <div>
              <dt>{tProject('file.format')}</dt>
              <dd className="cy-mono">
                {project.format} v{fmtNumber(project.version, 0)}
              </dd>
            </div>
          </dl>
        </div>
      </Panel>
      <Panel title={tProject('sum.title')} subtitle={tProject('sum.subtitle')}>
        <ul className="pj-sections">
          {rows.map((r) => (
            <li key={r.id} className={r.empty ? 'is-empty' : undefined}>
              <span className="pj-sections__label">{r.label}</span>
              <span className="pj-sections__sum">{r.summary}</span>
            </li>
          ))}
        </ul>
      </Panel>
      <ConfirmDialog
        open={confirm !== null}
        tone="danger"
        title={tProject('file.discardTitle')}
        message={tProject('file.discardBody')}
        confirmLabel={confirm === 'new' ? tProject('file.new') : tProject('file.open')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void run(confirm)}
      />
    </div>
  );
}
