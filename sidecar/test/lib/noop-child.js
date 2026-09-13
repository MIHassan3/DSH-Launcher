/**
 * Throwaway long-lived child used by sidecar/test/platform.js.
 *
 * Exists so the identity and kill tests can probe a REAL second process whose
 * command line contains an absolute script path. Deliberately self-contained:
 * no imports, no output, no stdio, so it cannot interfere with the test that
 * spawns it.
 *
 * Not part of the product. Safe to delete if the test stops using it.
 */

setInterval(() => {}, 1000);
