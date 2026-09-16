'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DialogContextValue {
  contentRef: React.RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

interface DialogContentContextValue {
  titleId: string;
  descriptionId: string;
  registerDescription: () => () => void;
}

const DialogContentContext = React.createContext<DialogContentContextValue | null>(null);

/** Elements focusable inside the dialog, in DOM order. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Lean, dependency-free dialog following shadcn conventions: portal,
 * overlay, Escape/overlay-click to close. Implements the WCAG dialog
 * pattern: focus moves to the content on open, Tab is trapped inside,
 * focus returns to the trigger on close, background scroll is locked and
 * the element is labelled via DialogTitle/DialogDescription ids.
 */
function Dialog({ open, onOpenChange, children }: DialogProps) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus into the dialog after it mounts.
    const raf = requestAnimationFrame(() => {
      contentRef.current?.focus();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onOpenChange(false);
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: cycle Tab/Shift+Tab within the dialog content.
      const focusables = focusablesIn(contentRef.current);
      if (focusables.length === 0) {
        e.preventDefault();
        contentRef.current?.focus();
        return;
      }
      const index = focusables.indexOf(document.activeElement as HTMLElement);
      const delta = e.shiftKey ? -1 : 1;
      const nextIndex = index < 0 ? (delta === 1 ? 0 : focusables.length - 1) : (index + delta + focusables.length) % focusables.length;
      e.preventDefault();
      focusables[nextIndex]!.focus();
    };
    document.addEventListener('keydown', onKey);

    // Make the app background inert while the dialog is open: focus traps
    // catch keyboard users, but without `inert` screen-reader virtual cursors
    // could still browse (and activate) content behind the modal.
    const appRoot = document.getElementById('app-shell-root');
    appRoot?.setAttribute('inert', '');

    return () => {
      appRoot?.removeAttribute('inert');
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      // Restore focus to the trigger (or whatever was focused before).
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open, onOpenChange]);

  if (!open || typeof document === 'undefined') return null;

  return (
    <DialogContext.Provider value={{ contentRef, onOpenChange }}>
      {createPortal(
        <div className="fixed inset-0 z-50">
          <div
            className="fixed inset-0 bg-black/70"
            aria-hidden="true"
            onClick={() => onOpenChange(false)}
          />
          {children}
        </div>,
        document.body,
      )}
    </DialogContext.Provider>
  );
}

const DialogContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => {
    const { contentRef } = React.useContext(DialogContext)!;
    const titleId = React.useId();
    const descriptionId = React.useId();
    const [hasDescription, setHasDescription] = React.useState(false);
    const registerDescription = React.useCallback(() => {
      setHasDescription(true);
      return () => setHasDescription(false);
    }, []);

    const setRef = (el: HTMLDivElement | null) => {
      contentRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    };

    return (
      <DialogContentContext.Provider
        value={{ titleId, descriptionId, registerDescription }}
      >
        <div
          ref={setRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={hasDescription ? descriptionId : undefined}
          tabIndex={-1}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 shadow-xl focus:outline-none',
            className,
          )}
          {...props}
        >
          {children}
        </div>
      </DialogContentContext.Provider>
    );
  },
);
DialogContent.displayName = 'DialogContent';

const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => {
    const { titleId } = React.useContext(DialogContentContext)!;
    return (
      <h2
        ref={ref}
        id={titleId}
        className={cn('text-base font-semibold', className)}
        {...props}
      />
    );
  },
);
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => {
  const { descriptionId, registerDescription } = React.useContext(DialogContentContext)!;
  React.useEffect(() => registerDescription(), [registerDescription]);
  return (
    <p
      ref={ref}
      id={descriptionId}
      className={cn('mt-1 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
});
DialogDescription.displayName = 'DialogDescription';

function DialogClose({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { onOpenChange } = React.useContext(DialogContext)!;
  return (
    <button
      type="button"
      aria-label="Close dialog"
      onClick={() => onOpenChange(false)}
      className={cn(
        'absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    >
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

export { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose };
