import { useState, type ReactNode } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import type { QuickAddDefaults } from '@/services/quick-add-service';
import { useUi } from '@/state/ui-store';
import { cx } from '../primitives';

export function AddTaskRow({ defaults, label = 'Add task' }: { defaults?: QuickAddDefaults; label?: string }) {
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  return (
    <button
      type="button"
      onClick={() => openQuickAdd(defaults)}
      className="group flex w-full items-center gap-2 py-2.5 pl-7 text-left text-[0.92rem] text-subtle hover:text-accent"
    >
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-accent group-hover:bg-accent group-hover:text-accent-fg">
        <Plus size={15} />
      </span>
      {label}
    </button>
  );
}

export function GroupHeading({
  title,
  count,
  actions,
  collapsible,
  defaultOpen = true,
  children,
  tone,
  onDragOver,
  onDrop,
  highlight,
}: {
  title: ReactNode;
  count?: number;
  actions?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
  tone?: 'danger';
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  highlight?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mt-5 first:mt-1" onDragOver={onDragOver} onDrop={onDrop}>
      <div className={cx('flex items-center gap-2 border-b border-line pb-1.5', highlight && 'border-accent')}>
        {collapsible ? (
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 items-center gap-1.5 text-left">
            <ChevronRight size={14} className={cx('shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
            <h2 className={cx('truncate text-[0.95rem] font-semibold', tone === 'danger' && 'text-danger')}>{title}</h2>
          </button>
        ) : (
          <h2 className={cx('truncate text-[0.95rem] font-semibold', tone === 'danger' && 'text-danger')}>{title}</h2>
        )}
        {count !== undefined && <span className="text-[0.8rem] text-subtle">{count}</span>}
        <div className="ml-auto flex items-center gap-0.5">{actions}</div>
      </div>
      {open && children}
    </section>
  );
}

export function ViewBody({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cx('mx-auto px-4 pb-16 lg:px-8', wide ? 'max-w-none' : 'max-w-3xl')}>{children}</div>;
}
