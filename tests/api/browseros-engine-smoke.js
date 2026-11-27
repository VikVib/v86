import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile as read_file } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const mode = process.env.BROWSEROS_BUILD || "debug";
const wasm_name = { debug: "v86-debug.wasm", release: "v86.wasm", fallback: "v86-fallback.wasm" }[mode];
assert(wasm_name, "Unknown BROWSEROS_BUILD");
const { V86 } = mode === "debug" ? await import("../../src/main.js") : await import("../../build/libv86.mjs");
const bytes = await read_file(new URL("build/" + wasm_name, root));
assert(WebAssembly.validate(bytes), "WASM module must validate");

// Minimal 1.44 MB floppy with a tiny real-mode guest program. It reports
// success through COM1 after executing a hot loop, then halts.
const floppy = new Uint8Array(1440 * 1024);
floppy.set([
    0xFA,                         // cli
    0xBA, 0xFB, 0x03,             // mov dx, 0x3fb
    0xB0, 0x03, 0xEE,             // 8-bit UART mode
    0xBA, 0xFC, 0x03,             // mov dx, 0x3fc
    0x30, 0xC0, 0xEE,             // disable loopback
    0xBB, 0x10, 0x00,             // mov bx, 16
    0x31, 0xC9,                   // outer: xor cx,cx
    0xE2, 0xFE,                   // loop inner (65536 iterations)
    0x4B, 0x75, 0xF9,             // dec bx; jnz outer
    0xBA, 0xF8, 0x03,
    0xB0, 0x42, 0xEE,             // output 'B'
    0xF4, 0xEB, 0xFD,             // halt
]);
floppy[510] = 0x55;
floppy[511] = 0xAA;

assert.throws(() => new V86({ cpu_count: 2 }), /exactly one virtual CPU/);
let exports;
let vm;
const timeout = setTimeout(() => {
    console.error("BrowserOS engine smoke test timed out:", mode);
    process.exit(1);
}, 60_000);
try
{
    vm = new V86({
        wasm_fn: async imports => {
            const instance = (await WebAssembly.instantiate(bytes, imports)).instance;
            exports = instance.exports;
            return exports;
        },
        bios: { url: fileURLToPath(new URL("bios/seabios.bin", root)) },
        vga_bios: { url: fileURLToPath(new URL("bios/vgabios.bin", root)) },
        fda: { buffer: floppy.buffer },
        memory_size: 32 * 1024 * 1024,
        acpi: true,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
        autostart: false,
        log_level: 0,
    });
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    assert.equal(exports.get_jit_config(4), 200000);
    exports.set_jit_config(4, 0);
    assert.equal(exports.get_jit_config(4), 50000);
    exports.set_jit_config(4, 1000000);
    assert.equal(exports.get_jit_config(4), 800000);
    exports.set_jit_config(4, 100000);
    const completed = new Promise(resolve => {
        vm.add_listener("serial0-output-byte", byte => {
            if(byte === 0x42) resolve();
        });
    });
    await vm.run();
    await completed;
    await vm.stop();
    assert(vm.get_instruction_counter() > 100000, "Guest executed hot loop");
    const before = await vm.save_state();
    assert(before instanceof ArrayBuffer && before.byteLength > 0);
    await vm.restore_state(before);
    const after = await vm.save_state();
    assert(after instanceof ArrayBuffer && after.byteLength > 0);
    console.log("Compiled engine boot/JIT/snapshot smoke test passed:", mode);
}
finally
{
    clearTimeout(timeout);
    if(vm) await vm.destroy();
}
