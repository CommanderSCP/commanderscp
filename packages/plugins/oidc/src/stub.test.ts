import { describe, expect, it } from "vitest";
import { STUB } from "./index.js";

/**
 * THIS PACKAGE IS AN M0 WALKING-SKELETON SCAFFOLD THAT WAS SUPERSEDED: M2 shipped OIDC IN-SERVER
 * (`apps/server/src/auth/oidc.ts`), not as this plugin. `src/index.ts` is a doc comment and
 * `export const STUB = true`; nothing imports this package as functional, and its own header says
 * it is safe to delete in a future cleanup.
 *
 * THIS TEST IS EXACTLY AS STRONG AS THE PACKAGE IS, AND NO STRONGER. It asserts the scaffold's only
 * contract — that the package builds and its marker export is reachable — so that `vitest run`
 * (now WITHOUT `--passWithNoTests`) has something to run rather than reporting success having run
 * nothing. It says NOTHING about OIDC, which is tested where it actually lives, in `apps/server`.
 *
 * DELETE THIS FILE WITH THE PACKAGE, or replace it outright if the package ever gains behaviour.
 */
describe("@scp/plugin-oidc (M0 scaffold, superseded by in-server OIDC)", () => {
  it("is a scaffold: the package builds and exports its stub marker, and nothing more", () => {
    expect(STUB).toBe(true);
  });
});
