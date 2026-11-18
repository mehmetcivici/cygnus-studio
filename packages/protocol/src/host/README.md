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
bus.device(2, 3); bus.deviceByUid('a867d8040149');    // kimlik uid48'dir; numara değişse de handle aynı kalır (eski kartlar: UID'leri 12 haneye dolgulu)
bus.estop();                                          // tüm control döngülerini keser + yayın ESTOP (10 ms arayla 3 kez)
await bus.stop();                                     // açık döngülere nötr gönderir; bekleyen her şey DISCONNECTED ile biter, cihazlar silinir
```

`transportState`: `{ phase, error?, notice? }`. `notice: 'fd_unsupported'`: slcan adaptörü `Y` (FD veri hızı) komutunu reddetti,
hat klasik CAN ile açıldı (`transport.info.fd === false`). roboRIO köprüsü çerçeveleme hatasından sonra tek kullanımlıktır: yeniden
bağlanmak için yeni soket + yeni `RoboRioBridgeTransport`.

`frame` olayı yalnızca abone varken üretilir (CAN izleyici): `bus.on('frame', ({dir, frame}) => rows.push(bus.describeFrame(frame, lang)))`.
`describeFrame` → `{ className, indexName, address, dir, fields[{label,value}], summary, raw }`; STATUS katalogdan çözülür, yabancı çerçeve ham kalır.

## Çakışma / atanmamış kartlar

```ts
bus.unresolved;                         // CONFLICT, NUM=63 veya aynı adreste iki bayraksız kart
bus.identifyByUid(d.uid48, 5);          // atanmamış kart da LED yakar
bus.suggestNumber(d.devType);           // o tipteki ilk boş numara (kayıp kartların ve çakışılan numara ayrılmış sayılır)
const plan = bus.planResolve();         // [{ device, from, to }] — önce kullanıcıya göster
// PROTOCOL §3.4: çakışma grubunda en düşük uid48 numarayı korur (son adım, from === to), diğerleri ve
// atanmamışlar ilk boş numaraları alır; numarası değişecek kartlar önce, koruyan kart en son atanır.
await bus.resolveAll({ persist: true }); // [{ ...plan, ok, error? }]
await bus.assignId(d.uid48, 7);         // dolu numara → CyError INVALID reason 'number_taken' ({force:true} ile geçilir)
// Sürülen kart (bu host'un döngüsü ya da ENABLED bildiren kart) veya hedef numaradaki sürülen kart → CyError BUSY reason 'driving'
// ({force} bunu geçmez). Önce döngüyü durdurun; durdurduktan hemen sonra atama serbesttir.
```

## Cihaz

Kimlik/durum alanları: `model, def (ModelDef|undefined), catalogStatus ('ok'|'unknownModel'|'newerCatalog'), devType, num, uid48, uid96, name, fw, hwRev, catalogRev, state, flags{unsaved,enabled,warning,identify}, faults{active,sticky,warn,list}, online, lastSeen, conflict, unassigned, bootloader, infoLoaded, capabilities`.
`d.on('changed' | 'paramChanged' | 'paramsInvalidated' | 'controlStopped', cb)`. Desteklenmeyen yetenek (`capabilities.x === false`) → `NOT_SUPPORTED`.

Kart yeniden başlarsa (heartbeat `state = BOOT`): parametre önbelleği ve INFO düşer (`paramsInvalidated`), IN_PROGRESS bekleyen komutlar
`ABORTED` (reason `board_reset`) ile biter, açık akışlar kart yeniden çalışınca kendiliğinden kurulur, kontrol döngüsü kesilir.
Karttan ESTOP heartbeat'i gelince IN_PROGRESS komutlar `ABORTED` (reason `estop`). SET yanıtı yalnız istenen değeri
(`quantizeParamValue`) taşıyorsa kabul edilir; yeniden gönderimlere gelen geç yanıtlar aynı anahtardaki sonraki isteğe verilmez.

```ts
const v = await d.getParam('vel.kp');              // önbellek: d.cachedParam(key), d.params
await d.setParam('vel.kp', 0.002);                 // önce katalogla denetlenir, sonra kart statüsü
const { values, failed } = await d.readAllParams({ onProgress: ({ done, total }) => bar(done / total) });
await d.save(); await d.loadDefaults(); await d.rename('Sol ön itici');
await d.loadSaved();                                // kayıtlı ayarları RAM'e geri yükler; önbellek düşer (paramsInvalidated)
await d.reboot();                                   // önbellek ve INFO düşer; heartbeat dönünce yeniden okunur
await d.command('measure_motor', 0, { onProgress: () => spin() });   // IN_PROGRESS → nihai sonuç
d.abortAction();                                     // eyleyiciyi hareket ettiren uzun komutu (katalog movesActuator) iptal: nötr CTRL → kart FAILED (PROTOCOL §4.5)
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
d.control.set('duty', 0.2);                         // tek atım (önce nötr, sonra hedef); kart ctrl.timeout_ms sonra nötre döner
const loop = d.control.start('velocity', 1500, {    // 50 Hz (ctrl.timeout_ms/4'ten hızlıysa ona iner)
  onStopped: (reason) => showWhy(reason),           // döngü hangi nedenle biterse bitsin bir kez çağrılır
});
loop.update(1800); loop.setMode('position', 2);
loop.stop();                                        // = d.control.stop(): döngüyü bitirir + nötr komut (reason 'stopped')
loop.active; loop.stopReason;                       // stopReason: bitene dek null
d.control.send('channels_1_4', { pulsesUs: [1500, 1500, 0, 0] }, { repeat: true }); // servo16: katalog control anahtarı
```

PROTOCOL §7 kuralları host'ta:

- **Nötrden başlama**: oturuma katılan her çerçeveden önce bir kez nötr komut gider (kart, nötr görmeden hedefi kabul etmez).
- Çerçeve her gönderimde kartın **güncel** adresiyle kodlanır.
- Host döngüyü kendisi keser ve `onStopped(reason)` + cihaz olayı `controlStopped` ile bildirir: `boardEstop` (başka düğüm ESTOP
  yolladı), `boardReset` (BOOT), `boardFault`, `bootloader`, `disabled` (sürülürken ENABLED düştü: CTRL zaman aşımı vb.),
  `renumbered` (numara değişti; eski adrese nötr gider), `unresolved` (CONFLICT/atanmamış), `lost`, `disconnected`, `estop` (`bus.estop()`).
  `lost`, `disconnected` ve `estop` dışındaki nedenlerde nötr komut da gönderilir.

Odak kaybı, sayfa değişimi, boşluk tuşu → `d.control.stop()`; ACİL DURDUR → `bus.estop()`.

## Akış (tuner/grafik)

```ts
const sub = d.stream.open({ signals: ['setpoint', 'velocity', 'loop.output'], periodUs: 1000 });
sub.onData((t, v) => chart.push(t, v[0], v[1], v[2]));  // t: host ms; v: Float32Array, signals sırasında, yeniden kullanılır
sub.lost; sub.samples; sub.periodUs;                     // seq boşluklarından kayıp; paylaşımda en hızlı periyot
sub.close();                                             // son tüketici kapanınca STOP
```

Aynı karta açılan akışlar 15 yuvayı paylaşır; aşılırsa `CyError('NO_SLOTS')`. Klasik kipte (hat ya da kartın `can.data_bitrate`'i
klasik) en çok 4 yuva: `NO_SLOTS` reason `classic_limit`; eksik örnekte ilgili değer `NaN`.
Açmadan önce hat bütçesi denetlenir (PROTOCOL §10.1): son ölçülen yük + o zamandan beri açılan akışlar + bu akış %80'i aşarsa
`CyError('NO_BANDWIDTH')` (reason `bus_load`); daha yavaş periyotla yeniden deneyin. `streamLoad(slots, periodUs, classic)` tahmini verir,
`defaultStatusLoad(def)` bir kartın varsayılan STATUS + heartbeat yükünü.
Bir tüketici kapanınca yuvalar STOP'tan 2 ms sonra yeniden yazılır (arada gelen örnekler atılır). `lost`, `seq` ve kart saatinden sayılır
(256'dan uzun kesintiler dahil). Kart bir canlı tutma süresi boyunca hiç veri yollamazsa yerleşim baştan yazılır.

## Firmware

```ts
const ctl = new AbortController();
const r = await d.firmware.update(bytes, { signal: ctl.signal, onProgress: (p) => bar(p.fraction, p.phase) });
// r: { version, previous, bytes, rewinds, durationMs } · phase: validate→enterBootloader→erase→transfer→finish→verify
const all = await bus.updateAllFirmware([escImg, encImg], { onDevice, onProgress: (dev, p) => … });
// all: [{ device, ok, skipped?: 'no_image'|'same_version'|'offline'|'aborted', result?, error? }]
// 'aborted': hat koptuğu için hiç başlanmayan kartlar (error DISCONNECTED)
```

Akış (PROTOCOL §9): `ENTER_BOOTLOADER` (`arg = 0xB0070000 | uid16`; `d.command('enter_bootloader')` bunu kendisi doldurur), yanıtsız
kalırsa yeniden; `BEGIN` → `OK`; ilk 64 bayt (başlık) → kart BUSY (silme) → `OK + next_offset`; kart başlığı reddederse `REJECTED`
(`BAD_IMAGE`), uygulama silinmez ve host kartı `REBOOT` ile eski uygulamasına döndürür. Aktarım ortasında BUSY → kartın verdiği
`next_offset`'ten devam. `END` onayı kaybolursa yalnız `END` yinelenir; sonuç kartın uygulama heartbeat'indeki sürümden doğrulanır.
Parça boyu: FD 61 B (yalnız kartın `can.data_bitrate`'i FD olarak biliniyorsa; bilinmiyorsa önce okunur, okunamazsa klasik 5 B).

### Kurtarma kipi (PROTOCOL §9.0)

```ts
bus.recovery.start();          // 20 ms'de bir yayın ENTER_BOOTLOADER(0xB0075AFE); kullanıcı aracın gücünü kapatıp açar
bus.recovery.devices;          // bootloader'da bekleyen çevrimiçi kartlar → d.firmware.update(img)
bus.recovery.stop();           // bus.on('recovery', (active) => …); hat kopunca / bus.stop() ile kendiliğinden durur
```

## Hatalar

Her hata `CyError`: `code` ∈ `TIMEOUT · REJECTED · NOT_SUPPORTED · DISCONNECTED · INVALID · UNRESOLVED · NO_SLOTS · NO_BANDWIDTH · BUSY · ABORTED`.
`REJECTED` → `status` + `statusKind` ('param'|'command'|'fw'), `e.statusLabel` katalog etiketi verir. `INVALID` → `reason`
(`out_of_range`, `read_only`, `not_integer`, `invalid_option`, `unknown_param`, `wrong_model`, `wrong_hw_rev`, `number_taken`…).

## Sürücüler

`CygnusBus` çerçeveleri sırayla `BusDriver`'lara verir (önce CyCAN). Eski Cyncoder v3 sürücüsü `new CygnusBus(t, s, { drivers: [legacy] })`
ile eklenir ve kartlarını aynı `DeviceHandle` yüzeyiyle, kısıtlı `capabilities` ile sunar.
