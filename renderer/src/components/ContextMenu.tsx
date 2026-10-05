import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | {
      type?: "item";
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      shortcut?: string;
      icon?: string;
      danger?: boolean;
    }
  | { type: "separator" };

export type ContextMenuState = { x: number; y: number; items: MenuItem[] };

type ContextMenuProps = {
  menu: ContextMenuState;
  onClose: () => void;
};

const EDGE_GAP = 8;

export default function ContextMenu({ menu, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  // Drop trailing / doubled separators left over from conditional sections.
  const items = menu.items.filter((item, i, all) => {
    if (item.type !== "separator") return true;
    if (i === 0 || i === all.length - 1) return false;
    return all[i - 1].type !== "separator";
  });

  // Measure once rendered (hidden), then flip/clamp so the menu never spills
  // off-screen. Written straight to the DOM to avoid a second render.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const flipX = menu.x + width > window.innerWidth - EDGE_GAP;
    const flipY = menu.y + height > window.innerHeight - EDGE_GAP;
    const left = Math.max(EDGE_GAP, flipX ? menu.x - width : menu.x);
    const top = Math.max(EDGE_GAP, flipY ? Math.min(menu.y - height, window.innerHeight - height - EDGE_GAP) : menu.y);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.transformOrigin = `${flipY ? "bottom" : "top"} ${flipX ? "right" : "left"}`;
    el.style.visibility = "visible";
    // Take keyboard focus away from the page so arrows / Enter / Esc land here.
    el.focus({ preventScroll: true });
  }, [menu]);

  function moveActive(step: 1 | -1) {
    const enabled = items
      .map((item, i) => (item.type !== "separator" && !item.disabled ? i : -1))
      .filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(activeIndex);
    const next = pos === -1 ? (step === 1 ? 0 : enabled.length - 1) : (pos + step + enabled.length) % enabled.length;
    setActiveIndex(enabled[next]);
  }

  function select(item: MenuItem) {
    if (item.type === "separator" || item.disabled) return;
    onClose();
    item.onSelect();
  }

  useEffect(() => {
    const onResize = () => onClose();
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onResize);
    };
  }, [onClose]);

  return (
    <>
      <div
        className="context-menu-overlay"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        className="context-menu"
        role="menu"
        tabIndex={-1}
        style={{ left: menu.x, top: menu.y, visibility: "hidden" }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            moveActive(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            moveActive(-1);
          } else if (e.key === "Enter" && activeIndex >= 0) {
            e.preventDefault();
            select(items[activeIndex]);
          }
        }}
      >
        {items.map((item, i) =>
          item.type === "separator" ? (
            <div key={`sep-${i}`} className="context-menu-separator" role="separator" />
          ) : (
            <div
              key={`${item.label}-${i}`}
              role="menuitem"
              aria-disabled={item.disabled || undefined}
              className={`context-menu-item${item.disabled ? " disabled" : ""}${item.danger ? " danger" : ""}${i === activeIndex ? " active" : ""}`}
              onMouseEnter={() => setActiveIndex(item.disabled ? -1 : i)}
              onMouseLeave={() => setActiveIndex(-1)}
              onClick={() => select(item)}
            >
              <span className="context-menu-icon material-symbols-outlined" aria-hidden="true">
                {item.icon ?? ""}
              </span>
              <span className="context-menu-label">{item.label}</span>
              {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
            </div>
          )
        )}
      </div>
    </>
  );
}
