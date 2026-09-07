import { UI_STYLES } from './ui-styles.mjs';
export { UI_STYLES } from './ui-styles.mjs';

const STYLE_ID = 'babel-shared-components-style';
const tags = {
  button: 'button', 'icon-button': 'button', input: 'input', checkbox: 'input', radio: 'input',
  range: 'input', color: 'input', select: 'select', textarea: 'textarea', field: 'label', label: 'span',
  link: 'a', title: 'h2', heading: 'h1', subtitle: 'p', hint: 'p', kbd: 'kbd', code: 'code',
  list: 'ul', divider: 'hr', details: 'details', summary: 'summary', table: 'table', 'menu-item': 'button',
};

export function componentClass(component, className = '') {
  return `bui-${component}${className ? ` ${className}` : ''}`;
}

export function ensureUiStyles(root = document) {
  if (root.getElementById?.(STYLE_ID) || root.querySelector?.(`#${STYLE_ID}`)) return;
  const doc = root.ownerDocument || root;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = UI_STYLES;
  (root.head || root.documentElement || root).appendChild(style);
}

export function themeProps(accent = 'white') {
  if (['white', 'purple', 'orange'].includes(accent)) return { className: 'bui-root', 'data-bui-accent': accent };
  if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new TypeError('Accent must be white, purple, orange, or a six-digit hex color.');
  const rgb = [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16) / 255);
  const luminance = rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const dark = luminance > .18;
  return { className: 'bui-root', 'data-bui-accent': 'custom', style: {
    '--bui-accent': accent, '--bui-on-accent': dark ? '#1a1a1a' : '#ffffff',
    '--bui-accent-ink': dark ? '#404040' : accent,
    '--bui-accent-soft': `color-mix(in srgb, ${accent} 8%, white)`,
    '--bui-accent-border': dark ? '#d4d4d4' : accent,
  } };
}

export function themeRoot(element, accent = 'white') {
  ensureUiStyles(element.getRootNode?.().host ? element.getRootNode() : element.ownerDocument || document);
  const props = themeProps(accent);
  element.classList.add('bui-root');
  element.setAttribute('data-bui-accent', props['data-bui-accent']);
  for (const key of ['--bui-accent','--bui-on-accent','--bui-accent-ink','--bui-accent-soft','--bui-accent-border']) {
    element.style.removeProperty(key);
  }
  for (const [key, value] of Object.entries(props.style || {})) element.style.setProperty(key, value);
  return element;
}

export function applyComponent(element, component, props = {}) {
  element.classList.add(`bui-${component}`);
  if (props.variant) element.setAttribute('data-variant', props.variant);
  if (props.size) element.setAttribute('data-size', props.size);
  if (props.tone) element.setAttribute('data-tone', props.tone);
  if (props.accent) themeRoot(element, props.accent);
  return element;
}

export function createComponent(component, props = {}) {
  const { document: doc = document, tag = tags[component] || 'div', text, children = [],
    className = '', accent, variant, size, tone, attrs = {}, on = {} } = props;
  const element = doc.createElement(tag);
  element.className = componentClass(component, className);
  if (tag === 'button') element.type = 'button';
  if (['checkbox','radio','range','color'].includes(component)) element.type = component;
  if (component === 'status') { element.setAttribute('role', 'status'); element.setAttribute('aria-live', 'polite'); }
  if (component === 'progress') element.setAttribute('role', 'progressbar');
  applyComponent(element, component, { accent, variant, size, tone });
  if (text !== undefined) element.textContent = text;
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child != null) element.append(child);
  for (const [event, listener] of Object.entries(on)) element.addEventListener(event, listener);
  return element;
}

// React is injected by the app so DOM-only extensions don't ship a framework.
export function createReactComponents(createElement) {
  const component = name => ({ as = tags[name] || 'div', accent, variant, size, tone, className = '', children, ...props }) => {
    const theme = accent ? themeProps(accent) : {};
    const merged = { ...theme, ...props, className: [theme.className, componentClass(name, className)].filter(Boolean).join(' ') };
    if (variant) merged['data-variant'] = variant;
    if (size) merged['data-size'] = size;
    if (tone) merged['data-tone'] = tone;
    if (as === 'button') merged.type ??= 'button';
    if (theme.style) merged.style = { ...theme.style, ...props.style };
    return createElement(as, merged, children);
  };
  return Object.fromEntries(['page','page-shell','settings-shell','surface','panel','card','header','footer','title','heading','subtitle','meta','status','hint','body','stack','row','grid','divider','label','section-title','field','input','select','textarea','toggle','button','icon-button','link','badge','dot','empty','notice','overlay','backdrop','dialog-position','dialog','menu','menu-item','tooltip','attached-status','toast','progress','progress-fill','spinner','diff','diff-pane','diff-label','diff-text','code','kbd','details','summary','list','table'].map(name => [name.replace(/(^|-)(\w)/g, (_, _dash, c) => c.toUpperCase()), component(name)]));
}

let dialogId = 0;
export function confirmDialog({ document: doc = document, accent = 'white', title = 'Confirm', message, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
  const previousFocus = doc.activeElement;
  const id = 'bui-confirm-' + ++dialogId;
  const dialog = createComponent('dialog', { document: doc, tag: 'dialog', accent, attrs: { 'aria-labelledby': id, 'aria-describedby': id + '-message' } });
  const heading = createComponent('title', { document: doc, text: title, attrs: { id } });
  const description = createComponent('hint', { document: doc, text: message, attrs: { id: id + '-message' } });
  const cancel = createComponent('button', { document: doc, text: cancelLabel });
  const confirm = createComponent('button', { document: doc, text: confirmLabel, variant: 'primary' });
  dialog.append(
    createComponent('header', { document: doc, children: [heading] }),
    createComponent('body', { document: doc, children: [description] }),
    createComponent('footer', { document: doc, children: [cancel, confirm] })
  );
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      if (event.shiftKey && doc.activeElement === cancel) { event.preventDefault(); confirm.focus(); }
      else if (!event.shiftKey && doc.activeElement === confirm) { event.preventDefault(); cancel.focus(); }
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.addEventListener('close', () => finish(false));
    doc.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
