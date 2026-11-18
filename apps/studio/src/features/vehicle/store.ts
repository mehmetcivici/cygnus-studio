import { create } from 'zustand';
import type { SlotBinding, VehicleConfig, VehicleSlot } from '@cygnus/vehicles';
import { SEQ_IDLE, bindSlot, seqReducer, unbindSlot, type SeqAction, type SeqState, type SlotTweak, type Tweaks } from './model';
import type { VehicleSetup } from './project';

export type WizardStep = 'template' | 'assign' | 'tune' | 'apply';
export const WIZARD_STEPS: readonly WizardStep[] = ['template', 'assign', 'tune', 'apply'];

type Bindings = Record<string, SlotBinding>;

/** The vehicle being set up. Kept outside the screen so leaving and coming back keeps the work. */
export interface Draft {
  /** The wizard is shown (otherwise the live view, when a vehicle exists). */
  open: boolean;
  step: WizardStep;
  templateId: string | null;
  name: string;
  bindings: Bindings;
  /** Earlier bindings, for undo. */
  history: Bindings[];
  tweaks: Tweaks;
  customSlots: VehicleSlot[];
  selected: string | null;
  seq: SeqState;
}

const EMPTY: Draft = { open: false, step: 'template', templateId: null, name: '', bindings: {}, history: [], tweaks: {}, customSlots: [], selected: null, seq: SEQ_IDLE };

export const useDraft = create<Draft>(() => EMPTY);

const HISTORY = 50;

function commit(next: Bindings): void {
  useDraft.setState((s) => ({ bindings: next, history: [...s.history, s.bindings].slice(-HISTORY) }));
}

export const draft = {
  /** New vehicle: the gallery. */
  startNew(): void {
    useDraft.setState({ ...EMPTY, open: true });
  },
  /** Reconfigure the saved vehicle, starting at the assignment step. */
  edit(cfg: VehicleConfig, setup: VehicleSetup): void {
    useDraft.setState({ ...EMPTY, open: true, step: 'assign', templateId: cfg.templateId, name: cfg.name, bindings: { ...cfg.bindings }, tweaks: { ...setup.tweaks }, customSlots: [...setup.customSlots] });
  },
  close(): void {
    useDraft.setState({ open: false, seq: SEQ_IDLE });
  },
  reset(): void {
    useDraft.setState(EMPTY);
  },
  chooseTemplate(id: string, name: string): void {
    const s = useDraft.getState();
    if (s.templateId === id) {
      useDraft.setState({ open: true });
      return;
    }
    useDraft.setState({ open: true, templateId: id, name, bindings: {}, history: [], tweaks: {}, selected: null, seq: SEQ_IDLE, customSlots: s.customSlots });
  },
  clearTemplate(): void {
    useDraft.setState({ templateId: null, step: 'template', bindings: {}, history: [], tweaks: {}, selected: null, seq: SEQ_IDLE });
  },
  setName(name: string): void {
    useDraft.setState({ name });
  },
  setStep(step: WizardStep): void {
    useDraft.setState({ step });
  },
  select(id: string | null): void {
    useDraft.setState({ selected: id });
  },
  bind(slotId: string, b: SlotBinding): void {
    commit(bindSlot(useDraft.getState().bindings, slotId, b));
    const s = useDraft.getState();
    if (s.seq.active) {
      const seq = seqReducer(s.seq, { type: 'assigned', bindings: s.bindings });
      useDraft.setState({ seq, selected: seq.done ? s.selected : (seq.order[seq.index] ?? s.selected) });
    }
  },
  unbind(slotId: string): void {
    commit(unbindSlot(useDraft.getState().bindings, slotId));
  },
  clearAll(): void {
    commit({});
  },
  undo(): void {
    useDraft.setState((s) => {
      const prev = s.history[s.history.length - 1];
      return prev ? { bindings: prev, history: s.history.slice(0, -1) } : s;
    });
  },
  setTweak(slotId: string, patch: Partial<SlotTweak>): void {
    useDraft.setState((s) => {
      const cur = { ...(s.tweaks[slotId] ?? {}), ...patch };
      for (const k of Object.keys(cur) as (keyof SlotTweak)[]) if (cur[k] === undefined) delete cur[k];
      const tweaks = { ...s.tweaks, [slotId]: cur };
      if (Object.keys(cur).length === 0) delete tweaks[slotId];
      return { tweaks };
    });
  },
  setCustomSlots(fn: (slots: VehicleSlot[]) => VehicleSlot[]): void {
    useDraft.setState((s) => {
      const customSlots = fn(s.customSlots);
      const ids = new Set(customSlots.map((x) => x.id));
      const bindings = Object.fromEntries(Object.entries(s.bindings).filter(([id]) => ids.has(id)));
      return { customSlots, bindings };
    });
  },
  seq(a: SeqAction): void {
    const s = useDraft.getState();
    const seq = seqReducer(s.seq, a);
    const cur = seq.active && !seq.done ? seq.order[seq.index] : undefined;
    useDraft.setState({ seq, selected: cur ?? s.selected });
  },
};
