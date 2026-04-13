# onoff-pi5

**Drop-in replacement for [onoff](https://github.com/fivdi/onoff) with full Raspberry Pi 5 compatibility.**

## Why this exists

The original `onoff` uses the Linux **sysfs GPIO interface** (`/sys/class/gpio`).
The Raspberry Pi 5 uses the **RP1** I/O controller chip, whose GPIO is only
accessible via the **character device API** (`/dev/gpiochipN`).
The sysfs interface is absent on Pi 5, making the original `onoff` non-functional.

This rewrite replaces sysfs with `node-libgpiod` (character device API) while
maintaining **100% API compatibility** with the original onoff public interface.

---

## Installation

```bash
npm install onoff-pi5
# or if replacing onoff in an existing project:
npm uninstall onoff
npm install onoff-pi5
# then in your code replace:
#   require('onoff')  →  require('onoff-pi5')
```

**System requirement:** `libgpiod` must be installed on the Pi:
```bash
sudo apt install libgpiod2 libgpiod-dev
```

---

## Key differences from original onoff

| Concern | Original onoff | onoff-pi5 |
|---|---|---|
| GPIO backend | sysfs `/sys/class/gpio` | Character device `/dev/gpiochipN` |
| Pi 5 support | ❌ No | ✅ Yes |
| Pi 1–4 support | ✅ Yes | ✅ Yes (auto-detects chip) |
| Interrupt detection | epoll on sysfs `value` file | 1ms polling via `setInterval` |
| Native dependency | `epoll` (compiled) | `node-libgpiod` (compiled) |
| API compatibility | — | 100% drop-in |

> **Interrupt note:** The polling approach works well for buttons and switches
> (debounce tolerance already covers the 1ms poll jitter). For high-frequency
> interrupts (>500/sec), replace `_startWatch()` with `line.eventWait()` in a
> `worker_thread`.

---

## gpiochip auto-detection

The library automatically selects the gpiochip with the most lines:

| Board | Chip | Lines |
|---|---|---|
| Pi 5 (RP1) | `gpiochip4` | 54 |
| Pi 4 / 3 / 2 | `gpiochip0` | 54 |

You do not need to configure this manually.

---

## Usage (identical to original onoff)

```javascript
const { Gpio } = require('onoff-pi5');

// LED on GPIO17, button on GPIO4
const led    = new Gpio(17, 'out');
const button = new Gpio(4, 'in', 'both');

button.watch((err, value) => {
  if (err) throw err;
  led.writeSync(value);
});

process.on('SIGINT', () => {
  led.unexport();
  button.unexport();
});
```

```javascript
// Debounced button with toggle
const { Gpio } = require('onoff-pi5');
const led    = new Gpio(17, 'out');
const button = new Gpio(4, 'in', 'rising', { debounceTimeout: 10 });

button.watch((err) => {
  if (err) throw err;
  led.writeSync(led.readSync() ^ 1);
});

process.on('SIGINT', () => {
  led.unexport();
  button.unexport();
});
```

```javascript
// Check accessibility (useful for dev machines without GPIO)
const { Gpio } = require('onoff-pi5');

if (Gpio.accessible) {
  const led = new Gpio(17, 'out');
  led.writeSync(Gpio.HIGH);
  setTimeout(() => { led.writeSync(Gpio.LOW); led.unexport(); }, 1000);
} else {
  console.log('No GPIO available on this system');
}
```

---

## API

Identical to the original onoff — see https://github.com/fivdi/onoff#api

## License

MIT
