import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as z from "zod/mini";
import { createEmptyProject, createIdGenerator } from "../core/index.ts";
import { en } from "../ui/strings.ts";
import "../ui/styles.css";
import { Shell } from "./Shell.tsx";

// Zod's JIT probes `new Function`; the CSP has no 'unsafe-eval', so the probe would only
// log a CSP violation. Interpreted parsing is fast enough for project files.
z.config({ jitless: true });

const newId = createIdGenerator({
  now: () => Date.now(),
  fillRandom: (bytes) => {
    crypto.getRandomValues(bytes);
  },
});

const container = document.getElementById("root");
if (container === null) throw new Error("#root missing");

createRoot(container).render(
  <StrictMode>
    <Shell strings={en} version={__APP_VERSION__} newId={newId} initialProject={createEmptyProject(en.untitledProject, newId)} />
  </StrictMode>,
);
