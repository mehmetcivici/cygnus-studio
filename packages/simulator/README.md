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
const runner = new RealtimeRunner(sim, realScheduler, { tickMs: 4, maxCatchUpMs: 100, speed: 1 });
runner.start();                            // runner.stop(); runner.speed = 0.25 for slow motion
await transport.open();
```

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
//   common: paramCrc · hardware · selfTestFail(arg = mask) · flashError
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

## Firmware images

`makeDemoFirmware(model, '1.2.0' | {major,minor,patch}, { size, hwRevMin, hwRevMax })` returns a
valid `.cyfw`. The simulated bootloader erases (BUSY), ACKs every 16 DATA frames, checks
CRC/header/model, and reboots into the new version (visible in HEARTBEAT).

## Physics notes

ESC loops output volts as the catalog gains define (velocity PID + kS/kV/kA, position PID +
trapezoid profile + the same feed-forward); current is limited at 10 kHz by phase, supply and
thermal derating. Hall velocity comes from edge timing (pole pairs matter), sensorless reads 0
below 250 motor rpm, remote Cyncoder feedback arrives at its STATUS 0 period (latency is real).
Gyro yaw drifts with an uncalibrated bias. Fuses trip on I²t.
