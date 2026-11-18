# `src/core` — uygulama çekirdeği

Ekranlar yalnızca `import { … } from '../../core'` kullanır (alt dosyalara doğrudan girmeyin).
`initCore()` `app/bootstrap.ts` içinden bir kez çağrılır; ekranların başlatması gereken bir şey yoktur.

## Modüller

| Modül | Amaç | Başlıca dışa aktarımlar |
|---|---|---|
| `connection/` | Tek etkin `CygnusBus` (CyCAN + eski Cyncoder v3 sürücüsü). Kaynak: simülatör senaryosu, Web Serial slcan, Tauri seri slcan, Tauri TCP roboRIO köprüsü. Son seçimi hatırlar; ilk açılışta ve `demo` kipinde `all.devices` kendiliğinden başlar. | `connection.connect(src)/disconnect()/reconnect()/setSimSpeed()/setAmbient()`, `useConnection`, `useBus()`, `useSimulation()` |
| `store/` | Zustand deposu + kancalar. Cihaz olayları 50 ms'de bir toplanır; değişmeyen `DeviceView` aynı nesne kalır (memo bileşenler yeniden çizilmez). | `useDevices`, `useDevice(uid)`, `useUnresolved`, `useBusStats`, `useLinkState`, `useSelectedDevice`, `useSignal(uid,key)`, `useSignals(uid,keys)`, `useParam(uid,key)` |
| `safety/` | Tek sürüş oturumu, otomatik kesmeler, ACİL DURDUR kilidi. | `useDriveSession`, `requestDrive`, `drive`, `useDrive`, `clearEstop`, `ArmButton`, `DriveBanner` |
| `recorder/` | Sinyal geçmişi halkaları, CAN çerçeve izi, oturum kaydı (CSV/JSON). | `useSignalHistory`, `useTrend`, `signalHistory`, `frameTrace`, `sessionRecorder`, `useRecorder` |
| `project/` | `.cygnus.json` (sürüm 1): hat anlık görüntüsü, araç yapılandırması, notlar, ekran bölümleri. Son proje localStorage'da. | `useProject`, `defineProjectSection`, `captureBus`, `saveProjectToDisk`, `openProjectFromDisk`, `setVehicleConfig`, `downloadFile`, `pickFile` |
| `settings/` | Gelişmiş kip, açı/sıcaklık birimi, Hat görünümü, onaltılık kimlik; dil ve tema kendi depolarında. | `useSettings`, `updateSettings`, `toDisplayUnit`, `fromDisplayUnit` |
| `catalog.ts`, `errors.ts` | Kartın 2–3 başlıca sinyali, sinyal biçimleme, `CyError` → okunur cümle. | `primarySignals`, `formatSignal`, `describeError` |
| `components/` | Katalog güdümlü paylaşılan bileşenler (aşağıda). | |

## Bağlantı

```ts
await connection.connect({ kind: 'sim', scenarioId: 'bench.arm' });          // senaryo değiştir
await connection.connect({ kind: 'webserial' });                              // tıklama içinde: port seçici
const phase = useConnection((s) => s.phase);  // 'idle'|'connecting'|'connected'|'lost'|'error'
const sim = useSimulation();                  // Simulation | null (yalnız senaryoda)
const bus = useBus();                         // CygnusBus | null; bağlantı değişince yeni nesne
```

`lost`: hat koptu, kartlar çevrim dışı listede kalır; kullanıcı yeniden bağlanır. Donanım hiçbir zaman
tıklamasız açılmaz; son donanım kaynağı Hat karşılama ekranında "Yeniden bağlan" olarak sunulur.

## Kancalar — kurallar

- `DeviceView` değişmez anlık görüntüdür; işlem için `view.handle` (DeviceHandle) kullanılır, render'da handle alanı okunmaz.
- `useSignal/useSignals`: kart başına tek `onSignals`, en çok ~20 Hz ve yalnız değişen anahtar için yeniden çizim. `useSignals`'a **sabit** dizi verin (modül sabiti / `useMemo`). Yüksek hızlı grafik için `d.stream.open()` + `SeriesBuffer` kullanın; React'ten geçirmeyin.
- `useParam(uid,key)` → `{ value, loading, error, def, set }`. Önbellekte yoksa bir kez okur; `paramChanged`/`paramsInvalidated` ile güncel kalır.
- `useSignalHistory(uid,key,capacity)` STATUS hızında `SeriesBuffer` (saniye zaman tabanı, `LiveChart` ile uyumlu). `useTrend` StatTile eğilimi içindir.
- `frameTrace.subscribe()` yalnız görünürken tutun (abone yokken `frame` olayı bağlanmaz). Okuma: `length`, `version`, `get(i)`, `idAt(i)`, `frameAt(i)`; `setPaused`, `clear`.

## Seçili cihaz

`useSelectedDevice()` → `[view, select]`. Hat ekranı "Karta git"te `selectDevice(uid)` + `navigate('device', { device: uid })`
yapar; Cihaz/Tuner/Grafik URL parametresini öncelikli, yoksa seçili cihazı kullanmalı.

## Bileşenler (`components/`)

- `DevicePicker {value, onChange, capability?, models?, categories?, includeOffline?, where?, autoSelect?}` — değer `uid48`. Aynı süzgeç: `matchDevice(view, filter)`.
- `SignalPicker {value: SignalRef[], onChange, max?, filterDevice?, numericOnly?, height?}`.
- `ParamField {uid48, paramKey, mode?: 'staged'|'immediate', showKey?, compact?, layout?, readOnly?, onApplied?}` — tip → kontrol (sayı/Toggle/Select), birim tercihi, min/max/adım, kirli/uygulanıyor/hata, rozetler (salt okunur, yeniden başlatma, sürülürken kilitli, gelişmiş), varsayılana dön, kart ret statüsü katalog etiketiyle.
- `ParamForm {uid48, groups?, toolbar?, toolbarExtra?, autoLoad?, onApplied?}` — tek `readAllParams`, arama, "yalnız değişenler" (varsayılandan farklı), gelişmişleri gizle; altta Uygula / Geri al / Karta kaydet. `ParamGroup {uid48, group, keys?, title?, actions?, mode?}` form içinde ya da tek başına (anında yazar).
- `DeviceBadge {device: view|uid, showModel?, showIcon?, size?, onClick?}`, `ModelIcon {def, size?, boxed?}`, `FaultList {device, clearable?, compact?}`, `SignalTile {uid48, signal, label?, trend?, tone?, size?, caption?}`.
- Eski protokollü kartın adı her yerde `modelText(view)` → "Cyncoder 1.4 (eski protokol)".

## Sürüş oturumu (Tuner, Araç motor testi, Cihaz elle kontrol)

```tsx
const { session, armed, busyOwner } = useDriveSession('tuner', uid48);   // mount'ta ister, unmount'ta bırakır
useEffect(() => session?.onStop(() => generator.stop()), [session]);     // her kesmede önce bu, sonra control.stop()
useEffect(() => {
  if (!armed || !session?.device) return;
  const loop = session.device.control.start('velocity', target);          // yalnız armed iken komut gönderin
  return () => loop.stop();
}, [armed, session]);
return <><DriveBanner session={session} /><ArmButton session={session} /></>;
```

Kesmeler (otomatik `disarm`): pencere odağı/sekme gizlenmesi, ekran/parametre değişimi, bağlantı kopması, kart kaybı veya arızası, ACİL DURDUR. ACİL DURDUR `bus.estop()` gönderir ve kilitler; kilit üst çubuktan (“Kilidi kaldır” → `clearEstop()`) kalkana dek `arm()` reddedilir (`core.drive.block.*` mesajları). Aynı anda yalnız bir sahip: başka ekran armed iken `session === null`, `busyOwner` dolu.

## Proje bölümü eklemek

```ts
// features/tuner/project.ts (modül düzeyinde bir kez)
export const tunerRuns = defineProjectSection('tuner.runs', { initial: [] as TunerRun[], guard: isTunerRunList });
tunerRuns.set((runs) => [...runs, run]);      // kirli işaretler, localStorage'a yazar
const runs = tunerRuns.use();                  // React kancası
```

Bölüm kimliği `<ekran>.<ad>` biçiminde olsun. Bilinmeyen bölümler yüklemede korunur. Araç yapılandırması bölüm değil, `project.vehicle` alanıdır (`setVehicleConfig`). Hat anlık görüntüsü: `captureBus(bus, onProgress)`.

## Testler

Çekirdek mantığı DOM'suz test edilir: `ManualUiClock` (store/sinyal toplama), `ManualScheduler` + simülatör
(bus deposu), sahte `DeviceHandle` nesneleri (hub, geçmiş, kaydedici), enjekte edilen ortam (`DriveController`).
Örnekler: `store/store.test.ts`, `safety/drive.test.ts`, `recorder/recorder.test.ts`, `project/project.test.ts`.

## Yapma

- `CygnusBus`/transport oluşturmayın; `connection` tek sahiptir. Bus olaylarına doğrudan bağlanmanız gerekirse `useBus()` + effect temizliği kullanın.
- `DeviceView` alanlarını değiştirmeyin; `useBusStore.setState` çağırmayın.
- Eyleyiciye `useDriveSession` dışında komut göndermeyin; `onEstop`'a ayrıca `bus.estop()` eklemeyin (çekirdek yapar).
- Yüksek frekanslı veriyi `useState`'e her örnekte yazmayın; `SeriesBuffer`/`LiveChart` kullanın.
- `localStorage`'a doğrudan erişmeyin; `lib/storage` (try/catch) kullanın.
- Kullanıcıya görünen metni koda gömmeyin; ekranın `messages.ts`'i (`registerMessages`) ya da `core.*`/`common.*` anahtarları.
