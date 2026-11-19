# İnceleme: masaüstü/tarayıcı uygulaması — emniyet, çekirdek, kabuk (`uygulama`)

Kapsam: `apps/studio/src/{core,app}`, `src-tauri/**`, `.github/workflows/**`, eyleyici süren ekranlar (tuner, device, vehicle, canmon, firmware) emniyet/yaşam döngüsü açısından.
Yöntem: kod okuma + Playwright (vite :5211, simülatör) + `tsx` betikleri + `cargo test/clippy` + `/tmp` klonunda `npm ci`. Betikler: `/tmp/review-uygulama/{pw,scripts,rs}`.

---

## Bulgular

### 1. **[Kritik]** Tuner'da "Durdur" açık döngü testini durdurur ama motoru açık döngü görev oranında bırakır
· `apps/studio/src/features/tuner/controller.tsx:379`, `engine.ts:307-321`
`stopTest` → `driver.abort('stopped')`. `abort` yalnız `reason !== 'stopped'` iken açık döngü komutunu keser/geri alır; `'stopped'` dalında döngü son açık döngü değerini 200 Hz'de göndermeye devam eder ve ekran armed kalır. Kullanıcının "Durdur"u motoru süresiz sürer.
**Kanıt (Playwright, `pw/tunerstop.mjs`):** bench.flywheel, Tuner › Yardımcı › Sistem tanıma "Çalıştır", 1,5 s sonra ilerleme çubuğundaki "Durdur": +1 s `duty 0.2, 936 rpm`, +2 s `993`, +3 s `1018`, +4 s `1031 rpm`, oturum `armed:true`. (ff/röle testleri de açık döngü.)
**Düzeltme:** `abort('stopped')` da açık döngüyü bitirsin: `loopMode==='open'` ise `loop.stop()`; kapalı döngüde `holdTarget`e dönsün. Ya da `stopTest` = `abort` + `session.disarm('released')`. Bunu kapsayan `engine.test.ts` testi ekleyin.

### 2. **[Kritik]** Yeniden etkinleştirme son hedefi kendiliğinden geri yükler (Cihaz › Kontrol, 16 kanal servo)
· `features/device/tabs/ControlTab.tsx:37-46` (`control.start(mode.key, targetRef.current)`), `Servo16Control.tsx:42-48`
Otomatik kesme (odak kaybı, ACİL DURDUR, kart hatası…) hedef durumunu sıfırlamıyor; tekrar "Etkinleştir" basılı tutulunca kart hemen eski hedefle sürülür. Servo kartında kanallar "açık" ve son µs değerinde kalır (ESC'de son gaz).
**Kanıt (`pw/rearm.mjs`):** hedef 3000 → armed (1262 rpm) → `blur` kesmesi (rpm 36, alan hâlâ "3000") → yalnız Etkinleştir: 250 ms aralıkla `797, 1003, 1135, 1228, 1284, 1298 rpm`. Servo16 yolu kod okumasıyla.
**Düzeltme:** `session.onStop` içinde `setTarget(0)` / pozisyon kipinde ölçülen konum; servo kartında tüm kanalları `on:false` yapın. Tuner'ın yaptığı gibi (armed → güvenli hedef) tüm ekranlarda "arm = nötr başla" kuralı; `drive.test.ts`'ye sözleşme testi.

### 3. **[Önemli]** CAN İzleyici gönderim paneli CTRL'i sürüş oturumu dışında, süresiz periyodik gönderir; veri alanındayken Boşluk ACİL DURDUR değildir
· `features/canmon/SendPanel.tsx:106-120`, `app/estop.ts:37-46`
Gelişmiş kipte CTRL çerçevesi tek onayla 10 ms'ye kadar periyodik gider: arm/basılı tutma yok, kart arızası/kaybı kesmesi yok, başka ekranın oturumu bilinmiyor (AGENTS.md "kendi başına CTRL gönderen kod yazma" kuralına aykırı). Kesen tek şeyler: blur/visibility/bus/ESTOP kilidi/unmount. Ayrıca ID/Veri alanları `TextField` (type=text) olduğundan odak oradayken Boşluk ESTOP yerine boşluk yazar.
**Kanıt (`pw/canmon.mjs`):** `02084001 # 01 00 00 00 9a 99 99 3e` (duty 0.3) 50 ms periyot → drive session `null`, motor 1362 rpm; veri alanında Boşluk → ESTOP sayacı 0, rpm 1550, alan `"…3 e"`.
**Düzeltme:** CTRL sınıfı (ve CTRL içeren yayın) için `useDriveSession('canmon', hedefUid)` + `ArmButton` zorunlu; periyodik gönderimi `session.onStop`'a bağlayın; kart `fault/offline` olunca durdurun. Periyodik çalışırken onaltılık alanlara `data-numeric` (ya da Boşluk'u alan içinde de ESTOP yapan özel işaret) verin.

### 4. **[Önemli]** Kullanıcı bağlantıyı kesince/kaynağı değiştirince armed karta nötr komut gönderilmiyor
· `core/connection/manager.ts:209-229`, `core/safety/drive.ts:181-188`, `core/safety/index.ts:281-284`
`teardown` önce `setBus(null)` → `cut('disconnected')`; `stopSession` `disconnected` için `control.stop()`'u atlıyor, sonra `bus.stop()` → `dispose` → `halt()` (nötr yok). Sağlam bir bağlantıda "Bağlantıyı kes" sonrası eyleyici `ctrl.timeout_ms` (200 ms, 2000'e kadar ayarlanabilir) boyunca son komutta kalır. Sayfa yenileme/kapama için de `pagehide`/`beforeunload` işleyicisi yok.
**Kanıt (`pw/safety2.mjs` adım 5):** armed 2000 hedefte (843 rpm) `connection.disconnect()` sırasında transport'a giden çerçeveler: `[]` (ne nötr CTRL ne ESTOP).
**Düzeltme:** `teardown` başında, bus hâlâ açıkken `drive.cut('released')` (nötr gönderen yol) ya da `stopSession`'da yalnız `phase==='lost'` iken nötrü atlayın. `pagehide`'da `connection.current?.devices.forEach(d=>d.control.stop())` (en azından aktif oturum) çağırın.

### 5. **[Önemli]** Tuner raporunda betik enjeksiyonu (proje dosyasından), uygulama kökeninde çalışıyor
· `features/tuner/report.ts:85` ve `:93` (`${x.gainSet}` kaçışsız), `types.ts:92-111` (`isRun` gainSet'i doğrulamıyor), `HeaderActions.tsx:63-72` (`window.open('')` + `document.write`)
Kötü niyetli `.cygnus.json` içinde `sections.tuner.runs[].gainSet = "<img src=x onerror=…>"` → "Rapor › Aç ve yazdır" açılan aynı kökenli pencerede betik çalışır, `window.opener` ile uygulamaya tam erişir. Tauri'de `csp: null` ve `link_*` komutlarının her pencereye açık olması etkiyi seri port/TCP'ye kadar büyütür (Tauri'de çalıştırılmadı).
**Kanıt (`pw/xss.mjs`):** zehirli proje yüklendi → popup içeriğinde ham `<img src="x" onerror…>` 1 adet, ana pencerede `window.__xss = 1`. Kart adı `<img …>` iken: Proje raporu (React `renderToStaticMarkup`) 3 yerde doğru kaçışlı, Tuner raporunda `deviceName` kaçışlı — sorun yalnız `gainSet`.
**Düzeltme:** `esc(x.gainSet)`; `isRun`'a `gainSet === null || gainSet === 'A' || 'B'` denetimi; raporu `about:blank` yerine `Blob` URL + `noopener` ya da sandbox'lı iframe ile açın; rapor HTML'ine `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">` (yazdır düğmesini CSS/`@media print` ile çözün).

### 6. **[Önemli]** Tauri seri port: yeniden bağlanma ve webview yenilemesi "exclusive lock" hatasıyla kilitleniyor
· `src-tauri/crates/cygnus-link/src/manager.rs:291-298`, `serial.rs:370-381`, `src/lib.rs:32-35`
`close()` bağlantıyı haritadan çıkarır ama port nesnesi okuyucu iş parçacığında ≤20 ms daha yaşar; hemen ardından gelen `open_serial` (yöneticinin `reconnect()` akışı tam bunu yapar) başarısız olur. Webview yenilenince (Ctrl+R, HMR, hata sonrası yenileme) eski link kapanmaz (veri kanalı hatası `let _ =` ile yutuluyor) ve port uygulama kapanana dek kilitli kalır.
**Kanıt (`rs/` + pty):** `first open: Ok` · `second open while first still registered: Err("Unable to acquire exclusive lock on serial port")` · `reopen right after close: Err(… exclusive lock …) (2.9µs)`.
**Düzeltme:** `close()` okuyucu iş parçacığını `join` etsin (ya da kapanış bir kanal ile onaylansın) ve portu açıkça düşürsün; `on_data.send` hata verince linki kapatın; `open_serial` aynı yol zaten açıksa eskisini kapatıp yeniden açsın; JS `connect()` öncesi `link_close` sonucunu bekleyip kısa geri çekilmeyle yeniden denesin.

### 7. **[Önemli]** `paramCache`: yeniden başlatmadan sonra izlenen tüm parametreler kalıcı olarak hatada kalıyor
· `core/store/paramCache.ts:112-117`, `:124`
`paramsInvalidated` anında, kart BOOT'tayken her izlenen anahtar için `getParam` atılıyor (bilinen fırtına); hepsi zaman aşımına düşüyor ve `e.snap.error` dolu kaldığı için `ensureLoaded` bir daha denemiyor; aynı handle kaldığından `deviceAvailable` da yeniden bağlamıyor.
**Kanıt (`scripts/paramcache.ts`):** ESC, 25 izlenen anahtar: önce 25 değer; `reboot()` + 8 s → `values 0, errors 25` ("GET motor.pole_pairs: no answer"); +20 s sonra hâlâ `0/25`.
**Düzeltme:** `paramsInvalidated`'da okumayı kart `state` BOOT dışına çıkana (ilk `deviceChanged`/HEARTBEAT `APP`) erteleyin; okumaları sıralayın (tek `readAllParams`); `deviceChanged`'da hatalı girdileri temizleyip yeniden deneyin.

### 8. **[Önemli]** Bozuk `vehicle.bindings` içeren proje Araç ekranını kalıcı olarak çökertiyor
· `core/project/schema.ts:99-103` (bindings doğrulanmıyor), `packages/vehicles/src/validate.ts:41,61`
`parseVehicle` yalnız `isObj(bindings)` bakıyor. Proje localStorage'a da yazıldığı için yeniden açılışta da çöküyor.
**Kanıt (`pw/vehbad.mjs`):** swerve4 yuvalarına `null` → "Cannot read properties of null (reading 'kind')"; `"x"` → `…reading 'toLowerCase'`; `{uid48:123}` → `uid.toLowerCase is not a function`; üçünde de ekran "Bu ekran yüklenirken bir hata oluştu".
**Düzeltme:** `parseVehicle`'da her bağlamayı `SlotBinding` şekline göre süzün (`kind` ∈ {device, channel, external}, `uid48` 12 hane hex, `channel` tamsayı); geçersizleri düşürüp uyarı döndürün.

### 9. **[Önemli]** Araç motor testi: `await setParam` sonrası oturum yeniden denetlenmeden sürme başlıyor (doğrulanmadı — kod okuması)
· `features/vehicle/MotorTest.tsx:85-103`
Servo kanalı kapalıysa `await d.setParam('ch.N.enable',1)` beklenir; bu sırada odak kaybı/gezinme/ESTOP kesmesi olursa `stopRef` henüz atanmadığı için iptal edilecek bir şey yok; `await` dönünce `control.send(…,{repeat:true})` disarm edilmiş oturumla 1 s sürer (unmount olduysa da `finish` zamanlayıcısı ile 1 s sonra durur). ESTOP'ta kart kilitli olduğundan etki yok; blur/gezinmede var.
**Düzeltme:** `await` sonrası `if (!session.armed) return finish();`; `stopRef.current = finish` atamasını `await`'ten önceye alın.

### 10. **[Önemli]** Tauri: `csp: null`, izinler en küçük değil, komut girdileri doğrulanmıyor
· `src-tauri/tauri.conf.json:"csp": null`, `capabilities/default.json` (`core:default`), `src/lib.rs:46-94`
CSP yok (bulgu 5 gibi bir enjeksiyon doğrudan IPC'ye ulaşır). `core:default` uygulamanın kullanmadığı window/webview/menu/tray/path vb. varsayılanlarını açar; uygulama yalnız `event` dinleme + kendi komutlarını kullanıyor. Uygulama komutları (`link_open_tcp` vb.) her pencere/kökenden çağrılabilir; `host`/`port` serbest (keyfi ağ hedefine ham bayt), `baud` 0 dahil her u32, `timeout_ms` sınırsız.
**Düzeltme:** `"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src ipc: http://ipc.localhost"`; izinleri `core:event:default` (+gereken en az) ile sınırlayın; `build.rs`'te `AppManifest::commands` + capability ile `link_*`'ı `main` penceresine kısıtlayın; baud için izinli liste, `timeout_ms` 100–10000 kıskacı, host için boş/uzun ad reddi.

### 11. **[Önemli]** `link_write` eşzamansız komut: yazma sırası garanti değil (doğrulanmadı)
· `src/lib.rs:77-89`, `core/transports/tauri.ts:103-105`
Her çerçeve ayrı `invoke('link_write')`; JS önceki yazmayı beklemiyor, Tauri `async` komutları çok iş parçacıklı çalışma zamanında ayrı görevler olarak yürütülür. slcan kurulum komutları (`C`,`S…`,`Y…`,`O`) ya da `stop()`'un nötr çerçevesi ile son SET çerçevesi yer değiştirebilir (nötr → SET sırası motoru `ctrl.timeout_ms` boyunca sürer). WebSerial yolu sıralı (`writer.write` kuyruğu).
**Düzeltme:** JS tarafında yazmaları tek bir promise zincirinde sıralayın (ya da toplu tampon); Rust'ta `link_write`'ı senkron komut yapın veya link başına tek yazıcı iş parçacığı + kanal kullanın.

### 12. **[Küçük]** TCP (roboRIO) linkinde okuma zaman aşımı/keepalive yok
· `crates/cygnus-link/src/tcp.rs:22-36`
Yarı açık bağlantı (kablo/güç kesilmesi, FIN yok) okuyucuyu sonsuza dek bloklar; `link://closed` gelmez, arayüz "Bağlı" kalır (kartlar heartbeat kaybıyla çevrimdışı düşer, bu yüzden sürme yine kesilir).
**Düzeltme:** `set_read_timeout(20ms)` (seri ile aynı desen) + `SO_KEEPALIVE`; köprüden düzenli canlılık çerçevesi bekleyip yoksa linki kayıp sayın.

### 13. **[Küçük]** CI Tauri kabuğunu hiç derlemiyor; clippy `-D warnings` test dosyasında düşüyor
· `.github/workflows/ci.yml:32-36`, `crates/cygnus-link/tests/link.rs:43`
CI yalnız `cargo test -p cygnus-link` çalıştırıyor; `src/lib.rs` ilk kez sürüm iş akışında derleniyor. `cargo clippy -p cygnus-link --all-targets -- -D warnings` → `type_complexity` hatası (kabuk crate'i için clippy temiz). Sürüm iş akışı test/typecheck ile kapılanmıyor.
Doğrulanan iyi taraf: `/tmp` klonunda `npm ci` (197 paket, 6 s), `npm run typecheck` temiz, `vitest` 71 dosya/784 test geçti; `apps/studio` içinden `npm run build -w @cygnus/studio` (Tauri `beforeBuildCommand`) çalışıyor; kilit dosyasında tüm platform ikilileri (tauri-cli, rollup, esbuild) var; `cargo test` 8/8.
**Düzeltme:** CI'a `libwebkit2gtk-4.1-dev` ile `cargo clippy --workspace --all-targets -- -D warnings` ekleyin; test için `type FakeEndpoint = …` takma adı; release'de `needs: test` ya da önce `npm test`.

### 14. **[Küçük]** Kayıt dışa aktarma ana iş parçacığını uzun süre bloklar (ACİL DURDUR düğmesi o sırada tepkisiz)
· `core/recorder/session.ts:105-143`
Üst sınır 5 M örnekte `toCSV` 1,18 s / 110 MB, `toJSON` 1,62 s / 186 MB (Node ölçümü, `scripts/rec.ts`; tarayıcıda benzer). Bu sürede klavye/düğme ESTOP işlenmez ve host kontrol döngüsü durur (kart zaman aşımına güvenilir). Sütun başlıkları kart adından geldiği için `=…` ile başlayan ad CSV formül enjeksiyonu yapar.
**Düzeltme:** Dışa aktarmayı parçalara bölüp (`await` aralı) ya da Worker'da üretin; armed iken dışa aktarmayı engelleyin; `=,+,-,@` ile başlayan hücrelere `'` ön eki.

### 15. **[Küçük]** CAN İzleyici akış görünümü 25 kartta ara ara takılıyor
· `features/canmon` (akış listesi)
**Kanıt (`pw/perf.mjs`, swerve4 + 11 eklenen kart = 25 çevrimiçi, ~4,4 k çerçeve/s, 10 s):** CAN İzleyici akış: 52 fps, p95 33 ms, p99 50 ms, 2 kare >100 ms, 4 uzun görev (en çok 81 ms). Grafik yüksek hız (önerilen sinyaller): 54 fps, 3 uzun görev (en çok 59 ms). Hat, Araç, Cihaz, Tuner (1 kHz akış), Grafik normal, CAN İzleyici "Kimliğe göre": 60 fps, uzun görev yok.
**Düzeltme:** Akış listesinde render'ı rAF başına tek sürüme sınırlayın, çözümleme (`describe`) sonucunu kimlik+veri için önbellekleyin.

### 16. **[Küçük]** Proje şeması sürümlemesi gevşek
· `core/project/schema.ts:116-117, 82-97`
`version` 0,5 veya −1e308 kabul ediliyor (göç yok, sessizce v1 sayılıyor); `uid48` biçimi doğrulanmıyor (`"A"` → `"a"`). Prototip kirliliği denendi: oluşmuyor (`__proto__` anahtarları güvenli). `validateCyfw` 20 000 rastgele girdide hiç fırlatmadı.
**Düzeltme:** `Number.isInteger(version) && version >= 1`; `uid48` için `/^[0-9a-f]{12}$/`.

### 17. **[Küçük]** Tauri komutları async çalışma zamanında bloklayan G/Ç yapıyor
· `src/lib.rs:46-75`
`link_open_tcp` (3 s'ye kadar `connect_timeout`) ve seri açma `async fn` içinde doğrudan çağrılıyor; Tokio işçi iş parçacığını bloklar (eşzamanlı `link_write`'ları geciktirebilir).
**Düzeltme:** `tauri::async_runtime::spawn_blocking` ya da bu komutları senkron (`fn`) yapın.

---

## İyi olanlar

- Odaklı düğmede Boşluk: yalnız ESTOP tetikleniyor, tıklama oluşmuyor (yakalama aşaması + keyup `preventDefault` çalışıyor; `pw/safety2.mjs` 1–2). ArmButton Boşluk ile kurulamıyor.
- Başka bir host'un ESTOP yayını → kart ESTOP → oturum `deviceFault` ile kesiliyor, kart kilitliyken yeniden kurma reddediliyor; ESTOP kilidi açıkken hiçbir ekran arm edemiyor.
- Kart bekçisi simülatörde doğru: host tamamen donunca görev oranı ~200–250 ms'de 0'a iniyor ve `CTRL_TIMEOUT` uyarısı (bit 4) yükseliyor (`scripts/watchdog.ts`).
- 20 bağlantı değiştir/kes döngüsünde eski `CygnusBus` nesneleri çöp toplanıyor (21'den 1'i canlı), window/document dinleyici ve interval sayıları sabit.
- Proje raporu React ile üretildiği için kart/proje adındaki HTML doğru kaçışlanıyor.

## Bakmadıklarım / doğrulayamadıklarım

- Tauri uygulamasını gerçekten çalıştırmadım (yalnız `cargo clippy`/test ve crate düzeyinde pty denemesi); IPC sıralaması (11), CSP'siz popup davranışı Tauri'de doğrulanmadı.
- Gerçek WebSerial donanımında kopma/yeniden bağlanma; macOS/Windows sürüm derlemesi.
- Gerçek arka plan sekme kısılması: headless Chrome'da `visibilityState` değişmedi; simülatör aynı iş parçacığında koştuğu için donma testi `ManualScheduler` ile ayrı yapıldı. `hidden` kesmesi yalnız kodla incelendi.
- Firmware ekranının güncelleme sırasında sürme etkileşimi, `signalHub` iç ayrıntıları, görsel tasarım.
