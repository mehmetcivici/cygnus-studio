# CyCAN kart kütüphanesi (`firmware/cycan`)

CyCAN v1 protokolünün (`docs/PROTOCOL.md`) kart tarafı referans gerçeklemesi. Taşınabilir C99, dinamik bellek ve global durum yok; donanıma yalnızca küçük bir HAL (`cycan_hal_t`) ile bağlanır. Hedef STM32G431 (Cortex-M4F, FDCAN), ama her MCU'ya taşınabilir.

| Dosya | İçerik |
|---|---|
| `include/cycan_codec.h`, `src/cycan_codec.c` | Kimlik kodlama/çözme, kabul kuralı, tüm mesaj yükleri, CRC32, FNV-1a-64, `.cyfw` başlığı, STATUS yardımcıları. TS codec'leriyle bit-bit aynı. |
| `include/cycan.h`, `src/cycan_node.c` | Uygulama kipindeki kart: keşif, numara, çakışma, heartbeat, parametreler, STATUS, STREAM, hatalar, ESTOP, CTRL bekçisi, komutlar. |
| `include/cycan_boot.h`, `src/cycan_boot.c` | Bootloader: FW güncelleme durum makinesi ve bootloader'ın hattaki varlığı. |
| `include/cycan_catalog.h` | Katalogdan **üretilir** (`tools/gen-catalog.ts`); elle değiştirmeyin. |
| `examples/stm32g431_cyncoder/` | Derlenmeyen ama gerçekçi iskelet: STM32 HAL ile port, Cyncoder uygulaması, bootloader. |
| `test/` | Host testleri, sahte HAL, altın vektör üreticisi. |

```
make test      # gcc -std=c99 -Wall -Wextra -Werror -pedantic + ASan/UBSan, testleri çalıştırır
make vectors   # test/cycan_vectors.inc dosyasını TS altın vektörlerinden yeniden üretir
```

## Bir karta 10 adımda ekleme

1. `include/`, `src/cycan_codec.c`, `src/cycan_node.c` dosyalarını projeye ekleyin (bootloader projesine ek olarak `src/cycan_boot.c`). Derleyici bayrakları: `-std=c99` veya üstü, `-ffunction-sections -fdata-sections` + bağlayıcıda `--gc-sections` (kullanılmayan host kodlayıcıları atılır).
2. Katalogdaki model bölümünü bulun (`CYCAN_<MODEL>_*`). Parametre deposunu ve tablosunu X-makrosundan üretin:
   ```c
   #define F(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_CTYPE(pt) name;
   static struct { CYCAN_CYNCODER_PARAMS(F) } p;
   #define R(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_PARAM_ENTRY(pid, pt, mn, mx, df, mnz, fl, &p.name, on_param),
   static const cycan_param_t k_params[] = { CYCAN_CYNCODER_PARAMS(R) };
   ```
   Değerleri doğrudan `p.ENC_RATIO` gibi okuyun; yazan yalnızca kütüphanedir (yerel değişiklik için `cycan_param_set`).
3. Ardışık olmayan enum seçenekleri varsa (`CYCAN_<MODEL>_ENUM_*_VALUES`) `param_validate` geri çağrısında denetleyin.
4. `status_fill(n, out[8])` yazın: yerleşim katalog başlığındaki `STATUS/n layout` yorumundadır. Ölçekli alanlar için `cycan_scale_round`, bit alanları için `cycan_put_bits`, f32 için `cycan_wr_f32`.
5. `signal_read(sid, &f)` yazın (STREAM). Bilinmeyen sid için `false` dönün (NaN gider).
6. Eyleyici kartlarda `ctrl(index, data, len)` ve `neutral(reason)` yazın. `ctrl` içinde sürmeye başlayınca `cycan_set_enabled(node, true)`; `neutral` eyleyiciyi **hemen** güvenli duruma alır.
7. Komut işleyicisi: `SELF_TEST` ve `0x40+` model komutları. Uzun işlemlerde `CYCAN_CMDST_IN_PROGRESS` dönün, bitince `cycan_command_finish(node, cmd, status, result)`.
8. HAL'i yazın (aşağıdaki sözleşme; örnek: `examples/stm32g431_cyncoder/cycan_port_stm32g4.c`). RX kesmesinde yalnızca `cycan_on_frame()`.
9. Açılışta `cycan_init()`, sonra `cycan_data_bitrate()` değerine göre CAN denetleyicisini kurun (FD veri hızı yeniden başlatınca değişir). Ana döngüde en az 1 kHz'de `cycan_poll(node, now_us)`.
10. Hataları `cycan_fault_set/clear` ile bildirin (ACTIVE = etkin + sticky, WARN = uyarı). Studio ile deneyin: keşif → numara atama → parametre → SAVE → yeniden başlat → STATUS/STREAM → ENTER_BOOTLOADER.

## HAL sözleşmesi (`cycan_hal_t`)

| Geri çağrı | Sözleşme |
|---|---|
| `can_send(frame)` | 29 bit kimlik; `flags` içinde `CYCAN_FRAME_FD/BRS`. Denetleyici alamıyorsa `false` dönün; kütüphane küçük bir kuyrukta (`CYCAN_TX_QUEUE_LEN`) tutup sırayı koruyarak yeniden dener. Donanım TX kuyruğu FIFO kipinde olmalı (sıra korunur). |
| `uid96(out)` | MCU'nun 96 bit UID'si, INFO sayfa 1–2 bayt sırasıyla. Yalnızca `cycan_init` içinde okunur. |
| `storage_read/erase/write(region, …)` | İki bölge: `CYCAN_REGION_IDENTITY` (8 bayt, NUM) ve `CYCAN_REGION_PARAMS` (`cycan_params_blob_size(app)` bayt). Yazmalar silmeden sonra, artan ofsetlerle, 8 bayt hizalı ve 8'in katı uzunlukta gelir (STM32G4 çift sözcük programlaması doğrudan uyar). Silinmiş alan 0xFF okunmalı. Üçü de `NULL` olabilir (kalıcılık yok). |
| `reboot()`, `enter_bootloader()` | Dönmez. Kütüphane yanıt çerçevesi gittikten sonra (`CYCAN_RESET_DELAY_US`, TX kuyruğu boş) çağırır; önce `neutral(RESET)`. |
| `led_set(on)` | Yalnızca IDENTIFY yanıp sönmesi için; kartın kendi LED mantığı `cycan_identify_active()` iken çekilir. |
| `random()` | ENUM çakışma geri çekilmesi ve CONFLICT duyurusu için; `NULL` ise UID+zaman kullanılır. |

Parametre bloğu biçimi: 32 bayt başlık (`"CYP1"`, model, kayıt sayısı, 21 bayt ad) + kayıt başına 8 bayt (`pid u16, ptype u8, 0, değer u32`) + 8 bayt iz (CRC32, ~CRC32). Yükleme iki geçişlidir: önce CRC, sonra uygulama; tabloya artık uymayan kayıtlar (pid yok, tip/aralık değişti) varsayılanda kalır, böylece firmware güncellemesi geçersiz değer yüklemez. CRC bozuksa varsayılanlar + `PARAM_CRC` uyarısı (WARN + sticky); başarılı `SAVE_PARAMS` uyarıyı siler. Kimlik (NUM) ayrı bölgededir; parametre bozulması numarayı kaybettirmez.

## Çalışma modeli ve zamanlama

- `cycan_on_frame()` kesmeden çağrılabilir: yalnızca kimlik süzer ve tek üretici/tek tüketici halkasına (`CYCAN_RX_QUEUE_LEN`, varsayılan 8) kopyalar. ESTOP halkadan bağımsız bir bayrakla tutulur; halka dolu olsa bile kaybolmaz. `cycan_on_tx_error()` da kesme güvenlidir.
- Geri kalan **her şey** tek bağlamda (ana döngü veya 1 kHz görevi) çalışır: `cycan_poll()` ve diğer tüm API çağrıları. HAL ve uygulama geri çağrıları yalnızca `cycan_poll()` içinden (veya uygulamanın çağırdığı API'den) gelir, asla `cycan_on_frame()`'den. Fonksiyonlar kendileriyle yeniden girişli değildir; geri çağrılar `cycan_poll()` çağırmamalıdır.
- Zaman: serbest çalışan 32 bit µs sayaç (STM32G431'de 1 MHz'lik TIM2). Taşma güvenli (~71 dakikada bir sarar).
- `cycan_poll()` en az 1 kHz. Katalogdaki `stream.minPeriodUs` 1 ms'den küçükse (ESC: 500 µs) poll en az o sıklıkta çağrılmalı.
- Gecikmeler: yanıtlar en geç bir poll periyodu sonra; ESTOP → `neutral()` en geç bir poll periyodu (1 ms). Daha hızlı ESTOP isteyen eyleyiciler kesmede ESTOP kimliğini ayrıca yakalayıp donanımı doğrudan kesebilir.
- Flaş silme (STM32G4: sayfa başına ~22 ms, tek bankta CPU bekler) yalnızca `SAVE_PARAMS`, kalıcı `ASSIGN_ID` ve bootloader'da olur. `ASSIGN_ID` onayı (ENUM_RSP) silmeden **önce** gönderilir (§3.3, 50 ms).
- Önerilen donanım süzgeci: genişletilmiş kimlik, maske `0x00FF0000`, değer `0x00080000` (MFR = 8).

## Kütüphanenin üstlendiği davranışlar

Kabul kuralı (§2.2), UID türetimi (FNV-1a-64), ENUM (UID'ye bağlı gecikme, özel kimlik, gönderim hatasında 0–100 ms rastgele tek deneme), çakışma algılama (farklı `uid16`'lı HEARTBEAT **veya** farklı `uid48`'li ENUM_RSP; 0–20 ms içinde CONFLICT bayraklı ENUM_RSP duyurusu; yalnızca kendi `uid48`'ine gelen ASSIGN_ID ile çıkış), atanmamış/CONFLICT sessizliği, ASSIGN_ID (+ kalıcılık), HEARTBEAT (500 ms, UID'ye bağlı 0–50 ms faz, yalnızca etkin hatalar), IDENTIFY (iki biçim), INFO sayfaları 0–6, NAME_SET, PARAM GET/SET (tüm statüler, `min_nonzero`, kilitli parametreler, salt-okunur), SAVE/LOAD_DEFAULTS + UNSAVED, ortak parametreler, STATUS zamanlayıcı, STREAM (yuvalar, periyot, 2 s canlı tutma, FD'de tek çerçeve / klasikte yuva başına), FAULT_REQ, ESTOP kilidi ve CLEAR_ESTOP, CTRL zaman aşımı (`ctrl.timeout_ms`, `CTRL_TIMEOUT` uyarısı), REBOOT/ENTER_BOOTLOADER, uygulama kipinde FW_REQ → `WRONG_STATE`.

Kütüphanenin verdiği kararlar (protokolün açık bıraktığı yerler):

- Sürülürken (`enabled`) `REBOOT`, `ENTER_BOOTLOADER` ve `LOAD_DEFAULTS` → `DENIED`.
- Bilinmeyen INFO sayfası yanıtsız kalır. DEVTYPE 0 yayınıyla gelen CTRL yok sayılır (CTRL yerleşimi modele özgüdür).
- Uzun bir komut sürerken aynı komut tekrar gelirse `IN_PROGRESS`, başka bir uygulama komutu gelirse `DENIED`.
- `CLEAR_FAULTS` sonrası hâlâ etkin olan hatalar sticky'de kalır.

## Bootloader

`cycan_boot` FW güncellemesini yürütür: `BEGIN` → `BUSY`, silme, `OK`; `DATA` sırayla yazılır, her `window` (16) iyi çerçevede `OK` (sayaç her ACK'tan sonra sıfırlanır; son eksik pencereyi `END`'in ACK'ı kapatır); sıra bozulunca `BAD_OFFSET` + beklenen ofset (yoldaki başıboş çerçeveler için pencere başına tek yanıt); başlık 64 bayt tamamlanınca doğrulanır (sihirli sözcük, sürüm, başlık CRC, model, hw_rev, boyut → `BAD_IMAGE`); `END`'de dosya CRC (`BAD_CRC`), gövde CRC (`BAD_IMAGE`), flaştan geri okuma (`FLASH_ERROR`), sonra `OK` ve uygulama başlatılır. Bootloader yalnızca HEARTBEAT (state = BOOTLOADER, atanmış numarayla), ENUM_REQ (BOOTLOADER biti), ASSIGN_ID, IDENTIFY, INFO_REQ 0–2 ve COMMAND REBOOT'a yanıt verir.

Flaş yerleşimi (örnek, G431 128 KB): bootloader `0x08000000–0x08003FFF`, görüntü alanı sayfa 8–61 (`.cyfw` başlığı `0x08004000`'da), kimlik sayfa 62, parametreler sayfa 63. Uygulama `0x08004040`'a bağlanır ve vektör tablosundan önce 512 bayta hizalanır (`0x08004200`, `VTOR` buna ayarlanır); böylece `.cyfw` gövdesi flaşa olduğu gibi yazılır. Açılışta: yazılımsal istek yoksa ve `cycan_boot_image_valid()` doğruysa uygulamaya atlanır.

## Bellek ayak izi (Cortex-M4F, clang `-Os`, `--gc-sections`)

| | Flaş | RAM |
|---|---|---|
| Uygulama kipi (codec + node) | ≈ 7,7 KB | `cycan_node_t` 696 B (RX 8, TX 4 çerçeve) + parametre deposu (4 B × parametre) |
| Bootloader (codec + boot) | ≈ 4,0 KB | `cycan_boot_t` 544 B (RX 4 FD çerçevesi, 64 B yazma tamponu) |
| Parametre tablosu | 28 B × parametre (Cyncoder 15 → 420 B, ESC 58 → 1,6 KB) | — |

En yüksek yığın kullanımı ≈ 400 B (STREAM gönderimi ve SAVE). TX kuyruğunun her elemanı 72 B'tır; yalnızca klasik CAN kullanan portlar `CYCAN_FRAME_MAX_DATA=8` ile bunu 16 B'a indirir (STREAM her zaman yuva başına çerçeve olur).

## Testler

`test/gen_vectors.py` (yalnızca Python standart kütüphanesi) `packages/protocol/test/vectors/cycan-vectors.json` dosyasını `test/cycan_vectors.inc`'e çevirir; TS tarafı vektörleri değişince `make vectors` çalıştırın. Testler: her vektör için C kodlama çıktısı = vektör ve çözme = alanlar; UID/CRC/STATUS/`.cyfw` vektörleri; sahte HAL ile açılış, ENUM, sessizlik, ASSIGN_ID, çakışma (HEARTBEAT ve ENUM_RSP yolu), tüm PARAM statüleri, SAVE → yeniden başlatma, LOAD_DEFAULTS, bozuk depolama, STATUS periyotları, STREAM FD/klasik + canlı tutma, CTRL zaman aşımı, ESTOP, uzun komut, TX kuyruğu, FW mutlu yol (klasik ve FD), sıra bozulması, bozuk CRC, yanlış model/hw_rev, bootloader'ın yanıt kümesi. ESC 20A ve Cyncoder tabloları testlerde doğrudan katalog X-makrolarından kurulur.
