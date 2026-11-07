// Global test setup for the web console (vitest + @testing-library).
//
// `@testing-library/react` auto-cleans the DOM after each test; we only need
// to register the custom matchers and give jsdom the browser APIs the console
// touches that jsdom does not implement (matchMedia).
import "@testing-library/jest-dom/vitest";

if (!window.matchMedia) {
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });
}
