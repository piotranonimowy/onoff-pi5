'use strict';

/**
 * onoff - Pi 5 compatible rewrite
 *
 * Original onoff uses the deprecated Linux sysfs GPIO interface
 * (/sys/class/gpio) which is NOT available on Raspberry Pi 5 (RP1 chip).
 *
 * This rewrite uses the Linux GPIO character device API via node-libgpiod,
 * maintaining 100% API compatibility with the original onoff public interface.
 *
 * Dependency: npm install node-libgpiod
 */

const EventEmitter = require('events').EventEmitter;
const fs = require('fs');
const debounce = require('lodash.debounce');

let gpiod;
try {
  gpiod = require('node-libgpiod');
} catch (e) {
  // Not on a GPIO-capable system; accessible will be false
  gpiod = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Auto-detect the correct gpiochip device for the running board.
 * Pi 5 exposes the RP1 GPIO bank as gpiochip4 (or gpiochip0 on some kernels).
 * We find the chip that advertises the most lines (typically 54 for Pi).
 */
function detectGpioChip() {
  if (!gpiod) return null;

  let bestChip = null;
  let bestLines = 0;

  for (let i = 0; i <= 9; i++) {
    const path = `/dev/gpiochip${i}`;
    if (!fs.existsSync(path)) continue;
    try {
      const chip = new gpiod.Chip(i);
      const numLines = chip.numberOfLines;
      if (numLines > bestLines) {
        bestLines = numLines;
        bestChip = i;
      }
    } catch (_) {
      // skip chips we can't open
    }
  }
  return bestChip;
}

const CHIP_INDEX = detectGpioChip();

// Direction constants used internally
const DIRECTION_IN  = 'in';
const DIRECTION_OUT = 'out';

// Edge constants
const EDGE_NONE    = 'none';
const EDGE_RISING  = 'rising';
const EDGE_FALLING = 'falling';
const EDGE_BOTH    = 'both';

// ---------------------------------------------------------------------------
// Gpio class
// ---------------------------------------------------------------------------

class Gpio extends EventEmitter {

  /**
   * @param {number}  gpio      - BCM GPIO number
   * @param {string}  direction - 'in' | 'out' | 'high' | 'low'
   * @param {string}  [edge]    - 'none' | 'rising' | 'falling' | 'both'
   * @param {object}  [options]
   * @param {number}  [options.debounceTimeout]
   * @param {boolean} [options.activeLow]
   * @param {boolean} [options.reconfigureDirection]
   */
  constructor(gpio, direction, edge, options) {
    super();

    // Argument normalisation (edge is optional)
    if (typeof edge === 'object' && edge !== null) {
      options = edge;
      edge = undefined;
    }

    this._gpio      = gpio;
    this._options   = Object.assign({
      activeLow:            false,
      reconfigureDirection: true,
      debounceTimeout:      0
    }, options || {});

    this._direction = (direction === 'high' || direction === 'out') ? DIRECTION_OUT
                    : (direction === 'low')                          ? DIRECTION_OUT
                    : DIRECTION_IN;

    this._edge      = edge || EDGE_NONE;
    this._line      = null;
    this._chip      = null;
    this._watchers  = [];
    this._watchPoll = null;
    this._lastValue = null;

    this._export(direction);
  }

  // -------------------------------------------------------------------------
  // Internal: export / configure the GPIO line
  // -------------------------------------------------------------------------

  _export(direction) {
    if (!gpiod || CHIP_INDEX === null) return; // non-GPIO system

    try {
      this._chip = new gpiod.Chip(CHIP_INDEX);
      this._line = this._chip.getLine(this._gpio);

      const activeLow = !!this._options.activeLow;
      const flags = activeLow ? gpiod.Line.RequestFlags.ACTIVE_LOW : 0;

      if (this._direction === DIRECTION_OUT) {
        const initialValue = (direction === 'high') ? 1 : 0;
        if (flags) {
          this._line.requestOutputModeFlags('onoff', flags, initialValue);
        } else {
          this._line.requestOutputMode('onoff', initialValue);
        }
      } else {
        const isEvent = this._edge !== EDGE_NONE;
        if (isEvent) {
          if (flags) {
            this._line.requestBothEdgesEventFlags('onoff', flags);
          } else {
            this._line.requestBothEdgesEvents('onoff');
          }
          this._startWatch();
        } else {
          if (flags) {
            this._line.requestInputModeFlags('onoff', flags);
          } else {
            this._line.requestInputMode('onoff');
          }
        }
        this._lastValue = this._line.getValue();
      }
    } catch (err) {
      throw new Error(
        `Failed to export GPIO${this._gpio} on gpiochip${CHIP_INDEX}: ${err.message}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Internal: polling-based interrupt detection
  // Using setInterval + getValue diff since node-libgpiod event streaming
  // varies across versions; a 1ms poll is used for interrupts.
  // For production use with high-frequency interrupts, replace with
  // line.eventWait() in a worker_thread.
  // -------------------------------------------------------------------------

  _startWatch() {
    if (this._watchPoll) return;

    const intervalMs = 1; // 1ms poll — acceptable for most switch/button use cases

    this._watchPoll = setInterval(() => {
      if (!this._line) return;
      try {
        const val = this._line.getValue();
        const activeLow = this._options.activeLow;
        const adjusted  = activeLow ? (val ^ 1) : val;

        if (this._lastValue === null) {
          this._lastValue = adjusted;
          return;
        }

        const changed = adjusted !== this._lastValue;
        const risingOk  = this._edge === EDGE_RISING  && adjusted === 1;
        const fallingOk = this._edge === EDGE_FALLING && adjusted === 0;
        const bothOk    = this._edge === EDGE_BOTH;

        if (changed && (risingOk || fallingOk || bothOk)) {
          this._lastValue = adjusted;
          this._fireWatchers(null, adjusted);
        }
      } catch (err) {
        this._fireWatchers(err, 0);
      }
    }, intervalMs);

    // Don't keep Node.js alive just for GPIO polling
    if (this._watchPoll.unref) this._watchPoll.unref();
  }

  _stopWatch() {
    if (this._watchPoll) {
      clearInterval(this._watchPoll);
      this._watchPoll = null;
    }
  }

  _fireWatchers(err, value) {
    const debounceMs = this._options.debounceTimeout;

    if (debounceMs > 0) {
      if (!this._debouncedFire) {
        this._debouncedFire = debounce((e, v) => {
          for (const cb of this._watchers) cb(e, v);
        }, debounceMs);
      }
      this._debouncedFire(err, value);
    } else {
      for (const cb of this._watchers) cb(err, value);
    }
  }

  // -------------------------------------------------------------------------
  // Public API — matches original onoff exactly
  // -------------------------------------------------------------------------

  /**
   * Read GPIO value asynchronously.
   * Returns a Promise if no callback supplied.
   */
  read(callback) {
    if (callback) {
      try {
        callback(null, this.readSync());
      } catch (err) {
        callback(err);
      }
      return;
    }
    return new Promise((resolve, reject) => {
      try {
        resolve(this.readSync());
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Read GPIO value synchronously. Returns 0 or 1.
   */
  readSync() {
    if (!this._line) return 0;
    const raw = this._line.getValue();
    return this._options.activeLow ? (raw ^ 1) : raw;
  }

  /**
   * Write GPIO value asynchronously.
   * Returns a Promise if no callback supplied.
   */
  write(value, callback) {
    if (callback) {
      try {
        this.writeSync(value);
        callback(null);
      } catch (err) {
        callback(err);
      }
      return;
    }
    return new Promise((resolve, reject) => {
      try {
        this.writeSync(value);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Write GPIO value synchronously.
   */
  writeSync(value) {
    if (!this._line) return;
    if (value !== 0 && value !== 1) {
      throw new Error(`Value must be 0 or 1, got ${value}`);
    }
    const toWrite = this._options.activeLow ? (value ^ 1) : value;
    this._line.setValue(toWrite);
  }

  /**
   * Watch for hardware interrupts on the GPIO.
   */
  watch(callback) {
    if (this._edge === EDGE_NONE) {
      // No edge configured — start watching anyway (caller's responsibility)
      this._startWatch();
    }

    const debounceMs = this._options.debounceTimeout;
    if (debounceMs > 0) {
      const debounced = debounce(callback, debounceMs);
      debounced._original = callback;
      this._watchers.push(debounced);
    } else {
      this._watchers.push(callback);
    }
  }

  /**
   * Stop watching for hardware interrupts.
   */
  unwatch(callback) {
    if (!callback) {
      this._watchers = [];
    } else {
      this._watchers = this._watchers.filter(cb => {
        return cb !== callback && cb._original !== callback;
      });
    }
    if (this._watchers.length === 0) {
      this._stopWatch();
    }
  }

  /**
   * Remove all hardware interrupt watchers.
   */
  unwatchAll() {
    this.unwatch();
  }

  /**
   * Get GPIO direction.
   */
  direction() {
    return this._direction;
  }

  /**
   * Set GPIO direction.
   * NOTE: on the character device API this requires releasing and
   * re-requesting the line.
   */
  setDirection(direction) {
    const flags = this._options.activeLow ? gpiod.Line.RequestFlags.ACTIVE_LOW : 0;

    this._line.release();

    if (direction === 'in') {
      this._direction = DIRECTION_IN;
      if (flags) this._line.requestInputModeFlags('onoff', flags);
      else       this._line.requestInputMode('onoff');
    } else {
      this._direction = DIRECTION_OUT;
      const initial = (direction === 'high') ? 1 : 0;
      if (flags) this._line.requestOutputModeFlags('onoff', flags, initial);
      else       this._line.requestOutputMode('onoff', initial);
    }
  }

  /**
   * Get GPIO interrupt generating edge.
   */
  edge() {
    return this._edge;
  }

  /**
   * Set GPIO interrupt generating edge.
   */
  setEdge(edge) {
    this._edge = edge;
    this._stopWatch();
    if (edge !== EDGE_NONE) {
      this._startWatch();
    }
  }

  /**
   * Get activeLow setting.
   */
  activeLow() {
    return this._options.activeLow;
  }

  /**
   * Set activeLow setting.
   */
  setActiveLow(invert) {
    this._options.activeLow = invert;
  }

  /**
   * Release the GPIO line and free resources.
   * Always call this on process exit / SIGINT.
   */
  unexport() {
    this._stopWatch();
    this._watchers = [];

    if (this._line) {
      try { this._line.release(); } catch (_) {}
      this._line = null;
    }
    this._chip = null;
  }

  // -------------------------------------------------------------------------
  // Static members
  // -------------------------------------------------------------------------

  /**
   * True if the current process can access GPIO hardware.
   */
  static get accessible() {
    if (!gpiod || CHIP_INDEX === null) return false;
    try {
      new gpiod.Chip(CHIP_INDEX);
      return true;
    } catch (_) {
      return false;
    }
  }

  static get HIGH() { return 1; }
  static get LOW()  { return 0; }
}

module.exports = { Gpio };
