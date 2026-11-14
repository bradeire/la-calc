import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type RefObject, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }>(
  function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cx(
          'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors select-none disabled:opacity-50 disabled:pointer-events-none',
          size === 'md' ? 'h-9 px-3.5 text-[0.93rem] max-lg:h-10' : 'h-7 px-2.5 text-[0.86rem]',
          variant === 'primary' && 'bg-accent text-accent-fg hover:brightness-110 active:brightness-95 shadow-sm',
          variant === 'secondary' && 'bg-surface-2 text-fg hover:bg-surface-3 border border-line',
          variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-fg',
          variant === 'danger' && 'bg-danger text-white hover:brightness-110',
          className,
        )}
        {...rest}
      />
    );
  },
);

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' }>(
  function IconButton({ label, size = 'md', className, type = 'button', children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={cx(
          'inline-flex shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40',
          size === 'md' ? 'h-9 w-9 max-lg:h-11 max-lg:w-11' : 'h-7 w-7',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        'h-9 w-full rounded-lg border border-line bg-surface px-3 text-fg placeholder:text-subtle outline-none focus:border-accent max-lg:h-11',
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx('w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg placeholder:text-subtle outline-none focus:border-accent', className)}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx('h-9 rounded-lg border border-line bg-surface px-2.5 text-fg outline-none focus:border-accent max-lg:h-11', className)}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-accent' : 'bg-surface-3')}
    >
      <span className={cx('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

export function Field({ label, children, hint, htmlFor }: { label: string; children: ReactNode; hint?: string; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[0.8rem] font-medium text-muted">
        {label}
      </label>
      {children}
      {hint && <p className="text-[0.78rem] text-subtle">{hint}</p>}
    </div>
  );
}

/** Modal dialog on the native <dialog> element: focus trap, Esc and backdrop handled by the platform. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  position = 'center',
  hideTitle,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  position?: 'center' | 'top';
  hideTitle?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx(
        'm-0 max-h-[100dvh] w-full max-w-none bg-transparent p-0 backdrop:backdrop-blur-[1px]',
        'max-sm:mt-auto max-sm:mb-0',
        'sm:mx-auto sm:max-w-[calc(100vw-2rem)]',
        position === 'top' ? 'sm:mt-[12vh]' : 'sm:my-auto',
        size === 'sm' && 'sm:w-[400px]',
        size === 'md' && 'sm:w-[540px]',
        size === 'lg' && 'sm:w-[720px]',
      )}
    >
      {open && (
        <div className="anim-pop max-sm:anim-sheet flex max-h-[90dvh] flex-col overflow-hidden border border-line bg-surface shadow-pop max-sm:rounded-t-2xl max-sm:pb-safe sm:rounded-xl">
          {!hideTitle && (
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h2 className="text-[1.02rem] font-semibold">{title}</h2>
              <IconButton label="Close" size="sm" onClick={onClose}>
                <X size={16} />
              </IconButton>
            </div>
          )}
          <div className="min-h-0 overflow-y-auto">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/** Confirmation for destructive or irreversible actions. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="px-4 py-4 text-[0.93rem] text-muted">{body}</div>
    </Dialog>
  );
}

/**
 * Anchored popover. On phones it becomes a bottom sheet with large targets.
 * Closes on outside press and Escape; returns focus to the anchor.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  width = 280,
  label,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null);
  const isPhone = typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches;

  useLayoutEffect(() => {
    if (!open || isPhone) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const h = ref.current?.offsetHeight ?? 300;
      if (!a || (a.width === 0 && a.height === 0)) {
        // Anchor hidden (e.g. opened by a swipe or keyboard shortcut): centre it.
        setPos({ top: Math.max(8, (window.innerHeight - h) / 3), left: (window.innerWidth - width) / 2, maxH: window.innerHeight - 16 });
        return;
      }
      const below = window.innerHeight - a.bottom;
      const top = below > h + 12 || below > a.top ? a.bottom + 4 : Math.max(8, a.top - h - 4);
      const left = Math.min(Math.max(8, a.left), window.innerWidth - width - 8);
      setPos({ top, left, maxH: window.innerHeight - 16 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, width, isPhone]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    const first = ref.current?.querySelector<HTMLElement>('input, button, [tabindex]');
    first?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  if (isPhone) {
    return createPortal(
      <div className="fixed inset-0 z-[70] flex flex-col justify-end bg-black/35 anim-fade">
        <div ref={ref} role="dialog" aria-label={label} className="anim-sheet max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface pb-safe shadow-pop">
          <div className="mx-auto mt-2 mb-1 h-1 w-10 rounded-full bg-line-strong" aria-hidden />
          {children}
        </div>
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxHeight: pos?.maxH }}
      className="anim-pop fixed z-[70] overflow-y-auto rounded-xl border border-line bg-surface shadow-pop"
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  shortcut,
  active,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  shortcut?: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[0.92rem] hover:bg-surface-2 max-sm:py-3',
        danger ? 'text-danger' : 'text-fg',
        active && 'bg-surface-2 font-medium',
      )}
    >
      {icon && <span className="flex w-5 shrink-0 justify-center text-muted">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <kbd className="text-[0.75rem] text-subtle">{shortcut}</kbd>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 border-t border-line" role="separator" />;
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-muted">{icon}</div>
      <h3 className="text-[1.02rem] font-semibold">{title}</h3>
      {body && <p className="mt-1.5 text-[0.9rem] text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-[0.75rem] text-muted">{children}</kbd>;
}

/** In-app replacement for window.prompt (unsupported in some native webviews). */
export function usePrompt() {
  const [state, setState] = useState<{ title: string; label: string; value: string; resolve: (v: string | null) => void } | null>(null);
  const ask = (title: string, label: string, initial = '') =>
    new Promise<string | null>((resolve) => setState({ title, label, value: initial, resolve }));
  const finish = (v: string | null) => {
    state?.resolve(v);
    setState(null);
  };
  const element = (
    <Dialog
      open={!!state}
      onClose={() => finish(null)}
      title={state?.title ?? ''}
      size="sm"
      footer={
        <>
          <Button onClick={() => finish(null)}>Cancel</Button>
          <Button variant="primary" disabled={!state?.value.trim()} onClick={() => finish(state!.value.trim())}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (state?.value.trim()) finish(state.value.trim());
        }}
      >
        <Field label={state?.label ?? ''} htmlFor="prompt-input">
          <Input id="prompt-input" autoFocus value={state?.value ?? ''} onChange={(e) => setState((s) => (s ? { ...s, value: e.target.value } : s))} />
        </Field>
      </form>
    </Dialog>
  );
  return { ask, element };
}
