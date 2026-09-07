// Shared presentation for every extension-owned surface. Layout that describes
// a product (timeline geometry, editor columns) remains with that product.
export const UI_STYLES = `
.bui-root {
  --bui-bg: #f5f5f5; --bui-surface: #fff; --bui-soft: #fafafa;
  --bui-ink: #1a1a1a; --bui-muted: #737373; --bui-faint: #a3a3a3;
  --bui-line: #e5e5e5; --bui-line-strong: #d4d4d4;
  --bui-accent: #fff; --bui-on-accent: #1a1a1a; --bui-accent-ink: #404040;
  --bui-accent-soft: #f5f5f5; --bui-accent-border: #d4d4d4;
  --bui-danger: #dc2626; --bui-danger-soft: #fef2f2;
  --bui-warning: #92400e; --bui-warning-soft: #fffbeb;
  --bui-success: #15803d; --bui-success-soft: #f0fdf4;
  --bui-radius: 8px; --bui-radius-sm: 6px;
  --bui-shadow: 0 12px 36px rgb(0 0 0 / .12);
  --bui-dialog-shadow: 0 24px 72px rgb(0 0 0 / .2);
  --bui-font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --bui-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font: 13px/1.5 var(--bui-font); color: var(--bui-ink); color-scheme: light;
  text-align: left; box-sizing: border-box;
}
.bui-root[data-bui-accent="orange"] {
  --bui-accent: #e8612d; --bui-on-accent: #fff; --bui-accent-ink: #b53c10;
  --bui-accent-soft: #fff5ef; --bui-accent-border: #e8612d;
}
.bui-root[data-bui-accent="purple"] {
  --bui-accent: #7c3aed; --bui-on-accent: #fff; --bui-accent-ink: #6d28d9;
  --bui-accent-soft: #f5f0ff; --bui-accent-border: #7c3aed;
  --bui-attached-bg: #f3e8ff; --bui-attached-line: #c084fc;
}
.bui-root[data-bui-accent="purple"][data-variant="tinted"] {
  --bui-surface: #fcfbff; --bui-soft: #faf5ff;
  --bui-ink: #221b2d; --bui-muted: #7c6995;
  --bui-line: #eadff7; --bui-line-strong: #d8b4fe;
  --bui-button-bg: #faf5ff; --bui-header-bg: #faf5ff;
  --bui-backdrop: rgba(15, 10, 25, .42);
  --bui-dialog-shadow: 0 24px 72px rgba(15, 10, 25, .28);
}
.bui-root *, .bui-root *::before, .bui-root *::after { box-sizing: border-box; }
.bui-root[hidden], .bui-root [hidden] { display: none !important; }
.bui-root :where(h1,h2,h3,h4,p) { margin: 0; }
.bui-root :where(button,input,select,textarea) { font: inherit; }
.bui-root :where(button,a,input,select,textarea,summary,[tabindex]):focus-visible {
  outline: 2px solid var(--bui-accent-ink); outline-offset: 3px;
}
.bui-settings-document { scrollbar-gutter: stable both-edges; background: #f5f5f5; }
.bui-page { margin: 0; min-height: 100vh; padding: 20px; background: var(--bui-bg); }
.bui-page-shell { width: 100%; max-width: 1040px; margin-inline: auto; display: grid; gap: 12px; }
.bui-settings-shell { overflow-wrap: anywhere; width: 100%; max-width: 640px; margin-inline: auto; }
.bui-settings-shell .bui-button { max-width: 100%; white-space: normal; }
.bui-setting-toggle { display: grid; grid-template-columns: 16px minmax(0,1fr); align-items: start; gap: 8px; cursor: pointer; }
.bui-setting-toggle > :not(input) { display: grid; gap: 8px; min-width: 0; }
.bui-setting-toggle > input { margin-top: 2px; }
.bui-surface, .bui-panel, .bui-card, .bui-dialog, .bui-menu, .bui-toast, .bui-tooltip {
  background: var(--bui-surface); color: var(--bui-ink); border: 1px solid var(--bui-line);
  border-radius: var(--bui-radius);
}
.bui-panel { overflow: hidden; }
.bui-card { padding: 12px; display: grid; gap: 8px; min-width: 0; }
.bui-header, .bui-footer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 16px; background: var(--bui-header-bg, var(--bui-surface)); }
.bui-header { justify-content: space-between; border-bottom: 1px solid var(--bui-line); }
.bui-footer { justify-content: flex-end; border-top: 1px solid var(--bui-line); }
.bui-title { font-size: 14px; font-weight: 600; line-height: 1.4; }
.bui-heading { font-size: 20px; font-weight: 650; line-height: 1.3; }
.bui-subtitle, .bui-meta, .bui-status, .bui-hint { font-size: 12px; color: var(--bui-muted); }
.bui-hint { line-height: 1.5; font-weight: 400; }
.bui-status[data-error="true"], .bui-status[data-tone="danger"] { color: var(--bui-danger); }
.bui-status[data-tone="success"] { color: var(--bui-success); }
.bui-body { padding: 14px 16px; display: grid; gap: 12px; min-width: 0; }
.bui-stack { display: grid; gap: 10px; min-width: 0; }
.bui-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bui-row[data-align="between"] { justify-content: space-between; }
.bui-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px,100%),1fr)); gap: 12px; }
.bui-divider { border: 0; border-top: 1px solid var(--bui-line); margin: 8px 0; }
.bui-label, .bui-section-title { font-size: 11px; font-weight: 600; color: var(--bui-muted); }
.bui-section-title { padding: 9px 12px; border-bottom: 1px solid var(--bui-line); background: var(--bui-soft); text-transform: uppercase; letter-spacing: .05em; }
.bui-field { display: grid; gap: 5px; min-width: 0; }
.bui-control, .bui-input, .bui-select, .bui-textarea {
  width: 100%; min-width: 0; border: 1px solid var(--bui-line-strong); border-radius: var(--bui-radius-sm);
  background: var(--bui-surface); color: var(--bui-ink); padding: 7px 9px; font: inherit; line-height: 1.4;
}
.bui-textarea { resize: vertical; min-height: 72px; }
.bui-control::placeholder, .bui-input::placeholder, .bui-textarea::placeholder { color: var(--bui-faint); }
.bui-checkbox, .bui-radio, .bui-range { accent-color: var(--bui-accent-ink); }
.bui-checkbox, .bui-radio { width: 16px; height: 16px; margin: 0; flex: 0 0 auto; cursor: pointer; }
.bui-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.bui-range { width: 100%; margin: 0; cursor: pointer; }
.bui-color { width: 100%; height: 32px; padding: 3px; background: var(--bui-surface); border: 1px solid var(--bui-line-strong); border-radius: var(--bui-radius-sm); cursor: pointer; }
.bui-button, .bui-icon-button, .bui-menu-item {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid var(--bui-line-strong); border-radius: var(--bui-radius-sm);
  background: var(--bui-button-bg, var(--bui-surface)); color: var(--bui-ink); padding: 7px 11px;
  font: 600 12px/1.4 var(--bui-font); text-decoration: none; cursor: pointer; white-space: nowrap;
}
.bui-button:hover, .bui-icon-button:hover, .bui-menu-item:hover { background: var(--bui-soft); border-color: var(--bui-faint); }
.bui-button[data-variant="primary"], .bui-icon-button[data-variant="primary"] {
  background: var(--bui-accent); color: var(--bui-on-accent); border-color: var(--bui-accent-border);
}
.bui-button[data-variant="primary"]:hover, .bui-icon-button[data-variant="primary"]:hover { filter: brightness(.95); }
.bui-button[data-variant="soft"], .bui-icon-button[data-variant="soft"] { background: var(--bui-accent-soft); color: var(--bui-accent-ink); border-color: color-mix(in srgb, var(--bui-accent) 35%, white); }
.bui-button[data-variant="soft"]:hover, .bui-icon-button[data-variant="soft"]:hover { background: color-mix(in srgb, var(--bui-accent) 12%, white); border-color: var(--bui-accent); }
.bui-icon-button[data-variant="soft"][data-attached-open="true"], .bui-attached-status {
  background: var(--bui-attached-bg, var(--bui-accent-soft));
  color: var(--bui-accent); border: 1px solid var(--bui-attached-line, var(--bui-accent-border));
}
.bui-icon-button[data-variant="soft"][data-attached-open="true"] { border-radius: var(--bui-radius-sm) 0 0 var(--bui-radius-sm); border-right-color: transparent; }
.bui-attached-status {
  display: flex; align-items: center; width: max-content; max-width: min(360px, calc(100vw - 24px));
  height: 36px; box-sizing: border-box; padding: 0 12px; border-left: 0;
  border-radius: 0 var(--bui-radius-sm) var(--bui-radius-sm) 0; box-shadow: none;
  font: 600 12px/1.2 var(--bui-font); white-space: nowrap;
}
.bui-attached-status .bui-row { min-width: 0; flex-wrap: nowrap; }
.bui-attached-status .bui-status-copy { overflow: hidden; text-overflow: ellipsis; }
.bui-attached-status .bui-button { padding: 0; border: 0; background: transparent; color: var(--bui-accent-ink); font-size: 12px; text-decoration: underline; }
.bui-button[data-variant="danger"] { color: var(--bui-danger); border-color: #fecaca; background: var(--bui-danger-soft); }
.bui-button[data-variant="ghost"] { background: transparent; border-color: transparent; }
.bui-button[data-size="sm"], .bui-menu-item[data-size="sm"] { padding: 4px 8px; font-size: 11px; }
.bui-icon-button { width: 36px; height: 36px; padding: 0; flex: 0 0 auto; }
.bui-root :where(button,input,select,textarea):disabled, .bui-button[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.bui-link { color: var(--bui-accent-ink); text-decoration: none; cursor: pointer; }
.bui-link:hover { text-decoration: underline; }
.bui-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; background: var(--bui-accent-soft); color: var(--bui-accent-ink); font-size: 11px; font-weight: 600; }
.bui-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--bui-accent-ink); }
.bui-empty { padding: 20px 12px; text-align: center; color: var(--bui-muted); background: var(--bui-soft); border-radius: var(--bui-radius-sm); font-size: 12px; }
.bui-notice { padding: 10px 12px; border: 1px solid var(--bui-line); border-left: 3px solid var(--bui-accent-ink); border-radius: var(--bui-radius-sm); background: var(--bui-accent-soft); display: grid; gap: 8px; font-size: 12px; }
.bui-notice[data-tone="warning"] { border-left-color: var(--bui-warning); background: var(--bui-warning-soft); color: var(--bui-warning); }
.bui-notice[data-tone="danger"], .bui-card[data-tone="danger"] { border-color: #fecaca; background: var(--bui-danger-soft); }
.bui-notice[data-tone="success"] { border-left-color: var(--bui-success); background: var(--bui-success-soft); }
.bui-overlay { position: fixed; inset: 0; z-index: 2147483647; }
.bui-backdrop { position: absolute; inset: 0; background: var(--bui-backdrop, rgb(0 0 0 / .38)); backdrop-filter: blur(2px); }
.bui-dialog-position { position: relative; height: 100%; display: flex; align-items: center; justify-content: center; padding: 16px; pointer-events: none; }
.bui-dialog { width: min(980px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; box-shadow: var(--bui-dialog-shadow); pointer-events: auto; }
.bui-dialog > .bui-header { position: sticky; top: 0; z-index: 2; }
.bui-dialog > .bui-footer { position: sticky; bottom: 0; z-index: 2; }
dialog.bui-dialog { padding: 0; width: min(460px, calc(100vw - 32px)); }
dialog.bui-dialog::backdrop { background: rgb(0 0 0 / .38); backdrop-filter: blur(2px); }
.bui-menu-item[aria-selected="true"] { background: var(--bui-accent-soft); border-color: var(--bui-accent-border); }
.bui-badge[data-tone="danger"] { color: var(--bui-danger); background: var(--bui-danger-soft); }
.bui-menu { margin: 0; list-style: none; padding: 4px; min-width: 160px; box-shadow: var(--bui-shadow); }
.bui-menu-item { width: 100%; justify-content: flex-start; border-color: transparent; }
.bui-tooltip { padding: 6px 9px; font-size: 11px; box-shadow: var(--bui-shadow); max-width: min(360px,calc(100vw - 24px)); }
.bui-toast { z-index: 2147483646; padding: 12px 14px; width: min(340px, calc(100vw - 36px)); box-shadow: var(--bui-shadow); display: grid; gap: 8px; }
.bui-toast[data-tone="danger"] { background: var(--bui-danger-soft); border-color: #fecaca; }
.bui-toast[data-tone="success"] { background: var(--bui-success-soft); border-color: #bbf7d0; }
.bui-toast[data-tone="warning"] { background: var(--bui-warning-soft); border-color: #fde68a; }
.bui-progress { width: 100%; height: 6px; overflow: hidden; border: 0; border-radius: 999px; background: var(--bui-line); }
.bui-progress-fill { height: 100%; width: 0; border-radius: inherit; background: var(--bui-accent-ink); transition: width 120ms ease; }
.bui-progress-fill[data-tone="danger"] { background: var(--bui-danger); }
.bui-progress-fill[data-tone="success"] { background: var(--bui-success); }
.bui-progress[data-indeterminate="true"] > .bui-progress-fill { width: 35% !important; transition: none !important; animation: bui-progress-slide 1.4s linear infinite; }
@keyframes bui-progress-slide { from { transform: translateX(-100%); } to { transform: translateX(286%); } }
.bui-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: bui-spin .7s linear infinite; }
.bui-diff { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 8px; }
.bui-diff-pane { min-width: 0; display: grid; align-content: start; gap: 4px; }
.bui-diff-label { font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--bui-muted); }
.bui-diff-text { border: 1px solid var(--bui-line); border-radius: var(--bui-radius-sm); background: var(--bui-soft); padding: 8px; font: 11px/1.6 var(--bui-mono); white-space: pre-wrap; overflow-wrap: anywhere; min-height: 58px; }
.bui-code, .bui-kbd { font-family: var(--bui-mono); font-size: 11px; }
.bui-kbd { border: 1px solid var(--bui-line-strong); border-bottom-width: 2px; background: var(--bui-soft); padding: 2px 5px; border-radius: 4px; }
.bui-details { border-top: 1px solid var(--bui-line); padding-top: 10px; }
.bui-summary { cursor: pointer; color: var(--bui-ink); font-size: 12px; font-weight: 600; padding-block: 4px; }
.bui-list { margin: 0; padding-left: 18px; font-size: 12px; color: var(--bui-muted); }
.bui-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.bui-table :where(td,th) { padding: 7px 9px; border-bottom: 1px solid var(--bui-line); text-align: left; }
.bui-table th { color: var(--bui-muted); font-weight: 600; }
@keyframes bui-spin { to { transform: rotate(360deg); } }
@media (max-width: 640px) { .bui-page { padding: 12px; } .bui-diff { grid-template-columns: minmax(0,1fr); } .bui-header, .bui-footer, .bui-body { padding: 12px; } }
@media (prefers-reduced-motion: reduce) { .bui-root *, .bui-root *::before, .bui-root *::after { transition: none !important; animation-duration: .001ms !important; animation-iteration-count: 1 !important; } }
`;
