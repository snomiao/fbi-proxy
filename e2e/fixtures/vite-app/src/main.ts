import { setupCounter } from "./counter";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div>
    <h1>HMR Test Fixture</h1>
    <div id="counter-container"></div>
    <p id="hmr-status">Initial load</p>
  </div>
`;

setupCounter(document.querySelector<HTMLDivElement>("#counter-container")!);

// HMR acceptance
if (import.meta.hot) {
  import.meta.hot.accept();
}
