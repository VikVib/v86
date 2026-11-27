// DOM-free screen adapter for the experimental Worker engine.
// Only one frame is requested at a time by the host. No WASM memory is transferred.
export function WorkerScreen()
{
    this.FLAG_BLINKING = 1;
    this.FLAG_FONT_PAGE_B = 2;
    this.graphical = false;
    this.size = [80, 25, 80, 25];
    this.cols = 80;
    this.rows = 25;
    this.cells = new Int32Array(80 * 25 * 4);
    this.cursor = [0, 0];
    this.scanline = [0, 0, false];
    this.text_dirty = true;
    this.generation = 0;
    this.clear = true;
    this.layers = [];
}

WorkerScreen.prototype.set_mode = function(graphical)
{
    if(this.graphical !== graphical)
    {
        this.graphical = graphical;
        this.generation++;
        this.clear = true;
        this.text_dirty = true;
    }
};
WorkerScreen.prototype.set_size_text = function(cols, rows)
{
    if(this.cols === cols && this.rows === rows && this.cells.length === cols * rows * 4) return;
    this.cols = cols;
    this.rows = rows;
    this.cells = new Int32Array(cols * rows * 4);
    this.text_dirty = true;
    this.generation++;
};
WorkerScreen.prototype.clear_text_state = function()
{
    this.cells = new Int32Array(0);
    this.text_dirty = true;
    this.generation++;
};
WorkerScreen.prototype.put_char = function(row, col, chr, flags, bg, fg)
{
    if(row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;
    const offset = (row * this.cols + col) * 4;
    if(this.cells[offset] === chr && this.cells[offset + 1] === flags &&
        this.cells[offset + 2] === bg && this.cells[offset + 3] === fg) return;
    this.cells[offset] = chr;
    this.cells[offset + 1] = flags;
    this.cells[offset + 2] = bg;
    this.cells[offset + 3] = fg;
    this.text_dirty = true;
};
WorkerScreen.prototype.update_cursor = function(row, col) { this.cursor = [row, col]; };
WorkerScreen.prototype.update_cursor_scanline = function(start, end, enabled) { this.scanline = [start, end, enabled]; };
WorkerScreen.prototype.set_font_bitmap = function() {};
WorkerScreen.prototype.set_font_page = function() {};
WorkerScreen.prototype.set_scale = function() {};
WorkerScreen.prototype.pause = function() {};
WorkerScreen.prototype.continue = function() {};
WorkerScreen.prototype.destroy = function() {};
WorkerScreen.prototype.set_size_graphical = function(width, height, buffer_width, buffer_height)
{
    this.size = [width, height, buffer_width, buffer_height];
    this.generation++;
    this.clear = true;
    this.layers = [];
};
WorkerScreen.prototype.clear_screen = function()
{
    this.clear = true;
    this.layers = [];
};
WorkerScreen.prototype.update_buffer = function(layers)
{
    for(const layer of layers)
    {
        const image = layer.image_data;
        const left = Math.max(0, -layer.buffer_x, -layer.screen_x);
        const top = Math.max(0, -layer.buffer_y, -layer.screen_y);
        const right = Math.min(layer.buffer_width, image.width - layer.buffer_x, this.size[0] - layer.screen_x);
        const bottom = Math.min(layer.buffer_height, image.height - layer.buffer_y, this.size[1] - layer.screen_y);
        const width = right - left, height = bottom - top;
        if(width <= 0 || height <= 0) continue;
        const sx = layer.buffer_x + left, sy = layer.buffer_y + top;
        const pixels = new Uint8ClampedArray(width * height * 4);
        for(let y = 0; y < height; y++)
        {
            const offset = ((sy + y) * image.width + sx) * 4;
            pixels.set(image.data.subarray(offset, offset + width * 4), y * width * 4);
        }
        this.layers.push({ x: layer.screen_x + left, y: layer.screen_y + top, width, height, pixels });
    }
};
WorkerScreen.prototype.take_frame = function()
{
    const cells = !this.graphical && this.text_dirty ? this.cells.slice() : null;
    const layers = this.layers;
    const transfer = layers.map(layer => layer.pixels.buffer);
    if(cells) transfer.push(cells.buffer);
    const frame = {
        graphical: this.graphical, generation: this.generation, clear: this.clear,
        size: this.size, cols: this.cols, rows: this.rows, cells,
        cursor: this.cursor, scanline: this.scanline, layers,
    };
    this.layers = [];
    this.clear = false;
    if(cells) this.text_dirty = false;
    return { frame, transfer };
};
