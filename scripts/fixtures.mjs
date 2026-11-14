// Synthetic scan inputs for demos and smoke tests. Text only: never executed.
export const FIXTURES = {
  // A hard-coded secret: the supplied scanner reports HIGH, so the verdict is FAIL.
  high: { files: [{ path: 'src/demo.js', content: 'const password = "demo-only-value";\nexport default password;' }], verdict: 'FAIL' },
  // The corrected version of the same file: no HIGH finding, verdict PASS.
  clean: { files: [{ path: 'src/demo.js', content: 'export const add = (a, b) => a + b;' }], verdict: 'PASS' },
  // A commit with no JavaScript: an explicit, complete zero-file scan.
  empty: { files: [], verdict: 'PASS' }
};
export function fixture(name) {
  if (!Object.hasOwn(FIXTURES, name)) throw new Error(`Use one of: ${Object.keys(FIXTURES).join(', ')}.`);
  return FIXTURES[name];
}
