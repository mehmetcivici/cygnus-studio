import { Suspense } from 'react';
import { CircleX, SearchX } from 'lucide-react';
import { useI18n } from '../i18n';
import { Button, EmptyState, Spinner } from '../ui';
import { findFeature } from '../features/registry';
import { DEFAULT_SCREEN, useNav } from './nav';
import { ErrorBoundary } from './ErrorBoundary';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { StatusBar } from './StatusBar';
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
  return (
    <div className="cy-shell">
      <TopBar />
      <Sidebar />
      <main className="cy-shell__main">
        <Screen />
      </main>
      <StatusBar />
    </div>
  );
}
