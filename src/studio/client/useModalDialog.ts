import { useEffect, useRef } from 'preact/hooks';

export function useModalDialog(): preact.RefObject<HTMLDialogElement> {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : undefined;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    return () => {
      if (dialog.current?.open) dialog.current.close();
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, []);
  return dialog;
}
