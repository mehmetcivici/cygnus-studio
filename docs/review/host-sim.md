# host-sim incelemesi — host istemcisi, eski sürücü, aktarımlar, simülatör fiziği, araç paketi

İnceleyen: `host-sim`. Depoda hiçbir dosya değiştirilmedi; tüm denemeler `/tmp/review-host-sim/*.ts` (`npx tsx` ile, depo modüllerini import ederek). Her bulgunun yanında yeniden üretim betiği var.

Özet: 1 Kritik · 8 Önemli · 8 Küçük.

---

## 1. [Kritik] Kontrol döngüsü kartın ESKİ numarasına göndermeyi sürdürüyor: numara değişince başka bir motor sürülüyor
`packages/protocol/src/host/cycan/control.ts:53,63,101` · `packages/protocol/src/host/cycan/device.ts:204-216`

Döngü çerçevesi `start()`/`update()` anında `dev.address` ile kodlanıp `session`'da saklanıyor; `tick` hep bu hazır çerçeveyi yolluyor. Bir döngü çalışırken kartın numarası değişirse (ASSIGN_ID, `resolveAll`, araç sihirbazındaki `applyPlan`) döngü eski adrese göndermeyi sürdürüyor. `applyEnum` numara değişiminde döngüyü yalnız `conflict || unassigned` olduğunda durduruyor. Eski numarayı başka bir kart almışsa (takas) kullanıcının hiç seçmediği motor dönüyor. `loop.stop()` nötrü ise kartın YENİ adresine gidiyor, yani yanlış sürülen kart nötr almıyor ve `ctrl.timeout_ms` dolana kadar dönmeyi sürdürüyor.

**Yeniden üretim** (`/tmp/review-host-sim/h1.ts`): A=#1, B=#2 iki ESC. A'da `control.start('duty',0.3)` çalışırken `assignId(A,3)` ve ardından `assignId(B,1)` yapılıyor. Sonuç: `A 0 rpm, B 1439 rpm`; `loop.active === true`. `loop.stop()` sonrasında B hâlâ 631 rpm'de (serbest dönüşte yavaşlıyor).

**Düzeltme:** Oturumda kodlanmış çerçeve değil alanlar (`def`, `fields`) saklanmalı ve her `tick`'te o anki adresle kodlanmalı. Bunun yanında `applyEnum`'da `devType`/`num` değişince döngü durdurulmalı: eski adrese nötr gönderilmeli, sonra `halt()` çağrılmalı. Ek olarak `assignId` etkin bir döngü (`control.active`) ya da `flags.enabled` varken `BUSY`/`DENIED` ile reddetmeli; `applyPlan` başlamadan önce tüm döngüleri durdurmalı.

## 2. [Önemli] Yeniden gönderimden gelen geç yanıt, aynı anahtardaki SONRAKİ isteğe bağlanıyor (SET yanlış değerle "başarılı" dönüyor, önbellek kartla çelişiyor)
`packages/protocol/src/host/requests.ts:69-88,129-143` · `packages/protocol/src/host/cycan/device.ts:481-503`

`RequestTracker` aynı `key`'e (`p:<pid>`) giden istekleri sıraya koyuyor, ama bir istek bitince onun yeniden gönderimlerine gelecek fazladan yanıtları süzmüyor. Kuyruktaki sıradaki istek bu yanıtı kendi yanıtı sanıyor. SET'in `accept` işlevi dönen değeri istenen değerle karşılaştırmıyor.

**Yeniden üretim** (`h2.ts`, ilk PARAM_RSP'yi 130 ms, sonrakileri 20 ms geciktiren sarmalayıcı aktarım): art arda `setParam('vel.kp',0.001)` ve `setParam('vel.kp',0.002)`. Sonuç: `SET B resolved 0.001`, `host cache 0.001`, kartın gerçek değeri `0.002`. USB-CAN gecikmesi ya da meşgul bir kart bunu gerçek donanımda tetikler. Tuner'da hızlı kazanç kaydırma tam bu deseni üretir.

**Düzeltme:** (a) Durumu OK olan SET yanıtı yalnız `value === f32(istenen)` ise kabul edilmeli, değilse `null` döndürülmeli. (b) Anahtar başına "yanıtı gelmemiş iletim" sayacı tutulmalı: bir istek bittiğinde kalan iletim sayısı kadar sonraki yanıt, kısa bir pencere içinde (~yanıt zaman aşımı kadar) yutulmalı. GET için (b) yeterli.

## 3. [Önemli] `state = BOOT` heartbeat'i işlenmiyor: kısa kesintide önbellek bayat kalıyor, akış sessizce ölüyor
`packages/protocol/src/host/cycan/device.ts:226-262` (yalnız BOOTLOADER→uygulama geçişinde `invalidateInfo`), `stream.ts:331` (`deviceBack` yalnız kayıptan dönüşte çağrılıyor)

PROTOCOL §4.1'e göre host, BOOT heartbeat'ini görünce önbelleğini geçersiz saymalı. Kod bunu yapmıyor. 1,5 s'den kısa bir güç kesintisi (sigorta, gevşek konnektör, brown-out) "kayıp" olarak algılanmıyor.

**Yeniden üretim** (`h3.ts`): `setParam('vel.kp',0.003)` yapılıyor, akış açılıyor, ESC'nin gücü 300 ms kesilip geri veriliyor. Sonuç: `paramsInvalidated` olayı yok; önbellekte `0.003`, kartta `0.002`. Sonraki 3 s'de akış örneği 0, `sub.lost` 0.

**Düzeltme:** `applyHeartbeat`'te `hb.state === BOOT && prevState !== BOOT` olduğunda (ya da `fw`/uid16 aynı kalıp BOOT görülünce) `invalidateInfo()` + `stream.deviceBack()` çağrılmalı. Çalışan bir kontrol döngüsü varsa `halt()` edilip kullanıcıya bildirilmeli: brown-out sonrası motorun kendiliğinden yeniden kalkması istenmez.

## 4. [Önemli] Akış tüketicisi kapanınca STOP→CONFIG→START, CAN önceliğiyle yeniden sıralanıyor: kalan tüketicinin akışı ~1 s duruyor, araya yanlış eşlenmiş örnekler giriyor
`packages/protocol/src/host/cycan/stream.ts:320-327`

`remove()` aynı anda STOP (INDEX 2), CONFIG (INDEX 0) ve START (INDEX 1) gönderiyor. Kimliği küçük olan önce iletildiği için hatta STOP en son gidiyor. Bu davranış simülatörde ve öncelik sıralı TX posta kutusu olan gerçek denetleyicilerde aynı. Kart sonunda durmuş kalıyor ve bir sonraki canlı tutma START'ına kadar (en çok 1 s) veri yok. Üstelik host `resetAssembly()`'yi hemen yaptığı için yoldaki eski yerleşimli çerçeveler yeni eşlemeyle çözülüyor.

**Yeniden üretim** (`h4.ts`, `h5.ts`): `['velocity','setpoint']` ve `['phase.current']` açılıyor, ilki kapatılıyor. İkinci tüketicide `phase.current` iki örnek boyunca `1292.0 1298.4` oluyor (aslında hız değeri). Ardından **701 ms boşluk** var. FD ve klasik kipte aynı sonuç.

**Düzeltme:** Yeniden paketlemede STOP gönderilmemeli (CONFIG çalışırken de kabul ediliyor), ya da STOP gönderilip CONFIG/START bir sonraki zamanlayıcı turuna ertelenmeli. Ertelemede iki tur arasında gelen DATA atılmalı. FD'de yük uzunluğundan çıkan `k`, yapılandırılan sayıdan büyük-eşit ve dolgu kuralına uymuyorsa çerçeve atılmalı. Uzun vadede protokole bir "yerleşim kuşağı" (ör. START'ta `seq`'i sıfırlama) eklenmesi değerlendirilmeli; bunu Protokol sorusu olarak öneriyorum.

## 5. [Önemli] `seq` boşluğu ≥128 olunca kayıp hiç sayılmıyor ve sonraki ~(256−boşluk) iyi örnek de atılıyor
`packages/protocol/src/host/cycan/stream.ts:357-363`

"Büyük boşluk = geç ya da çift çerçeve" varsayımıyla `return` ediliyor, ama `curSeq` güncellenmiyor. Bu yüzden gerçek bir uzun kesintiden sonra `seq` eski `curSeq`'in 127 yakınına dönene kadar her çerçeve atılıyor.

**Yeniden üretim** (`h7.ts`, 1 kHz akışta kart kablosu çekiliyor):

| Kesinti | `lost` | Atılan iyi örnek |
|---|---|---|
| 100 ms | 100 | yok (doğru) |
| 200 ms | **0** | 56 |
| 400 ms | **0** | 112 |

Hat yükü yüksekken Tuner grafiği bu yüzden sessizce delikli çıkar.

**Düzeltme:** Geç/çift çerçeveyi ayırt etmek için `t_100us` kullanılmalı. Zaman ileri gidiyorsa çerçeve yeni örnek sayılmalı ve `lost += round(Δt/period) − 1` eklenmeli. Zaman geri gidiyor ya da eşitse çerçeve atılmalı. Her durumda `curSeq` güncellenmeli.

## 6. [Önemli] Simülatör hattı: kuyruk dolunca host'un çerçeveleri, ESTOP dahil, öncelikten bağımsız düşürülüyor; host ESTOP'u bir kez gönderiyor
`packages/simulator/src/bus.ts:122-129` · `packages/simulator/src/transport.ts:39-44` (dönüş değeri yok sayılıyor) · `packages/protocol/src/host/bus.ts:272-275`

`SimBus` tüm uç noktalar için tek, 1024 çerçevelik ortak bir kuyruk kullanıyor. Doluyken `transmit` en yüksek öncelikli kimliği bile reddediyor. Gerçek CAN'de her düğümün kendi TX tamponu var ve ESTOP (DEVTYPE 0) tahkimi kazanırdı. Bu yüzden simülatör acil durdurmayı gerçekte olmayacak biçimde kaybediyor ve bu yolun testlerini yanıltıyor.

**Yeniden üretim** (`s6.ts`, 18 ESC + 5 encoder + gyro + PDH, 18 duty döngüsü, 2 ESC'de 1 kHz × 6 sinyal akış): `bus.estop()` çağrısından sonra `host drops 1`, ESTOP'ta kilitlenen ESC sayısı 0, 20 ms sonra hâlâ 2 ESC sürülüyor. Bu ESC'ler ancak `ctrl.timeout_ms` ile duruyor. Taban yükü: yalnız 18 ESC iken hat %47 dolu (`s7.ts`).

**Düzeltme:** Simülatörde kuyruk uç nokta başına olmalı (taşma o düğümün kendi sorunu olsun) ya da taşmada kuyruktaki en düşük öncelikli çerçeve atılmalı. Host tarafında `estop()` ESTOP'u kısa aralıkla 3 kez yollamalı (ör. 0/10/30 ms). Bu idempotent, protokolü bozmaz.

## 7. [Önemli] Simülatör güç hesabı: düğümsüz PDH kanalındaki PWM ESC yükü hiç sıfırlanmıyor; batarya birkaç saniyede çöküyor
`packages/simulator/src/simulation.ts:163-180`

`powerStep` yalnız bir `SimNode`'un bağlı olduğu besleme noktalarının `load` değerini sıfırlıyor. `PwmEsc.feed` bir PDH kanalıysa ve o kanala hiç kart bağlı değilse yük her ms `+supplyCurrent` kadar birikiyor.

**Yeniden üretim** (`s2.ts`, `s3.ts`; `createScenario(id,{useServoChannels:true})`): boşta duran PWM ESC'lerle 2,1 s sonra kanallarda 41,98 A (rov6'da 6 kanal). Batarya 5 s'de 3,78 V, 10 s'de 0 V'a iniyor ve tüm kartlar kapanıyor. quadx/hexax/octox/plane/rov6/rov8/usv2 senaryolarında aynı. Not: uygulama bu seçeneği şu an kullanmıyor, ama `scenarios.test.ts:112` kullanıyor; test kısa sürdüğü için hatayı görmüyor.

**Düzeltme:** Adımın başında tüm `PowerFeed`'ler sıfırlanmalı: dağıtıcıların `channels`/`output` beslemeleri ve `pwmEscs[i].feed` dahil. Daha temiz çözüm, `World`'ün tüm beslemelerin listesini tutması.

## 8. [Önemli] `RealtimeRunner`: sekme arka plana düşünce her kart sürekli "kayıp/çevrimiçi" arasında gidip geliyor ve tüm parametre önbellekleri siliniyor
`packages/simulator/src/runner.ts:57-69`

Tarayıcı arka plandaki zamanlayıcıları ~1 Hz'e kısıyor. Runner her turda en çok 100 ms simüle ediyor, yani simülasyon gerçek zamanın %10'u hızında ilerliyor. Host ise 1500 ms'lik "kayıp" zamanlayıcısını duvar saatiyle işletiyor.

**Yeniden üretim** (`r1.ts`, `all.devices`, 1 s'lik tur): 10 s arka planda simülasyon 1000 ms ilerliyor, `droppedMs` 9000, **99 `deviceLost` olayı** (11 kart). Ön plana dönünce 11 `paramsInvalidated` ve önbellekteki 348 parametrenin hepsi siliniyor. Bu, kayıttan geri dönen kartlarda yeniden INFO okuma ve akışın yeniden kurulması fırtınası demek.

**Düzeltme:** `visibilitychange` olayında runner ile host'un kayıp denetimi birlikte duraklatılmalı (ör. `CygnusBus.suspendSupervision()`), ya da simülasyon bir Worker'da koşturulmalı. Daha kaba seçenek: `maxCatchUpMs` arka planda `LOST_AFTER_MS`'in üstüne (ör. 2000 ms) çıkarılmalı. 25 kartta 1 s simülasyon ~50 ms tuttuğu için bu bütçe karşılanabilir.

## 9. [Küçük] `updateAllFirmware`: DISCONNECTED ile kesilince kuyrukta kalan kartlar sonuçta hiç görünmüyor
`packages/protocol/src/host/bus.ts:321`

`break` sonrası kalan `queue` öğeleri `out`'a eklenmiyor. Arayüz "bu kartlar ne oldu" sorusunu yanıtlayamıyor. Kod okumayla doğrulandı.

**Düzeltme:** Döngüden sonra kalan öğeler `{ ok:false, error: DISCONNECTED }` (ya da `skipped:'aborted'`) ile eklenmeli.

## 10. [Küçük] `planApply`: numara kalmayan kart için yine de `rename`/`setParam` adımları üretiliyor
`packages/vehicles/src/plan.ts:112` (`continue` kartı `cards`'tan çıkarmıyor)

`v1.ts`: 1..62 dolu, planlanan ESC #63'te. Uyarı `numExhausted`, ama adımlar `rename`, `setParam motor.idle_mode`. `applyPlan` bu adımda `UNRESOLVED` ile duruyor ve sonraki her şey atlanıyor.

**Düzeltme:** `numExhausted` durumunda kart `cards`'tan silinmeli ya da sonraki döngülerde `finalNum.has(uid)` koşulu aranmalı.

## 11. [Küçük] `planDevices` çevrimdışı ve katalogda olmayan kartları atıyor; numaraları ayrılmıyor
`packages/vehicles/src/apply.ts:42`, `plan.ts:95`

`!d.online || !d.def` olan kartlar planlayıcıya hiç verilmiyor. Plan, kayıp ya da bilinmeyen modelli bir kartın numarasını başka karta verebiliyor. `orderAssignments` engeli "plan dışı" görüp numarayı "planlandığı gibi" atıyor. Kart geri gelince ikisi de CONFLICT'e geçip susuyor. Oysa `CyCanDriver.suggestNumber` kayıp kartların numarasını ayırıyor; iki yol tutarsız. Kod okumayla doğrulandı.

**Düzeltme:** Plan dışı numara kümesi için `bus.devices`'ın tamamı (kayıp ve modeli bilinmeyenler dahil) kullanılmalı.

## 12. [Küçük] `detectMovedEncoder` hareket hâlindeki encoder'da hemen yanlış pozitif veriyor
`packages/vehicles/src/detect.ts:93-108`

Taban değer, çağrı anındaki konum. Motorla dönen (volan, tekerlek) ya da yerçekimiyle düşen (kol) bir milin encoder'ı birkaç ms içinde 0,1 tur eşiğini geçip "elle döndürülen kart" seçiliyor. Gürültü tarafı sorunsuz: Cyncoder gürültüsü ~0,7 LSB, yani 1,7e-4 tur; gyro ~0,02°. Kod okuma ve simülatör gürültü modeliyle doğrulandı.

**Düzeltme:** İlk ~300 ms'de |velocity| eşiğin üstünde olan ya da tabanı oynayan adaylar dışlanmalı. Ek olarak "hareket etti, sonra durdu" deseni aranmalı, ya da çağrıdan önce tüm döngülerin durdurulması şart koşulmalı.

## 13. [Küçük] ESC: anahtar (FET) iletim kayıpları besleme akımına yansımıyor
`packages/simulator/src/devices/esc.ts:410` (`supplyA = i·v/vbus + 0.06`), `:764` (FET ısısı `2·i²·rds`)

Motor ve mil enerji dengesi tam tutuyor (`p2.ts`: E_terminal 1343,7 J = KE + I²R + sürtünme 1343,7 J). Ancak FET'te harcanan güç bataryadan çekilmiyor: 92 A'de ~27 W, yani ~%2-3 eksik. PDH kanal ve batarya akımı hafif düşük kalıyor.

**Düzeltme:** `supplyA += 2·i²·rds/vbus` (ve anahtarlama kaybı terimi) eklenmeli.

## 14. [Küçük] ESC konumu açılışta 0 değil, rastgele rotor açısı/dişli oranı
`packages/simulator/src/devices/esc.ts:422-425`

`hallInit` ilk sayacı `floor(angleRot·edges)` mutlak değerine eşitliyor. `p6.ts`'te açılışta `position = 0.429` tur. Gerçek bir hall sayacı açılışta 0'dan başlar. Bu fark, Tuner'da "hedef 0" testlerini ve araç örneklerini yanıltabilir.

**Düzeltme:** `onAppStart`'ta `posOffset` başlangıç konumuna eşitlenmeli, ya da sayaç 0'dan başlatılmalı.

## 15. [Küçük] roboRIO köprüsü: tek bir çerçeveleme hatası aktarımı kalıcı olarak bozuyor
`packages/protocol/src/transport/roborio-bridge.ts:157-210`

Geçersiz `size` ya da bilinmeyen tip görülünce `broken = true` oluyor ve `open()` sürekli reddediyor; aynı nesneyle yeniden eşzamanlama mümkün değil (`t1.ts`). TCP'de bozulma beklenmediği için bu bilinçli bir seçim olabilir. Ancak bu durumda bağlantı yöneticisinin her hatada yeni bir `RoboRioBridgeTransport` + soket oluşturması gerekiyor; bunun belgelenmesi ya da `close()`'un `broken`'ı sıfırlaması gerekir.

## 16. [Küçük] `SlcanTransport`: `Y` komutunu bilmeyen klasik adaptör açılışta başarısız oluyor
`packages/protocol/src/transport/slcan-transport.ts:74-77`, `slcan.ts:24-29`

Varsayılan `dataBitrate` 2, ve `Y2` BEL ile reddedilirse "adapter rejected 'Y2'" hatası veriliyor. CANable 1.x ve Lawicel gibi klasik adaptörlerle bağlantı, klasik kipe düşülmeden kuruluyor. Donanımda doğrulanmadı; kod okumayla tespit edildi.

**Düzeltme:** `Y` reddedilirse `info.fd=false` ile klasik kipte devam edilmeli ve bir uyarı durumu bildirilmeli.

## 17. [Küçük] Kullanıcının bağlantıyı kesmesi (`bus.stop()`) çalışan döngüye nötr göndermiyor
`packages/protocol/src/host/cycan/driver.ts:66-78` → `device.dispose` → `control.halt()`

Hat hâlâ açıkken (kullanıcı "Bağlantıyı kes" dediğinde) bile nötr gönderilmiyor. Motor son komutla `ctrl.timeout_ms` (varsayılan 200 ms, en çok 2 s) boyunca dönmeyi sürdürüyor. Kod okumayla doğrulandı.

**Düzeltme:** `stop()` içinde `teardown`'dan önce, hat açıkken her sürücünün `control.stop()` yöntemi (nötrlü) çağrılmalı.

---

## Ölçümler ve doğrulanan iyi davranışlar (bulgu değil)

- **Basamak yanıtı** (`p1.ts`, volan, duty 0,1): simülasyon ile analitik birinci derece model (τ = 1051 ms, ω_ss = 462 rpm) arasındaki en büyük fark **0,3 rpm**.
- **Akım sınırlama** (`p2.ts`, duty ±1): faz akımı en çok 92 A (sınır 100 A); besleme akımı 60,1 A (sınır 60 A).
- **Ayrık zaman yakınsaması** (`p5.ts`): dt 1e-6 / 1e-5 / 1e-4 s arasında 10 ms'deki hız farkı ≤ %0,4. 5e-4 s'de bile ≤ %1,8. 0,1 ms alt adım yeterli.
- **Kötü kazanç** (`p3.ts`): vel.kp = 1 (en büyük değer), vel.filter_hz = 1 + kp 0,2, pos.kp = 1000 denendi. NaN yok; akım sınırda kalıyor. Sonuç sınırlı salınım (±25 rpm) ya da aşma; sayısal patlama yok.
- **Profil üreteci** (`p6.ts`): trapez profil analitik değerlerle uyumlu (250 ms'de 1,061 / beklenen 1,054; bitiş 1,48 s).
- **Başarım** (`s4.ts`, 25 kart): 1 s simülasyon yalnız simülatörle **~49 ms**. Host + 18 döngü + 5 akışla ~80 ms. Ana iş parçacığı payı %5-8.

## İyi olanlar
1. Motor/mil modeli: RL adımı tam (exact), viskoz ve pervane sürüklemesi örtük (implicit) tümleniyor. Enerji dengesi ve analitik karşılaştırma çok iyi.
2. Eski Cyncoder v3 sürücüsü Java kaynağıyla bit düzeyinde uyumlu. BLINK #5, uid 0x12345678, seq 7 için elle hesaplanan kimlik `0x0A0804C5` ve yük `78 56 34 12 07` birebir tuttu. ACK eşleme uid + index + seq ile yapılıyor; sağlık kodu >3 → ERROR eşlemesi doğru.
3. slcan ayrıştırıcısı sağlam ve hızlı: 20 bin rastgele satırda istisna yok; klasik ~4 M, FD-64 ~430 k çerçeve/s; aşırı uzun satırdan sonra eşzamanı geri kazanıyor; hatalı DLC reddediliyor.
4. `RequestTracker`, `ManualScheduler` ve `Scheduler` soyutlaması testleri belirlenimci yapıyor. Firmware akışındaki pencere/geri sarma mantığı geç ACK'lara dayanıklı.
5. Akış zaman eşlemesi (16 bit taşma, uzun sessizlikte host saatiyle taşma sayısı) doğru. `deviceBack` ile kayıptan dönüşte yerleşim yeniden yazılıyor.

## En değerli 5 eksik test
1. Sim bütünleşik: çalışan bir döngü varken kartın numarası değişiyor (takas) → döngü durmalı ya da yeni adrese geçmeli; eski adrese CTRL gitmemeli (Bulgu 1).
2. Geciktiren/çoğaltan sarmalayıcı aktarımla aynı `pid`'e art arda iki SET ve GET → değer ile önbellek tutarlı kalmalı (Bulgu 2).
3. 1,5 s'den kısa güç kesintisi → `paramsInvalidated`, akış yeniden kurulmalı; döngü davranışı tanımlı olmalı (Bulgu 3).
4. Simülatöre karşı akış: iki tüketiciden biri kapanınca kalanın veri boşluğu < 2 periyot ve değerler doğru sinyalde olmalı. Ek olarak ≥128 örnek kayıpta `lost` doğru sayılmalı (Bulgu 4, 5).
5. Simülatör değişmezleri: her senaryoda (`useServoChannels` dahil) 60 s boyunca tüm `PowerFeed.load` değerleri sınırlı kalmalı ve batarya akımı ≈ Σ kart akımı olmalı. Ek olarak doymuş hatta `bus.estop()` 5 ms içinde tüm ESC'leri ESTOP'a almalı (Bulgu 6, 7).

## Bakmadıklarım
- Protokol belgesiyle düğüm davranışı uyumu (başka inceleyicide); `node.ts`'in büyük kısmı, `sealed-servo.ts`, `servo16.ts`, `oled.ts`, `gyro.ts` yalnız gürültü satırları düzeyinde okundu.
- `describe.ts` (host ve legacy), `stats.ts` yük tahmini, katalog doğrulaması.
- `firmware.ts`'te bilinen iki açık (ENTER_BOOTLOADER tek deneme, END sonrası ACK kaybı) istendiği gibi yeniden yazılmadı. Firmware sırasında `markLost`'un iptal etmemesi yalnız okundu (ACK zaman aşımıyla ~2 s'de düşüyor).
- Gerçek donanım ve adaptör davranışı (CANable `Y` yanıtı, WebSerial yazma eşzamanlılığı) doğrulanmadı.
- Mevcut vitest paketleri çalıştırılmadı (yalnız `tsx` betikleri kullanıldı).
