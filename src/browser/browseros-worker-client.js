/* global structuredClone */
import "../main.js";
import { Bus } from "../bus.js";
import { ScreenAdapter } from "./screen.js";
import { KeyboardAdapter } from "./keyboard.js";
import { MouseAdapter } from "./mouse.js";

// This is an experimental, separate API, not a drop-in replacement for V86.
// It uses hosted ES modules. The ordinary V86 constructor remains unchanged.
export class BrowserOSWorker
{
    constructor(options, container, { renderer = "canvas", fps = 30 } = {})
    {
        if(typeof Worker !== "function" || typeof MessageChannel !== "function")
            throw new Error("Dedicated Workers and MessageChannel are required");
        if(!container) throw new Error("A screen container is required");

        // Only serializable options belong in a Worker. URL resolution must
        // happen here, relative to the embedding page, not the Worker module.
        if(options.wasm_fn || options.filesystem || options.modem ||
            options.serial_console || options.serial_container || options.serial_container_xtermjs ||
            options.virtio_console || options.screen || options.screen_container)
            throw new Error("Custom adapters, filesystem and console options are not supported by this prototype");
        const config = structuredClone(options);
        for(const name of ["bios", "vga_bios", "hda", "hdb", "cdrom", "fda", "fdb",
            "bzimage", "initrd", "multiboot", "initial_state"])
        {
            const image = config[name];
            if(image && image.url) image.url = new URL(image.url, document.baseURI).href;
        }
        config.wasm_path = options.wasm_path
            ? new URL(options.wasm_path, document.baseURI).href
            : new URL("../../build/v86-debug.wasm", import.meta.url).href;

        this.closed = false;
        this.loaded = false;
        this.running = false;
        this.next_id = 0;
        this.pending = new Map();
        this.frame_pending = false;
        this.full_redraw = true;
        this.generation = -1;
        this.graphical = false;
        this.last_frame = -Infinity;
        this.frame_interval = 1000 / Math.max(1, Math.min(60, Number(fps) || 30));

        const url = new URL("./browseros-cpu-worker.js", import.meta.url);
        url.searchParams.set("use-message-channel", "1");
        this.worker = new Worker(url, { type: "module", name: "BrowserOS CPU" });
        this.ready = new Promise((resolve, reject) => {
            this.resolve_ready = resolve;
            this.reject_ready = reject;
        });
        this.ready_timeout = setTimeout(() => this.fail(new Error("CPU Worker initialization timed out")), 120000);
        this.worker.onmessage = event => {
            try { this.receive(event.data); }
            catch(error) { this.fail(error); }
        };
        this.worker.onerror = event => this.fail(new Error(event.message || "CPU Worker failed"));
        this.worker.onmessageerror = () => this.fail(new Error("CPU Worker message could not be decoded"));

        const [host, remote] = Bus.create();
        this.bus = host;
        this.remote_bus = remote;
        this.screen_adapter = new ScreenAdapter({ container, renderer }, () => {}, () => {
            this.full_redraw = true;
        });
        this.keyboard_adapter = options.disable_keyboard ? null : new KeyboardAdapter(host);
        this.mouse_adapter = options.disable_mouse ? null : new MouseAdapter(host, container);

        for(const name of ["keyboard-code", "mouse-delta", "mouse-absolute", "mouse-click",
            "mouse-wheel", "mouse-pointer-lock", "serial0-input"])
        {
            remote.register(name, value => {
                if(this.loaded && !this.closed) this.worker.postMessage({ type: "input", name, value });
            }, this);
        }

        const loop = now => {
            if(this.closed) return;
            if(this.loaded && !this.frame_pending && now - this.last_frame >= this.frame_interval)
            {
                this.frame_pending = true;
                this.last_frame = now;
                this.worker.postMessage({ type: "frame", full: this.full_redraw });
                this.full_redraw = false;
            }
            this.animation = requestAnimationFrame(loop);
        };
        this.animation = requestAnimationFrame(loop);

        try { this.worker.postMessage({ type: "init", options: config }); }
        catch(error) { this.fail(error); }
        // Keep autostart errors observable through the ready promise.
        if(options.autostart) this.ready = this.ready.then(() => this.call("run"));
    }

    receive(message)
    {
        if(this.closed) return;
        switch(message.type)
        {
            case "ready":
                this.loaded = true;
                clearTimeout(this.ready_timeout);
                this.resolve_ready();
                this.remote_bus.send("emulator-loaded");
                break;
            case "event":
                if(message.name === "emulator-started") this.running = true;
                if(message.name === "emulator-stopped") this.running = false;
                this.remote_bus.send(message.name, message.value);
                break;
            case "frame":
                this.frame_pending = false;
                if(message.frame) this.draw(message.frame);
                break;
            case "reply": {
                const pending = this.pending.get(message.id);
                if(!pending) break;
                this.pending.delete(message.id);
                if(message.error) pending.reject(new Error(message.error));
                else pending.resolve(message.result);
                break;
            }
            case "fatal": this.fail(new Error(message.error)); break;
        }
    }

    draw(frame)
    {
        const screen = this.screen_adapter;
        if(this.generation !== frame.generation || this.graphical !== frame.graphical)
        {
            const changed_mode = this.graphical !== frame.graphical || this.generation < 0;
            this.generation = frame.generation;
            this.graphical = frame.graphical;
            screen.set_mode(frame.graphical);
            if(frame.graphical) screen.set_size_graphical(...frame.size);
            else
            {
                if(changed_mode) screen.clear_text_state();
                screen.set_size_text(frame.cols, frame.rows);
            }
        }
        if(frame.graphical)
        {
            if(frame.clear) screen.clear_screen();
            if(frame.layers.length)
            {
                screen.update_buffer(frame.layers.map(layer => ({
                    image_data: new ImageData(layer.pixels, layer.width, layer.height),
                    screen_x: layer.x, screen_y: layer.y,
                    buffer_x: 0, buffer_y: 0, buffer_width: layer.width, buffer_height: layer.height,
                })));
            }
        }
        else
        {
            if(frame.cells)
            {
                for(let row = 0; row < frame.rows; row++)
                {
                    for(let col = 0; col < frame.cols; col++)
                    {
                        const offset = (row * frame.cols + col) * 4;
                        if(offset + 3 >= frame.cells.length) break;
                        screen.put_char(row, col, frame.cells[offset], frame.cells[offset + 1],
                            frame.cells[offset + 2], frame.cells[offset + 3]);
                    }
                }
            }
            screen.update_cursor(...frame.cursor);
            screen.update_cursor_scanline(...frame.scanline);
        }
    }

    call(method, ...args)
    {
        if(this.closed || !this.loaded) return Promise.reject(new Error("CPU Worker is unavailable"));
        const id = ++this.next_id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try { this.worker.postMessage({ type: "rpc", id, method, args }); }
            catch(error) { this.pending.delete(id); reject(error); }
        });
    }

    run() { return this.call("run"); }
    stop() { return this.call("stop"); }
    restart() { return this.call("restart"); }
    save_state() { return this.call("save_state"); }
    async restore_state(state)
    {
        await this.call("restore_state", state);
        this.full_redraw = true;
    }
    get_instruction_counter() { return this.call("get_instruction_counter"); }
    is_running() { return this.running; }
    add_listener(name, fn) { this.bus.register(name, fn, this); }
    remove_listener(name, fn) { this.bus.unregister(name, fn); }
    screen_set_scale(x, y) { this.screen_adapter.set_scale(x, y); }
    screen_make_screenshot() { return this.screen_adapter.make_screenshot(); }
    keyboard_set_enabled(value) { if(this.keyboard_adapter) this.keyboard_adapter.emu_enabled = value; }
    mouse_set_enabled(value)
    {
        if(this.mouse_adapter)
        {
            this.mouse_adapter.emu_enabled = value;
            this.mouse_adapter.update_cursor();
        }
    }
    fail(error)
    {
        if(this.closed) return;
        this.reject_ready(error);
        this.remote_bus?.send("worker-error", error);
        this.dispose(error);
    }
    dispose(error = new Error("CPU Worker closed"))
    {
        if(this.closed) return;
        this.closed = true;
        this.running = false;
        this.loaded = false;
        clearTimeout(this.ready_timeout);
        cancelAnimationFrame(this.animation);
        this.worker.terminate();
        this.keyboard_adapter?.destroy();
        this.mouse_adapter?.destroy();
        this.screen_adapter?.destroy();
        for(const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.reject_ready(error);
    }
    async destroy()
    {
        // Termination is guaranteed even if the guest is too busy to reply.
        // Persist state explicitly before closing if the caller needs it.
        this.dispose();
    }
}
