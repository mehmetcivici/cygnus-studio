import { useEffect, useRef, useState } from 'react';
import { MonitorOff, Send } from 'lucide-react';
import { OLED_HEIGHT, OLED_WIDTH, OledNode, type OledPage, type Simulation } from '@cygnus/simulator';
import { useI18n } from '../../../i18n';
import { Badge, Button, NumberField, TextField, toast } from '../../../ui';
import { describeError, useDriveSession, useSimulation, useSignals } from '../../../core';
import { tDevice } from '../messages';
import { OLED_COLS, OLED_LINES, textFrames } from '../logic/oledText';
import { Readout, VizBlock, useSignalFormat, type VizProps } from './shared';

const KEYS = ['bus.devices', 'bus.load', 'bus.error_frames'] as const;

function findOled(sim: Simulation | null, uid48: string): OledNode | null {
  const n = sim?.nodes.find((x) => x.uid48.toString(16).padStart(12, '0') === uid48);
  return n instanceof OledNode ? n : null;
}

/** Live 128×64 framebuffer of a simulated OLED, redrawn when the board's frame counter moves. */
function Screen({ node }: { node: OledNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState<OledPage>(node.currentPage);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const img = ctx.createImageData(OLED_WIDTH, OLED_HEIGHT);
    let version = -1;
    let bright = -1;
    let raf = 0;
    const draw = (): void => {
      if (node.frameVersion !== version || node.brightness !== bright) {
        version = node.frameVersion;
        bright = node.brightness;
        const k = 0.35 + 0.65 * Math.max(0, Math.min(1, bright));
        for (let y = 0; y < OLED_HEIGHT; y++) {
          for (let x = 0; x < OLED_WIDTH; x++) {
            const on = node.pixel(x, y);
            const i = (y * OLED_WIDTH + x) * 4;
            img.data[i] = on ? Math.round(150 * k) : 4;
            img.data[i + 1] = on ? Math.round(232 * k) : 9;
            img.data[i + 2] = on ? Math.round(255 * k) : 16;
            img.data[i + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
        setPage(node.currentPage);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [node]);
  return (
    <>
      <div className="dv-oled">
        <canvas ref={ref} width={OLED_WIDTH} height={OLED_HEIGHT} aria-label={tDevice('viz.oled.screen')} />
      </div>
      <p className="dv-note">{tDevice('viz.oled.page', { page: tDevice(`viz.oled.pages.${page}`) })}</p>
    </>
  );
}

function TextSender({ uid48, live }: { uid48: string; live: boolean }) {
  const { lang } = useI18n();
  const { session, busyOwner } = useDriveSession('device.oled', uid48);
  const [line, setLine] = useState(0);
  const [text, setText] = useState('');
  const send = (clear: boolean): void => {
    if (!session) return;
    // Text is not actuation, but it is a CTRL frame: go through the drive session so the
    // E-STOP latch and fault blocks apply; the session is released right after.
    const armed = session.armed || session.arm().ok;
    const dev = session.device;
    if (!armed || !dev) {
      toast.warn(tDevice('viz.oled.sendBlocked'));
      return;
    }
    try {
      const lines = clear ? Array.from({ length: OLED_LINES }, (_, i) => i) : [line];
      for (const l of lines) for (const f of textFrames(l, clear ? '' : text)) dev.control.send('text', f);
      toast.success(clear ? tDevice('viz.oled.cleared') : tDevice('viz.oled.sent'), { id: `oled-${uid48}` });
    } catch (e) {
      toast.error(tDevice('viz.oled.sendFailed'), { description: describeError(e, lang) });
    } finally {
      session.disarm('released');
    }
  };
  const disabled = !live || !session;
  return (
    <div className="dv-oled-send">
      <div className="dv-oled-send__row">
        <label className="dv-field-label">{tDevice('viz.oled.line')}</label>
        <NumberField value={line + 1} onCommit={(v) => setLine(Math.max(0, Math.min(OLED_LINES - 1, Math.round(v) - 1)))} min={1} max={OLED_LINES} integer size="sm" width={72} ariaLabel={tDevice('viz.oled.line')} />
        <TextField
          value={text}
          onChange={(v) => setText(v.replace(/[^\x20-\x7e]/g, '').slice(0, OLED_COLS))}
          placeholder={tDevice('viz.oled.placeholder')}
          size="sm"
          mono
          block
          maxLength={OLED_COLS}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !disabled) send(false);
          }}
          aria-label={tDevice('viz.oled.text')}
        />
        <Button size="sm" variant="primary" icon={Send} disabled={disabled} onClick={() => send(false)}>
          {tDevice('viz.oled.send')}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => send(true)}>
          {tDevice('viz.oled.clear')}
        </Button>
      </div>
      <p className="dv-note">{busyOwner ? tDevice('viz.oled.busy') : tDevice('viz.oled.hint', { cols: OLED_COLS })}</p>
    </div>
  );
}

/** Debug OLED: live picture of the simulated panel, text sending, bus counters it reports. */
export function VizOled({ uid48, def, live }: VizProps) {
  const sim = useSimulation();
  const node = findOled(sim, uid48);
  const s = useSignals(uid48, KEYS);
  const fmt = useSignalFormat(def);
  return (
    <div className="dv-viz dv-viz--wide">
      <VizBlock title={tDevice('viz.oled.screen')} aside={node ? <Badge size="sm" tone="accent">{tDevice('viz.oled.simulated')}</Badge> : undefined}>
        {node ? (
          <Screen node={node} />
        ) : (
          <div className="dv-oled dv-oled--none">
            <MonitorOff size={22} aria-hidden />
            <span>{tDevice('viz.oled.unreadable')}</span>
          </div>
        )}
        <TextSender uid48={uid48} live={live} />
      </VizBlock>
      <VizBlock title={tDevice('viz.oled.seen')}>
        <div className="dv-readouts dv-readouts--col">
          {KEYS.map((k) => {
            const f = fmt(k, s[k] ?? NaN);
            return <Readout key={k} label={f.label} text={f.text} unit={f.unit} />;
          })}
        </div>
      </VizBlock>
    </div>
  );
}
