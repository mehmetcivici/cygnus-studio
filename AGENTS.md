# Çalışma kuralları (bu depoda çalışan her ajan için)

Önce oku: `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`; cihazlarla ilgili işte `docs/DEVICES.md`. Görevinin dışındaki büyük dosyaları baştan sona okuma; `grep` ile ihtiyacın olan yeri bul.

## Sınırlar

- Yalnızca görevinde sana verilen dizinlerde dosya oluştur/değiştir. Başka bir dizinde değişiklik şartsa yapma; raporunda "İstek" olarak yaz.
- **git komutu çalıştırma** (commit, add, stash, checkout yok). Sürüm yönetimini yönetici yapar. Aynı anda başka ajanlar başka dizinlerde çalışıyor olabilir.
- Yeni bağımlılık ekleme. Gerçekten şartsa `npm install <paket> -w <çalışma-alanı>` kullan ve raporunda gerekçesiyle belirt.
- `docs/PROTOCOL.md` ile çelişen bir şey gerekiyorsa belgeyi değiştirme; raporda "Protokol sorusu" olarak yaz ve belgeye en yakın yorumu uygula.

## Kod

- Kod, tanımlayıcılar ve kod yorumları İngilizce. Kullanıcıya görünen her metin sözlükten gelir (TR varsayılan + EN).
- TypeScript `strict`; `any` yok (`unknown` + daraltma). Varsayılan dışa aktarım yok, adlandırılmış dışa aktarım kullan.
- `@cygnus/protocol` ve `@cygnus/simulator` saf TS'dir: DOM, Node API'si, zamanlayıcı globali kullanmaz; zaman `Scheduler` üzerinden gelir.
- Yorumlar "neden"i anlatsın; kodu tekrar eden yorum yazma. Gereksiz soyutlama, kullanılmayan kod, TODO yığını bırakma.
- Testler `vitest`; gerçek bekleme yok, `ManualScheduler` kullan. Test dosyaları: paketlerde `test/`, uygulamada kaynağın yanında `*.test.ts(x)`.

## Bitirmeden önce

Depo kökünde çalıştır ve hatasız olduğunu gör:

```
npm run typecheck
npx vitest run <kendi test yolun>
```

Arayüz işi yaptıysan uygulamayı aç (`npm run dev -w @cygnus/studio -- --port <boş port>`), `playwright-core` + `/usr/bin/google-chrome` ile ekran görüntüsü al (`executablePath: '/usr/bin/google-chrome'`, `args: ['--no-sandbox']`), görüntüyü kendin incele ve gördüğün kusurları düzelt. Dev sunucusunu ve tarayıcıyı kapatmayı unutma.

## Rapor (son mesajın)

En fazla 250 kelime, Türkçe, düz metin:

1. Ne teslim edildi (dosya/dizin düzeyinde, tek satırlık maddeler).
2. Doğrulama: çalıştırdığın komutlar ve sonuçları (geçen test sayısı).
3. Sonraki ajanların bilmesi gereken arayüzler: yalnızca dosya yolları ve en önemli 5–10 dışa aktarım adı.
4. Açık kalanlar / Protokol soruları / İstekler.

Kod dökme, dosya içeriği yapıştırma.

## Ekran ajanları için ek kurallar (apps/studio/src/features/*)

- Önce oku: `apps/studio/src/core/README.md` (çekirdek API'si), `packages/protocol/src/host/README.md`, `packages/simulator/README.md`. Bileşen kullanımı için `src/features/gallery/` ve örnek ekran olarak `src/features/bus/`.
- Yalnızca kendi özellik dizin(ler)inde çalış. `src/core`, `src/ui`, `src/app`, `registry.ts` ve diğer ekranların dizinleri sana kapalı; eksik gördüğünü kendi dizininde çöz ve raporda "İstek" olarak yaz. İstisna: seni engelleyen bariz bir hata için en küçük düzeltme (dosyayı düzenlemeden hemen önce yeniden oku, raporda belirt).
- Ekranının sözlüğü kendi dizinindeki `messages.ts`'te (TR + EN). Kalıcı veri için `defineProjectSection` kullan.
- Eyleyici süren her şey `useDriveSession` + `ArmButton` üzerinden gider; kendi başına CTRL gönderen kod yazma.
- Aynı anda başka ajanlar başka ekranları yazıyor: kök `npm run typecheck` onların yarım işinden dolayı düşebilir. Kendi dosyalarında hata olmadığını doğrula: `npx tsc --noEmit -p apps/studio 2>&1 | grep "features/<dizinin>"` boş dönmeli. Testlerde yalnız kendi yolunu çalıştır.
- Dev sunucusunu sana verilen portta aç ve iş bitince YALNIZ kendi sürecini kapat (`kill <pid>`); `pkill vite`/`pkill chrome` KULLANMA, diğer ajanların süreçlerini öldürürsün. Playwright'ı `chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })` ile kullan, ekran görüntülerini `/tmp/shots-<dizinin>/` altına al ve kendin incele.
- Belirli bir senaryoyla açmak için bağlantı yöneticisinin API'sini kullan (README'de); testlerde Playwright ile üst çubuktaki bağlantı menüsünden de seçebilirsin.
- Görsel çıta: Hat ekranı ve galeri. Yoğun ama ferah, hizalı, tutarlı; boş/yükleniyor/hata/bağlantı yok durumlarının hepsi tasarlanmış olmalı. 1440×900 ve 1100×700'de taşma olmamalı.
