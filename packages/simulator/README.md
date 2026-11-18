# @cygnus/simulator

Simulated CyCAN hardware for Cygnus Studio: virtual bus, boards that run the firmware side of
`docs/PROTOCOL.md`, and a 1 kHz physics world (10 kHz motor/current substeps). Pure TS,
deterministic (seeded), time only advances through `sim.advance(ms)` or a `RealtimeRunner`.

## Build a scenario and connect the host

```ts
import { realScheduler } from '@cygnus/protocol';
import { scenarios, createScenario, RealtimeRunner } from '@cygnus/simulator';

scenarios;                         // [{ id, name: {tr,en}, description, category: 'bench'|'demo'|'vehicle' }]
const sim = createScenario('bench.flywheel', { seed: 1 });
// ids: bench.flywheel · bench.arm · factory.fresh · legacy.cyncoder · all.devices · vehicle.<templateId> (e.g. vehicle.frc.swerve4)
// options: { seed, assigned: false (factory-fresh boards, for the vehicle wizard), fd: false, useServoChannels }
// fd: false is a classic-only bus: every board is built with can.data_bitrate = 0 (classic mode).
// legacy.cyncoder (classic by default): two Cyncoder 1.4 on the legacy v3 firmware + one CyCAN Cyncoder;
// all.devices also has one legacy board ('cyncoder_v3'). Add `new CyncoderV3Driver()` to the CygnusBus to see them.

const transport = sim.createTransport();   // Transport (kind 'sim'), give it to CygnusBus
const runner = new RealtimeRunner(sim, realScheduler, { tickMs: 4, speed: 1 });
runner.start();                            // runner.stop(); runner.speed = 0.25 for slow motion
await transport.open();
```

`RealtimeRunner` catches up to `maxCatchUpMs` (default 2000 ms, above the host's 1500 ms "lost"
limit) per tick, so a background tab whose timers run once a second keeps every board online.
Frames of a catch-up are stamped so it ends at the scheduler's `now` (node clocks and the host
clock agree even after time was dropped). While the machine cannot keep up with real time the
limit falls back to 100 ms to keep the page responsive; `runner.droppedMs` counts what was dropped.

`buildVehicleScenario(template, opts)` builds directly from a `@cygnus/vehicles` template.
`sim.slotPlacements[slotId]` → `{ nodeId, channel?, shaftId? }` tells where each slot lives.
Frame timestamps follow the scheduler clock (`sim.hostTimeOffset` is kept by the runner).
In tests use `ManualScheduler` with the runner, or call `sim.advance(ms)` directly.
Host ↔ simulator integration tests live in `test/integration/`; `harness.ts` `connect(sim)` gives a
`CygnusBus` on the same clock with `runFor(ms)`, `settle(promise)`, `until(cond)`, `discover()`, `dev(nodeId)`.

## Simulator panel (control API)

```ts
sim.snapshot();       // { timeMs, bus, battery, nodes[], shafts[], body }  — poll at 5–10 Hz
sim.onEvent((e) => …) // nodeAdded | nodeRemoved

// boards
sim.nodes / sim.node(id)            // SimNode: id, def (catalog), num, uid48, state, faults, signalValues()
sim.addNode(new EscNode(Model.ESC_80A, { motor, num: 5 }))   // hot-plug; it boots like a real board
sim.removeNode(id)
sim.setCable(id, false)             // pull / plug the CAN cable (board keeps running)
sim.setPower(id, false); sim.powerCycle(id)
sim.factoryReset(id)                // number 63, defaults, reboot
sim.inject(id, kind, on = true, arg = 0)  // node.allInjections() lists supported kinds
//   common: paramCrc (settings store corrupt: next boot comes up unassigned, defaults, PARAM_CRC
//           active until SAVE_PARAMS/CLEAR_FAULTS) · hardware · selfTestFail(arg = mask) · flashError
//           brokenApp (CRC-valid image that hangs at start-up: the board is silent after its next
//           power-up; only the recovery window gets it back, PROTOCOL §9.0; a new image repairs it)
//   ESC: overtemp · motorDisconnected · hallLost · jam   Cyncoder: magnetMissing/Weak/Strong
//   sealed servo: leak · jam · overtemp   PDH: fuseBlown(arg = channel) · auxOvercurrent
//   servo16: railOvercurrent   SoC: outputOvercurrent
(sim.node('power') as PdhLargeNode).replaceFuse(3)

// bus and supply
sim.setBusLoss(5)                   // % of frames destroyed
sim.setBusShort(true)               // nothing gets through; boards raise CAN_ERR
sim.setBatteryVoltage(11.2); sim.setBatteryConnected(false)

// mechanics (hand of god), times in sim ms
const w = sim.world, t = sim.timeMs;
w.handTurn(shaftId, rpm, t, durationMs)   // −1 = until handRelease(shaftId)
w.handRotate(shaftId, deltaRot, t, 300)   // "turn it so the Studio finds the encoder"
w.handHold(shaftId, t); w.handRelease(shaftId)
w.setLoad(shaftId, nm); w.push(shaftId, nm, t, ms)   // constant load / step disturbance
w.setJammed(shaftId, true)
w.tiltBody(pitchDeg, rollDeg); w.spinBody(dps, t, ms) // gyro sees it
```

`sim.bus.stats.txOverflow` counts frames dropped by full transmit queues. Every endpoint (board,
host adapter) has its own 256-frame queue, as on a real bus: a babbling board only overflows
itself, and inside one queue a higher-priority frame displaces the lowest one (ESTOP is never
crowded out). `node.hangs` is true for a board stuck on a broken image.

Snapshot `nodes[]` carry: `id, model, modelKey, devType, num, uid48Hex, name, state, mode
('off'|'boot'|'app'|'bootloader'), powered, connected, conflict, identify (blink the LED),
enabled, unsaved, faults {active,sticky,warn}, fw, supplyV, supplyA, streaming, signals
(catalog signal key → value), injections, activeInjections`.

## Board-specific views

- `OledNode`: `framebuffer` (1024 B, SSD1306 pages, bit 0 = top), `pixel(x, y)`,
  `frameVersion` (redraw counter), `brightness`, `currentPage`, `textLines()`.
- `LegacyCyncoderNode` (Cyncoder v3 / FRC protocol, PROTOCOL §11): `uid32`, `version`, `applied` (commands
  that matched its UID), `blinking`; `inject(id, 'hardware')` = sensor fault. Snapshot reports model 0,
  modelKey `cyncoder_v3`, devType 10. It never answers CyCAN frames.
- `Servo16Node.pulse(ch)`, `EscNode.fetTemperature`, `EscNode.pwmIn.pulseUs` (RC input),
  `GyroNode.trueBias`, `SocRegNode.brownoutCount`, `PdhLargeNode.channel(n)` (PowerFeed).

## Board firmware behaviour (reference implementation of `docs/PROTOCOL.md`)

`SimNode` is the reference for the card side; the C library (`firmware/cycan`) implements the
same rules and `test/integration/c-node.test.ts` checks both give the same replies.

- Power-up runs the bootloader: with a valid image it listens 150 ms for the recovery beacon
  (broadcast `ENTER_BOOTLOADER`, `arg = RECOVERY_STAY_MAGIC`) and then starts the application.
  The application's first heartbeat (within 100 ms) says `state = BOOT`.
- CTRL: addressed only (both broadcast forms ignored), refused in ESTOP, with an active fault or
  when silent. **Neutral first**: boards classify each frame (`CtrlResult` INVALID / NEUTRAL /
  DRIVE, the C `ctrl` contract); a DRIVE is applied only after a NEUTRAL on that CTRL index since
  the last neutral-forcing event (boot, ESTOP and CLEAR_ESTOP, CTRL timeout, new active fault,
  CONFLICT, renumbering). Only accepted frames feed the `ctrl.timeout_ms` watchdog.
- Commands: `LOAD_SAVED` restores stored parameters and name (`FAILED` on a corrupt store).
  While driving `REBOOT`, `ENTER_BOOTLOADER`, `SAVE_PARAMS`, `LOAD_DEFAULTS`, `LOAD_SAVED` (and
  `SELF_TEST`) answer `DENIED`; in ESTOP `REBOOT`/`ENTER_BOOTLOADER` too. `ENTER_BOOTLOADER`
  needs `arg = ENTER_BOOTLOADER_INTENT | uid16` (`INVALID_ARG` otherwise); a running app ignores
  the recovery beacon silently. ESTOP wins over a CLEAR_ESTOP of the same ms (`DENIED`) and ends a
  running long command with `FAILED`; a neutral CTRL (and any other neutral-forcing event) ends a running
  catalog `movesActuator` command with `FAILED` as well (PROTOCOL §4.5, same as the C library); a repeated long command answers `IN_PROGRESS`, others `DENIED`.
- ASSIGN_ID: a persistent one is ignored while driving; a new number on an active board forces
  neutral and stops its stream. Warnings are not sticky (CAN_ERR is, and is a warning).
- Stream: classic mode sends at most 4 slots; an unknown sid keeps its slot and streams NaN.
- Settings store corrupt (`paramCrc`): unassigned, catalog defaults, `PARAM_CRC` active,
  `UNSAVED` until saved; the bootloader then runs classic CAN. Otherwise it uses the stored
  `can.data_bitrate` (classic if the model has none).

## Firmware images

`makeDemoFirmware(model, '1.2.0' | {major,minor,patch}, { size, hwRevMin, hwRevMax })` returns a
valid `.cyfw`. The simulated bootloader follows PROTOCOL §9: `BEGIN` → `OK` (nothing erased);
the 64-byte header is collected and checked first (wrong model/hw/size → `BAD_IMAGE`, the
installed application stays); then `BUSY` while erasing and `OK` with `next_offset = 64`; an ACK
every 16 DATA frames; one `BAD_OFFSET` per window of stray frames; DATA whose length + 3 is not a
frame length is ignored; `END` → file CRC (`BAD_CRC`), payload CRC (`BAD_IMAGE`), `OK`, and the
new version starts 5 ms later (FW requests meanwhile answer `BUSY`). FW frames are taken only at
the board's own number. Bootloader `REBOOT` answers `FAILED` without a valid image.

## C cross-compatibility test

`test/integration/c-node.test.ts` drives the real C library through `cycan-bridge`
(`make -C firmware/cycan bridge`; wire format in `firmware/cycan/tools/bridge/README.md`): the host
`CygnusBus` runs the full flow against it, and a differential test feeds the same frames to a
simulated ESC 20A and to the C board and compares every reply. Without the binary the tests are
skipped.

## Physics notes

ESC loops output volts as the catalog gains define (velocity PID + kS/kV/kA, position PID +
trapezoid profile + the same feed-forward); current is limited at 10 kHz by phase, supply and
thermal derating. Hall velocity comes from edge timing (pole pairs matter), sensorless reads 0
below 250 motor rpm, remote Cyncoder feedback arrives at its STATUS 0 period (latency is real).
Gyro yaw drifts with an uncalibrated bias. Fuses trip on I²t. The hall position counter starts at 0
when the firmware starts; the supply current includes the bridge's conduction and switching
losses. Every power feed (PDH channels, regulator output, PWM ESC feeds) is summed afresh each ms.
