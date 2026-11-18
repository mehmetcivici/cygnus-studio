import { defineProjectSection } from '../../core';
import { defaultLayout, isScopeLayout, type ScopeLayout } from './layout';

/** Panes, plotted signals and window; saved with the project file. */
export const scopeLayoutSection = defineProjectSection<ScopeLayout>('scope.layout', { initial: defaultLayout(), validate: isScopeLayout });
