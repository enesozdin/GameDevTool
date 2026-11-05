import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

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
  /**
   * true (default): selection follows focus, every arrow key selects. false: arrows only
   * move the highlight and Enter or Space selects. Use false when selecting is costly
   * (it opens an editor) so arrowing through a long list does not.
   */
  readonly selectOnMove?: boolean;
}

/**
 * Single-select listbox that renders only the visible rows, so DOM size stays constant
 * however many items there are. Keyboard: arrows, Home/End, PageUp/PageDown; selection
 * follows focus (unless `selectOnMove` is false). Uses aria-activedescendant, and the active row is always scrolled into
 * view (and therefore rendered).
 */
export function VirtualListbox<T>({ id, label, items, getKey, renderItem, selectedKey, onSelect, itemHeight = 44, selectOnMove = true }: VirtualListboxProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => itemHeight,
    getItemKey: (index) => getKey(items[index]!),
    overscan: 8,
  });

  // Highlighted row when selection does not follow focus; follows the selection otherwise.
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => setHighlight(null), [selectedKey]);
  const activeKey = selectOnMove ? selectedKey : (highlight ?? selectedKey);
  const activeIndex = activeKey === null ? -1 : items.findIndex((item) => getKey(item) === activeKey);

  useEffect(() => {
    if (activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex, virtualizer]);

  const optionId = (key: string) => `${id}-opt-${key}`;
  const pageSize = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? itemHeight * 10) / itemHeight) - 1);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    const last = items.length - 1;
    if (!selectOnMove && (e.key === "Enter" || e.key === " ")) {
      if (activeIndex >= 0) {
        e.preventDefault();
        onSelect(getKey(items[activeIndex]!));
      }
      return;
    }
    const from = activeIndex < 0 ? -1 : activeIndex;
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
    if (selectOnMove) onSelect(getKey(items[next]!));
    else setHighlight(getKey(items[next]!));
  };

  return (
    <div
      ref={scrollRef}
      id={id}
      className="listbox"
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={activeIndex >= 0 ? optionId(activeKey!) : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="listbox-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index]!;
          const key = getKey(item);
          const selected = key === selectedKey;
          const active = !selectOnMove && key === highlight && !selected;
          return (
            <div
              key={row.key}
              id={optionId(key)}
              role="option"
              aria-selected={selected}
              aria-setsize={items.length}
              aria-posinset={row.index + 1}
              className={selected ? "listbox-option is-selected" : active ? "listbox-option is-active" : "listbox-option"}
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
