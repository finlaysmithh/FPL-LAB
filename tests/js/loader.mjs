// Node cannot import JSON without an explicit `with { type: "json" }`
// attribute; Vite can, and the app source is written for Vite. Rather than
// litter the app with attributes that only exist to please the test runner,
// the runner adapts: this hook supplies the attribute on node's behalf.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    if (r.url.endsWith(".json")) r.importAttributes = { type: "json" };
    return r;
  },
});
