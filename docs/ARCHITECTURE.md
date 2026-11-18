# Cygnus Studio — Mimari

Cygnus Studio, Cygnus CAN ekosistemindeki kartları bulan, yapılandıran, ayarlayan (PID tuner), izleyen ve güncelleyen masaüstü uygulamasıdır (FRC'deki Phoenix Tuner X / REV Hardware Client karşılığı). Donanım çıkana kadar her şey, firmware davranışını taklit eden simülatöre karşı çalışır; donanım geldiğinde yalnızca aktarım katmanı değişir.

## Depo düzeni

```
docs/                   PROTOCOL.md · DEVICES.md · ARCHITECTURE.md · PLAN.md · CATALOG.md (üretilir)
packages/protocol/      @cygnus/protocol — saf TypeScript, DOM/Node bağımlılığı yok
  src/core/             kimlik düzeni, çerçeve tipleri, tüm mesaj codec'leri, crc32, fnv, cyfw
  src/catalog/          model katalogları (tek doğruluk kaynağı) + şema
  src/transport/        Transport arayüzü, slcan codec'i
  src/host/             host istemcisi: CygnusBus, DeviceHandle, keşif, parametre, akış, firmware
  src/legacy/           Cyncoder v3 (FRC) sürücüsü
packages/vehicles/      @cygnus/vehicles — araç şablonları (saf veri) ve yapılandırma planlayıcısı
packages/simulator/     @cygnus/simulator — sanal hat + sanal kartlar (firmware tarafının referans gerçeklemesi)
apps/studio/            React + Vite arayüz; src-tauri/ masaüstü kabuğu
firmware/cycan/         Kartlar için taşınabilir C kütüphanesi (CyCAN düğüm tarafı) + host testleri
tools/                  katalogdan C başlığı ve CATALOG.md üreten betikler
```

npm workspaces. Paketler derlenmeden kaynak olarak tüketilir (`"main": "src/index.ts"`); doğrulama `tsc --noEmit` + `vitest`.

## Katmanlar

```
Arayüz (React)  ──  core/ servisleri (Zustand)  ──  CygnusBus (host istemcisi)  ──  Transport
                                                                                     ├─ SimTransport   → @cygnus/simulator
                                                                                     ├─ SlcanTransport → WebSerial | Tauri seri port
                                                                                     └─ (ileride) roboRIO köprüsü, SocketCAN
```

### Sözleşmeler

```ts
interface CanFrame { id: number; data: Uint8Array; fd: boolean; brs: boolean; timestamp: number /* ms */ }

interface Transport {
  readonly info: { kind: 'sim' | 'slcan' | string; label: string; fd: boolean };
  open(): Promise<void>;
  close(): Promise<void>;
  send(frame: Omit<CanFrame, 'timestamp'>): void;
  onFrame(cb: (f: CanFrame) => void): () => void;          // abonelikten çıkış fonksiyonu döner
  onState(cb: (s: TransportState) => void): () => void;     // 'closed'|'opening'|'open'|'error' + hata metni
}

interface Scheduler { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
```

- Host istemcisi ve simülatör zamanı yalnızca `Scheduler` üzerinden okur. Testlerde `ManualScheduler` ile zaman elle ilerletilir; hiçbir testte gerçek bekleme (`sleep`) olmaz.
- Simülatör adım tabanlıdır: `sim.advance(ms)`. Uygulamada bir `RealtimeRunner` onu duvar saatine bağlar.
- Katalog tek kaynaktır: host istemcisi, simülatör, arayüz formları, C başlığı ve CATALOG.md hep ondan beslenir. Arayüzde modele özel elle yazılmış form olmaz; formlar katalogdan üretilir (modele özel *görselleştirme* serbesttir).
- Sürücü soyutlaması: `CygnusBus` çerçeveleri sürücülere dağıtır (CyCAN, Cyncoder v3). Her sürücü cihazları aynı `DeviceHandle` yüzeyiyle sunar; arayüz protokol ayrımını bilmez.

## Arayüz

Hedef: pitte, güneş altında, eldivenle, acele içinde kullanılabilen; ilk açılışta donanımsız bile etkileyen bir araç.

Gezinme (sol şerit): **Hat** · **Araç** · **Cihaz** · **Tuner** · **Grafik** · **CAN İzleyici** · **Firmware** · **Proje**.
Üst çubuk: bağlantı seçici (Simülatör senaryosu / seri port), hat sağlığı (yük %, çerçeve/s, hata), dil (TR/EN), tema, her zaman görünen **ACİL DURDUR** (boşluk tuşu).

| Ekran | İçerik |
|---|---|
| Hat | Bulunan kartlar (durum noktası, ad, model, numara, firmware, hata), çakışma/atanmamış kart çözücü, LED ile tanıt, hat şeması, güç özeti |
| Araç | Araç şablonu seçimi, kartları şase şemasındaki yuvalara atama, motor testi, canlı şema (bkz. `docs/VEHICLES.md`) |
| Cihaz | Canlı kutucuklar, modele özel görsel (ör. kanal akım çubukları, açı kadranı, yapay ufuk), katalogdan üretilen ayar formu (kirli durum, uygula, karta kaydet, geri al, varsayılan), eylemler, hatalar, öz-test |
| Tuner | Döngü seçimi (akım/hız/konum), hedef üreteci (elle, basamak, kare, sinüs, rampa), kazanç düzenleme, yüksek hızlı grafik, basamak yanıtı ölçütleri, koşu geçmişi ve karşılaştırma, kazanç önerisi |
| Grafik | Her karttan çoklu sinyal, duraklat/yakınlaştır/imleç, kayıt ve CSV dışa aktarma |
| CAN İzleyici | Ham çerçeveler, çözümlenmiş görünüm, süzgeç, çerçeve gönder, hat istatistikleri |
| Firmware | `.cyfw` yükleme, sürüm karşılaştırma, tek kart / tüm kartlar güncelleme |
| Proje | Hattın tüm ayarlarını dosyaya kaydet/yükle, kart ile dosya farkı, aynı modele kopyala, kod parçası üret |

Güvenlik kuralları (eyleyici süren her ekran): sürme açıkça **etkinleştirilir**; pencere odağı kaybı, bağlantı kopması, sayfa değişimi ve boşluk tuşu sürmeyi keser; ACİL DURDUR her ekranda tek tıktır.

### Tasarım dili (yatırımcı sunumuyla aynı)

| Belirteç | Koyu tema |
|---|---|
| Zemin / panel / panel-2 | `#0A1931` / `#0F2347` / `#152A52` |
| Çizgi / seçili | `#22396B` / `#163A6B` |
| Metin / ikincil / soluk | `#FFFFFF` / `#C9D6EA` / `#8FA3BF` |
| Vurgu | `#4FC3EA` |
| İyi / uyarı / dikkat / tehlike | `#3DDC84` / `#F2C94C` / `#F28C3B` / `#F2685B` |

Yazı: Lato (arayüz), JetBrains Mono (sayılar, kimlikler, ham veri). Yazı tipleri pakete gömülür; uygulama çevrimdışı çalışır. Açık tema da vardır (dış mekân).

### Diller

Türkçe varsayılan, İngilizce ikinci. Tüm metinler sözlükten gelir; katalog etiketleri zaten iki dillidir.

## Kalite çıtası

- `npm run typecheck`, `npm test` hatasız; protokol codec'leri için altın vektörler (TS ↔ C aynı vektörleri doğrular).
- Host istemcisi ↔ simülatör bütünleşik testleri: keşif, çakışma çözme, parametre, akış, firmware güncelleme, bağlantı kopması.
- Arayüz, simülatörle tarayıcıda uçtan uca açılıp ekran görüntüsüyle doğrulanır.
