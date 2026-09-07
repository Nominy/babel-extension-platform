export type UiAccent = 'white' | 'purple' | 'orange' | `#${string}`;
export type UiVariant = 'primary' | 'soft' | 'tinted' | 'secondary' | 'ghost' | 'danger';
export type UiTone = 'danger' | 'success' | 'warning';
export interface ComponentStyleProps { accent?: UiAccent; variant?: UiVariant; size?: 'sm'; tone?: UiTone }
export declare const UI_STYLES: string;
export declare function componentClass(component: string, className?: string): string;
export declare function ensureUiStyles(root?: Document | ShadowRoot): void;
export declare function themeProps(accent?: UiAccent): { className: string; 'data-bui-accent': string; style?: Record<string, string> };
export declare function themeRoot<T extends HTMLElement>(element: T, accent?: UiAccent): T;
export declare function applyComponent<T extends HTMLElement>(element: T, component: string, props?: ComponentStyleProps): T;
export interface ComponentProps extends ComponentStyleProps {
  document?: Document; tag?: keyof HTMLElementTagNameMap; text?: string; className?: string;
  children?: (Node | string | null)[]; attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Record<string, EventListener>;
}
export declare function createComponent(component: string, props?: ComponentProps): HTMLElement;
export declare function createReactComponents<T>(createElement: (...args: any[]) => T): Record<
  'Page' | 'PageShell' | 'SettingsShell' | 'Surface' | 'Panel' | 'Card' | 'Header' | 'Footer' | 'Title' | 'Heading' | 'Subtitle' |
  'Meta' | 'Status' | 'Hint' | 'Body' | 'Stack' | 'Row' | 'Grid' | 'Divider' | 'Label' | 'SectionTitle' |
  'Field' | 'Input' | 'Select' | 'Textarea' | 'Toggle' | 'Button' | 'IconButton' | 'Link' | 'Badge' | 'Dot' |
  'Empty' | 'Notice' | 'Overlay' | 'Backdrop' | 'DialogPosition' | 'Dialog' | 'Menu' | 'MenuItem' |
  'Tooltip' | 'AttachedStatus' | 'Toast' | 'Progress' | 'ProgressFill' | 'Spinner' | 'Diff' | 'DiffPane' | 'DiffLabel' |
  'DiffText' | 'Code' | 'Kbd' | 'Details' | 'Summary' | 'List' | 'Table',
  (props: ComponentStyleProps & { as?: string; className?: string; children?: any; [key: string]: any }) => T
>;

export declare function confirmDialog(props: { document?: Document; accent?: UiAccent; title?: string; message: string; confirmLabel?: string; cancelLabel?: string }): Promise<boolean>;
