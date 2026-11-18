import { useDeferredValue, useMemo, useState } from 'react';
import { LayoutGrid, List, Network, Search, SearchX } from 'lucide-react';
import { useI18n, type Lang } from '../../i18n';
import { EmptyState, Page, SegmentedControl, Select, Spinner, TextField } from '../../ui';
import { LEGACY_MODEL_NAME, updateSettings, useConnection, useDevices, useSettings, type BusView, type DeviceView } from '../../core';
import type { FeatureProps } from '../registry';
import { BusDiagram } from './BusDiagram';
import { DeviceCard, DeviceRow } from './DeviceCard';
import { PowerSummary, findPowerBoard } from './PowerSummary';
import { UnresolvedStrip } from './Unresolved';
import { Welcome } from './Welcome';
import { SimIntro } from './SimIntro';
import { tBus } from './messages';
import './bus.css';

type GroupBy = 'none' | 'type' | 'status';

const CATEGORY_ORDER = ['motor', 'sensor', 'servo', 'power', 'tool', 'other'] as const;
const STATUS_ORDER = ['fault', 'warn', 'boot', 'ok', 'offline'] as const;

function matches(d: DeviceView, q: string, lang: Lang): boolean {
  if (!q) return true;
  const hay = [d.name, d.def?.name[lang] ?? '', d.def?.name.tr ?? '', d.legacy ? LEGACY_MODEL_NAME[lang] : '', `#${d.num}`, d.uid48, d.def?.key ?? '']
    .join(' ')
    .toLocaleLowerCase(lang);
  return hay.includes(q.toLocaleLowerCase(lang));
}

function groupOf(d: DeviceView, by: GroupBy): string {
  if (by === 'status') return d.status;
  if (by === 'type') return d.legacy ? 'legacy' : (d.def?.category ?? 'other');
  return 'all';
}

function useGroups(devices: readonly DeviceView[], by: GroupBy, q: string, lang: Lang) {
  return useMemo(() => {
    const shown = devices.filter((d) => matches(d, q, lang));
    if (by === 'none') return { shown: shown.length, groups: [{ key: 'all', items: shown }] };
    const map = new Map<string, DeviceView[]>();
    for (const d of shown) {
      const k = groupOf(d, by);
      map.set(k, [...(map.get(k) ?? []), d]);
    }
    const order: readonly string[] = by === 'status' ? STATUS_ORDER : [...CATEGORY_ORDER.slice(0, 5), 'legacy', 'other'];
    return { shown: shown.length, groups: order.filter((k) => map.has(k)).map((k) => ({ key: k, items: map.get(k) ?? [] })) };
  }, [devices, by, q, lang]);
}

export function BusScreen(_props: FeatureProps) {
  const { t, lang } = useI18n();
  const phase = useConnection((s) => s.phase);
  const devices = useDevices();
  const view = useSettings((s) => s.busView);
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const q = useDeferredValue(query.trim());
  const { shown, groups } = useGroups(devices, groupBy, q, lang);
  const power = findPowerBoard(devices);
  const online = devices.filter((d) => d.online).length;

  if (phase === 'idle' || phase === 'error' || (phase === 'connecting' && devices.length === 0)) {
    return (
      <Page title={t('nav.bus')} subtitle={tBus('subtitle')} icon={Network}>
        <Welcome />
      </Page>
    );
  }

  const groupLabel = (k: string): string => {
    if (groupBy === 'status') return tBus(`statusGroup.${k as (typeof STATUS_ORDER)[number]}`);
    if (k === 'legacy') return tBus('legacyGroup');
    if (k === 'other') return '—';
    return t(`core.category.${k}`);
  };

  return (
    <Page
      title={t('nav.bus')}
      subtitle={tBus('subtitle')}
      icon={Network}
      actions={
        <>
          <span className={online < devices.length ? 'bus-count is-short' : 'bus-count'}>
            {q ? tBus('count', { shown, total: devices.length }) : tBus('countOnline', { online, total: devices.length })}
          </span>
          <TextField value={query} onChange={setQuery} icon={Search} placeholder={tBus('search')} aria-label={tBus('search')} size="sm" width={260} />
          <Select<GroupBy>
            size="sm"
            value={groupBy}
            onChange={setGroupBy}
            ariaLabel={tBus('group.label')}
            options={[
              { value: 'none', label: tBus('group.none') },
              { value: 'type', label: tBus('group.type') },
              { value: 'status', label: tBus('group.status') },
            ]}
          />
          <SegmentedControl<BusView>
            size="sm"
            value={view}
            onChange={(v) => updateSettings({ busView: v })}
            ariaLabel={tBus('view.grid')}
            options={[
              { value: 'grid', icon: LayoutGrid, title: tBus('view.grid') },
              { value: 'list', icon: List, title: tBus('view.list') },
            ]}
          />
        </>
      }
    >
      <div className="bus-screen">
        <SimIntro />
        <UnresolvedStrip />
        {devices.length === 0 ? (
          <EmptyState
            icon={phase === 'connected' ? Network : undefined}
            title={phase === 'connected' ? tBus('searching') : tBus('noDevices')}
            description={phase === 'connected' ? <Spinner size={18} /> : tBus('noDevicesBody')}
          />
        ) : (
          <>
            <div className={power ? 'bus-overview has-power' : 'bus-overview'}>
              <BusDiagram devices={devices} />
              {power && <PowerSummary device={power} />}
            </div>
            {shown === 0 && <EmptyState size="sm" icon={SearchX} title={tBus('noMatch')} />}
            {groups.map(
              (g) =>
                g.items.length > 0 && (
                  <section key={g.key} className="bus-group">
                    {groupBy !== 'none' && (
                      <h2 className="bus-group__title">
                        {groupLabel(g.key)} <span>{g.items.length}</span>
                      </h2>
                    )}
                    {view === 'grid' ? (
                      <div className="bus-grid">
                        {g.items.map((d) => (
                          <DeviceCard key={d.uid48} device={d} />
                        ))}
                      </div>
                    ) : (
                      <div className="bus-list" role="table">
                        {g.items.map((d) => (
                          <DeviceRow key={d.uid48} device={d} />
                        ))}
                      </div>
                    )}
                  </section>
                ),
            )}
          </>
        )}
      </div>
    </Page>
  );
}
