"use client";
// beui.dev/components/motion/popover, with a confirm step on top of it

import { CircleHelp, TriangleAlert } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  usePopoverTriggerRef,
} from "@/components/beui/popover";
import { cn } from "@/lib/cn";

export interface PopconfirmProps {
  /** The control that opens the confirmation (a button) */
  children: ReactElement;
  /** The question, e.g. "删除此账号？" — one line, not the action repeated */
  title: string;
  /** What follows if confirmed, in one line; not a restatement of the title */
  description?: string;
  /** A short verb naming the outcome ("删除", "清除"), never "确定" */
  confirmText: string;
  cancelText: string;
  /** Warning icon and danger styling for the confirm button (destructive actions) */
  danger?: boolean;
  onConfirm: () => void;
  /** Controlled open state; omit it for the component's own */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Panel alignment against the trigger. Default "end": the trigger is a row's last control as often as not. */
  align?: "start" | "center" | "end";
  /** Side of the trigger the panel grows from. Default "bottom". */
  side?: "top" | "bottom";
  className?: string;
}

/**
 * An in-place confirmation: the question opens against the control that
 * raised it, and everything around stays where it was.
 *
 * For a small, clear-cut action — clearing a derived store, removing a row,
 * cutting a link that can be remade. A decision that deserves the room, an
 * irreversible one with a scope to it, or leaving a form with unsaved input
 * still takes a dialog (see ConfirmDialog). Escape and an outside press
 * cancel, and focus lands on the safe choice so a stray Enter cannot confirm;
 * whichever way it closes, focus goes back to the trigger.
 */
export function Popconfirm({
  children,
  open: controlledOpen,
  onOpenChange,
  ...panel
}: PopconfirmProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align={panel.align ?? "end"}
      side={panel.side ?? "bottom"}
      sideOffset={10}
    >
      <PopoverTrigger>{children}</PopoverTrigger>
      <PopoverContent
        ariaLabel={panel.title}
        className={cn("w-72 max-w-[min(92vw,20rem)] p-3.5", panel.className)}
      >
        <PopconfirmPanel {...panel} open={open} setOpen={setOpen} />
      </PopoverContent>
    </Popover>
  );
}

/** Lives inside the popover so it can hand focus back to the trigger */
function PopconfirmPanel(
  props: Omit<
    PopconfirmProps,
    "children" | "open" | "onOpenChange" | "align" | "side" | "className"
  > & {
    open: boolean;
    setOpen: (next: boolean) => void;
  },
) {
  const { title, description, confirmText, cancelText, danger, onConfirm, open, setOpen } =
    props;
  const triggerRef: RefObject<HTMLElement | null> = usePopoverTriggerRef();
  // The panel is always mounted (portalled, inert while closed), so the safe
  // button is focused when it opens rather than on mount. It is also hidden
  // until the popover has measured it — on the first open that lands a tick
  // after the effect — and a focus call against a hidden element is dropped,
  // so keep trying for a few ticks until it sticks.
  const safeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const button = safeRef.current;
    if (!button) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryFocus = () => {
      button.focus();
      // Retry only while focus is where the click left it (the trigger, or
      // nothing): once it sits on something else the user put it there
      const active = document.activeElement;
      const unmoved = active === document.body || active === triggerRef.current;
      if (active !== button && unmoved && attempts++ < 12) {
        timer = setTimeout(tryFocus, 16);
      }
    };
    tryFocus();
    return () => clearTimeout(timer);
  }, [open, triggerRef]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const Icon = danger ? TriangleAlert : CircleHelp;
  return (
    // The panel is portalled to the body, but React events bubble along the
    // component tree, not the DOM: without this, a click on either button
    // reached the clickable row the trigger sits in (the account list rows
    // open the editor) and opened it behind the confirmation
    <div className="flex items-start gap-2.5" onClick={(e) => e.stopPropagation()}>
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          danger ? "text-danger" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium leading-5 text-foreground">{title}</p>
        {description && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            ref={safeRef}
            type="button"
            onClick={close}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={() => {
              close();
              onConfirm();
            }}
            className={
              // The app's destructive-confirm language is an outlined red, in
              // the dialogs and on every delete button; a filled one is saved
              // for selection and status fills
              danger
                ? "rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
                : "rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-strong"
            }
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
