import type { SimulationHandle, SimulationService } from "../ui/production/simulation.ts";
import type { WorkerMessage } from "./workers/monte-carlo.worker.ts";

/**
 * Starts each Monte Carlo run in its own Web Worker from the inlined worker source.
 * The worker is terminated when the run finishes, is cancelled, or the tab is hidden
 * (no background work while hidden).
 */
export function createSimulationService(): SimulationService {
  let url: string | null = null;
  return {
    run(request, onProgress): SimulationHandle {
      url ??= URL.createObjectURL(new Blob([__MONTE_CARLO_WORKER__], { type: "text/javascript" }));
      const worker = new Worker(url);
      let settle: (value: Awaited<SimulationHandle["result"]>) => void = () => {};
      const result = new Promise<Awaited<SimulationHandle["result"]>>((resolve) => (settle = resolve));
      const stop = (value: Awaited<SimulationHandle["result"]>) => {
        worker.terminate();
        document.removeEventListener("visibilitychange", onHidden);
        settle(value);
      };
      const onHidden = () => {
        if (document.visibilityState === "hidden") stop(null);
      };
      document.addEventListener("visibilitychange", onHidden);
      worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        if (e.data.type === "progress") onProgress(e.data.done, e.data.total);
        else stop(e.data.result);
      };
      worker.onerror = () => stop(null);
      worker.postMessage(request);
      return { result, cancel: () => stop(null) };
    },
  };
}
