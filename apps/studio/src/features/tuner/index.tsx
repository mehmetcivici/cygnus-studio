import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Cable, FlaskConical, SlidersHorizontal } from 'lucide-react';
import { Button, EmptyState, Page, Spinner, cx } from '../../ui';
import { useI18n } from '../../i18n';
import { connection, useConnection, useDevices, useUnresolved, type DeviceView } from '../../core';
import { navigate } from '../../app/nav';
import type { FeatureProps } from '../registry';
import { TunerProvider, useTuner, useTunerController, useTunerDevice } from './controller';
import { setUi, useTunerUi } from './state';
import { CompactLoopBar, LeftColumn } from './LeftColumn';
import { CenterColumn } from './CenterColumn';
import { RightColumn } from './RightColumn';
import { RunStrip } from './RunStrip';
import { HeaderActions } from './HeaderActions';
import { useTunerKeys } from './keys';
import { tTuner } from './messages';
import './tuner.css';

export function TunerScreen({ params }: FeatureProps) {
  const { t } = useI18n();
  const phase = useConnection((s) => s.phase);
  const devices = useDevices();
  const unresolved = useUnresolved();
  const { view, tunable } = useTunerDevice(params.device);
  const loopKey = useTunerUi((s) => s.loopKey);
  const loop = view?.def?.tuner.loops.find((l) => l.key === loopKey) ?? view?.def?.tuner.loops[0];

  useEffect(() => {
    if (view && useTunerUi.getState().uid !== view.uid48) setUi({ uid: view.uid48 });
  }, [view]);

  const page = (body: ReactNode, actions?: ReactNode) => (
    <Page title={t('nav.tuner')} subtitle={tTuner('subtitle')} icon={SlidersHorizontal} layout="fill" actions={actions}>
      {body}
    </Page>
  );

  if (phase !== 'connected' && phase !== 'lost') {
    return page(
      <EmptyState
        icon={Cable}
        title={phase === 'connecting' ? tTuner('state.connecting') : tTuner('state.noConnection')}
        description={phase === 'connecting' ? <Spinner size={18} /> : tTuner('state.noConnectionBody')}
        actions={
          phase === 'connecting' ? undefined : (
            <>
              <Button variant="primary" onClick={() => navigate('bus')}>
                {tTuner('state.openBus')}
              </Button>
              <Button icon={FlaskConical} onClick={() => void connection.connect({ kind: 'sim', scenarioId: 'bench.flywheel' })}>
                {tTuner('state.trySim')}
              </Button>
            </>
          )
        }
      />,
    );
  }

  if (!view || !loop) {
    const searching = devices.length === 0 && phase === 'connected';
    const body = tunable.length ? tTuner('state.allOffline') : unresolved.length ? tTuner('state.unresolved', { n: unresolved.length }) : tTuner('state.noTunableBody');
    return page(
      <EmptyState
        icon={SlidersHorizontal}
        title={searching ? tTuner('state.searching') : tTuner('state.noTunable')}
        description={searching ? <Spinner size={18} /> : body}
        actions={
          searching ? undefined : (
            <>
              {unresolved.length > 0 && (
                <Button variant="primary" onClick={() => navigate('bus')}>
                  {tTuner('state.openBusResolve')}
                </Button>
              )}
              <Button icon={FlaskConical} onClick={() => void connection.connect({ kind: 'sim', scenarioId: 'bench.flywheel' })}>
                {tTuner('state.simFlywheel')}
              </Button>
              <Button icon={FlaskConical} onClick={() => void connection.connect({ kind: 'sim', scenarioId: 'bench.arm' })}>
                {tTuner('state.simArm')}
              </Button>
            </>
          )
        }
      />,
    );
  }

  // Remount per board + loop: stream, drive session and history start clean.
  return <TunerLoaded key={`${view.uid48}:${loop.key}`} view={view} loopKey={loop.key} title={t('nav.tuner')} />;
}

function TunerLoaded({ view, loopKey, title }: { view: DeviceView; loopKey: string; title: string }) {
  const api = useTunerController(view, loopKey);
  return (
    <TunerProvider value={api}>
      <Page title={title} subtitle={tTuner('subtitle')} icon={SlidersHorizontal} layout="fill" actions={<HeaderActions />}>
        <Workspace />
      </Page>
    </TunerProvider>
  );
}

/** Below this workspace width the left column folds into a row and a gains tab. */
const NARROW_PX = 1040;

function Workspace() {
  const api = useTuner();
  useTunerKeys();
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < NARROW_PX));
    ro.observe(el);
    setNarrow(el.clientWidth < NARROW_PX);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={cx('tuner', narrow && 'is-narrow')}>
      <div className="tuner__grid">
        {!narrow && <LeftColumn />}
        <div className="tuner__middle">
          {narrow && <CompactLoopBar />}
          <CenterColumn />
          <RunStrip />
        </div>
        <RightColumn withGains={narrow} />
      </div>
    </div>
  );
}
