import React, { useCallback, useEffect, useState } from "react";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

type TextControl = HTMLInputElement | HTMLTextAreaElement;

interface MenuState {
  x: number;
  y: number;
  target: HTMLElement;
  selectedText: string;
}

function textControl(target: HTMLElement): TextControl | null {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
}

function editableElement(target: HTMLElement): HTMLElement | null {
  return target.closest<HTMLElement>("[contenteditable]:not([contenteditable='false'])");
}

function selectionFrom(target: HTMLElement): string {
  const control = textControl(target);
  if (control) {
    const start = control.selectionStart ?? 0;
    const end = control.selectionEnd ?? start;
    return control.value.slice(start, end);
  }
  return window.getSelection()?.toString() ?? "";
}

function insertIntoControl(control: TextControl, value: string): void {
  const start = control.selectionStart ?? control.value.length;
  const end = control.selectionEnd ?? start;
  control.setRangeText(value, start, end, "end");
  control.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertFromPaste",
    data: value,
  }));
}

function selectEditableContents(element: HTMLElement): void {
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export const AppContextMenu: React.FC = () => {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const openMenu = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) return;

      // xterm owns its selection model, so TerminalNode supplies its own menu.
      if (target.closest(".terminal-body, .xterm")) return;

      event.preventDefault();
      setMenu({
        x: event.clientX,
        y: event.clientY,
        target,
        selectedText: selectionFrom(target),
      });
    };

    document.addEventListener("contextmenu", openMenu);
    return () => document.removeEventListener("contextmenu", openMenu);
  }, []);

  if (!menu) return null;

  const control = textControl(menu.target);
  const editable = editableElement(menu.target);
  const canEdit = Boolean(control ? !control.disabled && !control.readOnly : editable);
  const canSelect = Boolean(control || editable || menu.selectedText);
  const copyText = menu.selectedText
    || menu.target.closest<HTMLElement>("[data-context-copy]")?.dataset.contextCopy
    || "";

  const items: ContextMenuItem[] = [
    {
      label: "Copiar",
      shortcut: "Ctrl+C",
      disabled: !copyText,
      action: () => writeClipboardText(copyText),
    },
    {
      label: "Colar",
      shortcut: "Ctrl+V",
      disabled: !canEdit,
      action: async () => {
        const value = await readClipboardText();
        if (control) {
          control.focus();
          insertIntoControl(control, value);
        } else if (editable) {
          editable.focus();
          document.execCommand("insertText", false, value);
          editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: value }));
        }
      },
    },
    {
      label: "Selecionar tudo",
      shortcut: "Ctrl+A",
      disabled: !canSelect,
      action: () => {
        if (control) {
          control.focus();
          control.select();
        } else if (editable) {
          selectEditableContents(editable);
        }
      },
    },
  ];

  return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={close} />;
};
