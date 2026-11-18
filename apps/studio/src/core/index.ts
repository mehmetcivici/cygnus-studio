// Core services for every screen. Import from '../../core' only (see README.md).
import './messages';

export { initCore } from './init';

// connection
export { connection, useConnection, useBus, useSimulation } from './connection/manager';
export type { ConnectionPhase, ConnectionState } from './connection/manager';
export { DEMO_SCENARIO_ID, DEFAULT_ROBORIO_HOST, ROBORIO_PORT } from './connection/sources';
export type { ConnectionSource, ConnectionKind, StoredSource } from './connection/sources';

// store + hooks
export {
  useDevices,
  useDevice,
  useUnresolved,
  useBusStats,
  useLinkState,
  useSelectedDevice,
  useSignal,
  useSignals,
  useParam,
  signalHub,
  paramCache,
} from './store/hooks';
export type { LinkState, ParamState } from './store/hooks';
export { useBusStore, selectDevice } from './store/busStore';
export { deviceStatus, displayName, modelText, fmtFw, LEGACY_MODEL_NAME } from './store/deviceView';
export type { DeviceView } from './store/deviceView';

// safety
export { drive, requestDrive, clearEstop, useDriveSession, useDrive, DriveSession } from './safety';
export type { DriveStopReason, ArmBlock, DriveInfo, UseDriveSession } from './safety';
export { ArmButton } from './safety/ArmButton';
export type { ArmButtonProps } from './safety/ArmButton';
export { DriveBanner } from './safety/DriveBanner';
export type { DriveBannerProps } from './safety/DriveBanner';

// recorder
export { signalHistory, useSignalHistory, useTrend, HISTORY_CAPACITY } from './recorder/history';
export { frameTrace, FrameTrace, FRAME_TRACE_CAPACITY } from './recorder/frames';
export type { TracedFrame } from './recorder/frames';
export { sessionRecorder, useRecorder } from './recorder/session';
export type { RecordChannel, RecorderState } from './recorder/session';

// project
export {
  useProject,
  updateProject,
  newProject,
  setProjectName,
  setProjectNotes,
  setVehicleConfig,
  captureBus,
  saveProjectToDisk,
  openProjectFromDisk,
  loadProjectText,
  projectText,
} from './project/store';
export type { ProjectState, CaptureProgress } from './project/store';
export { defineProjectSection } from './project/sections';
export type { ProjectSection } from './project/sections';
export { parseProject, serializeProject, emptyProject, PROJECT_EXT, PROJECT_VERSION } from './project/schema';
export type { ProjectFile, ProjectDevice } from './project/schema';
export { downloadFile, pickFile, safeFileName } from './project/files';

// settings
export { useSettings, updateSettings, toDisplayUnit, fromDisplayUnit, setTheme, setLang, useLang } from './settings';
export type { Settings, AngleUnit, TempUnit, BusView } from './settings';

// catalog helpers + errors
export { primarySignals, formatSignal, isDiscrete, rangeTone } from './catalog';
export { describeError } from './errors';

// shared components
export * from './components';
