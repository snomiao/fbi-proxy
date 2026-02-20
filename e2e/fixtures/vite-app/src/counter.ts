export const HMR_TEST_VALUE = "INITIAL_VALUE";

export function setupCounter(element: HTMLElement) {
  let count = 0;

  element.innerHTML = `
    <button id="counter-btn" type="button">count is ${count}</button>
    <p id="hmr-marker" data-value="${HMR_TEST_VALUE}">${HMR_TEST_VALUE}</p>
  `;

  const button = element.querySelector<HTMLButtonElement>("#counter-btn")!;
  button.addEventListener("click", () => {
    count++;
    button.textContent = `count is ${count}`;
  });
}
