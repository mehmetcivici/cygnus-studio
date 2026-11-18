import { useMemo } from 'react';
import { useDevices, type DeviceView } from '../../core';
import { assessCard, compatibleImages, type CardAssessment, type FwImage } from './logic';
import { useFwLibrary } from './store';

export interface FwRow {
  view: DeviceView;
  assessment: CardAssessment;
  /** Every compatible image, newest first. */
  compatible: FwImage[];
}

/** Boards that can be addressed (numbered, no clash) against the current library. */
export function useFwRows(): { rows: FwRow[]; unresolved: number } {
  const devices = useDevices();
  const images = useFwLibrary((s) => s.images);
  return useMemo(() => {
    const rows: FwRow[] = [];
    let unresolved = 0;
    for (const view of devices) {
      if (view.unassigned || view.conflict) {
        unresolved++;
        continue;
      }
      const card = { model: view.model, hwRev: view.hwRev, online: view.online, legacy: view.legacy, firmwareCapable: !view.legacy, bootloader: view.bootloader, fw: view.fw };
      rows.push({ view, assessment: assessCard(card, images), compatible: compatibleImages(images, card) });
    }
    return { rows, unresolved };
  }, [devices, images]);
}
