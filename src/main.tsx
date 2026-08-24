import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./App";

// Terminal nodes own native ConPTY processes. React StrictMode deliberately
// mounts effects twice in development, which races creation and teardown of
// those external resources. Keep lifecycle ownership one-to-one here.
createRoot(document.getElementById("root")!).render(<App />);
