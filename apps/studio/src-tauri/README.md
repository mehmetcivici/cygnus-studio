# Cygnus Studio masaüstü kabuğu (Tauri v2)

Web sürümüne ek olarak yerel **seri port** (USB-CAN adaptör, slcan) ve **TCP** (roboRIO köprüsü, port 5800) erişimi sağlar.

```
src-tauri/
  crates/cygnus-link/   arayüzsüz bağlantı mantığı (seri + TCP, okuma iş parçacığı, bağlantı kimlikleri)
  src/lib.rs            ince Tauri katmanı: link_list_serial · link_open_serial · link_open_tcp · link_write · link_close
../src/core/transports/tauri.ts   ön yüz bağdaştırıcısı (ByteStream)
```

Veri akışı: gelen baytlar ham `ArrayBuffer` olarak `Channel` ile, giden baytlar ham istek gövdesiyle taşınır (JSON/base64 yok). Beklenmeyen kopma `link://closed` olayıyla bildirilir.

## Ön koşullar

- Node 22, Rust (stable) — https://tauri.app/start/prerequisites/
- **Linux:** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libudev-dev libssl-dev pkg-config`. Seri port erişimi için kullanıcı `dialout` grubunda olmalı (`sudo usermod -aG dialout $USER`, ardından oturumu yeniden aç).
- **macOS:** Xcode Command Line Tools.
- **Windows:** WebView2 (Windows 11'de hazır) ve MSVC Build Tools.

## Geliştirme ve derleme

```
npm ci
npm run tauri dev -w @cygnus/studio          # Vite'ı 1420 portunda başlatır, pencereyi açar
npm run tauri build -w @cygnus/studio        # kurulum paketlerini src-tauri/target/release/bundle altına üretir
cargo test -p cygnus-link --manifest-path apps/studio/src-tauri/Cargo.toml   # GUI gerektirmez
```

## Sürüm çıkarma

1. `apps/studio/package.json`, `src-tauri/tauri.conf.json` ve `src-tauri/Cargo.toml` içindeki sürümü aynı değere getir.
2. `git tag v0.1.0 && git push origin v0.1.0` (ya da Actions sekmesinden "Release" iş akışını elle çalıştır).
3. `release.yml` macOS (universal), Windows ve Linux paketlerini üretip **taslak** GitHub Release'e ekler; taslağı inceleyip yayınla.

CI (`ci.yml`) her push/PR'da typecheck, vitest, firmware testleri ve `cargo test -p cygnus-link` çalıştırır.

## İmzasız paketler

Paketler şu an **imzalı değil** (Apple/Windows sertifikası yok).

- **macOS Gatekeeper:** "hasarlı / doğrulanamadı" uyarısı çıkar. Uygulamayı Applications'a taşıyıp sağ tık → Aç, ya da `xattr -dr com.apple.quarantine "/Applications/Cygnus Studio.app"`.
- **Windows SmartScreen:** "Windows bilgisayarınızı korudu" ekranında *Ek bilgi → Yine de çalıştır*.
- **Linux:** AppImage için `chmod +x`; `.deb` için `sudo apt install ./Cygnus*.deb`.

İleride imzalama için tauri-action'a Apple (`APPLE_CERTIFICATE`, notarization) ve Windows kod imzalama gizli değişkenleri eklenir.
