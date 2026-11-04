import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface VirtualListboxProps<T> {
  readonly id: string;
  readonly label: string;
  readonly items: readonly T[];
  readonly getKey: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
  /** Fixed row height in px. 44 meets the touch-target minimum. */
  readonly itemHeight?: number;
}

/**
 * Single-select listbox that renders only the visible rows, so DOM size stays constant
 * however many items there are. Keyboard: arrows, Home/End, PageUp/PageDown; selection
 * follows focus. Uses aria-activedescendant, and the active row is always scrolled into
 * view (and therefore rendered).
 */
export function VirtualListbox<T>({ id, label, items, getKey, renderItem, selectedKey, onSelect, itemHeight = 44 }: VirtualListboxProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => itemHeight,
    getItemKey: (index) => getKey(items[index]!),
    overscan: 8,
  });

  const selectedIndex = selectedKey === null ? -1 : items.findIndex((item) => getKey(item) === selectedKey);

  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtualizer]);

  const optionId = (key: string) => `${id}-opt-${key}`;
  const pageSize = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? itemHeight * 10) / itemHeight) - 1);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    const last = items.length - 1;
    const from = selectedIndex < 0 ? -1 : selectedIndex;
    let next: number;
    switch (e.key) {
      case "ArrowDown":
        next = Math.min(last, from + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, from - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "PageDown":
        next = Math.min(last, Math.max(0, from) + pageSize);
        break;
      case "PageUp":
        next = Math.max(0, from - pageSize);
        break;
      default:
        return;
    }
    e.preventDefault();
    onSelect(getKey(items[next]!));
  };

  return (
    <div
      ref={scrollRef}
      id={id}
      className="listbox"
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={selectedIndex >= 0 ? optionId(selectedKey!) : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="listbox-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index]!;
          const key = getKey(item);
          const selected = key === selectedKey;
          return (
            <div
              key={row.key}
              id={optionId(key)}
              role="option"
              aria-selected={selected}
              aria-setsize={items.length}
              aria-posinset={row.index + 1}
              className={selected ? "listbox-option is-selected" : "listbox-option"}
              style={{ height: itemHeight, transform: `translateY(${row.start}px)` }}
              onClick={() => onSelect(key)}
            >
              {renderItem(item)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
