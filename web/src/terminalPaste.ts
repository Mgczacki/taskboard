// xterm handles native paste events. Some hosts send the paste shortcut without a paste event.
// Read the clipboard for those hosts, while leaving native paste to xterm when it arrives.
export function terminalPaste(
  element: HTMLElement,
  paste: (text: string) => void,
  beforePaste: () => void,
  readText: () => Promise<string> = () => navigator.clipboard.readText(),
): () => void {
  let nativePastes = 0;
  let shortcut = 0;
  const onPaste = () => { nativePastes++; beforePaste(); };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== 'KeyV' || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
    const current = ++shortcut;
    const seen = nativePastes;
    // Do not cancel the key. A native paste event usually follows it and needs no clipboard permission.
    setTimeout(() => {
      if (current !== shortcut || nativePastes !== seen) return;
      try {
        void readText().then(text => {
          if (current !== shortcut || nativePastes !== seen || !text) return;
          beforePaste();
          paste(text);
        }).catch(() => { /* native paste remains available */ });
      } catch { /* native paste remains available */ }
    }, 30);
  };
  element.addEventListener('paste', onPaste, true);
  element.addEventListener('keydown', onKeyDown, true);
  return () => {
    shortcut++;
    element.removeEventListener('paste', onPaste, true);
    element.removeEventListener('keydown', onKeyDown, true);
  };
}
