# BrowserOS Worker prototype

The experimental `BrowserOSWorker` client runs the existing single-vCPU v86 engine in a dedicated module Worker. Guest WASM memory, CPU, JIT and virtual devices reside there. The main thread retains keyboard/mouse adapters and ScreenAdapter (including experimental WebGL). The display protocol uses one in-flight request and transferable, compact copies of dirty rectangles; guest WASM memory is never transferred.

## Trying it

Serve the repository over HTTP(S), build the upstream debug WASM using the documented build prerequisites, and load the client as an ES module:

```js
import { BrowserOSWorker } from "./src/browser/browseros-worker-client.js";

const vm = new BrowserOSWorker({
    wasm_path: "./build/v86-debug.wasm",
    bios: { url: "./bios/seabios.bin" },
    vga_bios: { url: "./bios/vgabios.bin" },
    cdrom: { url: "./images/linux4.iso", async: true },
    memory_size: 256 * 1024 * 1024,
    autostart: true
}, document.querySelector("#screen_container"), { renderer: "canvas", fps: 30 });
await vm.ready;
```

Use a normal v86 screen container containing a div and a canvas. Supply an ISO that is actually available on the server. The client resolves media URLs relative to the page and defaults to a debug WASM build; a release-build integration needs separate verification.

Supported prototype API: run, stop, restart, save_state, restore_state (leaves guest paused), asynchronous get_instruction_counter, is_running, events, input enabling, scale and screenshot. Explicitly save before destroying. Guest state and media configuration still must match for restoration.

## Limitations and acceptance criteria

- Not a drop-in replacement for V86: direct device references, custom buffer callbacks, full audio, file sharing/9p, modem, graphical VGA fonts and runtime media management are not wired into this client.
- Network functionality and save/restore have not been end-to-end tested. Do not switch production BrowserOS to the Worker path until boot, input, display, storage and snapshot tests pass.
- Hosted ES-module prototype, not yet compatible with the standalone HTML bundle. A later integration needs a bundled Worker entry and a path for local media and embedded WASM. No automatic restart into the ordinary engine occurs; the original V86 constructor remains available as a separate fallback.
- No SharedArrayBuffer or cross-origin isolation needed for the proposed message transport. This is not multicore guest emulation.
- Run `node tests/api/browseros-worker-screen.js` for screen protocol regression checks, then benchmark real guest interaction and validate lifecycle and disk consistency. Isolated screen tests are not a full Worker boot test.
