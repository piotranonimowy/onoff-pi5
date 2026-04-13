/// <reference types="node" />

import { EventEmitter } from 'events';

export type Direction = 'in' | 'out' | 'high' | 'low';
export type Edge = 'none' | 'rising' | 'falling' | 'both';
export type BinaryValue = 0 | 1;

export interface Options {
  debounceTimeout?: number;
  activeLow?: boolean;
  reconfigureDirection?: boolean;
}

export type Callback = (err: Error | null | undefined, value: BinaryValue) => void;

export class Gpio extends EventEmitter {
  constructor(gpio: number, direction: Direction, edge?: Edge, options?: Options);
  constructor(gpio: number, direction: Direction, options?: Options);

  read(callback: Callback): void;
  read(): Promise<BinaryValue>;

  readSync(): BinaryValue;

  write(value: BinaryValue, callback: (err: Error | null | undefined) => void): void;
  write(value: BinaryValue): Promise<void>;

  writeSync(value: BinaryValue): void;

  watch(callback: Callback): void;
  unwatch(callback?: Callback): void;
  unwatchAll(): void;

  direction(): 'in' | 'out';
  setDirection(direction: Direction): void;

  edge(): Edge;
  setEdge(edge: Edge): void;

  activeLow(): boolean;
  setActiveLow(invert: boolean): void;

  unexport(): void;

  static readonly accessible: boolean;
  static readonly HIGH: 1;
  static readonly LOW: 0;
}
