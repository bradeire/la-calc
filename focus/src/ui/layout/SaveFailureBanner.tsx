import { CircleAlert } from 'lucide-react';
import { useSaveStatus } from './useSaveStatus';

/**
 * Saving to this device failed (the app keeps retrying). Shown on every screen, phones included:
 * the sidebar's small indicator is hidden there, and silent save failures lose data.
 */
export function SaveFailureBanner() {
  const { status, error } = useSaveStatus();
  if (status !== 'error') return null;
  return (
    <div role="alert" className="fixed inset-x-0 top-0 z-[60] flex items-start gap-2 bg-danger px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-[0.85rem] text-white shadow">
      <CircleAlert size={16} className="mt-0.5 shrink-0" />
      <span>
        <strong>Changes aren’t being saved on this device.</strong> Don’t close Focus; it keeps retrying. Export a backup
        (Settings → Data) to be safe. Details: {error ?? 'storage error'}
      </span>
    </div>
  );
}
