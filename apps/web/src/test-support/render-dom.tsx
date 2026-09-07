import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/** THE STRUCTURAL FIX FOR THE "WORDING, NOT BEHAVIOUR" CLASS. See docs/web.md §512. */

/** Vitest's own signal that `act()` is being used correctly; React reads it off the global. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  container: HTMLElement;
  /** The single element carrying `data-testid="…"`. Throws rather than returning null, so a typo in
   *  a selector is a loud failure and never a silently-skipped assertion. */
  byTestId(testId: string): HTMLElement;
  /** A real bubbling click, flushed through `act` so any resulting state update has landed before
   *  the next assertion. A `disabled` button swallows it exactly as a browser would. */
  click(testId: string): void;
  html(): string;
  unmount(): void;
}

/** Dispatch any event on any node, flushed through `act`. `click(testId)` covers the common case;
 *  this is for the rest (a `change` on a `<select>`, a click on one of several same-testid nodes). */
export function fire(target: EventTarget, event: Event): void {
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Type into a CONTROLLED `<input>`. Not `el.value = x; fire(input)`. See docs/web.md §513. */
export function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter)
    throw new Error("HTMLInputElement.prototype has no value setter in this environment");
  setter.call(input, value);
  fire(input, new Event("input", { bubbles: true }));
}

/** Flush pending microtasks (an awaited mutation, a resolved promise) inside `act`, so state updates
 *  they trigger have landed before the next assertion. */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

export function render(element: ReactElement): Rendered {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(element);
  });

  const byTestId = (testId: string): HTMLElement => {
    const found = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (found === null) throw new Error(`no element carries data-testid="${testId}"`);
    return found;
  };

  return {
    container,
    byTestId,
    click: (testId) => {
      const target = byTestId(testId);
      act(() => {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
    html: () => container.innerHTML,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}
