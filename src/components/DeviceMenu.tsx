import { useId, useRef } from "react";

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** "⋯" button with a small menu. The native popover gives light dismiss
 *  (click outside, Esc) and keeps it above everything; we only place it. */
export default function DeviceMenu({ name, items }: { name: string; items: MenuItem[] }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  if (items.length === 0) return null;

  // Right-align the menu under the button, flipping up near the bottom.
  const place = () => {
    const b = button.current?.getBoundingClientRect();
    const m = menu.current;
    if (!b || !m) return;
    const below = window.innerHeight - b.bottom > m.offsetHeight + 12;
    m.style.top = `${below ? b.bottom + 6 : b.top - m.offsetHeight - 6}px`;
    m.style.left = `${Math.max(8, b.right - m.offsetWidth)}px`;
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon small menu-button"
        aria-label={`More for ${name}`}
        aria-haspopup="menu"
        popoverTarget={id}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <circle cx="5" cy="12" r="1.4" />
          <circle cx="12" cy="12" r="1.4" />
          <circle cx="19" cy="12" r="1.4" />
        </svg>
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        className="device-menu"
        onToggle={(e) => {
          if ((e as unknown as ToggleEvent).newState === "open") place();
        }}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={item.danger ? "danger-text" : undefined}
            onClick={() => {
              menu.current?.hidePopover();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
