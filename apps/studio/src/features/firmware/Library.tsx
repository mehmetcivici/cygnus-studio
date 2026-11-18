import { useRef, useState, type DragEvent } from 'react';
import { FilePlus2, FileX2, PackagePlus, Trash2, Upload, X } from 'lucide-react';
import { getModel } from '@cygnus/protocol';
import { useI18n } from '../../i18n';
import { Badge, Button, EmptyState, IconButton, Panel, toast } from '../../ui';
import { ModelIcon, useSimulation, useBus } from '../../core';
import { buildDate, fmtVersion, imageVersion, type FwImage } from './logic';
import { addImageFiles, dismissRejected, loadDemoImages, removeImage, useFwLibrary } from './store';
import { tFirmware } from './messages';

function ImageItem({ image }: { image: FwImage }) {
  const { tl, fmtNumber } = useI18n();
  const h = image.header;
  const def = getModel(h.model);
  const studioRev = def?.catalogRev;
  const newer = studioRev !== undefined && h.catalogRev > studioRev;
  return (
    <li className="fw-image">
      <ModelIcon def={def} size={18} boxed />
      <div className="fw-image__main">
        <div className="fw-image__head">
          <span className="fw-image__model">{def ? tl(def.name) : tFirmware('lib.unknownModel', { model: h.model })}</span>
          <Badge mono tone="accent" size="sm">
            {fmtVersion(imageVersion(h))}
          </Badge>
        </div>
        <div className="fw-image__file cy-mono" title={image.fileName}>
          {image.fileName} · {fmtNumber(image.bytes.length / 1024, 1)} kB
        </div>
        <div className="fw-image__meta">
          <span>{tFirmware('lib.col.hw')}: {tFirmware('lib.hw', { min: h.hwRevMin, max: h.hwRevMax })}</span>
          <span>{tFirmware('lib.col.catalog')}: {h.catalogRev}</span>
          <span className="cy-mono">{buildDate(h.buildDay)}</span>
          <span className="cy-mono">#{h.gitHash.toString(16).padStart(8, '0')}</span>
        </div>
        {newer && <div className="fw-image__warn">{tFirmware('lib.catalogNewer', { studio: studioRev, image: h.catalogRev })}</div>}
      </div>
      <IconButton size="sm" icon={Trash2} label={tFirmware('lib.remove')} onClick={() => removeImage(image.id)} />
    </li>
  );
}

export function Library() {
  const { t } = useI18n();
  const images = useFwLibrary((s) => s.images);
  const rejected = useFwLibrary((s) => s.rejected);
  const sim = useSimulation();
  const bus = useBus();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const addFiles = async (files: FileList | File[] | null): Promise<void> => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    const r = await addImageFiles(list);
    if (r.added > 0) toast.success(tFirmware('lib.added', { count: r.added }));
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setOver(false);
    void addFiles(e.dataTransfer.files);
  };
  const demo = (): void => {
    const n = bus ? loadDemoImages(bus.devices) : 0;
    if (n > 0) toast.success(tFirmware('lib.demoDone', { count: n }));
    else toast.info(tFirmware('lib.demoNone'));
  };

  return (
    <Panel
      title={tFirmware('lib.title')}
      subtitle={tFirmware('lib.count', { count: images.length })}
      icon={PackagePlus}
      actions={
        <Button size="sm" icon={FilePlus2} onClick={() => input.current?.click()}>
          {tFirmware('lib.add')}
        </Button>
      }
    >
      <input
        ref={input}
        type="file"
        multiple
        accept=".cyfw,application/octet-stream"
        hidden
        data-testid="fw-file-input"
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="fw-lib">
        <div
          className={over ? 'fw-drop is-over' : 'fw-drop'}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          data-testid="fw-dropzone"
        >
          <Upload size={18} strokeWidth={1.8} aria-hidden />
          <div>
            <div className="fw-drop__title">{over ? tFirmware('lib.dropActive') : tFirmware('lib.dropTitle')}</div>
            <div className="fw-drop__body">{tFirmware('lib.dropBody')}</div>
          </div>
        </div>
        {sim && (
          <Button variant="secondary" size="sm" block icon={PackagePlus} onClick={demo} title={tFirmware('lib.demoHint')}>
            {tFirmware('lib.demo')}
          </Button>
        )}
        {rejected.length > 0 && (
          <div className="fw-rejects" role="alert">
            <div className="fw-rejects__head">
              <FileX2 size={14} aria-hidden />
              <span>{tFirmware('lib.rejected')}</span>
              <button type="button" className="fw-rejects__clear" onClick={() => dismissRejected('all')}>
                {tFirmware('lib.dismiss')}
              </button>
            </div>
            <ul>
              {rejected.map((r) => (
                <li key={r.id}>
                  <div className="fw-rejects__file cy-mono">{r.fileName}</div>
                  <div className="fw-rejects__why">{t(`firmware.lib.error.${r.error}`)}</div>
                  <IconButton size="sm" icon={X} label={tFirmware('lib.dismiss')} noTooltip onClick={() => dismissRejected(r.id)} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {images.length === 0 ? (
          <EmptyState size="sm" title={tFirmware('lib.emptyTitle')} description={tFirmware('lib.emptyBody')} />
        ) : (
          <ul className="fw-images">
            {images.map((i) => (
              <ImageItem key={i.id} image={i} />
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
