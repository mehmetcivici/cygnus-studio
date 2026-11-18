import { Suspense } from 'react';
import { CircleX, SearchX } from 'lucide-react';
import { useI18n } from '../i18n';
import { Button, EmptyState, Spinner, cx } from '../ui';
import { findFeature } from '../features/registry';
import { DEFAULT_SCREEN, useNav } from './nav';
import { ErrorBoundary } from './ErrorBoundary';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { StatusBar } from './StatusBar';
import { SimDrawer } from './sim/SimPanel';
import { GlobalDriveBanner, useDriving } from './DriveFrame';
import { BusyPrompt } from './BusyPrompt';
import { ReportPreview } from './ReportPreview';
import './shell.css';

function Screen() {
  const { t } = useI18n();
  const screen = useNav((s) => s.screen);
  const params = useNav((s) => s.params);
  const navigate = useNav((s) => s.navigate);
  const feature = findFeature(screen);
  if (!feature) {
    return (
      <EmptyState
        icon={SearchX}
        title={t('app.pageNotFound')}
        description={t('app.pageNotFoundBody', { id: screen })}
        actions={
          <Button variant="primary" onClick={() => navigate(DEFAULT_SCREEN)}>
            {t('app.goHome')}
          </Button>
        }
      />
    );
  }
  const View = feature.component;
  return (
    <ErrorBoundary
      resetKey={screen}
      fallback={(err) => <EmptyState icon={CircleX} title={t('app.pageError')} description={<span className="cy-mono">{err.message}</span>} />}
    >
      <Suspense
        fallback={
          <div className="cy-shell__loading">
            <Spinner size={22} label={t('common.loading')} />
          </div>
        }
      >
        <View params={params} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Application frame: top bar, navigation rail, content, status bar. */
export function Shell() {
  const driving = useDriving();
  return (
    <div className="cy-shell">
      <TopBar />
      <Sidebar />
      <main className={cx('cy-shell__main', driving && 'is-driving')}>
        <GlobalDriveBanner />
        <div className="cy-shell__screen">
          <Screen />
        </div>
      </main>
      <StatusBar />
      <SimDrawer />
      <BusyPrompt />
      <ReportPreview />
    </div>
  );
}
