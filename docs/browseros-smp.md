# BrowserOS SMP investigation

Status: single virtual CPU only. The CPU Worker prototype is host concurrency, not SMP. Do not expose a 2+ CPU selector yet.

## Source audit

- `src/rust/cpu/global_pointers.rs`: registers, flags, control registers, segment caches, FPU, XMM, TSC, instruction pointer and HLT state use fixed linear-memory offsets. Two instances sharing the current memory would overwrite one another's register state.
- `src/rust/cpu/cpu.rs`: reset, execution loop, IRQ handling, global TLB and instruction counter assume a single active CPU. Global pointers are not the complete CPU context; audit mutable statics and hidden instruction/JIT state as well.
- `src/rust/cpu/memory.rs`: guest physical memory is allocated once in the engine's linear memory; MMIO dispatch is synchronous. Separate independent WASM memories would not represent one PC.
- `src/rust/cpu/apic.rs`: one local APIC object; INIT and NMI incomplete, ICR startup delivery previously not distinguished from ordinary vectors. This stage fixes physical destination routing and prevents SIPI from injecting a normal interrupt into the only CPU. Logical routing and AP startup remain incomplete.
- `src/rust/jit.rs`: one global JIT state, shared code and TLB metadata, fixed register addresses. Compilation completion and self-modifying-code invalidation must be safe across cores.
- `src/cpu.js`: firmware CPU count is hard-coded to one, CMOS SMP count is zero, snapshots contain one local APIC. Leave these values unchanged until all CPU/device paths implement SMP.
- `src/browser/starter.js`: reject unsupported cpu_count values synchronously, before allocating a VM.

## Proposed architecture

First implement cooperative SMP (multiple architectural CPU contexts, one host execution thread), then experiment with parallel host execution. Cooperative SMP is a correctness milestone, not a guaranteed speedup.

1. Define complete per-vCPU context storage, with explicit shared machine state. Migrate register accesses in interpreter, code generator, JS state views and CPU-specific helpers. No raw fixed offsets may accidentally refer to another CPU. Audit TLB, flags, FPU, TSC and reset state.
2. Introduce one local APIC per CPU, physical and logical destination routing, interrupt arbitration, INIT/SIPI state machine, BSP/AP distinction, per-core HLT wakeup and APIC timers. Keep IOAPIC and legacy PIC machine-wide.
3. Implement deterministic round-robin execution with bounded quanta, per-core counters and safe switching. Initially disable the JIT on the SMP experimental path or explicitly invalidate context-dependent compiled code. Maintain a single coherent physical RAM and device bus.
4. Expose consistent firmware (fw_cfg, CMOS, MADT/MP tables) and CPUID topology only after AP startup works. Extend the snapshot format with versioned per-core state; preserve old single-core snapshots.
5. For real parallel execution, redesign WASM memory layout and allocator for sharing, JIT imports and per-thread stack/context, shared RAM ordering and x86 LOCK atomics, translation/TLB invalidation and synchronized MMIO/device ownership. Evaluate browser SharedArrayBuffer and WASM atomics capability with ordinary fallback; do not require unsupported browser features.
6. Measure two virtual CPUs against one on the same image and host. Parallel SMP must earn its cost in memory and synchronization; a two-core host still needs resources for display and browser UI.

## Acceptance gates

- One-core guests retain previous firmware, snapshot compatibility, interrupt behavior and boot reliability.
- Two cores are reported by Linux only after distinct processors execute an AP startup trampoline and complete a shared-memory handshake.
- Verify per-CPU APIC IDs, directed and broadcast IPIs, INIT/SIPI, HLT wakeups, timers, TLB shootdowns, locked memory operations, self-modifying code, page faults and concurrent device access.
- Verify independent registers/FPU/SSE state, pause/resume, reboot and snapshot restoration with both CPUs active.
- Compare single-core and dual-core workloads, frame time, input delay and memory on target hardware. Do not claim parallel speedup for cooperative SMP.
- Run existing upstream CPU, APIC, JIT paging and guest integration suites plus new SMP tests.

## Research references

- Upstream v86 README: https://github.com/copy/v86 (multicore is listed as unsupported).
- QEMU multi-threaded TCG design: https://github.com/qemu/qemu/blob/master/docs/devel/multi-thread-tcg.rst (per-vCPU state, synchronization, memory ordering, translation invalidation).
- Intel x86 software developer manuals: https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html (AP startup, local APIC and multiprocessor management).

This stage is groundwork, not an SMP implementation. The Rust changes need a compiled regression run. All work stays on the private development workflow within this public fork; do not submit AI-generated contributions to upstream contrary to its contribution policy.
