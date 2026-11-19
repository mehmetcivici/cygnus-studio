# Q3 — Uzlaştırma ve bağımsız doğrulama (2026-11-19)

Betikler ve çıktılar: `/tmp/q3/` (`pw/` Playwright, `hs/` host-sim, `pts/` protokol, `probe/` C sondası, `rs/` Rust, `walk/` yürüyüş ekranları, `safety-tuner.log`).

## Aşama 1

| # | İş | Durum |
|---|---|---|
| 1 | §4.5 nötr CTRL ile hareketli komut iptali | Simülatör (`node.ts` `abortMovingCommand`/`failMovingCommand`; ESC `neutral` PWM kalibrasyonunu artık öldürmüyor), C (`cycan_app_t.moving_cmds`, `CYCAN_NEUTRAL_ABORT`, katalogdan `CYCAN_<MODEL>_MOVING_CMDS`), host `DeviceHandle.abortAction()` (`control.neutralAll`), Cihaz › Eylemler kesmede bunu kullanıyor. Ek: nötre zorlayan her olay (CTRL zaman aşımı vb.) hareketli komutu `FAILED` bitiriyor — önceden simülatörde ve C'de komut **asılı kalıyordu** (fark testi yakaladı). Testler: `esc.test.ts` (3), `commands.test.ts`, `c-node.test.ts` (köprü + fark betiğine 3 adım), `test_node_moving_abort`. |
| 2 | StaticChart log ekseni + Bode taşıma | `logTickLabels` (yalnız 1·2·5×10ⁿ, sığmazsa yalnız 10ⁿ; basamak değerin kendisinden), uPlot'un x eksenini y gibi ölçen log süzgeci devre dışı; `points` stili ve `guides` (yatay çizgi) eklendi. Bode `StaticChart`'a taşındı (eski SVG kaldırıldı): okunur yazı, imleç, efsane, ωc/ω180 işaretleri, 0 dB/−180° kılavuzları; eskisinden iyi (`/tmp/q3/bode-old-crop.png` ↔ `bode-new-crop.png`). |
| 3 | 'Kalibre edildi' | Yapıldı, `gen:catalog`; CAN İzleyici'de görüldü. |
| 4 | describe.ts | Dile göre ondalık (TR virgül); gyro birimi katalogda `°/s` (her yerde tutarlı). Test eklendi. |
| 5 | 25 kartlı hız testi | Süreç CPU süresi, 3 dilimin en iyisi; 2× CPU aşırı yükte geçti. |
| 6 | README, PLAN, README'ler | Güncellendi; core README'de yanlış senaryo kimliği (`frc.swerve4` → `vehicle.frc.swerve4`) ve demo kısıtları; host/sim/C README'lerine iptal kuralı. |
| 7 | Sürümler/üretilenler | PROTO 1.0 (TS=C), tüm `catalog_rev`=1 (sahada kart yok). `gen:catalog`, `gen:vectors`, `make vectors` yeniden üretimde fark yok. **Bulgu:** HEAD'deki C testi `test_node_status_periods` eski STATUS periyotlarını bekliyordu; bayat derleme yüzünden "geçiyor" görünüyordu (temiz klonda 45/46). Düzeltildi. |
| 8 | Korumalı iframe demo | `IS_DEMO`; `downloadFile` bilgi toast'ı + `false`; rapor/yazdır → uygulama içi önizleme (betiksiz sandbox iframe); seri port/roboRIO/masaüstü seri açıklamalı pasif; hash güncellemesi try/catch; UID kopyalama hata yakalıyor. `alert/confirm/prompt` kullanımı yok. |

## Aşama 2-A — Kritik/Önemli bulgular (50)

Sonuç: **KAPANDI 46 · KISMEN 4 · AÇIK 0 · UYGULANAMAZ 0** (Q3'te kapatılanlar dahil).

| Rapor/# | Sonuç | Kanıt |
|---|---|---|
| protokol 1 (K) | KAPANDI | `renumber.ts`: sürülen karta ASSIGN_ID → `BUSY driving`; `h1.ts` B 0 rpm |
| protokol 2 (K) | KAPANDI | C sonda P1 `ctrl_calls=0`; simdiff (a) iki yayın biçimi `enabled=false` |
| protokol 3 | KAPANDI | P2: bozuk CTRL bekçiyi beslemiyor, `neutral_calls=1 driving=0` |
| protokol 4 | KAPANDI | P3: aynı poll'da CLEAR+ESTOP → kilitli, CTRL reddedildi |
| protokol 5 | KAPANDI | `estop2.ts`: dış ESTOP/yeniden başlatmada döngü kesildi, `enabled=false` |
| protokol 6 | KAPANDI | C↔sim fark testi "save while driving" eşit (DENIED) |
| protokol 7 | KAPANDI | `test_boot_races` (END sonrası BEGIN → BUSY, silinmiş imaj başlamıyor) |
| protokol 8 | KAPANDI | `test_boot_wrong_image` (silmeden ret, imaj korunuyor) + c-node yanlış model testi |
| protokol 9 | KAPANDI | Arayüz: `brokenApp` + kurtarma yayını + güç kapat-aç → bootloader'da, 1.1.0→1.2.0 yüklendi |
| protokol 10 | KAPANDI | host testi "END yanıtı kaybolunca heartbeat sürümünden doğrular" (eski `xcompat2` köprüsü eski API'ye bağlı, yeniden koşulamadı) |
| protokol 11 | KAPANDI | fark testi 0 fark (yeni iptal adımları dahil) |
| protokol 12 | KAPANDI | klasikte en çok 4 yuva (`NO_SLOTS`), TX kaybı `CAN_ERR` |
| protokol 13 | KAPANDI | A/B depo + sıra sayacı; her bayt için güç kesintisi testi |
| protokol 18 | KISMEN | ESTOP 3×, ESTOP'ta REBOOT reddi; kilit güç kesintisinde kalkıyor, ENABLE sinyali yol haritasında |
| protokol 19 | KAPANDI | `load.ts` ESC %1,25; akış %98 yük tahmininde `NO_BANDWIDTH` |
| protokol 20 | KISMEN | kasıt argümanı, başlık doğrulama, sürülürken ret var; kimlik doğrulama/imza yok (yol haritası) |
| host-sim 1 (K) | KAPANDI | `h1.ts`: atama reddi, A 1499 / B 0 rpm |
| host-sim 2 | KAPANDI | `h2.ts`: B 0,002 çözüldü, önbellek=kart |
| host-sim 3 | KAPANDI | `h3.ts`: `paramsInvalidated`, akış 2333 örnek, lost 0 |
| host-sim 4 | KAPANDI | `h4/h5.ts`: boşluk yok, yanlış eşleme yok |
| host-sim 5 | KAPANDI | `h7.ts`: 200 ms kopuk → lost 200 |
| host-sim 6 | KAPANDI | `s6.ts`: 18/18 ESC ESTOP'ta, host düşürmesi 0 |
| host-sim 7 | KAPANDI | `s2/s3.ts`: kanallar 0,02 A, batarya 12,7 V (30 s) |
| host-sim 8 | KAPANDI | `r1.ts`: 10 s arka plan, 0 kayıp, 0 önbellek silme |
| uygulama 1 (K) | KAPANDI | `tunerstop.mjs`: Durdur'dan 1 s sonra duty 0, 3 s'de 0 rpm, armed=false |
| uygulama 2 (K) | KAPANDI | `rearm.mjs`: yeniden etkinleştirmede 0 rpm; servo: yeniden etkinleştirmede 273 CTRL hepsi nötr |
| uygulama 3 | KAPANDI (Q3) | CTRL oturumsuz gitmiyor (düğmeler pasif). Boşluk veri alanında yazıyordu: periyodik gönderimde alanlar salt okunur + salt okunur alanda Boşluk=ESTOP; test eklendi |
| uygulama 4 | KAPANDI | kesmede nötr CTRL + ESTOP gönderiliyor (`disc.mjs`) |
| uygulama 5 | KAPANDI | `isRun` gainSet denetimi; rapor Blob+CSP, betik 0 (rapor açıldı: `scripts=0 csp=true`) |
| uygulama 6 | KAPANDI | `rs/`: ikinci açma ve kapat-hemen-aç `Ok` (58 µs) |
| uygulama 7 | KAPANDI | `paramcache.test.ts`: yeniden başlatma sonrası 25/25 değer, 0 hata |
| uygulama 8 | KAPANDI | `vehbad.mjs`: üç bozuk bağlamada ekran açılıyor |
| uygulama 9 | KAPANDI | kod: motor testi `session.onDisarm` → abort sinyali |
| uygulama 10 | KAPANDI | `capabilities/default.json` yalnız `link_*`; CSP nesnesi |
| uygulama 11 | KAPANDI | kod: `link_write` tek kuyruk zinciri |
| tasarim B1 | KAPANDI | ACİL DURDUR sonrası gösteri motoru 1205→722 rpm (serbest yavaşlama) |
| tasarim B2 | KAPANDI | hareketli eylem: basılı tut penceresi, öncesinde CTRL/COMMAND 0 |
| tasarim B3 | KAPANDI | kabuk düzeyinde kırmızı çerçeve + şerit (Cihaz/servo ekranında görüldü) |
| tasarim B4 | KAPANDI | ilk basamak sınırın %10'u; ff kartı süre/rpm/görev özetini veriyor |
| tasarim B5 | KAPANDI | kısa devre: kırmızı nokta, uyarı "CAN_H/CAN_L birbirine değiyor", güç paneli "Veri yok" |
| tasarim B6 | KAPANDI | "Servo kartı hattan düştü" uyarısı, KAYIP rozeti, 11/12 |
| tasarim B7 | KAPANDI | "SoC 12V hattan düştü · Neden: Güç dağıtım K5 sigortası attı" |
| tasarim B8 | KISMEN | yük ≥%80 uyarısı ve `NO_BANDWIDTH` var; "kayıp" yerine "gecikiyor" ayrımı doğrulanmadı |
| tasarim B11 | KAPANDI | sihirbaz/canlı şemada çakışma yok |
| tasarim B12 | KAPANDI (Q3) | soru + encoder sıfırlama vardı; 2. adımdaki yanıt 3. adıma taşınmıyordu ("Test edilmedi") → taslağa alındı, test eklendi |
| tasarim B15 | KAPANDI (Q3) | ulaşılmayan yanıtta zaman ölçütleri "—"; "%-257" yüzdesi 0'a kırpıldı |
| tasarim B16 | KAPANDI | "Ne yapmalı?" eylem düğmeleri, önerilen sıra, formül açılırda |
| tasarim B23 | KAPANDI (Q3) | `%13,2`, `0,1 °/s` (CAN İzleyici) |
| tasarim B26 | KAPANDI | ACİL DURDUR beyaz/#c62f22 5,48:1; açık tema #8a6500 / #0f7a40 |
| tasarim B27 | KISMEN | `--cy-fs-xs` 12 px; `--cy-h-sm` 28 px (öneri 32), pit kipi yok |

## Aşama 2-B — Emniyet turu (sayısal)

- Tuner, 9 test türü × 5 kesme (Durdur, ESTOP, odak kaybı, ekran değişimi, bağlantı kesme): 42/45 koşu ölçüldü, **hepsinde** 1,5 s sonra `enabled=false`, duty 0, kesme sonrası sürme CTRL'i 0; nötr kesmeden 1–72 ms sonra (Durdur tıklaması dahil), ESTOP 3 kez 3–14 ms içinde, bağlantı kesmede nötr+ESTOP. Ölçülemeyen 3: Kare/Sinüs testi 1,5 s'de bitiyor (Durdur yok), Röle×kesme tıklama zaman aşımı.
- Cihaz › Kontrol: oturumsuz 2 s'de CTRL 0, hedef alanı pasif; odak kaybından sonra yeniden etkinleştirmede hedef 0, 0 rpm.
- Servo paneli: oturumsuz CTRL 0; kesmede kanallar 0 µs; yeniden etkinleştirmede 273 CTRL hepsi nötr, açık kanal 0.
- Cihaz › Eylemler (motor ölç): odak kaybında tek nötr CTRL → kart FAILED, 300 ms'de `enabled=false`, kV yazılmadı.
- CAN İzleyici: oturumsuz "Tek atım/Periyodik" pasif, CTRL 0; periyodik sırasında veri alanında Boşluk → ESTOP (düzeltme sonrası).
- Sürerken dış olaylar: güç kapat-aç → son sürme CTRL +162 ms, 0 rpm, geri gelmedi; fabrika sıfırlama (numara 63) → eski #1'e CTRL +560 ms'ye kadar (kayıp algılanana dek; kart atanmamış, yok sayıyor); başka hosttan ASSIGN_ID → anında kesildi; başka hosttan ESTOP → +302 ms'ye kadar 1 çerçeve, kart ESTOP'ta.
- Sekme arka planda: nötr CTRL 0 ms'de, kart 16 ms'de `enabled=false` (`ctrl.timeout_ms` 200).
- ACİL DURDUR: 8 ekran × odak (gövde, düğme, yazı alanı Ctrl+Boşluk ve Esc Esc, sayı alanı, açılır menü, modal, üst çubuk menüsü, düğme tıklaması): 35/35 çalıştı; kilitliyken basılı tut etkinleştirmiyor.

## Aşama 2-C — Yürüyüşte bulunup düzeltilenler

1. Araç sihirbazı yapışkan alt çubuğu ile ekran altı arasında 24 px boşluk; içerik arkadan görünüyordu → düzeltildi.
2. Motor testi yanıtı (Evet/Ters) 3. adımda "Test edilmedi" görünüyordu → taslak deposunda paylaşılıyor.
3. Yön ve ayarlar tablosu 1440'ta yatay taşıyordu → yan panel daraltıldı.
4. Tuner ölçütler: "yalnız %-257 kadarına çıktı" → 0–100 arası.
5. Tuner raporu IAE/ITAE 4 ondalık, birimsiz → 3 anlamlı basamak + birim (uygulamayla aynı).
6. Cihaz › Ayarlar aramada sonuç yokken boş sayfa → boş durum.
7. Firmware: doğrulamada iptal edilen kartta "0,0 / 6,1 kB" → gönderilen bayt korunuyor.
8. Kurtarma: tüm kartlar yüklenince "Bitir ve 0 kartı yeniden başlat" pasif + "Vazgeç" → "Kapat".
9. Proje içerik özeti ham bölüm kimlikleri ("vehicle.setup", "scope.layout") ve "anahtar" → anlaşılır adlar.
10. 1100×700'de üst çubuk yuvaları 23–37 px taşıyordu → dar pencerede birim yazısı/yük çubuğu gizleniyor.
11. core README'deki senaryo kimliği yanlıştı.

Bulunup düzeltilmeyen (PLAN "Açık işler"): her sürüş sonunda `CTRL_TIMEOUT` "Uyarı" rozeti; simülatörün senaryolar arası aynı uid48'leri (kayıtlı Grafik düzeni başka modele bağlanıp ham anahtar gösteriyor); tanımada θ≈0; demo raporundaki "Ctrl+P ile yazdırın" satırı.

## Aşama 2-D — Derlemeler

- `npm run build -w @cygnus/studio`: hatasız. `build:demo`: `dist-demo/index.html` 2,21 MB (gzip 948 kB); `file://` ile açılıyor, demo senaryosu bağlı, konsol hatası yok.
- Korumalı iframe (`sandbox="allow-scripts"`, :5232): origin `null`, 8 ekran açıldı (hash `#/bus`…), Tuner basamak testi koştu (Koşular 1), rapor uygulama içi önizlemede, yeni pencere 0, indirme 0 + bilgi toast'ı, USB-CAN sekmesi açıklamalı pasif; konsolda yalnız dış sayfanın `favicon.ico` 404'ü, `SecurityError` yok.
- `cargo check` / `cargo test --workspace` (11+3) / `cargo clippy -- -D warnings`: temiz.
- `make -C firmware/cycan test fuzz bridge`: 47/47, fuzz 20 000 + 200 000 çerçeve, köprü derlendi.
- Temiz klon (HEAD): `npm ci` ✓, `typecheck` ✓, `npm test` 944 geçti / 9 atlandı (köprü yok). Aynı klonda `make test` **45/46** (yukarıdaki bayat C testi; çalışma ağacında düzeltildi).
- Son durum (çalışma ağacı): `npm run typecheck` temiz, `npx vitest run` 964/964, `make -C firmware/cycan test` 47/47.
