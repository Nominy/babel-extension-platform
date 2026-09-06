import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./recovered/generated/liveStyles.css";

document.documentElement.lang = "en";
document.documentElement.className = "overscroll-y-none light";
document.documentElement.style.colorScheme = "light";
document.body.className = "overscroll-y-none overscroll-x-none font-sans antialiased __variable_f367f3";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
