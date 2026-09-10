import { mount } from "svelte";
import App from "./App.svelte";
import "./styles/global.css";

const target = document.getElementById("app");
if (!target) {
  throw new Error("DSH-Dock: mount target #app was not found in index.html");
}

const app = mount(App, { target });

export default app;
