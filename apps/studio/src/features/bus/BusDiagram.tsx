import { useEffect, useRef, useState, type RefObject } from 'react';
import { Waypoints } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Badge, Panel, cx } from '../../ui';
import { displayName, modelIcon, useConnection, useSimulation, type DeviceView } from '../../core';
import { tBus } from './messages';
import { openDevice } from './parts';

const NODE_W = 84;
const GAP = 14;
const PITCH = NODE_W + GAP;
const TOP = 30;
const DROP = 26;
const NODE_H = 62;
const ROW_H = DROP + NODE_H + 26;
const LEFT = 136;
const TURN = 16;

function useWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Total termination resistors: measured in the simulator, from cached `can.termination` on hardware. */
function useTerminations(devices: readonly DeviceView[]): { count: number | null; onBoards: number } {
  const sim = useSimulation();
  const [simCount, setSimCount] = useState<number | null>(null);
  useEffect(() => {
    if (!sim) {
      setSimCount(null);
      return;
    }
    const read = (): void => setSimCount(sim.snapshot().bus.terminations);
    read();
    const h = setInterval(read, 1000);
    return () => clearInterval(h);
  }, [sim]);
  let onBoards = 0;
  let known = 0;
  for (const d of devices) {
    if (!d.online) continue;
    const v = d.handle.cachedParam('can.termination');
    if (v === undefined) continue;
    known++;
    if (v) onBoards++;
  }
  if (simCount !== null) return { count: simCount, onBoards };
  return { count: known > 0 ? onBoards : null, onBoards };
}

/** Single-cable picture of the bus: every board hangs off one trunk, ends terminated. */
export function BusDiagram({ devices }: { devices: readonly DeviceView[] }) {
  const { lang } = useI18n();
  const isSim = useConnection((s) => s.sim !== null);
  const term = useTerminations(devices);
  const [wrapRef, avail] = useWidth();
  const n = devices.length;
  // Serpentine: the one cable runs right, turns down, runs left … like a real harness.
  const perRow = Math.max(1, Math.floor((avail - LEFT - TURN - 12) / PITCH));
  const rows = Math.max(1, Math.ceil(n / perRow));
  const rowRight = LEFT + Math.min(n, perRow) * PITCH - GAP + TURN;
  const rowLeft = LEFT - TURN;
  const width = Math.max(avail, rowRight + 24);
  const height = TOP + rows * ROW_H - 18;
  const pos = (i: number): { x: number; y: number } => {
    const r = Math.floor(i / perRow);
    const c = i % perRow;
    const x = r % 2 === 0 ? LEFT + c * PITCH : LEFT + (perRow - 1 - c) * PITCH;
    return { x, y: TOP + r * ROW_H };
  };
  let trunk = `M 100 ${TOP}`;
  for (let r = 0; r < rows; r++) {
    const y = TOP + r * ROW_H;
    const last = r === rows - 1;
    const lastIdx = Math.min(n, (r + 1) * perRow) - 1;
    const endX = last ? pos(Math.max(0, lastIdx)).x + NODE_W / 2 + (r % 2 === 0 ? 34 : -34) : r % 2 === 0 ? rowRight : rowLeft;
    trunk += ` L ${endX} ${y}`;
    if (!last) trunk += ` L ${endX} ${y + ROW_H}`;
  }
  const endPt = trunk.split(' L ').pop()?.split(' ').map(Number) ?? [rowRight, TOP];
  const termTone = term.count === null ? 'neutral' : term.count === 2 ? 'ok' : 'warn';
  const termText =
    term.count === null
      ? tBus('diagram.termUnknown')
      : term.count === 2
        ? tBus('diagram.termOk')
        : term.count < 2
          ? tBus('diagram.termMissing', { count: term.count })
          : tBus('diagram.termExtra', { count: term.count });
  return (
    <Panel
      title={tBus('diagram.title')}
      icon={Waypoints}
      subtitle={tBus('diagram.oneCable', { count: n })}
      actions={
        <Badge tone={termTone} size="sm">
          {termText}
        </Badge>
      }
      padding="none"
      className="bus-diagram"
    >
      <div className="bus-diagram__scroll" ref={wrapRef}>
        <svg width={width} height={height} className="bus-diagram__svg" role="img" aria-label={tBus('diagram.title')}>
          {/* host adapter */}
          <g className="bus-diagram__host">
            <rect x={8} y={TOP - 20} width={92} height={40} rx={8} />
            <text x={54} y={TOP - 3} textAnchor="middle" className="bus-diagram__host-title">
              {tBus('diagram.host')}
            </text>
            <text x={54} y={TOP + 11} textAnchor="middle" className="bus-diagram__host-sub">
              {isSim ? tBus('diagram.sim') : 'USB-CAN'}
            </text>
          </g>
          {/* trunk: CAN_H over CAN_L */}
          <path d={trunk} className="bus-diagram__cable" />
          <path d={trunk} className="bus-diagram__pair" />
          <g className={cx('bus-diagram__term', `is-${termTone}`)}>
            <rect x={106} y={TOP - 9} width={14} height={18} rx={3} />
            <rect x={(endPt[0] ?? 0) - 7} y={(endPt[1] ?? 0) - 9} width={14} height={18} rx={3} />
          </g>
          {devices.map((d, i) => {
            const { x, y: ty } = pos(i);
            const cx0 = x + NODE_W / 2;
            const ny = ty + DROP;
            const bad = d.unassigned || d.conflict;
            const Icon = modelIcon(d.def);
            const name = displayName(d, lang);
            return (
              <g
                key={d.uid48}
                className={cx('bus-diagram__node', `is-${d.status}`, !d.online && 'is-lost', bad && 'is-bad', d.flags.identify && 'is-identify')}
                onClick={() => !bad && openDevice(d)}
              >
                <title>{`${name} · #${d.num} · ${d.uid48}`}</title>
                <line x1={cx0} y1={ty + 3} x2={cx0} y2={ny} className="bus-diagram__stub" />
                <circle cx={cx0} cy={ty} r={4} className="bus-diagram__tap" />
                <rect x={x} y={ny} width={NODE_W} height={NODE_H} rx={9} className="bus-diagram__box" />
                <Icon x={x + 8} y={ny + 8} width={16} height={16} className="bus-diagram__icon" />
                <text x={x + NODE_W - 8} y={ny + 21} textAnchor="end" className="bus-diagram__num">
                  {d.unassigned ? '#—' : `#${d.num}`}
                </text>
                <text x={x + 8} y={ny + 41} className="bus-diagram__name">
                  {name.length > 11 ? `${name.slice(0, 10)}…` : name}
                </text>
                <text x={x + 8} y={ny + 54} className="bus-diagram__model">
                  {(d.def?.key ?? '').toUpperCase().slice(0, 12)}
                </text>
                {bad && (
                  <g className="bus-diagram__warn">
                    <circle cx={x + NODE_W - 4} cy={ny + 4} r={8} />
                    <text x={x + NODE_W - 4} y={ny + 8} textAnchor="middle">
                      !
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="bus-diagram__legend">
        <span className="bus-diagram__key is-lost" /> {tBus('diagram.legendLost')}
        <span className="bus-diagram__key is-bad" /> {tBus('diagram.legendConflict')}
        {term.onBoards > 0 && <span className="bus-diagram__legend-term">{tBus('diagram.termOnBoards', { count: term.onBoards })}</span>}
      </div>
    </Panel>
  );
}
