import { createContext, useContext } from 'react';

/** Staged edits of one board's parameters, shared by a ParamForm and its fields. */
export interface ParamDraftApi {
  uid48: string;
  drafts: Readonly<Record<string, number>>;
  /** Write errors per key (already human readable). */
  errors: Readonly<Record<string, string>>;
  applying: ReadonlySet<string>;
  setDraft: (key: string, value: number | undefined) => void;
  /** Search / filter state of the surrounding form. */
  filter: { query: string; onlyChanged: boolean; showAdvanced: boolean };
}

export const ParamDraftContext = createContext<ParamDraftApi | null>(null);

export function useParamDraft(uid48: string): ParamDraftApi | null {
  const ctx = useContext(ParamDraftContext);
  return ctx && ctx.uid48 === uid48 ? ctx : null;
}
