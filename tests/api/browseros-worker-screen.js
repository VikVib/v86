import assert from "node:assert/strict";
import { WorkerScreen } from "../../src/browser/browseros-worker-screen.js";

const screen = new WorkerScreen();
screen.put_char(1, 2, 65, 1, 0, 255);
let result = screen.take_frame();
assert.equal(result.frame.cells[(1 * 80 + 2) * 4], 65);
assert.notEqual(result.transfer[0], screen.cells.buffer);
assert.equal(screen.take_frame().frame.cells, null);

screen.set_mode(true);
screen.set_size_graphical(3, 2, 4, 3);
const data = Uint8ClampedArray.from({ length: 48 }, (_, i) => i);
screen.update_buffer([{
    image_data: { data, width: 4, height: 3 },
    screen_x: -1, screen_y: 0,
    buffer_x: 0, buffer_y: 1, buffer_width: 4, buffer_height: 2,
}]);
result = screen.take_frame();
const layer = result.frame.layers[0];
assert.deepEqual([layer.width, layer.height, layer.x], [3, 2, 0]);
assert.deepEqual([layer.pixels[0], layer.pixels[12]], [20, 36]);
assert.notEqual(result.transfer[0], data.buffer);
assert.equal(screen.take_frame().frame.layers.length, 0);
screen.clear_screen();
assert.equal(screen.take_frame().frame.clear, true);
screen.set_mode(false);
screen.clear_text_state();
screen.set_size_text(80, 25);
assert.equal(screen.cells.length, 8000);
console.log("Worker screen protocol checks passed");
