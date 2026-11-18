import type { en } from './en';

/** The shape every language's dictionary has: the English one's. */
export type Dict = typeof en;

/** Every branch optional, down to the entries (a string, a function or a list is taken whole). */
type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

/** A dictionary that may leave words out: they are shown in English (index.ts). */
export type PartialDict = DeepPartial<Dict>;
