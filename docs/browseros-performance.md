# BrowserOS performance engineering

This branch targets responsive 32-bit desktop guests on low-power Chromebooks while preserving ordinary v86 behavior and compatibility with the standalone BrowserOS HTML.

## Baseline findings

- `src/main.js`: CPU execution runs in `do_tick()` on the calling thread. The browser scheduling Worker merely posts tick notifications back; it does not execute the guest CPU. The existing scheduler.postTask experiment is a useful comparison.
- `src/browser/starter.js`: the ScreenAdapter directly accesses the VGA device; the WorkerBus setup is commented out. Moving the CPU into a Worker requires an explicit device/adapter protocol.
- `src/browser/screen.js`: the graphical adapter uses a 2D canvas with alpha disabled. Accelerated framebuffer presentation is distinct from guest GPU acceleration.
- `Makefile`: the primary WASM build already enables SIMD128, bulk memory and multivalue. Keep the fallback build; do not advertise SIMD as a new optimization.
- `docs/profiling.md`: upstream already has a profiler (make debug-with-profiler).
- `Readme.md`: multicore and x86-64 are unsupported. SoftFloat is intentionally precise but slow.

## Acceptance and baseline measurement

Compare the same guest image, RAM, network configuration, guest resolution and host power state across baseline and candidate builds. Run on both the Chromebook and gaming laptop. Repeat each test three times and record median and range. Separate cold boot and warm boot. Measure:
- Guest CPU instruction throughput (handle counter wraparound).
- Main-thread long tasks, frame presentation interval and input latency.
- Guest boot, app launch, disk read/write and full-session resume time.
- Guest allocation and host memory where measurable.

Exercise idle desktop, window dragging, scrolling, CPU workload, disk workload and saving/restoring. Start with 800x600 and 1280x720, 512/1024 MiB. Use the same guest and browser version for comparisons. Run existing upstream tests before adopting any engine changes; check the BrowserOS single-HTML bundle, mouse, keyboard, primary/secondary media and snapshots separately. Do not claim gains until measured.

## Milestones

1. Instrument scheduler and screen; compare existing scheduler to an opt-in MessageChannel or scheduler.postTask implementation. Preserve idle and interrupt wakeup semantics.
2. Profile VGA changed-region updates, avoid unnecessary copies, compare Canvas2D against optional WebGL/WebGPU framebuffer presentation with fallback. Never claim guest OpenGL acceleration from host presentation.
3. Profile JIT, interpreter, and SoftFloat hotspots; preserve x86 exception and rounding behavior. Test normal and fallback WASM builds.
4. Prototype Worker-owned CPU with explicit asynchronous input, framebuffer, storage and network interfaces. Prefer transferable buffers; feature-detect shared memory and keep a non-isolated fallback for local HTML. Preserve device state and snapshot consistency.
5. Profile disk and RAM allocations; introduce bounded caches only where measurements justify them.
6. Research virtual SMP and accelerated guest graphics separately. SMP requires per-vCPU state, APIC/interrupts, shared memory ordering, atomic instructions, JIT invalidation and guest boot discovery. No fake core-count option.

## Build and integration

Use the existing upstream build and tests first. The Makefile's `all` target produces the JS library and WASM artifacts; consult the repository build instructions for prerequisites. Pin the exact engine commit and matching JS/WASM artifacts in each BrowserOS bundle. Keep an upstream-compatible baseline for comparison and rollback.

This document records the initial plan, not implemented optimizations or benchmark results.
