import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * THE STRUCTURAL FIX FOR THE "WORDING, NOT BEHAVIOUR" CLASS (M16.2 phase B, round 3).
 *
 * WHY THIS EXISTS. Every component test in `apps/web` renders through `react-dom/server`'s
 * `renderToStaticMarkup` — a STRING. A string cannot fire a handler, so every behavioural guarantee
 * on this branch had to be pinned as an ATTRIBUTE or a LABEL beside the handler instead of as the
 * handler's own effect. That is not a pin: it is a second copy of the claim, and the two can
 * diverge silently. The measured proof — replacing `onClick={() => onReconcile(defaultKeep.objectId)}`
 * in `outpost-configuration.tsx` with `onClick={() => onReconcile(undefined)}`, i.e. restoring the
 * exact bare destructive verb the reconcile-default work exists to remove, left the whole web suite
 * GREEN, because the only thing asserted was the `data-keep` attribute rendered NEXT TO the handler.
 *
 * WHY A REAL DOM AND NOT A CLEVERER STRING TRICK. The alternative considered was hoisting the click
 * payload into an exported pure function and asserting that. It is cheaper, but it does not satisfy
 * the acceptance criterion: with no way to INVOKE the handler, `onReconcile(undefined)` written
 * directly in the JSX still goes unnoticed however the payload is computed elsewhere. Only actually
 * dispatching the event and observing the argument closes that gap — and it generalises: disabled
 * buttons really do swallow clicks, state updates really do re-render, so the next interaction
 * guarantee has somewhere to live instead of becoming another attribute.
 *
 * COST, STATED HONESTLY: one devDependency, `happy-dom` — chosen over `jsdom` as the far smaller of
 * the two, and used ONLY by test files that opt in with a `@vitest-environment happy-dom` docblock.
 * The default Vitest environment for `apps/web` is still Node, so every existing
 * `renderToStaticMarkup` test keeps running exactly as before with no environment cost. Nothing
 * here touches the network (charter principle 5); it is a dev-time dependency in the same class as
 * the Playwright/Chromium toolchain CI already vendors.
 */

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

/**
 * Type into a CONTROLLED `<input>`.
 *
 * Not `el.value = x; fire(input)`: React installs its own value setter on the element instance and
 * uses it to dedupe change events, so a plain assignment can leave the tracker believing nothing
 * changed and the `onChange` never fires — a silently vacuous test. Going through the PROTOTYPE
 * setter updates the DOM without touching React's tracker, so the dispatched `input` event is seen
 * as a real change. (React's `onChange` is wired to the native `input` event, not `change`.)
 */
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
