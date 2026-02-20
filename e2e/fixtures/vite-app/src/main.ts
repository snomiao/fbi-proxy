import { setupCounter, getHmrTestValue } from "./counter";

function render(getValue: () => string = getHmrTestValue) {
  const value = getValue();
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
    <div>
      <h1>HMR Test Fixture</h1>
      <div id="counter-container"></div>
      <p id="hmr-marker" data-value="${value}">${value}</p>
      <p id="hmr-status">Loaded</p>
    </div>
  `;

  setupCounter(document.querySelector<HTMLDivElement>("#counter-container")!);
}

render();

// HMR acceptance - re-render when this module or its dependencies change
if (import.meta.hot) {
  console.log("[HMR] Setting up HMR handlers...");

  // Accept updates to counter.ts and re-import with the new module
  import.meta.hot.accept("./counter", (newModule) => {
    console.log("[HMR] counter.ts updated with new module:", newModule);
    if (newModule) {
      // Call the NEW function from the new module to get the updated value
      const newValue = newModule.getHmrTestValue();
      console.log("[HMR] New value from getHmrTestValue():", newValue);

      // Re-render with the new module's function
      const app = document.querySelector<HTMLDivElement>("#app")!;
      app.innerHTML = `
        <div>
          <h1>HMR Test Fixture</h1>
          <div id="counter-container"></div>
          <p id="hmr-marker" data-value="${newValue}">${newValue}</p>
          <p id="hmr-status">HMR Updated at ${new Date().toISOString()}</p>
        </div>
      `;
      newModule.setupCounter(
        document.querySelector<HTMLDivElement>("#counter-container")!,
      );
      console.log(
        "[HMR] Render complete, marker text:",
        document.getElementById("hmr-marker")?.textContent,
      );
    }
  });
}
