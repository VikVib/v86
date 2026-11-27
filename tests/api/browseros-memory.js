#!/usr/bin/env node

import assert from "node:assert/strict";
await import("../../src/main.js");
const { buffer_from_object } = await import("../../src/buffer.js");
const { CPU } = await import("../../src/cpu.js");

const make_disk = budget => buffer_from_object({
    url: "unused.img", async: true, size: 4096, fixed_chunk_size: 512,
    read_cache_bytes: budget,
});

const disk = make_disk(512);
disk.handle_read(0, 512, new Uint8Array(512).fill(1));
assert.equal(disk.block_cache.size, 2);
disk.get_from_cache(0, 256);
disk.handle_read(512, 256, new Uint8Array(256).fill(2));
assert(disk.block_cache.has(0));
assert(!disk.block_cache.has(1));
assert(disk.block_cache.has(2));

disk.set(0, new Uint8Array(256).fill(9), () => {});
disk.handle_read(768, 1024, new Uint8Array(1024).fill(3));
assert(disk.block_cache.has(0));
assert(disk.block_cache_is_write.has(0));
assert.equal(disk.read_cache_order.size, 2);
const incoming = new Uint8Array(512);
disk.handle_read(0, 512, incoming);
assert(incoming.subarray(0, 256).every(x => x === 9));
const state = disk.get_state();
assert.equal(state[0].length, 1);
disk.set_state(state);
assert.equal(disk.read_cache_order.size, 0);
assert.equal(disk.block_cache.size, 1);

// Explicitly cached boot sectors must survive clean-cache eviction.
const pinned = make_disk(256);
pinned.handle_read(0, 256, new Uint8Array(256).fill(7));
pinned.get_and_cache(0, 256, () => {});
pinned.handle_read(256, 1024, new Uint8Array(1024));
assert(pinned.get_from_cache(0, 256).every(x => x === 7));
assert.equal(pinned.read_cache_order.size, 1);

const disabled = make_disk(0);
disabled.handle_read(0, 512, new Uint8Array(512));
assert.equal(disabled.block_cache.size, 0);
const legacy = make_disk(undefined);
legacy.handle_read(0, 512, new Uint8Array(512));
assert.equal(legacy.block_cache.size, 2);

// Check both byte-for-byte output compatibility and restoration.
for(const pages of [[], [0, 1, 2], [1, 2, 3, 5, 8, 9, 11], Array.from({ length: 12 }, (_, i) => i)])
{
    const memory = new Uint8Array(4096 * 12);
    for(const page of pages) memory.fill(page + 1, page * 4096, (page + 1) * 4096);
    const fixture = {
        mem8: memory,
        memory_size: [memory.length],
        is_memory_zeroed: (offset, length) => memory.subarray(offset, offset + length).every(x => x === 0),
    };
    const { bitmap, packed_memory } = CPU.prototype.pack_memory.call(fixture);
    const reference = new Uint8Array(pages.length * 4096);
    pages.forEach((page, i) => reference.set(memory.subarray(page * 4096, (page + 1) * 4096), i * 4096));
    assert.deepEqual(packed_memory, reference);
    const restored = new Uint8Array(memory.length).fill(255);
    CPU.prototype.unpack_memory.call({
        mem8: restored,
        memory_size: [restored.length],
        zero_memory: () => restored.fill(0),
    }, bitmap, packed_memory);
    assert.deepEqual(restored, memory);
}

console.log("BrowserOS memory regression tests passed");
