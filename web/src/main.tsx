import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { reloadOnStaleBuild } from "./lib/stale-build";
import { ErrorBoundary } from "./components/app/error-boundary";

reloadOnStaleBuild();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary what="SPIL REO">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
