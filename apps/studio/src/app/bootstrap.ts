import { initCore } from '../core';
import { registerSlot } from './slots';
import { ConnectionMenu } from './ConnectionMenu';
import { BusHealth } from './BusHealth';
import { AlertCenter } from './AlertCenter';
import { EstopStatus } from './EstopStatus';
import { StatusLeft } from './StatusItems';
import { SimToggle } from './sim/SimPanel';
import { installScreenShortcuts } from './keyboard';
import './messages';
import './coreShell.css';

/** Starts the core services and fills the shell slots. Called once from main.tsx. */
export function bootstrapApp(): void {
  registerSlot('topbar.connection', ConnectionMenu);
  registerSlot('topbar.health', BusHealth);
  registerSlot('topbar.health', AlertCenter, 10);
  registerSlot('topbar.actions', EstopStatus, -10);
  registerSlot('topbar.actions', SimToggle, -5);
  registerSlot('statusbar.left', StatusLeft);
  installScreenShortcuts();
  initCore();
}
