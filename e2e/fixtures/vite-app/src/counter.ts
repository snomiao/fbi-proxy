// Use a getter function to ensure HMR picks up new values
export function getHmrTestValue(): string {
  return "INITIAL_VALUE";
}

export function setupCounter(element: HTMLElement) {
  let count = 0;

  element.innerHTML = `
    <button id="counter-btn" type="button">count is ${count}</button>
  `;

  const button = element.querySelector<HTMLButtonElement>("#counter-btn")!;
  button.addEventListener("click", () => {
    count++;
    button.textContent = `count is ${count}`;
  });
}
