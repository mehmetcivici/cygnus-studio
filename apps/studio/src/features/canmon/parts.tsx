import { memo } from 'react';
import { Cls, decodeId, type FrameDescription } from '@cygnus/protocol';
import { cardOf, type CardRef } from './filter';
import { Badge, type Tone } from '../../ui';
import { classLabel, frameKind, idHex } from './ids';
import { tCanMonitor } from './messages';

const CLASS_TONE: Readonly<Record<number, Tone>> = {
  [Cls.CTRL]: 'caution',
  [Cls.STATUS]: 'neutral',
  [Cls.SYS_REQ]: 'accent',
  [Cls.SYS_RSP]: 'accent',
  [Cls.PARAM_REQ]: 'ok',
  [Cls.PARAM_RSP]: 'ok',
  [Cls.STREAM_REQ]: 'warn',
  [Cls.STREAM_RSP]: 'warn',
  [Cls.FW_REQ]: 'danger',
  [Cls.FW_RSP]: 'danger',
  [Cls.ENUM_RSP]: 'accent',
};

export function classTone(id: number): Tone {
  return CLASS_TONE[decodeId(id).cls] ?? 'neutral';
}

export function ClassBadge({ id }: { id: number }) {
  const kind = frameKind(id);
  if (kind === 'legacy') return <Badge size="sm" variant="outline" mono>{tCanMonitor('kind.legacy')}</Badge>;
  if (kind === 'foreign') return <Badge size="sm" variant="outline" mono>{tCanMonitor('kind.foreign')}</Badge>;
  return (
    <Badge size="sm" tone={classTone(id)} mono>
      {classLabel(id)}
    </Badge>
  );
}

export function fmtId(id: number, hex: boolean): string {
  return hex ? `0x${idHex(id)}` : String(id);
}

export interface DecodedProps {
  id: number;
  desc: FrameDescription | null;
  /** User-given board name for the sender/target, when known. */
  boardName: string;
  onCard: (card: CardRef) => void;
}

/** Class, index, card and the first decoded fields on one line. Memoised: a row's frame never changes. */
export const Decoded = memo(function Decoded({ id, desc, boardName, onCard }: DecodedProps) {
  const kind = frameKind(id);
  if (!desc) return <ClassBadge id={id} />;
  if (kind !== 'cycan') {
    return (
      <span className="canmon-dec">
        <ClassBadge id={id} />
        <span className="canmon-dec__dim">{desc.summary}</span>
      </span>
    );
  }
  const fields = desc.fields
    .slice(0, 4)
    .map((f) => `${f.label} ${f.value}`)
    .join(' · ');
  return (
    <span className="canmon-dec">
      <ClassBadge id={id} />
      {desc.indexName && desc.indexName !== desc.className && <strong className="canmon-dec__index">{desc.indexName}</strong>}
      <button
        type="button"
        className="canmon-link"
        title={tCanMonitor('filterCard')}
        onClick={(e) => {
          e.stopPropagation();
          const card = cardOf(id);
          if (card) onCard(card);
        }}
      >
        {desc.address}
      </button>
      {boardName && <span className="canmon-dec__name">“{boardName}”</span>}
      {fields && <span className="canmon-dec__dim">{fields}</span>}
    </span>
  );
});

/** Payload bytes in hex; bytes that changed recently are highlighted. */
export const Bytes = memo(function Bytes({ data, changed }: { data: Uint8Array; changed?: (i: number) => boolean }) {
  return (
    <span className="canmon-bytes cy-mono">
      {Array.from(data, (b, i) => (
        <span key={i} className={changed?.(i) ? 'is-changed' : undefined}>
          {b.toString(16).toUpperCase().padStart(2, '0')}
        </span>
      ))}
    </span>
  );
});
