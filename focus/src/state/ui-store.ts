import { create } from 'zustand';
import type { QuickAddDefaults } from '@/services/quick-add-service';

export interface Toast {
  id: number;
  message: string;
  tone?: 'default' | 'error' | 'success';
  action?: { label: string; run: () => void };
}

interface UiState {
  quickAdd: { open: boolean; defaults: QuickAddDefaults; initialText?: string };
  openQuickAdd: (defaults?: QuickAddDefaults, initialText?: string) => void;
  closeQuickAdd: () => void;

  toasts: Toast[];
  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;

  selection: string[];
  lastSelected: string | null;
  setSelection: (ids: string[], last?: string | null) => void;
  toggleSelected: (id: string) => void;
  clearSelection: () => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  detailWidth: number;
  setDetailWidth: (w: number) => void;

  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
}

let toastId = 0;

/** Per-device UI conveniences only. Data lives in SQLite, never here. */
function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`focus.ui.${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`focus.ui.${key}`, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode); preference simply is not remembered.
  }
}

export const useUi = create<UiState>((set, get) => ({
  quickAdd: { open: false, defaults: {} },
  openQuickAdd: (defaults = {}, initialText) => set({ quickAdd: { open: true, defaults, initialText } }),
  closeQuickAdd: () => set({ quickAdd: { open: false, defaults: {} } }),

  toasts: [],
  pushToast: (t) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-2), { ...t, id }] });
    setTimeout(() => get().dismissToast(id), t.tone === 'error' ? 7000 : 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  selection: [],
  lastSelected: null,
  setSelection: (ids, last = null) => set({ selection: ids, lastSelected: last }),
  toggleSelected: (id) => {
    const s = get().selection;
    set({ selection: s.includes(id) ? s.filter((x) => x !== id) : [...s, id], lastSelected: id });
  },
  clearSelection: () => set({ selection: [], lastSelected: null }),

  sidebarCollapsed: readPref('sidebarCollapsed', false),
  toggleSidebar: () => {
    const v = !get().sidebarCollapsed;
    writePref('sidebarCollapsed', v);
    set({ sidebarCollapsed: v });
  },

  detailWidth: readPref('detailWidth', 440),
  setDetailWidth: (w) => {
    const clamped = Math.min(720, Math.max(340, Math.round(w)));
    writePref('detailWidth', clamped);
    set({ detailWidth: clamped });
  },

  shortcutsOpen: false,
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
}));
