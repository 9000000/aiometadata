import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestAuth {
  authenticated: boolean;
}

const store = new AsyncLocalStorage<RequestAuth>();

function runWithRequestAuth<T>(authenticated: boolean, fn: () => T): T {
  return store.run({ authenticated }, fn);
}

function inRequest(): boolean {
  return store.getStore() !== undefined;
}

function requestIsAuthenticated(): boolean {
  return store.getStore()?.authenticated === true;
}

export { runWithRequestAuth, inRequest, requestIsAuthenticated };
module.exports = { runWithRequestAuth, inRequest, requestIsAuthenticated };
