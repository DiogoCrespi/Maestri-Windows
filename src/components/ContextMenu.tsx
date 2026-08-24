import React, { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => void | Promise<void>;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const position = useMemo(() => ({
    left: Math.max(8, Math.min(x, window.innerWidth - 228)),
    top: Math.max(8, Math.min(y, window.innerHeight - (items.length * 36 + 20))),
  }), [items.length, x, y]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const closeOnPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnWindowChange = () => onClose();
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnPointer, true);
    window.addEventListener("blur", closeOnWindowChange);
    window.addEventListener("resize", closeOnWindowChange);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnPointer, true);
      window.removeEventListener("blur", closeOnWindowChange);
      window.removeEventListener("resize", closeOnWindowChange);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="maestri-context-menu"
      role="menu"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="maestri-context-menu__item"
          disabled={item.disabled}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            onClose();
            void Promise.resolve(item.action()).catch((error) => {
              console.error("Falha ao executar ação do menu contextual", error);
            });
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
};
