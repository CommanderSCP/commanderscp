import { ScpClient } from "@scp/sdk";

/** The ONE `ScpClient` instance the whole SPA shares. See docs/web.md §117. */
export const client = new ScpClient({ baseUrl: "/api/v1" });
