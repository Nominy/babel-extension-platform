# Shared extension frontend

All extension-owned UI uses white surfaces, compact controls, neutral borders,
shared typography, and one accent per extension: Helper `white`, Gold Drafting
`purple`, Review Helper `orange`. Custom six-digit hex accents are supported.
Semantic success, warning, and error colors are independent of the accent.

## DOM

```js
import { createComponent, themeRoot, applyComponent } from '@nominy/babel-extension-frontend';
const panel = createComponent('panel', { accent: 'purple' });
panel.append(createComponent('button', {
  text: 'Apply changes', variant: 'primary', on: { click: applyChanges }
}));
document.body.append(panel);
```

Use `applyComponent(existingElement, 'button', { variant: 'primary' })` when an
integration owns the element. HTML templates use `bui-button` and
`data-variant="primary"`, with `ensureUiStyles()` and a `bui-root` ancestor
carrying `data-bui-accent`. Styles do not reset the host page.

For Shadow DOM, call `themeRoot(panel, accent)` after mounting in the shadow
tree, or install `UI_STYLES` in the shadow template. `ensureUiStyles(root)`
installs one stylesheet per document or shadow root.

## React

```jsx
const Ui = createReactComponents(React.createElement);
ensureUiStyles();
<Ui.Panel accent="orange">
  <Ui.Header><Ui.Title>Review</Ui.Title></Ui.Header>
  <Ui.Body>...</Ui.Body>
  <Ui.Footer><Ui.Button variant="primary">Apply</Ui.Button></Ui.Footer>
</Ui.Panel>
```

React comes from the consumer; DOM extensions do not bundle it. Props including
events, ARIA attributes, `disabled`, and `as` pass through.

## Composition

Surfaces: page, page-shell, panel, card, header, body, footer, dialog, overlay,
backdrop, menu, menu-item, toast, tooltip, notice. Controls: button, icon-button,
input, select, textarea, checkbox, radio, range, color, toggle. Content: title,
heading, hint, status, badge, progress, spinner, diff, diff-pane, diff-label,
diff-text, kbd, code, table, details. Layout: row, stack, grid, field, divider.

`confirmDialog({ accent, title, message, confirmLabel })` returns a boolean,
uses native modal focus containment, starts on Cancel, cancels on Escape,
and restores focus to the opener.

Keep extension CSS limited to feature geometry and state. Shared visual changes
belong in `src/ui-styles.mjs`. Native transcript/waveform data colors and user
appearance settings remain domain data rather than extension UI themes.

Browser behavior and rendered themes are covered by `shared-ui.spec.mjs` in the
shared E2E package alongside each extension's real interaction journeys.
## Settings layout

Use `SettingsShell` (or `bui-settings-shell`) for options pages. It is based on
Babel Review settings: 640px maximum width, the shared page inset, Header,
Body, Stack and Card components. Use Title for the page heading and Label for
field names. Checkbox cards use `bui-setting-toggle`. Keep widths, fonts and
control padding in the shared library rather than per-extension CSS.

Settings documents use `bui-settings-document` on the HTML element to reserve
symmetric scrollbar gutters. This keeps the 640px shell centered identically
on short and long pages. The settings browser check uses visible scrollbars
and compares shell/header/title coordinates across all three extensions,
including forced scrolling and non-scrolling states.
