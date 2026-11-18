import { create } from 'zustand';

/** When this session last wrote the project file (the project itself only knows when it changed). */
export const useSaveInfo = create<{ savedAt: number | null }>(() => ({ savedAt: null }));

export const markSaved = (): void => useSaveInfo.setState({ savedAt: Date.now() });
export const clearSaved = (): void => useSaveInfo.setState({ savedAt: null });
