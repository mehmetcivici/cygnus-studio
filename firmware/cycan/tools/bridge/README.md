# cycan-bridge — gerçek C kütüphanesiyle çapraz uyum köprüsü

Tek bir CyCAN kartını (gerçek `firmware/cycan` kütüphanesi: bootloader + uygulama) stdin/stdout üzerinden satır tabanlı bir protokolle sunar. TS tarafı (host `CygnusBus`, simülatör karşılaştırmaları) bunu bir `Transport` gibi sürer.

```
make -C firmware/cycan bridge      # → firmware/cycan/build/cycan-bridge
```

Kaynak: `tools/bridge/cycan_bridge.c`. Bağımlılık yok (C99, yalnız stdio).

## Seçenekler

| Seçenek | Anlam | Varsayılan |
|---|---|---|
| `--model esc20a\|cyncoder` | Kart modeli (parametre tablosu katalogdan) | `esc20a` |
| `--uid <24 onaltılık>` | 96 bit UID (INFO sayfa 1–2 sırası) | bayt `i` = `0x5A + 17·i` |
| `--hw-rev <n>` | Donanım revizyonu (`.cyfw` denetimi) | 1 |
| `--fw <a.b.c>` | İlk açılışta kurulan sentetik imajın sürümü | `1.0.0` |
| `--no-image` | İmaj alanı boş başlar (kart bootloader'da kalır) | — |
| `--store <dosya>` | Parametre deposu (A/B yuvaları) ve imaj flaşı bu dosyada kalıcı; varsa yüklenir | yalnız bellek |
| `--off` | Güç kapalı başlar (`P 1` bekler) | açık başlar |

Depo dosyası şu anlarda yazılır: parametre deposuna her yazmadan sonraki satır sonunda, kip değişiminde, güç kesilince ve çıkışta (FW aktarımı sırasında her DATA'da değil).

## Tel biçimi

Her satır bir komut (stdin) veya olay (stdout). Alanlar tek boşlukla ayrılır. Onaltılık sayılar küçük/büyük harf fark etmez, `0x` öneki yok. Boş veri `-` ile yazılır. `#` ile başlayan giriş satırları yok sayılır.

### Giriş (host → köprü)

| Satır | Anlam |
|---|---|
| `F <id> <veri> [bayrak]` | Hattan karta bir çerçeve. `id` 29 bit onaltılık; `veri` onaltılık bayt dizisi veya `-`; uzunluk geçerli bir CAN/CAN-FD uzunluğu olmalı (0–8, 12, 16, 20, 24, 32, 48, 64). `bayrak` isteğe bağlıdır ve yok sayılır. |
| `T <µs>` | Sanal zamanı `µs` (onluk) kadar ilerletir; kart her 1000 µs'de bir poll edilir. Bitince `T <şimdi>` yazılır. `T 0` yalnız bir poll yapar. |
| `S <işaret>` | Bariyer: önceki tüm satırlar işlendikten sonra `S <işaret>` yazılır. |
| `P 1` / `P 0` | Güç aç (soğuk açılış: bootloader → 150 ms kurtarma penceresi → uygulama) / güç kes (RAM durumu kaybolur, depo ve flaş kalır). |
| `C <bayt>` | Güç kesintisi kur: flaşa (parametre deposu veya imaj) `bayt` kadar daha yazıldıktan sonra güç gider (yazma yarıda kalır; `0` = sonraki silme yarıda kalır). `C -1` kaldırır. Tetiklenince `E power-cut` + `M OFF`. |
| `X <n>` | Sonraki `n` gönderim denetleyici dolu sayılır (kütüphanenin TX kuyruğu/ENUM geri çekilmesi denenir). |
| `Q` | Depoyu yazıp çıkar (yanıt yok). Stdin kapanması da aynıdır. |

Zaman yalnız `T` ile ilerler; `F` çerçeveleri o anki sanal zamanda teslim edilir. Uygulama kipinde çerçeveler kütüphanenin RX halkasına girer ve sonraki poll'da (sonraki `T`) işlenir — aynı `T` aralığında gelen ESTOP ve CLEAR_ESTOP gerçek kartta olduğu gibi aynı işlem turuna düşer. Halka doluysa önce bir poll yapılır (donanım FIFO'sunun yerine). Bootloader kipinde her çerçeveden sonra hemen poll edilir (örnek bootloader da böyle çalışır), yani FW yanıtları `F` satırının hemen ardından gelir.

### Çıkış (köprü → host)

| Satır | Anlam |
|---|---|
| `F <id> <veri> <bayrak> <t_µs>` | Kartın gönderdiği çerçeve. `id` 8 haneli onaltılık; `bayrak`: 0 klasik, 1 FD, 3 FD+BRS; `t_µs` gönderim anının sanal zamanı (onluk). |
| `T <şimdi_µs>` | `T` komutunun onayı (mutlak sanal zaman). |
| `S <işaret>` | Bariyer onayı. |
| `M BOOT` / `M APP` / `M OFF` | Kip değişti (bootloader başladı / uygulama başladı / güç yok). |
| `A <etkin 0/1> <mode> <value>` | ESC modeli: eyleyici çıkışı değişti (uygulanan CTRL; nötrde `A 0 0 0`). |
| `N <neden>` | Kütüphane kartı nötre zorladı: `CTRL_TIMEOUT`, `ESTOP`, `CONFLICT`, `UNASSIGNED`, `RESET`, `FAULT`. |
| `E <ileti>` | Hata/bilgi: `bad-frame`, `bad-time`, `unknown-command <x>`, `power-cut`, `store-ignored <yol>`, `store-write-failed <yol>`. |

### Örnek

```
> T 200000
< M APP                       (açılışta önce M BOOT, 150 ms sonra M APP)
< T 200000
> F 00084840 <uid48 6B>0501   (ASSIGN_ID yayını: NUM 5, kalıcı)
> T 1000
< F 026c.... <8 bayt> 0 201000  (ENUM_RSP onayı, kimlik = DEVTYPE 2 + hash10)
< T 201000
```

## Kartın davranışı

- Fabrika durumu: depo boş (NUM 63, sessiz), imaj alanında `--fw` sürümünde geçerli bir sentetik imaj.
- `REBOOT` → bootloader (kurtarma penceresiyle) → uygulama; `ENTER_BOOTLOADER` (`arg = 0xB0070000 | uid16`) → bootloader'da kalır; FW `END` sonrası 5 ms içinde yeni imajla uygulama. Uygulama sürümü kurulu imajın başlığından gelir.
- ESC modelinde CTRL/0 `SET`: `mode 0, value 0` nötr; nötrden başlama kuralı ve bekçi kütüphaneden gelir. `MEASURE_MOTOR` (0x40+) 500 ms süren uzun komuttur (ESTOP'ta `FAILED`).
- STATUS çerçeveleri sıfır doludur (yalnız zamanlama içindir); STREAM sinyalleri: ESC'de `setpoint`/`ctrl_mode`/`duty` uygulanan hedefi, diğer sid'ler `sid` değerini (f32) verir; tanımsız sid (>20) NaN.
