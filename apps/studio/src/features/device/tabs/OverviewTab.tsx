import { useMemo } from 'react';
import { Activity } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { EmptyState, Panel } from '../../../ui';
import { FaultList, SignalTile, modelText, type DeviceView } from '../../../core';
import { pickVisualization, tileSignals } from '../logic/viz';
import { VIZ_COMPONENTS } from '../viz';
import { tDevice } from '../messages';

/** Live tiles from the catalog plus the model's visualisation. */
export function OverviewTab({ device }: { device: DeviceView }) {
  const { tl } = useI18n();
  const def = device.def;
  const viz = pickVisualization(def);
  const tiles = useMemo(() => tileSignals(def, viz), [def, viz]);
  const Viz = viz ? VIZ_COMPONENTS[viz] : null;
  const live = device.online;
  return (
    <div className="dv-overview">
      {device.faults.list.length > 0 && (
        <Panel title={tDevice('overview.faults')} padding="sm" className="dv-overview__faults">
          <FaultList device={device} compact />
        </Panel>
      )}
      {Viz && def && (
        <Panel title={tDevice('overview.viz', { model: tl(modelText(device)) })} padding="md">
          <Viz uid48={device.uid48} def={def} live={live} />
        </Panel>
      )}
      <Panel title={tDevice('overview.tiles')} subtitle={tiles.length ? tDevice('overview.tilesCount', { count: tiles.length }) : undefined} padding="md">
        {tiles.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Activity}
            title={def ? tDevice('overview.noSignals') : tDevice('overview.unknownModel')}
            description={def ? tDevice('overview.noSignalsBody') : tDevice('overview.unknownModelBody')}
          />
        ) : (
          <div className="dv-tiles">
            {tiles.map((s) => (
              <SignalTile key={s.key} uid48={device.uid48} signal={s.key} />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
