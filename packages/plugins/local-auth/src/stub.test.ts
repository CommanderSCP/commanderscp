import { describe, expect, it } from "vitest";
import { STUB } from "./index.js";

/**
 * THIS PACKAGE IS AN M0 WALKING-SKELETON SCAFFOLD and has no behaviour: `src/index.ts` is a doc
 * comment and `export const STUB = true`. The real local-auth implementation is scheduled for M3+;
 * the M0 bootstrap-admin/argon2 login lives in `apps/server` until the plugin host exists.
 *
 * THIS TEST IS EXACTLY AS STRONG AS THE PACKAGE IS, AND NO STRONGER. It asserts the scaffold's only
 * contract — that the package builds and its marker export is reachable — so that `vitest run`
 * (now WITHOUT `--passWithNoTests`) has something to run rather than reporting success having run
 * nothing. It proves no behaviour, because there is none to prove.
 *
 * WHEN THIS PACKAGE GETS REAL BEHAVIOUR, DELETE THIS FILE rather than adding beside it: a scaffold
 * marker left asserted next to real tests is a green that means nothing.
 */
describe("@scp/plugin-local-auth (M0 scaffold)", () => {
  it("is a scaffold: the package builds and exports its stub marker, and nothing more", () => {
    expect(STUB).toBe(true);
  });
});
