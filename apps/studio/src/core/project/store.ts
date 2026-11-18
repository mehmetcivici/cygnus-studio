import { create } from 'zustand';
import type { CygnusBus } from '@cygnus/protocol';
import type { VehicleConfig } from '@cygnus/vehicles';
import { readStored, writeStored } from '../../lib/storage';
import { downloadFile, pickFile, safeFileName } from './files';
import {
  PROJECT_EXT,
  emptyProject,
  parseProject,
  projectDeviceFrom,
  serializeProject,
  type ProjectDevice,
  type ProjectFile,
  type ProjectParseError,
} from './schema';

const LAST_KEY = 'cy.project.last';
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

export interface ProjectState {
  project: ProjectFile;
  /** Changed since the last save/open. */
  dirty: boolean;
  /** Name of the file it was opened from / saved to. */
  fileName: string | null;
}

function restore(): ProjectState {
  const raw = readStored(LAST_KEY);
  if (raw) {
    const r = parseProject(raw);
    if (r.ok) return { project: r.project, dirty: false, fileName: null };
  }
  return { project: emptyProject('', APP_VERSION), dirty: false, fileName: null };
}

export const useProject = create<ProjectState>(() => restore());

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistSoon(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeStored(LAST_KEY, serializeProject(useProject.getState().project));
  }, 500);
}

/** Applies a change to the current project, stamps `modifiedAt`, marks it dirty and persists. */
export function updateProject(fn: (p: ProjectFile) => ProjectFile): void {
  useProject.setState((s) => ({ project: { ...fn(s.project), modifiedAt: new Date().toISOString() }, dirty: true }));
  persistSoon();
}

export function newProject(name = ''): void {
  useProject.setState({ project: emptyProject(name, APP_VERSION), dirty: false, fileName: null });
  persistSoon();
}

export function setProjectName(name: string): void {
  updateProject((p) => ({ ...p, name }));
}

export function setProjectNotes(notes: string): void {
  updateProject((p) => ({ ...p, notes }));
}

export function setVehicleConfig(vehicle: VehicleConfig | null): void {
  updateProject((p) => ({ ...p, vehicle }));
}

export function setProjectSection(id: string, value: unknown): void {
  updateProject((p) => {
    const sections = { ...p.sections };
    if (value === undefined) delete sections[id];
    else sections[id] = value;
    return { ...p, sections };
  });
}

export interface CaptureProgress {
  device: number;
  devices: number;
  /** 0..1 over everything. */
  fraction: number;
}

/**
 * Reads every parameter of every online board and stores the bus snapshot in the project.
 * Boards without parameter access (legacy) are stored with an empty `params`. Returns the
 * boards whose read failed partially (their successful values are still stored).
 */
export async function captureBus(bus: CygnusBus, onProgress?: (p: CaptureProgress) => void): Promise<{ devices: ProjectDevice[]; failed: string[] }> {
  const online = bus.devices.filter((d) => d.online && !d.unassigned && !d.conflict);
  const out: ProjectDevice[] = [];
  const failed: string[] = [];
  for (let i = 0; i < online.length; i++) {
    const d = online[i];
    if (!d) continue;
    let params: Record<string, number> = {};
    if (d.capabilities.params) {
      const r = await d.readAllParams({
        onProgress: ({ done, total }) => onProgress?.({ device: i, devices: online.length, fraction: (i + (total ? done / total : 1)) / online.length }),
      });
      params = r.values;
      if (r.failed.length) failed.push(d.uid48);
    }
    out.push(projectDeviceFrom(d, params));
    onProgress?.({ device: i + 1, devices: online.length, fraction: (i + 1) / online.length });
  }
  updateProject((p) => ({ ...p, bus: { capturedAt: new Date().toISOString(), devices: out } }));
  return { devices: out, failed };
}

export function projectText(): string {
  return serializeProject(useProject.getState().project);
}

export function projectFileName(): string {
  const { project, fileName } = useProject.getState();
  return fileName ?? `${safeFileName(project.name, 'cygnus-proje')}${PROJECT_EXT}`;
}

/** Downloads the project file and clears the dirty flag. */
export function saveProjectToDisk(): void {
  const name = projectFileName();
  downloadFile(name, projectText(), 'application/json');
  useProject.setState({ dirty: false, fileName: name });
}

export function loadProjectText(text: string, fileName: string | null = null): { ok: true } | { ok: false; error: ProjectParseError; detail?: string } {
  const r = parseProject(text);
  if (!r.ok) return r;
  useProject.setState({ project: r.project, dirty: false, fileName });
  persistSoon();
  return { ok: true };
}

/** Shows the file chooser and loads the file. `null` when the user cancelled. */
export async function openProjectFromDisk(): Promise<{ ok: true } | { ok: false; error: ProjectParseError; detail?: string } | null> {
  const file = await pickFile(`${PROJECT_EXT},.json,application/json`);
  if (!file) return null;
  return loadProjectText(await file.text(), file.name);
}
