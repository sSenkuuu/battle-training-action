// A controller that does nothing: drafts the default squad and sends no
// orders. Used by the tests as a controller that must FAIL the thresholds.
globalThis.controller = {
  hello() {},
  tick() {
    return { units: [] };
  },
};
