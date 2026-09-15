import "./style.css";
import { App } from "./app.js";

const root = document.getElementById("app");
if (!root) throw new Error("no #app");
new App(root).start().catch((e: unknown) => {
  root.textContent = `Blockshop kon niet starten: ${(e as Error)?.message ?? String(e)}`;
});
