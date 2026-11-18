import { CarFront } from 'lucide-react';
import { EmptyState, Page } from '../../ui';
import type { FeatureProps } from '../registry';
import { tVehicle } from './messages';

export function VehicleScreen(_props: FeatureProps) {
  return (
    <Page title={tVehicle('nav')} subtitle={tVehicle('subtitle')} icon={CarFront}>
      <EmptyState icon={CarFront} title={tVehicle('placeholderTitle')} description={tVehicle('placeholderBody')} />
    </Page>
  );
}
