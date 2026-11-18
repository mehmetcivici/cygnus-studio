// Fonts are bundled from @fontsource so the app works fully offline.
import '@fontsource/lato/400.css';
import '@fontsource/lato/700.css';
import '@fontsource/lato/900.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './tokens.css';
import './base.css';

export { useTheme, resolveColor, chartColor, CHART_COLORS } from './theme';
export type { ThemeName } from './theme';
