import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState, type DragEvent } from "react";
import type { Catalog, GraphNodeType, Id } from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";

/** What a library entry adds. Item entries add the chosen node type for that item. */
export type LibraryDrop = { readonly kind: "recipe"; readonly recipe: Id } | { readonly kind: "item"; readonly item: Id; readonly type: Exclude<GraphNodeType, "recipe"> };

export const DRAG_MIME = "application/x-gamedevtool-node";

interface Entry {
  readonly key: string;
  readonly heading?: string;
  readonly id?: Id;
  readonly name?: string;
  readonly kind?: "recipe" | "item";
}

const ROW_HEIGHT = 40;
const ITEM_TYPES = ["source", "sink", "storage", "splitter", "merger", "gate"] as const;

export interface LibraryProps {
  readonly strings: UiStrings;
  readonly catalog: Catalog;
  readonly onAdd: (drop: LibraryDrop) => void;
}

/** Recipes and items to place on the canvas. Virtualized: DOM size is constant. */
export function Library({ strings, catalog, onAdd }: LibraryProps) {
  const s = strings.production;
  const [query, setQuery] = useState("");
  const [itemType, setItemType] = useState<(typeof ITEM_TYPES)[number]>("source");
  const scrollRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (name: string) => q === "" || name.toLowerCase().includes(q);
    const list: Entry[] = [{ key: "h-recipes", heading: s.recipesHeading }];
    for (const r of catalog.recipes.values()) if (match(r.name)) list.push({ key: r.id, id: r.id, name: r.name, kind: "recipe" });
    list.push({ key: "h-items", heading: s.itemsHeading });
    for (const i of catalog.items.values()) if (match(i.name)) list.push({ key: i.id, id: i.id, name: i.name, kind: "item" });
    return list;
  }, [catalog, query, s]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => entries[i]!.key,
    overscan: 6,
  });

  const dropOf = (e: Entry): LibraryDrop => (e.kind === "recipe" ? { kind: "recipe", recipe: e.id! } : { kind: "item", item: e.id!, type: itemType });
  const onDragStart = (ev: DragEvent, e: Entry) => {
    ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(dropOf(e)));
    ev.dataTransfer.effectAllowed = "copy";
  };

  return (
    <section className="plib" aria-labelledby="plib-heading">
      <h3 id="plib-heading">{s.library}</h3>
      <input type="text" aria-label={s.search} placeholder={s.search} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="segmented" role="radiogroup" aria-label={s.itemsHeading}>
        {ITEM_TYPES.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={itemType === t} className={itemType === t ? "is-on" : undefined} onClick={() => setItemType(t)}>
            {s.nodeType[t]}
          </button>
        ))}
      </div>
      <p className="muted small">{s.libraryHint}</p>
      <div ref={scrollRef} className="plib-list">
        <div className="listbox-inner" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const e = entries[v.index]!;
            return (
              <div key={v.key} className="plib-row" style={{ transform: `translateY(${v.start}px)`, height: ROW_HEIGHT }}>
                {e.heading !== undefined ? (
                  <span className="plib-heading">{e.heading}</span>
                ) : (
                  <button type="button" className="plib-entry" draggable onDragStart={(ev) => onDragStart(ev, e)} onClick={() => onAdd(dropOf(e))}>
                    <span className="asset-kind">{e.kind === "recipe" ? s.nodeType.recipe : s.nodeType[itemType]}</span>
                    <span className="asset-name">{e.name}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
