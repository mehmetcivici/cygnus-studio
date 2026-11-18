import { useDrive } from '../core';
import { DriveBannerView, useGlobalDriveBannerHost } from '../core/safety/DriveBanner';
import { useI18n } from '../i18n';
import { findFeature } from '../features/registry';
import { navigate, useNav } from './nav';

/** Screen id that owns a drive session (`device.oled` → `device`). */
export function ownerScreen(owner: string): string {
  return owner.split('.')[0] ?? owner;
}

/**
 * Global drive banner: whatever screen is open, an armed session shows a loud strip with its
 * owner and board above the content, and `is-driving` frames the whole content area.
 */
export function GlobalDriveBanner() {
  useGlobalDriveBannerHost();
  const { t } = useI18n();
  const info = useDrive((s) => s.session);
  const screen = useNav((s) => s.screen);
  const params = useNav((s) => s.params);
  const owner = info ? ownerScreen(info.owner) : null;
  const feature = owner ? findFeature(owner) : undefined;
  const elsewhere = !!info?.armed && owner !== null && owner !== screen;
  return (
    <div className="cy-shell__drive">
      <DriveBannerView
        ownerLabel={feature ? t(feature.labelKey) : info?.owner}
        onGoToOwner={elsewhere && owner ? () => navigate(owner, info ? { ...params, device: info.uid48 } : params) : undefined}
      />
    </div>
  );
}

export function useDriving(): boolean {
  return useDrive((s) => s.session?.armed === true);
}
