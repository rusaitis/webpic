// The render layer has no cross-layer surface: app and tests deep-import the worker-message
// contract (`@render/messages.ts`), everything else is render-internal. This file exists so the
// `@render` alias resolves (tests/aliases.test.ts).
export {};
