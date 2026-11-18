import { Search, X } from 'lucide-react';
import type { DeviceView } from '../../core';
import { displayName } from '../../core';
import { useI18n } from '../../i18n';
import { Badge, Button, Checkbox, SegmentedControl, Select, TextField } from '../../ui';
import { EMPTY_FILTER, isFilterActive, type FrameFilter } from './filter';
import { CLASS_NAMES, KNOWN_CLASSES, idHex } from './ids';
import { tCanMonitor } from './messages';

export interface FiltersProps {
  filter: FrameFilter;
  onChange: (f: FrameFilter) => void;
  devices: readonly DeviceView[];
  shown: number;
  total: number;
}

const cardKey = (devType: number, num: number): string => `${devType}:${num}`;

export function Filters({ filter, onChange, devices, shown, total }: FiltersProps) {
  const { lang, fmtNumber } = useI18n();
  const active = isFilterActive(filter);
  const cards = [
    { value: '', label: tCanMonitor('filter.allCards') },
    ...devices.map((d) => ({ value: cardKey(d.devType, d.num), label: `${displayName(d, lang)} · #${d.num}` })),
  ];
  const selectedCard = filter.card ? cardKey(filter.card.devType, filter.card.num) : '';
  if (filter.card && !cards.some((c) => c.value === selectedCard)) cards.push({ value: selectedCard, label: `DEVTYPE ${filter.card.devType} · #${filter.card.num}` });
  const classOptions = [
    { value: '', label: tCanMonitor('filter.allClasses') },
    ...KNOWN_CLASSES.map((c) => ({ value: String(c), label: CLASS_NAMES[c] ?? String(c) })),
    { value: '-1', label: tCanMonitor('kind.legacy') },
    { value: '-2', label: tCanMonitor('kind.foreign') },
  ];
  return (
    <div className="canmon-filters">
      <Select<string>
        size="sm"
        value={selectedCard}
        options={cards}
        width={168}
        ariaLabel={tCanMonitor('filter.card')}
        onChange={(v) => {
          const [dt, num] = v.split(':').map(Number);
          onChange({ ...filter, card: v === '' || dt === undefined || num === undefined ? null : { devType: dt, num } });
        }}
      />
      <Select<string>
        size="sm"
        value={filter.classes[0] === undefined ? '' : String(filter.classes[0])}
        options={classOptions}
        width={132}
        ariaLabel={tCanMonitor('filter.class')}
        onChange={(v) => onChange({ ...filter, classes: v === '' ? [] : [Number(v)] })}
      />
      <SegmentedControl<FrameFilter['dir']>
        size="sm"
        value={filter.dir}
        ariaLabel={tCanMonitor('filter.dir')}
        onChange={(dir) => onChange({ ...filter, dir })}
        options={[
          { value: 'all', label: tCanMonitor('filter.dirAll') },
          { value: 'rx', label: 'RX' },
          { value: 'tx', label: 'TX' },
        ]}
      />
      <TextField
        size="sm"
        icon={Search}
        value={filter.text}
        onChange={(text) => onChange({ ...filter, text })}
        placeholder={tCanMonitor('filter.search')}
        aria-label={tCanMonitor('filter.search')}
        mono
        width={210}
      />
      <Checkbox checked={filter.problemsOnly} onChange={(problemsOnly) => onChange({ ...filter, problemsOnly })} label={tCanMonitor('filter.problems')} />
      {filter.idEq !== null && (
        <Badge tone="accent" mono>
          ID {idHex(filter.idEq)}
          <button type="button" className="canmon-chipx" aria-label={tCanMonitor('filter.clearId')} onClick={() => onChange({ ...filter, idEq: null })}>
            <X size={11} />
          </button>
        </Badge>
      )}
      {active && (
        <Button size="sm" variant="ghost" icon={X} onClick={() => onChange(EMPTY_FILTER)}>
          {tCanMonitor('filter.reset')}
        </Button>
      )}
      <span className="canmon-filters__count cy-mono">{tCanMonitor('count', { shown: fmtNumber(shown, 0), total: fmtNumber(total, 0) })}</span>
    </div>
  );
}
