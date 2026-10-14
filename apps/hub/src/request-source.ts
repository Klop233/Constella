import { AsyncLocalStorage } from "node:async_hooks";

/** The device and address of the HTTP request being handled; audit entries written while handling it pick this up. */
export interface RequestSource {
  ip: string;
  device: string;
}

export const requestSource = new AsyncLocalStorage<RequestSource>();
