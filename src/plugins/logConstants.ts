/**
 * Console prefix and style the plugin layer logs under. A leaf module (no
 * imports) that `host.ts` and `runtime.ts` both value-import, so they share
 * the constants without the host gaining a runtime-module dependency.
 */
export const LOG_PREFIX = '%c[plugins]';
export const LOG_STYLE = 'color:#40bfc4';
