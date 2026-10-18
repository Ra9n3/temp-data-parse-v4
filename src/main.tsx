import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { installGlobalErrorLog } from "./diagnostics/errorLog";

// Stage 3b polish — the error.log rider mounts before React so even a
// mount-time throw lands in %APPDATA%/scorch/error.log.
installGlobalErrorLog();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
