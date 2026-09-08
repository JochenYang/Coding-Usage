import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/cn";

export interface ConfirmDialogProps {
  /** Visibility flag owned by the caller */
  open: boolean;
  /** Dialog heading */
  title: string;
  /** Optional explanatory line under the heading */
  description?: string;
  /** Confirm button label */
  confirmText: string;
  /** Cancel button label */
  cancelText: string;
  /** Danger styling for the confirm button (destructive actions) */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Extra classes appended to the panel */
  className?: string;
}

/**
 * Themed confirmation dialog matching the app's tray-or-quit close dialog
 * (same overlay, motion and button language) — a replacement for the native
 * `window.confirm`, which breaks the visual theme. Escape and backdrop click
 * cancel. Focus lands on the safe choice: cancel for danger dialogs, confirm
 * otherwise.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText,
  cancelText,
  danger,
  onConfirm,
  onCancel,
  className,
}: ConfirmDialogProps) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[999] flex items-center justify-center bg-black/40 backdrop-blur-[2px] [app-region:no-drag]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onCancel();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            className={cn("w-[26rem] rounded-2xl border border-border bg-card p-5 shadow-xl", className)}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.96, y: reduceMotion ? 0 : 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.96 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: EASE_OUT }}
          >
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {description && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
            )}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                autoFocus={danger}
                onClick={onCancel}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {cancelText}
              </button>
              <button
                type="button"
                autoFocus={!danger}
                onClick={onConfirm}
                className={
                  danger
                    ? "rounded-lg border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10"
                    : "rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-strong"
                }
              >
                {confirmText}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
