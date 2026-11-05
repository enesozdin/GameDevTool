import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Histogram, Percentiles } from "../../core/index.ts";
import { formatNumber } from "./format.ts";

export interface HistogramChartProps {
  readonly histogram: Histogram;
  readonly percentiles: Percentiles;
  /** Accessible name, e.g. "IronSword: items per hour". */
  readonly label: string;
  readonly xLabel: string;
  readonly yLabel: string;
}

const HEIGHT = 180;
const DARK = "(prefers-color-scheme: dark)";

/**
 * Bar chart of one sink's Monte Carlo distribution (uPlot, canvas): runs per bin, with
 * P10 / P50 / P90 drawn as vertical lines. One canvas, drawn only when the data, the size
 * or the colour scheme changes; nothing runs in the background.
 */
export function HistogramChart({ histogram, percentiles, label, xLabel, yLabel }: HistogramChartProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (el === null || histogram.counts.length === 0) return;
    const n = histogram.counts.length;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = histogram.start + (i + 0.5) * histogram.width;
      y[i] = histogram.counts[i]!;
    }
    const data: uPlot.AlignedData = [x, y];
    const markers = [percentiles.p10, percentiles.p50, percentiles.p90];

    let plot: uPlot | null = null;
    const build = () => {
      plot?.destroy();
      const css = getComputedStyle(el);
      const color = (name: string) => css.getPropertyValue(name).trim();
      const fg = color("--muted");
      const grid = color("--border");
      const accent = color("--accent");
      const axis = { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, font: "11px system-ui, sans-serif", labelFont: "11px system-ui, sans-serif" };
      plot = new uPlot(
        {
          width: Math.max(160, el.clientWidth),
          height: HEIGHT,
          legend: { show: false },
          cursor: { show: false },
          select: { show: false, left: 0, top: 0, width: 0, height: 0 },
          scales: {
            x: { time: false, range: () => [histogram.start, histogram.start + n * histogram.width] },
            y: { range: (_u, _min, max) => [0, Math.max(1, max) * 1.05] },
          },
          axes: [
            { ...axis, label: xLabel, values: (_u, ticks) => ticks.map(formatNumber) },
            { ...axis, label: yLabel, size: 44, values: (_u, ticks) => ticks.map(formatNumber) },
          ],
          series: [{}, { stroke: accent, fill: accent, width: 0, paths: uPlot.paths.bars!({ size: [0.9, Infinity], align: 0 }), points: { show: false } }],
          hooks: {
            draw: [
              (u) => {
                const ctx = u.ctx;
                ctx.save();
                ctx.strokeStyle = color("--fg");
                ctx.lineWidth = Math.max(1, devicePixelRatio);
                ctx.setLineDash([4 * devicePixelRatio, 3 * devicePixelRatio]);
                for (const v of markers) {
                  const px = Math.round(u.valToPos(v, "x", true));
                  ctx.beginPath();
                  ctx.moveTo(px, u.bbox.top);
                  ctx.lineTo(px, u.bbox.top + u.bbox.height);
                  ctx.stroke();
                }
                ctx.restore();
              },
            ],
          },
        },
        data,
        el,
      );
    };
    build();

    // Resize with the panel; rebuild on a colour-scheme switch (colours are read once).
    let width = el.clientWidth;
    const resize = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      plot?.setSize({ width: Math.max(160, width), height: HEIGHT });
    });
    resize.observe(el);
    const scheme = matchMedia(DARK);
    scheme.addEventListener("change", build);
    return () => {
      resize.disconnect();
      scheme.removeEventListener("change", build);
      plot?.destroy();
    };
  }, [histogram, percentiles, xLabel, yLabel]);

  return <div ref={host} className="phist" role="img" aria-label={label} />;
}
