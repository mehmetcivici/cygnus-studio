# `@cygnus/protocol` · host istemcisi

Arayüzün (ve ileride Python/Gemstone eşleniğinin) üzerine oturduğu katman. Saf TS; zaman yalnızca `Scheduler`'dan gelir.
Arayüz protokol ayrıntısı bilmez: kartları `DeviceHandle` olarak görür, metinleri katalog `Text` alanlarından (`{tr,en}`) alır.

## Hat

```ts
const bus = new CygnusBus(transport, realScheduler, { dataBitrateMbps: 2 });
bus.on('deviceAdded', (d) => store.add(d));          // deviceChanged · deviceLost · deviceRemoved
bus.on('stats', (s) => setHealth(s.loadPct, s.rxFps, s.txFps, s.requestTimeouts));
bus.on('transportState', (s) => setLink(s.phase, s.error));
await bus.start();                                    // transport.open + 1 s ENUM taraması + heartbeat izleme
bus.devices;                                          // tip/numara/UID sırasında, kayıplar dahil (d.online)
bus.device(2, 3); bus.deviceByUid('a867d8040149');    // kimlik uid48'dir; numara değişse de handle aynı kalır
bus.estop();                                          // tüm control döngülerini keser + yayın ESTOP
await bus.stop();                                     // bekleyen her şey DISCONNECTED ile biter, cihazlar silinir
```

`frame` olayı yalnızca abone varken üretilir (CAN izleyici): `bus.on('frame', ({dir, frame}) => rows.push(bus.describeFrame(frame, lang)))`.
`describeFrame` → `{ className, indexName, address, dir, fields[{label,value}], summary, raw }`; STATUS katalogdan çözülür, yabancı çerçeve ham kalır.

## Çakışma / atanmamış kartlar

```ts
bus.unresolved;                         // CONFLICT, NUM=63 veya aynı adreste iki bayraksız kart
bus.identifyByUid(d.uid48, 5);          // atanmamış kart da LED yakar
bus.suggestNumber(d.devType);           // o tipteki ilk boş numara (kayıp kartların numarası ayrılmış sayılır)
const plan = bus.planResolve();         // [{ device, from, to }] — önce kullanıcıya göster
await bus.resolveAll({ persist: true }); // [{ ...plan, ok, error? }]
await bus.assignId(d.uid48, 7);         // dolu numara → CyError INVALID reason 'number_taken' ({force:true} ile geçilir)
```

## Cihaz

Kimlik/durum alanları: `model, def (ModelDef|undefined), catalogStatus ('ok'|'unknownModel'|'newerCatalog'), devType, num, uid48, uid96, name, fw, hwRev, catalogRev, state, flags{unsaved,enabled,warning,identify}, faults{active,sticky,warn,list}, online, lastSeen, conflict, unassigned, bootloader, infoLoaded, capabilities`.
`d.on('changed' | 'paramChanged' | 'paramsInvalidated', cb)`. Desteklenmeyen yetenek (`capabilities.x === false`) → `NOT_SUPPORTED`.

```ts
const v = await d.getParam('vel.kp');              // önbellek: d.cachedParam(key), d.params
await d.setParam('vel.kp', 0.002);                 // önce katalogla denetlenir, sonra kart statüsü
const { values, failed } = await d.readAllParams({ onProgress: ({ done, total }) => bar(done / total) });
await d.save(); await d.loadDefaults(); await d.rename('Sol ön itici');
await d.command('measure_motor', 0, { onProgress: () => spin() });   // IN_PROGRESS → nihai sonuç
const st = await d.selfTest();                     // { passed, mask, failed: BitDef[] } (katalog etiketleri)
await d.identify(5); await d.reboot(); await d.clearFaults(); await d.clearEstop(); await d.readFaults();
```

Sinyaller (STATUS): `d.signals.velocity`, `d.getSignal('bus.voltage')` (henüz gelmediyse `NaN`).
Yüksek frekans için çerçeve başına tek çağrı; nesne yeniden kullanılır, saklamak için kopyalayın:

```ts
const off = d.onSignals((u) => { if (u.keys.includes('velocity')) gauge(u.values.velocity); });
```

## Kontrol (eyleyici)

```ts
d.control.set('duty', 0.2);                         // tek atım; kart ctrl.timeout_ms sonra nötre döner
const loop = d.control.start('velocity', 1500);     // 50 Hz (ctrl.timeout_ms/4'ten hızlıysa ona iner)
loop.update(1800); loop.setMode('position', 2);
loop.stop();                                        // = d.control.stop(): döngüyü bitirir + nötr komut
d.control.send('channels_1_4', { pulsesUs: [1500, 1500, 0, 0] }, { repeat: true }); // servo16: katalog control anahtarı
```

Odak kaybı, sayfa değişimi, boşluk tuşu → `d.control.stop()`; ACİL DURDUR → `bus.estop()`. Kart kaybolunca/hat kopunca döngü kendiliğinden durur (nötr gönderilmeden).

## Akış (tuner/grafik)

```ts
const sub = d.stream.open({ signals: ['setpoint', 'velocity', 'loop.output'], periodUs: 1000 });
sub.onData((t, v) => chart.push(t, v[0], v[1], v[2]));  // t: host ms; v: Float32Array, signals sırasında, yeniden kullanılır
sub.lost; sub.samples; sub.periodUs;                     // seq boşluklarından kayıp; paylaşımda en hızlı periyot
sub.close();                                             // son tüketici kapanınca STOP
```

Aynı karta açılan akışlar 15 yuvayı paylaşır; aşılırsa `CyError('NO_SLOTS')`. Klasik kipte eksik örnekte ilgili değer `NaN`.

## Firmware

```ts
const ctl = new AbortController();
const r = await d.firmware.update(bytes, { signal: ctl.signal, onProgress: (p) => bar(p.fraction, p.phase) });
// r: { version, previous, bytes, rewinds, durationMs } · phase: validate→enterBootloader→erase→transfer→verify
const all = await bus.updateAllFirmware([escImg, encImg], { onDevice, onProgress: (dev, p) => … });
// all: [{ device, ok, skipped?: 'no_image'|'same_version'|'offline', result?, error? }]
```

## Hatalar

Her hata `CyError`: `code` ∈ `TIMEOUT · REJECTED · NOT_SUPPORTED · DISCONNECTED · INVALID · UNRESOLVED · NO_SLOTS · BUSY · ABORTED`.
`REJECTED` → `status` + `statusKind` ('param'|'command'|'fw'), `e.statusLabel` katalog etiketi verir. `INVALID` → `reason`
(`out_of_range`, `read_only`, `not_integer`, `invalid_option`, `unknown_param`, `wrong_model`, `wrong_hw_rev`, `number_taken`…).

## Sürücüler

`CygnusBus` çerçeveleri sırayla `BusDriver`'lara verir (önce CyCAN). Eski Cyncoder v3 sürücüsü `new CygnusBus(t, s, { drivers: [legacy] })`
ile eklenir ve kartlarını aynı `DeviceHandle` yüzeyiyle, kısıtlı `capabilities` ile sunar.
