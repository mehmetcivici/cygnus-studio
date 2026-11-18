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

## Kayıt (oturum kaydedici)

```ts
sessionRecorder.start(channels);                              // STATUS hızında (her STATUS güncellemesi)
sessionRecorder.start(channels, { streamPeriodUs: 1000 });    // yüksek hız: kart başına d.stream.open (1 kHz)
useRecorder((s) => s.statusFallback);                         // akış açılamayan kartlar (STATUS'a düştü)
useRecorder((s) => s.lost);                                   // akış sıra boşluklarından kayıp örnek
const csv = await sessionRecorder.exportCSV();                // olay döngüsünü bırakarak üretir (ESTOP tepkili kalır)
const json = await sessionRecorder.exportJSON({ note });
```
`toCSV()/toJSON()` eşzamanlı sürümlerdir; büyük kayıtta kullanmayın. CSV başlıklarında `= + - @` ile başlayan
metin `'` ön ekiyle zararsızlaştırılır.

## Grafik bileşeni ekleri (`ui` → `StaticChart`)

`xScale="log"` (Bode/spektrum; yakınlaştırma/kaydırma onluk ölçekte, x > 0), `xUnit="Hz"`,
`markers={[{ x: a, label: 'A', color: 'accent' }, { x: b, label: 'B', dashed: true }]}` (sabit dizi verin),
`onPick={(x, e) => (e.shiftKey ? setB(x) : setA(x))}` (sürüklemesiz tıklama → x). Eksen adımları 1-2-5; birim
eksenin üstünde yatay yazılır.

## Uyarı merkezi (üst çubuk)

Çekirdek 2 Hz'de `useAlerts((s) => s.alerts)` üretir: bağlantı koptu, hat kısa devre/sessiz, yük ≥ %80,
istek zaman aşımı artışı, kart kaybı (simülatörde besleyen PDH kanalının sigortasıyla, donanımda ±2 s içinde atan
sigortayla ilişkilendirilir), sigorta, kart arızası, ACİL DURDUR kilidi. Her uyarının `target`'ı ilgili ekrana götürür;
bağlantı noktası hat sağlığına göre sarı/kırmızı olur. Ekranlar yeni uyarı türü isterse ISTEKLER.md.

## Kurtarma kipi (PROTOCOL §9.0)

```ts
recovery.start();                               // etkin bus'ta 20 ms'lik kurtarma işaretini başlatır (false: bağlı değil)
const { active, waiting } = useRecovery();      // waiting: önyükleyicide bekleyen kartların uid48'leri
recovery.stop();                                // hat kopunca/bağlantı değişince kendiliğinden durur
```
Etkinken `arm()` `'recovery'` ile reddedilir, uyarı merkezinde "Kurtarma kipi etkin" görünür (Firmware ekranına götürür).
Kurtarma süresince ekran `useBusyLock(...)` tutmalı.

## Senaryo seçenekleri

`connection.connectScenario('frc.swerve4', { assigned: false })` fabrika çıkışı kartlarla başlatır (numara 63);
`connection.connect(src, { force: true })` meşgul kilidi onayını atlar.

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

**Sözleşme: her etkinleştirme NÖTRDEN başlar.** Kesmeden (elle, odak kaybı, ACİL DURDUR, kart/bağlantı kaybı…) sonra
yeniden "Etkinleştir" basılınca kart hiçbir zaman son hedefle sürülmez. Bunun için `onDisarm` içinde hedefi sıfırlayın
(ya da `armGeneration` değişince); `drive.test.ts` "re-arm starts from neutral" testi örnektir.

```tsx
const { session, armed, armGeneration, busyOwner } = useDriveSession('tuner', uid48); // mount'ta ister, unmount'ta bırakır
useEffect(() => session?.onDisarm(() => { generator.stop(); setTarget(0); }), [session]); // önce bu, sonra control.stop()
useEffect(() => setTarget(0), [armGeneration]);                                         // her arm'da nötr başla
useEffect(() => {
  if (!armed || !session?.device) return;
  const loop = session.device.control.start('velocity', target);          // yalnız armed iken komut gönderin
  return () => loop.stop();
}, [armed, session]);
return <ArmButton session={session} />;   // çerçeve + şerit kabukta (küresel DriveBanner), ekran eklemez
```

Etkin oturum varken kabuk, hangi ekranda olunursa olsun içerik alanını kırmızı çerçeveyle çevreler ve üstte
**küresel şerit** gösterir: sahibi ekran, kart, "Sürüşü durdur", ACİL DURDUR kısayolu, başka ekrandaysa "Ekrana git".
Ekranların kendi `DriveBanner`'ı artık bir şey çizmez (geri uyumluluk için dışa aktarılıyor; kaldırabilirsiniz).
Bağlantı kesme (`connection.disconnect`/kaynak değiştirme) ve sayfa kapatma (`pagehide`) armed iken önce karta nötr,
sonra ACİL DURDUR yayını gönderir ve kilidi kurar.

ACİL DURDUR kısayolları: düz **Boşluk** yazı alanı dışında her yerde (odaklı düğmede tıklama üretmez);
**Ctrl+Boşluk** ve **Esc Esc** (600 ms içinde iki kez) metin/sayı alanı dahil HER YERDE.

Kesmeler (otomatik `disarm`): pencere odağı/sekme gizlenmesi, ekran/parametre değişimi, bağlantı kopması, kart kaybı veya arızası, ACİL DURDUR. ACİL DURDUR `bus.estop()` gönderir ve kilitler; kilit üst çubuktan (“Kilidi kaldır” → `clearEstop()`) kalkana dek `arm()` reddedilir (`core.drive.block.*` mesajları). Aynı anda yalnız bir sahip: başka ekran armed iken `session === null`, `busyOwner` dolu.

## Proje bölümü eklemek

```ts
// features/tuner/project.ts (modül düzeyinde bir kez)
export const tunerRuns = defineProjectSection('tuner.runs', {
  initial: [] as TunerRun[],
  validate: isTunerRunList,          // ZORUNLU: (v: unknown) => v is T; fırlatmamalı
  version: 2,                        // isteğe bağlı, varsayılan 1
  migrate: (raw, from) => (from === 1 ? upgradeV1(raw) : undefined), // version > 1 ise ZORUNLU
});
tunerRuns.set((runs) => [...runs, run]);      // kirli işaretler, localStorage'a yazar (sürümüyle)
const runs = tunerRuns.use();                  // React kancası
```

- Okunan veri önce göç ettirilir (`sectionVersions[id]` < `version` → `migrate(raw, from)`), sonra `validate` edilir.
  Geçersiz / göç edilemeyen / daha yeni sürümlü veri **`initial` döner**, kullanıcıya bir kez uyarı toast'ı çıkar,
  ham veri bir sonraki `set`'e kadar dosyada korunur. `validate`/`migrate` fırlatırsa da ekran çökmez.
- Şema sürümleme kuralları: sürüm tamsayı ≥ 1. Kaydedilen biçim **uyumsuz** değiştiğinde (alan adı/anlamı/tipi
  değişti, alan kaldırıldı) `version`'ı 1 artırın ve `migrate`'e eski biçimi öğretin; yalnız isteğe bağlı alan
  eklemek sürüm gerektirmez (`validate` eksik alanı kabul etsin). Sürüm dosyada `project.sectionVersions[id]`
  olarak durur (yoksa 1); bölüm verisinin kendisi düz kalır.
- `guard` (eski ad) hâlâ derlenir ama `@deprecated`; `validate`'e geçin.
- Proje dosyasının kendisi: `version` tamsayı ≥ 1, `uid48` 12 hane onaltılık, araç bağlamaları (`vehicle.bindings`)
  şekil denetiminden geçer; bozuk bağlama düşürülür ve "dosyanın bir kısmı yüklenemedi" uyarısı çıkar
  (`loadProjectText` → `{ ok: true, warnings }`).

Bölüm kimliği `<ekran>.<ad>` biçiminde olsun. Bilinmeyen bölümler yüklemede korunur. Araç yapılandırması bölüm değil, `project.vehicle` alanıdır (`setVehicleConfig`). Hat anlık görüntüsü: `captureBus(bus, onProgress)`.

## Sayı ve birim biçimleme (tek yol)

`useI18n()` → `fmtNumber(v, ondalık)`, `fmtValue(v, birim, ondalık)`, `fmtPercent(v, ondalık)`; bileşen dışında
aynı adlar `core`/`i18n`'den (`fmtNumber(v, 2, { lang })`). Kurallar:

- Yüzde **yalnız** `fmtPercent`/`fmtValue(v, '%')` ile: TR `%28`, `%12,5`; EN `28%`. Elle `%${n}` / `${n}%` yazmayın.
  `fmtPercent(0.28, 0, { ratio: true })` 0–1 değer alır.
- Ondalık ayırıcı dile göre (TR virgül, EN nokta); `toFixed`/`String(n)` kullanıcıya gösterilmez.
  Gruplama varsayılan açık; kimlik/ham değer için `{ grouping: false }`. Onaltılık: `fmtHex`.
- Birim: sayı + dar boşluksuz birim `fmtValue(12.5, 'A', 1)` → `12,5 A`; `°` bitişik. Açısal hız `°/s`, süre `s`.
- Değer yoksa `NO_VALUE` (—).

## Güvenli rapor penceresi

Kullanıcı verisi (proje dosyası, kart adı, koşu adı…) içeren HTML **her zaman kaçışlı** üretilir:

```ts
import { html, openReportWindow, printReport, reportDocument } from '../../core';
const body = html`<h1>${project.name}</h1><table>${rows.map((r) => html`<tr><td>${r.name}</td></tr>`)}</table>`;
openReportWindow(body, { title: t('report.title'), lang, css: REPORT_CSS }); // yeni sekme: Blob URL + noopener
await printReport(body, { title, css });                                      // gizli sandbox iframe → yazdır
```

- `html` şablonu her `${…}` değerini kaçışlar; iç içe `html` ve dizileri olduğu gibi gömer. Tek değer için `escapeHtml(x)`.
  `rawHtml()` yalnız uygulamanın kendi sabit işaretlemesi içindir, kullanıcı verisine asla.
- Belge `REPORT_CSP` (`script-src` yok, ağ yok) taşır; pencere `noopener,noreferrer` ile açılır (`window.opener` yok),
  `printReport` iframe'i `allow-scripts` OLMADAN sandbox'lanır. Rapora betik/yazdır düğmesi koymayın: yazdırma tarayıcıdan
  (Ctrl+P) ya da `printReport` ile. `window.open('')` + `document.write` KULLANMAYIN.

## Meşgul kilidi (uzun işlem sürerken ekran değişimi / bağlantı kesme onayı)

```ts
useBusyLock(flashing ? 'firmware.busy.flashing' : null, { count });   // bileşen yaşadıkça
const release = acquireBusyLock('project.busy.capture'); try { … } finally { release(); }
```

Kilit varken: ekran değişimi (kenar çubuğu, kısayol, geri/ileri), bağlantı kesme/kaynak değiştirme (`connection.connect/disconnect`)
ve sayfa kapatma/yenileme kullanıcıya onaylatılır; durum çubuğunda kilidin metni (`reasonKey` global sözlük anahtarı,
`params` ile) sarı öğe olarak görünür. `confirmLeave('navigate'|'disconnect')` → `Promise<boolean>` kendi akışınız için.
Zorla: `connection.disconnect({ force: true })`.

## Durum çubuğu öğesi

```tsx
useStatusItem('scope.recording', recording ? { text: t('scope.rec', { n }), tone: 'danger', onClick: () => navigate('scope') } : null);
```
`id` uygulama genelinde tekil (`<ekran>.<ne>`); `tone`: `neutral|info|warn|danger`. Bileşen kalkınca öğe kalkar.

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
