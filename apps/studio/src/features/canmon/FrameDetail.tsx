import { Filter, X } from 'lucide-react';
import { decodeId, MFR, type FrameDescription } from '@cygnus/protocol';
import { fmtNumber, useI18n } from '../../i18n';
import { Button, IconButton, cx } from '../../ui';
import { cardOf, type CardRef } from './filter';
import { fmtFrameTime, frameTypeLabel } from './format';
import { FIELD_BITS, FIELD_ORDER, bytesHex, frameKind, idHex, idSegments, type FieldKey } from './ids';
import { tCanMonitor } from './messages';
import { ClassBadge } from './parts';

export interface DetailFrame {
  id: number;
  t: number;
  dir: 'rx' | 'tx';
  fd: boolean;
  brs: boolean;
  data: Uint8Array;
}

export interface FrameDetailProps {
  frame: DetailFrame;
  desc: FrameDescription | null;
  onClose: () => void;
  onFilterId: (id: number) => void;
  onFilterCard: (card: CardRef) => void;
}

function meaning(key: FieldKey, value: number, desc: FrameDescription | null): string {
  switch (key) {
    case 'devType':
      return desc?.devTypeName ?? '';
    case 'mfr':
      return value === MFR ? tCanMonitor('mfr.ours') : tCanMonitor('mfr.foreign');
    case 'cls':
      return desc ? desc.className : '';
    case 'index':
      return desc?.indexName ?? '';
    case 'num':
      return value === 0 ? tCanMonitor('num.broadcast') : value === 63 ? tCanMonitor('num.unassigned') : '';
  }
}

const FIELD_NAMES: Record<FieldKey, string> = { devType: 'DEVTYPE', mfr: 'MFR', cls: 'CLASS', index: 'INDEX', num: 'NUM' };

/** The selected frame: 29-bit identifier map, byte/bit view and decoded fields. */
export function FrameDetail({ frame, desc, onClose, onFilterId, onFilterCard }: FrameDetailProps) {
  const { lang } = useI18n();
  const dec = (v: number, d: number): string => fmtNumber(v, d, { lang, grouping: false });
  const segs = idSegments(frame.id);
  const card = cardOf(frame.id);
  const kind = frameKind(frame.id);
  const f = decodeId(frame.id);
  return (
    <aside className="canmon-detail" aria-label={tCanMonitor('detail.title')}>
      <header className="canmon-detail__head">
        <div className="canmon-detail__title">
          <ClassBadge id={frame.id} />
          <strong className="cy-mono">0x{idHex(frame.id)}</strong>
        </div>
        <IconButton size="sm" icon={X} label={tCanMonitor('detail.close')} onClick={onClose} />
      </header>
      <div className="canmon-detail__meta cy-mono">
        <span>{frame.dir.toUpperCase()}</span>
        <span>{frameTypeLabel(frame)}</span>
        <span>{tCanMonitor('detail.bytes', { n: frame.data.length })}</span>
        <span>{fmtFrameTime('abs', frame.t, null, dec)} s</span>
      </div>
      {desc && <p className="canmon-detail__summary">{desc.summary}</p>}
      <div className="canmon-detail__actions">
        <Button size="sm" icon={Filter} onClick={() => onFilterId(frame.id)}>
          {tCanMonitor('detail.filterId')}
        </Button>
        {card && (
          <Button size="sm" icon={Filter} onClick={() => onFilterCard(card)}>
            {tCanMonitor('detail.filterCard')}
          </Button>
        )}
      </div>

      <section className="canmon-detail__sec">
        <h3>{tCanMonitor('detail.id')}</h3>
        <div className="canmon-bitmap" role="group" aria-label={tCanMonitor('detail.id')}>
          {segs.map((s) => (
            <div key={s.key} className={cx('canmon-seg', `canmon-seg--${s.key}`, s.key === 'mfr' && s.value !== MFR && 'is-foreign')} style={{ flexGrow: s.bits.length }}>
              <div className="canmon-seg__name">{FIELD_NAMES[s.key]}</div>
              <div className="canmon-seg__bits cy-mono">{s.bits}</div>
              <div className="canmon-seg__range cy-mono">
                {s.hi}‥{s.lo}
              </div>
              <div className="canmon-seg__val cy-mono">
                {s.value} <span>0x{s.value.toString(16).toUpperCase()}</span>
              </div>
              <div className="canmon-seg__meaning">{meaning(s.key, s.value, desc) || ' '}</div>
            </div>
          ))}
        </div>
        <div className="canmon-detail__note">
          {FIELD_ORDER.map((k) => `${FIELD_NAMES[k]} ${FIELD_BITS[k].hi - FIELD_BITS[k].lo + 1}`).join(' · ')} = 29 bit
        </div>
        {kind === 'legacy' && <div className="canmon-detail__note">{tCanMonitor('detail.legacy', { cls: f.cls })}</div>}
        {kind === 'foreign' && <div className="canmon-detail__note">{tCanMonitor('detail.foreign')}</div>}
      </section>

      <section className="canmon-detail__sec">
        <h3>{tCanMonitor('detail.data')}</h3>
        {frame.data.length === 0 ? (
          <div className="canmon-detail__note">{tCanMonitor('detail.noData')}</div>
        ) : (
          <table className="canmon-bytetable cy-mono">
            <thead>
              <tr>
                <th>#</th>
                <th>HEX</th>
                <th>DEC</th>
                <th>BIN</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(frame.data, (b, i) => (
                <tr key={i}>
                  <td>{i}</td>
                  <td>{bytesHex(Uint8Array.of(b))}</td>
                  <td>{b}</td>
                  <td>
                    {Array.from({ length: 8 }, (_, k) => {
                      const on = (b >> (7 - k)) & 1;
                      return (
                        <span key={k} className={cx('canmon-bit', on === 1 && 'is-on', k === 3 && 'is-nibble')}>
                          {on}
                        </span>
                      );
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {desc && desc.fields.length > 0 && (
        <section className="canmon-detail__sec">
          <h3>{tCanMonitor('detail.fields')}</h3>
          <table className="canmon-fields">
            <tbody>
              {desc.fields.map((fl) => (
                <tr key={fl.key}>
                  <th>{fl.label}</th>
                  <td className="cy-mono">{fl.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </aside>
  );
}
