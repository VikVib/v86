import { V86 } from "../main.js";
import { WorkerScreen } from "./browseros-worker-screen.js";

let emulator = null;
let screen = null;
let loaded = false;
let rpc_queue = Promise.resolve();
const inputs = new Set(["keyboard-code", "mouse-delta", "mouse-absolute", "mouse-click",
    "mouse-wheel", "mouse-pointer-lock", "serial0-input"]);

function report_error(error)
{
    self.postMessage({ type: "fatal", error: String(error && error.stack || error) });
}

self.addEventListener("unhandledrejection", event => {
    report_error(event.reason);
});

function initialize(options)
{
    if(emulator) throw new Error("Worker already initialized");
    screen = new WorkerScreen();
    // All DOM-dependent adapters live on the host. The guest CPU, memory,
    // JIT, hardware timers and disk image access live in this Worker.
    emulator = new V86({
        ...options,
        autostart: false,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
        screen: {},
        worker_screen_adapter: screen,
    });
    for(const name of ["emulator-started", "emulator-stopped", "mouse-enable",
        "vmware-absolute-mouse", "screen-set-size", "serial0-output-byte", "download-progress"])
    {
        emulator.add_listener(name, value => self.postMessage({ type: "event", name, value }));
    }
    emulator.add_listener("download-error", () => report_error("Guest image download failed"));
    emulator.add_listener("emulator-loaded", () => {
        loaded = true;
        self.postMessage({ type: "ready" });
    });
}

async function handle_rpc(message)
{
    if(!loaded) throw new Error("Worker emulator is not ready");
    const args = message.args || [];
    let result;
    switch(message.method)
    {
        case "run": await emulator.run(); break;
        case "stop": await emulator.stop(); break;
        case "restart": emulator.restart(); break;
        case "get_instruction_counter": result = emulator.get_instruction_counter(); break;
        case "save_state":
            // Worker processing is serialized; the CPU cannot mutate state
            // during synchronous snapshot serialization.
            result = await emulator.save_state();
            break;
        case "restore_state":
            await emulator.stop();
            await emulator.restore_state(args[0]);
            break;
        case "destroy":
            await emulator.destroy();
            loaded = false;
            break;
        default: throw new Error("Unsupported Worker method: " + message.method);
    }
    self.postMessage({ type: "reply", id: message.id, result },
        result instanceof ArrayBuffer ? [result] : []);
}

self.addEventListener("message", event => {
    const message = event.data;
    try
    {
        if(message.type === "init") initialize(message.options);
        else if(message.type === "input" && loaded && inputs.has(message.name))
        {
            emulator.bus.send(message.name, message.value);
        }
        else if(message.type === "frame")
        {
            if(!loaded)
            {
                self.postMessage({ type: "frame", frame: null });
                return;
            }
            const vga = emulator.v86.cpu.devices.vga;
            if(message.full) vga.complete_redraw();
            // The host pulls a frame only after processing the last one,
            // bounding display transfer backlog and memory consumption.
            vga.screen_fill_buffer();
            const { frame, transfer } = screen.take_frame();
            self.postMessage({ type: "frame", frame }, transfer);
        }
        else if(message.type === "rpc")
        {
            rpc_queue = rpc_queue.then(() => handle_rpc(message)).catch(error => {
                self.postMessage({ type: "reply", id: message.id, error: String(error) });
            });
        }
    }
    catch(error)
    {
        report_error(error);
    }
});
