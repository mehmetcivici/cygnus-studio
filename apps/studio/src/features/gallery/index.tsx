import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  Battery,
  Compass,
  Cpu,
  Download,
  Gauge as GaugeIcon,
  Layers,
  Lightbulb,
  RotateCcw,
  Save,
  Search,
  Thermometer,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  Badge,
  BarMeter,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormRow,
  Gauge,
  IconButton,
  Kbd,
  LiveChart,
  Modal,
  NumberField,
  Page,
  Panel,
  ProgressBar,
  SegmentedControl,
  Select,
  Slider,
  Spinner,
  SplitPane,
  StatTile,
  StaticChart,
  StatusDot,
  Tabs,
  TextField,
  Toggle,
  Tooltip,
  toast,
  type Column,
  type DeviceStatus,
  type LiveSeries,
  type RowKey,
  type StaticSeries,
} from '../../ui';
import { fmtHex } from '../../i18n';
import type { FeatureProps } from '../registry';
import { createStepSim, makeCanRows, makeRuns, type CanRow } from './demoData';
import { tg } from './messages';
import './gallery.css';

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="gal-section">
      <div className="gal-section__head">
        <h2 className="gal-section__title">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Re-renders at `hz` (live readouts are fine at 10 Hz; charts bypass React). */
function useTick(hz: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => setN((x) => x + 1), 1000 / hz);
    return () => window.clearInterval(h);
  }, [hz]);
  return n;
}

function pushTrend(arr: number[], v: number, max = 48): number[] {
  const next = arr.length >= max ? arr.slice(1) : arr.slice();
  next.push(v);
  return next;
}

// ---------------------------------------------------------------------------

function LiveSection() {
  const { t, fmtNumber } = useI18n();
  const sim = useMemo(() => createStepSim(8), []);
  const [stress, setStress] = useState(false);
  const [paused, setPaused] = useState(false);
  const fpsRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const t0 = performance.now();
    let raf = 0;
    let frames = 0;
    let samples = 0;
    let last = t0;
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      samples += sim.advanceTo((now - t0) / 1000) * (5 + sim.extras.length);
      frames++;
      if (now - last > 500) {
        const sec = (now - last) / 1000;
        if (fpsRef.current) {
          fpsRef.current.textContent = tg('fps', {
            fps: Math.round(frames / sec),
            rate: fmtNumber(samples / sec, 0),
          });
        }
        frames = 0;
        samples = 0;
        last = now;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sim, fmtNumber]);

  const series = useMemo<LiveSeries[]>(() => {
    const base: LiveSeries[] = [
      { key: 'sp', label: tg('signals.setpoint'), unit: 'rpm', color: 'text-3', dash: [6, 4], width: 1.25, digits: 0, buffer: sim.setpoint },
      { key: 'vel', label: tg('signals.velocity'), unit: 'rpm', color: 'chart-1', digits: 0, width: 1.75, buffer: sim.velocity },
      { key: 'cur', label: tg('signals.current'), unit: 'A', axis: 'right', color: 'chart-2', digits: 2, buffer: sim.current },
      { key: 'err', label: tg('signals.error'), unit: 'rpm', color: 'chart-6', digits: 0, visible: false, buffer: sim.error },
      { key: 'duty', label: tg('signals.duty'), unit: '%', axis: 'right', color: 'chart-3', digits: 1, visible: false, buffer: sim.duty },
    ];
    if (!stress) return base;
    return [
      ...base,
      ...sim.extras.map((b, i): LiveSeries => ({ key: `x${i}`, label: tg('signals.extra', { n: i + 1 }), unit: 'rpm', digits: 0, width: 1, buffer: b })),
    ];
    // Labels depend on the language; `t` changes identity with it.
  }, [sim, stress, t]);

  return (
    <Section title={tg('sections.chart')}>
      <LiveChart
        height={400}
        window={6}
        series={series}
        paused={paused}
        onPausedChange={setPaused}
        title={tg('chartTitle')}
        actions={
          <>
            <span ref={fpsRef} className="gal-fps cy-mono" />
            <Toggle size="sm" checked={stress} onChange={setStress} label={tg('stress')} />
          </>
        }
      />
    </Section>
  );
}

function TelemetrySection() {
  const tick = useTick(8);
  const [trends, setTrends] = useState({ v: [] as number[], a: [] as number[], rpm: [] as number[], temp: [] as number[], load: [] as number[] });
  const s = Math.sin(tick / 9);
  const vals = {
    v: 12.46 - Math.abs(s) * 0.38 + Math.sin(tick * 1.7) * 0.02,
    a: 18.3 + s * 6 + Math.sin(tick * 2.3) * 0.6,
    rpm: 4812 + s * 420 + Math.sin(tick * 3.1) * 25,
    temp: 71.5 + s * 1.2,
    load: 37 + s * 6,
  };
  useEffect(() => {
    setTrends((p) => ({
      v: pushTrend(p.v, vals.v),
      a: pushTrend(p.a, vals.a),
      rpm: pushTrend(p.rpm, vals.rpm),
      temp: pushTrend(p.temp, vals.temp),
      load: pushTrend(p.load, vals.load),
    }));
    // Sample once per tick; `vals` is derived from `tick`.
  }, [tick]);
  return (
    <Section title={tg('sections.telemetry')}>
      <div className="gal-tiles">
        <StatTile label={tg('signals.supply')} icon={Battery} value={vals.v} unit="V" digits={2} trend={trends.v} size="lg" />
        <StatTile label={tg('signals.phase')} icon={Zap} value={vals.a} unit="A" digits={1} trend={trends.a} size="lg" />
        <StatTile label={tg('signals.velocity')} icon={GaugeIcon} value={vals.rpm} unit="rpm" digits={0} trend={trends.rpm} size="lg" tone="accent" />
        <StatTile
          label={tg('signals.fetTemp')}
          icon={Thermometer}
          value={vals.temp}
          unit="°C"
          digits={1}
          trend={trends.temp}
          size="lg"
          tone="warn"
          caption={tg('limitCaption', { limit: '85 °C' })}
        />
        <StatTile label={tg('signals.busLoad')} icon={Activity} value={vals.load} unit="%" digits={0} trend={trends.load} size="lg" />
      </div>
    </Section>
  );
}

const CHANNEL_BASE = [12.4, 8.1, 22.6, 3.2, 0, 27.4, 31.8, 14.9, 6.7, 18.2, 0.4, 9.9];

function MetersSection() {
  const tick = useTick(6);
  return (
    <Section title={tg('sections.meters')}>
      <div className="gal-grid gal-grid--meters">
        <Panel title={tg('channels')} subtitle={tg('channelLimit')} icon={Zap}>
          <div className="gal-bars">
            {CHANNEL_BASE.map((b, i) => (
              <BarMeter
                key={i}
                value={b === 0 ? 0 : Math.max(0, b + Math.sin(tick / 4 + i) * 1.8)}
                max={40}
                threshold={30}
                unit="A"
                label={`K${i + 1}`}
                inactive={b === 0}
                height={132}
              />
            ))}
          </div>
        </Panel>
        <Panel title={tg('sections.meters')} icon={GaugeIcon}>
          <div className="gal-gauges">
            <Gauge
              value={71.5 + Math.sin(tick / 9) * 1.2}
              min={0}
              max={100}
              unit="°C"
              label={tg('gaugeFet')}
              zones={[
                { from: 0, to: 70, tone: 'ok' },
                { from: 70, to: 85, tone: 'warn' },
                { from: 85, to: 100, tone: 'danger' },
              ]}
            />
            <Gauge value={37 + Math.sin(tick / 9) * 6} min={0} max={100} unit="%" digits={0} label={tg('gaugeLoad')} />
            <Gauge
              value={12.46 - Math.abs(Math.sin(tick / 9)) * 0.38}
              min={6}
              max={16}
              unit="V"
              digits={2}
              label={tg('gaugeSupply')}
              zones={[
                { from: 6, to: 10.5, tone: 'danger' },
                { from: 10.5, to: 11.5, tone: 'warn' },
                { from: 11.5, to: 16, tone: 'ok' },
              ]}
            />
          </div>
        </Panel>
      </div>
    </Section>
  );
}

interface VelForm {
  kp: number;
  ki: number;
  kd: number;
  kv: number;
  filter: number;
  feedback: number;
  invert: boolean;
  ramp: number;
  brake: boolean;
}

const DEFAULTS: VelForm = { kp: 0.0014, ki: 0.00002, kd: 0, kv: 0.00205, filter: 250, feedback: 1, invert: false, ramp: 0.25, brake: true };

function FormSection() {
  const { t, fmtValue } = useI18n();
  const [applied, setApplied] = useState<VelForm>({ ...DEFAULTS, kp: 0.0018 });
  const [form, setForm] = useState<VelForm>({ ...DEFAULTS, kp: 0.0018, ki: 0.00004, ramp: 0.4 });
  const [saving, setSaving] = useState(false);
  const [loop, setLoop] = useState<'current' | 'velocity' | 'position'>('velocity');
  const set = <K extends keyof VelForm>(k: K, v: VelForm[K]): void => setForm((f) => ({ ...f, [k]: v }));
  const dirty = (k: keyof VelForm): boolean => form[k] !== applied[k];
  const dirtyCount = (Object.keys(form) as (keyof VelForm)[]).filter(dirty).length;

  const num = (k: 'kp' | 'ki' | 'kd' | 'kv' | 'filter', opts: { step: number; digits: number; min: number; max: number; unit?: string }) => (
    <FormRow
      label={tg(`params.${k}` as 'params.kp')}
      help={k === 'kp' ? tg('params.kpHelp') : k === 'ki' ? tg('params.kiHelp') : k === 'kv' ? tg('params.kvHelp') : k === 'filter' ? tg('params.filterHelp') : undefined}
      meta={`vel.${k}`}
      htmlFor={`gal-${k}`}
      dirty={dirty(k)}
      isDefault={form[k] === DEFAULTS[k]}
      defaultText={fmtValue(DEFAULTS[k], opts.unit, opts.digits)}
      onReset={() => set(k, DEFAULTS[k])}
    >
      <NumberField id={`gal-${k}`} value={form[k]} onCommit={(v) => set(k, v)} {...opts} width={150} />
    </FormRow>
  );

  return (
    <Section title={tg('sections.form')}>
      <div className="gal-grid gal-grid--form">
        <Panel
          title={tg('velLoop')}
          subtitle="ESC 80A #3"
          icon={Cpu}
          actions={
            <SegmentedControl
              size="sm"
              value={loop}
              onChange={setLoop}
              options={[
                { value: 'current', label: tg('loops.current') },
                { value: 'velocity', label: tg('loops.velocity') },
                { value: 'position', label: tg('loops.position') },
              ]}
            />
          }
          padding="sm"
          footer={
            <>
              <span className="gal-dirty">{dirtyCount ? tg('changes', { count: dirtyCount }) : tg('noChanges')}</span>
              <Button variant="ghost" icon={RotateCcw} disabled={!dirtyCount} onClick={() => setForm(applied)}>
                {t('common.revert')}
              </Button>
              <Button variant="secondary" icon={Save} disabled={!dirtyCount}>
                {t('common.saveToDevice')}
              </Button>
              <Button
                variant="primary"
                loading={saving}
                disabled={!dirtyCount}
                onClick={() => {
                  setSaving(true);
                  window.setTimeout(() => {
                    setApplied(form);
                    setSaving(false);
                    toast.success(tg('applied'), { description: tg('appliedBody') });
                  }, 700);
                }}
              >
                {t('common.apply')}
              </Button>
            </>
          }
        >
          {num('kp', { step: 0.0001, digits: 4, min: 0, max: 1, unit: 'A/rpm' })}
          {num('ki', { step: 0.00001, digits: 5, min: 0, max: 1, unit: 'A/rev' })}
          {num('kd', { step: 0.0001, digits: 4, min: 0, max: 1 })}
          {num('kv', { step: 0.00001, digits: 5, min: 0, max: 0.01, unit: 'V/rpm' })}
          {num('filter', { step: 10, digits: 0, min: 10, max: 1000, unit: 'Hz' })}
        </Panel>
        <Panel title={t('common.advanced')} icon={Layers} padding="sm">
          <FormRow
            label={tg('params.feedback')}
            help={tg('params.feedbackHelp')}
            meta="fb.source"
            dirty={dirty('feedback')}
            badges={<Badge tone="warn" size="sm">{t('common.rebootRequired')}</Badge>}
            isDefault={form.feedback === DEFAULTS.feedback}
            onReset={() => set('feedback', DEFAULTS.feedback)}
          >
            <Select
              value={form.feedback}
              onChange={(v) => set('feedback', v)}
              width={170}
              options={[
                { value: 0, label: tg('params.sensorless') },
                { value: 1, label: tg('params.hall') },
                { value: 2, label: tg('params.remote') },
              ]}
            />
          </FormRow>
          <FormRow label={tg('params.invert')} meta="motor.invert" dirty={dirty('invert')} badges={<Badge size="sm">{t('common.lockedWhileEnabled')}</Badge>}>
            <Toggle checked={form.invert} onChange={(v) => set('invert', v)} ariaLabel={tg('params.invert')} />
          </FormRow>
          <FormRow
            label={tg('params.ramp')}
            help={tg('params.rampHelp')}
            meta="motor.ramp_s"
            layout="vertical"
            dirty={dirty('ramp')}
            isDefault={form.ramp === DEFAULTS.ramp}
            onReset={() => set('ramp', DEFAULTS.ramp)}
          >
            <Slider value={form.ramp} onChange={(v) => set('ramp', v)} min={0} max={2} step={0.05} showValue unit="s" digits={2} ariaLabel={tg('params.ramp')} />
          </FormRow>
          <FormRow label={tg('params.brake')} meta="motor.idle_brake" dirty={dirty('brake')}>
            <Checkbox checked={form.brake} onChange={(v) => set('brake', v)} ariaLabel={tg('params.brake')} />
          </FormRow>
          <FormRow label="CAN · ID" meta="can.id" help={t('common.readOnly')}>
            <NumberField value={3} onCommit={() => undefined} readOnly integer width={150} />
          </FormRow>
        </Panel>
      </div>
    </Section>
  );
}

function ControlsSection() {
  const { t, lang } = useI18n();
  const [tab, setTab] = useState('config');
  const [loop, setLoop] = useState<'current' | 'velocity' | 'position'>('velocity');
  const [q, setQ] = useState('');
  return (
    <Section title={tg('sections.controls')}>
      <div className="gal-grid gal-grid--2">
        <Panel padding="md">
          <div className="gal-stack">
            <div className="gal-row">
              <Button variant="primary" icon={Upload}>
                {tg('buttons.primary')}
              </Button>
              <Button variant="secondary">{tg('buttons.secondary')}</Button>
              <Button variant="ghost">{tg('buttons.ghost')}</Button>
              <Button variant="danger" icon={Trash2}>
                {tg('buttons.danger')}
              </Button>
              <Button variant="primary" loading>
                {tg('buttons.loading')}
              </Button>
            </div>
            <div className="gal-row">
              <Button size="sm" variant="secondary" icon={Lightbulb}>
                {tg('buttons.identify')}
              </Button>
              <Button size="lg" variant="primary" icon={Download}>
                {t('common.export')}
              </Button>
              <Button variant="secondary" disabled>
                {t('common.disabled')}
              </Button>
              <IconButton icon={Save} label={t('common.save')} variant="secondary" />
              <IconButton icon={RotateCcw} label={t('common.revert')} />
              <IconButton icon={Compass} label="Gyro" active />
            </div>
            <div className="gal-row">
              <SegmentedControl
                value={loop}
                onChange={setLoop}
                options={[
                  { value: 'current', label: tg('loops.current') },
                  { value: 'velocity', label: tg('loops.velocity') },
                  { value: 'position', label: tg('loops.position') },
                ]}
              />
              <TextField value={q} onChange={setQ} icon={Search} placeholder={tg('searchPlaceholder')} width={240} suffix={<Kbd>/</Kbd>} />
            </div>
          </div>
        </Panel>
        <Panel padding="md">
          <div className="gal-stack">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { id: 'overview', label: tg('tabs.overview') },
                { id: 'config', label: tg('tabs.config'), badge: 3 },
                { id: 'faults', label: tg('tabs.faults'), badge: 1 },
                { id: 'selftest', label: tg('tabs.selftest'), disabled: true },
              ]}
            />
            <Tabs
              variant="pill"
              value={tab}
              onChange={setTab}
              items={[
                { id: 'overview', label: tg('tabs.overview'), icon: Activity },
                { id: 'config', label: tg('tabs.config'), icon: Layers },
                { id: 'faults', label: tg('tabs.faults'), icon: Zap },
              ]}
            />
            <div className="gal-row">
              <Tooltip content={tg('tooltipBody')}>
                <Button variant="ghost">{tg('tooltipDemo')}</Button>
              </Tooltip>
              <span className="gal-inline">
                <Kbd>{lang === 'tr' ? 'Boşluk' : 'Space'}</Kbd> {tg('kbdHint')}
              </span>
            </div>
          </div>
        </Panel>
      </div>
    </Section>
  );
}

function StatusSection() {
  const tick = useTick(4);
  const prog = ((tick * 3) % 110) / 100;
  return (
    <Section title={tg('sections.status')}>
      <div className="gal-grid gal-grid--2">
        <Panel padding="md">
          <div className="gal-stack">
            <div className="gal-row">
              {(['ok', 'warn', 'fault', 'offline', 'boot'] as DeviceStatus[]).map((s) => (
                <StatusDot key={s} status={s} withLabel />
              ))}
            </div>
            <div className="gal-row">
              <Badge tone="accent">FD</Badge>
              <Badge tone="ok">v1.3.2</Badge>
              <Badge tone="warn">{tg('devices.calibrating')}</Badge>
              <Badge tone="caution">{tg('devices.noMagnet')}</Badge>
              <Badge tone="danger" variant="solid">
                {tg('devices.faultLocked')}
              </Badge>
              <Badge mono>0x0A0403</Badge>
              <Badge tone="accent" variant="outline">
                CAN 1 Mbit/s
              </Badge>
            </div>
            <div className="gal-row">
              <Spinner />
              <Spinner size={22} />
              <span className="cy-muted">{tg('verifying')}</span>
            </div>
          </div>
        </Panel>
        <Panel padding="md">
          <div className="gal-stack">
            <ProgressBar value={Math.min(1, prog)} label={tg('flashing')} showPercent />
            <ProgressBar value={null} label={tg('verifying')} tone="neutral" size="sm" />
            <ProgressBar value={0.86} label="ESC 20A #5 · 86%" tone="ok" size="sm" />
            <div className="gal-row">
              <Button size="sm" variant="secondary" onClick={() => toast.success(tg('toasts.successMsg'), { description: 'ESC 80A #3' })}>
                {tg('toasts.success')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  toast.error(tg('toasts.errorMsg'), {
                    description: tg('toasts.errorBody'),
                    action: { label: tg('toasts.retry'), onClick: () => undefined },
                  })
                }
              >
                {tg('toasts.error')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => toast.info(tg('toasts.infoMsg'))}>
                {tg('toasts.info')}
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </Section>
  );
}

interface DemoDevice {
  key: string;
  name: string;
  num: number;
  status: DeviceStatus;
  fw: string;
  note?: string;
  tone?: 'warn' | 'danger';
}

function DevicesSection() {
  const [sel, setSel] = useState('esc80-3');
  const devices: DemoDevice[] = [
    { key: 'esc80-3', name: tg('devices.esc80'), num: 3, status: 'ok', fw: '1.3.2' },
    { key: 'esc20-5', name: tg('devices.esc20'), num: 5, status: 'fault', fw: '1.3.2', note: tg('devices.faultLocked'), tone: 'danger' },
    { key: 'cyn-7', name: tg('devices.cyncoder'), num: 7, status: 'warn', fw: '1.4.0', note: tg('devices.noMagnet'), tone: 'warn' },
    { key: 'gyro-1', name: tg('devices.gyro'), num: 1, status: 'boot', fw: '0.9.1', note: tg('devices.calibrating') },
    { key: 'servo-2', name: tg('devices.servo'), num: 2, status: 'offline', fw: '1.1.0', note: tg('devices.lastSeen') },
  ];
  return (
    <Section title={tg('sections.devices')}>
      <div className="gal-devices">
        {devices.map((d) => (
          <Card key={d.key} interactive selected={sel === d.key} tone={d.tone} onClick={() => setSel(d.key)}>
            <div className="gal-device">
              <StatusDot status={d.status} />
              <div className="gal-device__main">
                <div className="gal-device__name">
                  {d.name} <span className="gal-device__num">#{d.num}</span>
                </div>
                <div className="gal-device__note">{d.note ?? <span className="cy-mono">fw {d.fw}</span>}</div>
              </div>
              <Badge mono size="sm">
                {fmtHex(d.num, 2)}
              </Badge>
            </div>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function TableSection() {
  const { fmtNumber } = useI18n();
  const rows = useMemo(() => makeCanRows(10_000), []);
  const [selected, setSelected] = useState<ReadonlySet<RowKey>>(new Set([3]));
  const kindLabel: Record<CanRow['kind'], string> = {
    status: tg('table.status'),
    param: tg('table.param'),
    heartbeat: tg('table.heartbeat'),
    ctrl: tg('table.ctrl'),
    fault: tg('table.fault'),
  };
  const columns: Column<CanRow>[] = [
    { key: 't', header: tg('table.time'), width: 104, align: 'right', mono: true, render: (r) => fmtNumber(r.t, 4, { grouping: false }) },
    { key: 'id', header: tg('table.id'), width: 108, mono: true, render: (r) => fmtHex(r.id, 8, false) },
    { key: 'dlc', header: tg('table.dlc'), width: 52, align: 'right', mono: true },
    { key: 'data', header: tg('table.data'), width: 220, mono: true },
    { key: 'device', header: tg('table.device'), width: 'minmax(120px, 1fr)' },
    {
      key: 'kind',
      header: tg('table.message'),
      width: 'minmax(140px, 1fr)',
      render: (r) => (r.kind === 'fault' ? <Badge tone="danger" size="sm">{kindLabel[r.kind]}</Badge> : kindLabel[r.kind]),
    },
  ];
  return (
    <Section title={tg('sections.table')} aside={<span className="cy-muted">{tg('table.frames', { count: rows.length, n: fmtNumber(rows.length, 0) })}</span>}>
      <DataTable
        height={320}
        rows={rows}
        columns={columns}
        rowKey={(r) => r.seq}
        selection="multi"
        selected={selected}
        onSelectionChange={setSelected}
        rowTone={(r) => (r.kind === 'fault' ? 'danger' : undefined)}
        rowHeight={28}
      />
    </Section>
  );
}

function RunsSection() {
  const { fmtNumber } = useI18n();
  const runs = useMemo(() => makeRuns(), []);
  const series = useMemo<StaticSeries[]>(
    () => [
      ...runs.map(
        (r, i): StaticSeries => ({
          key: `run${i}`,
          label: tg('runs.run', { n: i + 1, kp: fmtNumber(r.kp, 4) }),
          unit: 'rpm',
          digits: 0,
          color: `chart-${[5, 2, 1][i] ?? 1}`,
          x: r.data.x,
          y: r.data.y,
        }),
      ),
      {
        key: 'sp',
        label: tg('signals.setpoint'),
        unit: 'rpm',
        digits: 0,
        color: 'text-3',
        dash: [6, 4],
        width: 1.25,
        x: [0, 0.0999, 0.1, 1.5],
        y: [0, 0, 3000, 3000],
      },
    ],
    [runs, fmtNumber],
  );
  return (
    <Section title={tg('sections.runs')}>
      <StaticChart height={300} series={series} title={tg('runs.title')} />
    </Section>
  );
}

function LayoutSection() {
  const { t } = useI18n();
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Section title={tg('sections.layout')}>
      <div className="gal-grid gal-grid--2">
        <Panel padding="none">
          <div style={{ height: 220 }}>
            <SplitPane defaultFraction={0.4} minSize={120}>
              <div className="gal-pane">
                <span className="cy-caps">{tg('split.left')}</span>
                <p className="cy-muted">{tg('split.hint')}</p>
              </div>
              <div className="gal-pane gal-pane--alt">
                <EmptyState size="sm" icon={Layers} title={tg('emptyTitle')} description={tg('emptyBody')} />
              </div>
            </SplitPane>
          </div>
        </Panel>
        <Panel padding="md">
          <div className="gal-row">
            <Button variant="secondary" onClick={() => setModal(true)}>
              {tg('modal.open')}
            </Button>
            <Button variant="danger" onClick={() => setConfirm(true)}>
              {tg('modal.confirm')}
            </Button>
          </div>
        </Panel>
      </div>
      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={tg('modal.title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" icon={Save} onClick={() => setModal(false)}>
              {t('common.saveToDevice')}
            </Button>
          </>
        }
      >
        {tg('modal.body')}
      </Modal>
      <ConfirmDialog
        open={confirm}
        tone="danger"
        title={tg('modal.danger')}
        message={tg('modal.dangerBody')}
        confirmLabel={tg('modal.dangerConfirm')}
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setBusy(true);
          window.setTimeout(() => {
            setBusy(false);
            setConfirm(false);
          }, 900);
        }}
      />
    </Section>
  );
}

export function GalleryScreen(_props: FeatureProps) {
  const { t } = useI18n();
  return (
    <Page title={t('nav.gallery')} subtitle={tg('subtitle')} icon={Layers}>
      <div className="gal">
        <TelemetrySection />
        <LiveSection />
        <MetersSection />
        <FormSection />
        <ControlsSection />
        <StatusSection />
        <DevicesSection />
        <TableSection />
        <RunsSection />
        <LayoutSection />
      </div>
    </Page>
  );
}
