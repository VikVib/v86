import { dbg_assert } from "../log.js";
import { get_charmap } from "../lib.js";

// Experimental host-side framebuffer presentation. Guest VGA emulation is unchanged.
// A persistent texture retains pixels outside dirty rectangles.
/**
 * @param {!HTMLCanvasElement} canvas
 * @return {?Object}
 */
function create_webgl_presenter(canvas)
{
    const gl = /** @type {?WebGLRenderingContext} */ (canvas.getContext("webgl", {
        alpha: false, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: true
    }));
    if(!gl) return null;

    function shader(type, source)
    {
        const result = gl.createShader(type);
        gl.shaderSource(result, source);
        gl.compileShader(result);
        if(!gl.getShaderParameter(result, gl.COMPILE_STATUS))
        {
            gl.deleteShader(result);
            return null;
        }
        return result;
    }

    const vs = shader(gl.VERTEX_SHADER,
        "attribute vec2 p; varying vec2 uv; void main(){gl_Position=vec4(p,0.,1.);uv=vec2((p.x+1.)*.5,(1.-p.y)*.5);}");
    const fs = shader(gl.FRAGMENT_SHADER,
        "precision mediump float; varying vec2 uv; uniform sampler2D tex; void main(){gl_FragColor=vec4(texture2D(tex,uv).rgb,1.);}");
    if(!vs || !fs)
    {
        if(vs) gl.deleteShader(vs);
        if(fs) gl.deleteShader(fs);
        return null;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if(!gl.getProgramParameter(program, gl.LINK_STATUS))
    {
        gl.deleteProgram(program);
        return null;
    }

    const vertices = gl.createBuffer();
    const texture = gl.createTexture();
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const attr = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(attr);
    gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, "tex"), 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const max_size = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    let width = 0, height = 0;
    let scratch = new Uint8Array(0);

    function resize()
    {
        width = canvas.width;
        height = canvas.height;
        if(!width || !height || width > max_size || height > max_size || gl.isContextLost()) return false;
        gl.viewport(0, 0, width, height);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return gl.getError() === gl.NO_ERROR;
    }

    function draw()
    {
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function update(layers)
    {
        if(gl.isContextLost()) return false;
        let dirty = false;
        for(const layer of layers)
        {
            const image = layer.image_data;
            // Clip source AND destination, matching putImageData's dirty-rect semantics.
            const left = Math.max(0, -layer.buffer_x, -layer.screen_x);
            const top = Math.max(0, -layer.buffer_y, -layer.screen_y);
            const right = Math.min(layer.buffer_width, image.width - layer.buffer_x, width - layer.screen_x);
            const bottom = Math.min(layer.buffer_height, image.height - layer.buffer_y, height - layer.screen_y);
            const w = right - left, h = bottom - top;
            if(w <= 0 || h <= 0) continue;
            const sx = layer.buffer_x + left, sy = layer.buffer_y + top;
            const data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
            const row_bytes = w * 4;
            let pixels;
            if(sx === 0 && w === image.width)
            {
                // Common SVGA path: view contiguous dirty rows without copying.
                const offset = sy * image.width * 4;
                pixels = data.subarray(offset, offset + row_bytes * h);
            }
            else
            {
                // WebGL 1 has no UNPACK_ROW_LENGTH. Reuse one staging allocation.
                const size = row_bytes * h;
                if(scratch.length < size) scratch = new Uint8Array(size);
                pixels = scratch.subarray(0, size);
                for(let y = 0; y < h; y++)
                {
                    const offset = ((sy + y) * image.width + sx) * 4;
                    pixels.set(data.subarray(offset, offset + row_bytes), y * row_bytes);
                }
            }
            gl.texSubImage2D(gl.TEXTURE_2D, 0, layer.screen_x + left, layer.screen_y + top,
                w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            dirty = true;
        }
        if(dirty) draw();
        return !gl.isContextLost();
    }

    return {
        resize,
        update,
        clear: resize,
        destroy: () => {
            gl.deleteTexture(texture);
            gl.deleteBuffer(vertices);
            gl.deleteProgram(program);
            scratch = new Uint8Array(0);
        }
    };
}

// Draws entire buffer and visualizes the layers that would be drawn
export const DEBUG_SCREEN_LAYERS = DEBUG && false;

/**
 * Adapter to use visual screen in browsers (in contrast to node)
 * @constructor
 * @param {Object} options
 * @param {function()} screen_fill_buffer
 * @param {function()=} request_full_redraw
 */
export function ScreenAdapter(options, screen_fill_buffer, request_full_redraw)
{
    const screen_container = options.container;
    this.screen_fill_buffer = screen_fill_buffer;

    console.assert(screen_container, "options.container must be provided");

    const MODE_TEXT = 0;
    const MODE_GRAPHICAL = 1;
    const MODE_GRAPHICAL_TEXT = 2;

    const CHARACTER_INDEX = 0;
    const FLAGS_INDEX = 1;
    const BG_COLOR_INDEX = 2;
    const FG_COLOR_INDEX = 3;
    const TEXT_BUF_COMPONENT_SIZE = 4;

    const FLAG_BLINKING = 0x01;
    const FLAG_FONT_PAGE_B = 0x02;

    this.FLAG_BLINKING = FLAG_BLINKING;
    this.FLAG_FONT_PAGE_B = FLAG_FONT_PAGE_B;

    let graphic_screen = screen_container.getElementsByTagName("canvas")[0];
    if(!graphic_screen)
    {
        graphic_screen = document.createElement("canvas");
        screen_container.appendChild(graphic_screen);
    }
    const software_canvas = graphic_screen;
    const graphic_context = software_canvas.getContext("2d", { alpha: false });
    let gpu = null;
    let needs_full_redraw = false;

    // Keep the original 2D canvas intact for fallback. Graphical text and
    // layer-debug mode continue using the original renderer.
    if(options["renderer"] === "webgl" && !options.use_graphical_text && !DEBUG_SCREEN_LAYERS)
    {
        const candidate = /** @type {!HTMLCanvasElement} */ (software_canvas.cloneNode(false));
        try
        {
            gpu = create_webgl_presenter(candidate);
            if(gpu && gpu.resize())
            {
                software_canvas.parentNode.replaceChild(candidate, software_canvas);
                graphic_screen = candidate;
                candidate.addEventListener("webglcontextlost", fallback_to_canvas);
            }
            else if(gpu)
            {
                gpu.destroy();
                gpu = null;
            }
        }
        catch(e)
        {
            if(gpu) gpu.destroy();
            gpu = null;
        }
    }

    function fallback_to_canvas()
    {
        if(!gpu) return;
        graphic_screen.removeEventListener("webglcontextlost", fallback_to_canvas);
        software_canvas.width = graphic_screen.width;
        software_canvas.height = graphic_screen.height;
        software_canvas.style.cssText = graphic_screen.style.cssText;
        graphic_context.imageSmoothingEnabled = false;
        if(graphic_screen.parentNode)
        {
            graphic_screen.parentNode.replaceChild(software_canvas, graphic_screen);
        }
        graphic_screen = software_canvas;
        gpu.destroy();
        gpu = null;
        needs_full_redraw = true;
    }

    let text_screen = screen_container.getElementsByTagName("div")[0];
    if(!text_screen)
    {
        text_screen = document.createElement("div");
        screen_container.appendChild(text_screen);
    }

    const cursor_element = document.createElement("div");

    var
        /** @type {number} */
        cursor_row,

        /** @type {number} */
        cursor_col,

        /** @type {number} */
        scale_x = options.scale !== undefined ? options.scale : 1,

        /** @type {number} */
        scale_y = options.scale !== undefined ? options.scale : 1,

        base_scale = 1,

        changed_rows,

        // current display mode: MODE_GRAPHICAL or either MODE_TEXT/MODE_GRAPHICAL_TEXT
        mode,

        // Index 0: ASCII code
        // Index 1: Flags bitset (see FLAG_...)
        // Index 2: Background color
        // Index 3: Foreground color
        text_mode_data,

        // number of columns
        text_mode_width,

        // number of rows
        text_mode_height,

        // graphical text mode's offscreen canvas contexts
        offscreen_context,
        offscreen_extra_context,

        // fonts
        font_context,
        font_image_data,
        font_is_visible = new Int8Array(8 * 256),
        font_height,
        font_width,
        font_width_9px,
        font_width_dbl,
        font_copy_8th_col,
        font_page_a = 0,
        font_page_b = 0,

        // blink state
        blink_visible,
        tm_last_update = 0,

        // cursor attributes
        cursor_start,
        cursor_end,
        cursor_enabled,

        // 8-bit-text to Unicode character map
        charmap = get_charmap(options.encoding),

        // render loop state
        timer_id = 0,
        paused = false;

    // 0x12345 -> "#012345"
    function number_as_color(n)
    {
        n = n.toString(16);
        return "#" + "0".repeat(6 - n.length) + n;
    }

    function render_font_bitmap(vga_bitmap)
    {
        // - Browsers impose limts on the X- and Y-axes of bitmaps (typically around 8 to 32k).
        //   Draw the 8 VGA font pages of 256 glyphs in 8 rows of 256 columns, this results
        //   in 2048, 2304 or 4096px on the X-axis (for 8, 9 or 16px VGA font width, resp.).
        //   This 2d layout is also convenient for glyph lookup when rendering text.
        // - Font bitmap pixels are black and either fully opaque (alpha 255) or fully transparent (0).
        const bitmap_width = font_width * 256;
        const bitmap_height = font_height * 8;

        let font_canvas = font_context ? font_context.canvas : null;
        if(!font_canvas || font_canvas.width !== bitmap_width || font_canvas.height !== bitmap_height)
        {
            if(!font_canvas)
            {
                font_canvas = new OffscreenCanvas(bitmap_width, bitmap_height);
                font_context = font_canvas.getContext("2d");
            }
            else
            {
                font_canvas.width = bitmap_width;
                font_canvas.height = bitmap_height;
            }
            font_image_data = font_context.createImageData(bitmap_width, bitmap_height);
        }

        const font_bitmap = font_image_data.data;
        let i_dst = 0, is_visible;
        const put_bit = font_width_dbl ?
            function(value)
            {
                is_visible = is_visible || value;
                font_bitmap[i_dst + 3] = value;
                font_bitmap[i_dst + 7] = value;
                i_dst += 8;
            } :
            function(value)
            {
                is_visible = is_visible || value;
                font_bitmap[i_dst + 3] = value;
                i_dst += 4;
            };

        // move i_vga from end of glyph to start of next glyph
        const vga_inc_chr = 32 - font_height;
        // move i_dst from end of font page (bitmap row) to start of next font page
        const dst_inc_row = bitmap_width * (font_height - 1) * 4;
        // move i_dst from end of glyph (bitmap column) to start of next glyph
        const dst_inc_col = (font_width - bitmap_width * font_height) * 4;
        // move i_dst from end of a glyph's scanline to start of its next scanline
        const dst_inc_line = font_width * 255 * 4;

        for(let i_chr_all = 0, i_vga = 0; i_chr_all < 2048; ++i_chr_all, i_vga += vga_inc_chr, i_dst += dst_inc_col)
        {
            const i_chr = i_chr_all % 256;
            if(i_chr_all && !i_chr)
            {
                i_dst += dst_inc_row;
            }
            is_visible = false;
            for(let i_line = 0; i_line < font_height; ++i_line, ++i_vga, i_dst += dst_inc_line)
            {
                const line_bits = vga_bitmap[i_vga];
                for(let i_bit = 0x80; i_bit > 0; i_bit >>= 1)
                {
                    put_bit(line_bits & i_bit ? 255 : 0);
                }
                if(font_width_9px)
                {
                    put_bit(font_copy_8th_col && i_chr >= 0xC0 && i_chr <= 0xDF && line_bits & 1 ? 255 : 0);
                }
            }
            font_is_visible[i_chr_all] = is_visible ? 1 : 0;
        }

        font_context.putImageData(font_image_data, 0, 0);
    }

    function render_changed_rows()
    {
        const font_canvas = font_context.canvas;
        const offscreen_extra_canvas = offscreen_extra_context.canvas;
        const txt_row_size = text_mode_width * TEXT_BUF_COMPONENT_SIZE;
        const gfx_width = text_mode_width * font_width;
        const row_extra_1_y = 0;
        const row_extra_2_y = font_height;

        if(gfx_width === 0)
        {
            return 0;
        }

        let n_rows_rendered = 0;
        for(let row_i = 0, row_y = 0, txt_i = 0; row_i < text_mode_height; ++row_i, row_y += font_height)
        {
            if(!changed_rows[row_i])
            {
                txt_i += txt_row_size;
                continue;
            }
            ++n_rows_rendered;

            // clear extra row 2
            offscreen_extra_context.clearRect(0, row_extra_2_y, gfx_width, font_height);

            // initialise to work around closure compiler bug (#1640)
            let fg_rgba = undefined, fg_x, bg_rgba = undefined, bg_x;
            for(let col_x = 0; col_x < gfx_width; col_x += font_width, txt_i += TEXT_BUF_COMPONENT_SIZE)
            {
                const chr = text_mode_data[txt_i + CHARACTER_INDEX];
                const chr_flags = text_mode_data[txt_i + FLAGS_INDEX];
                const chr_bg_rgba = text_mode_data[txt_i + BG_COLOR_INDEX];
                const chr_fg_rgba = text_mode_data[txt_i + FG_COLOR_INDEX];
                const chr_font_page = chr_flags & FLAG_FONT_PAGE_B ? font_page_b : font_page_a;
                const chr_visible = (!(chr_flags & FLAG_BLINKING) || blink_visible) && font_is_visible[(chr_font_page << 8) + chr];

                if(bg_rgba !== chr_bg_rgba)
                {
                    if(bg_rgba !== undefined)
                    {
                        // draw opaque block of background color into offscreen_context
                        offscreen_context.fillStyle = number_as_color(bg_rgba);
                        offscreen_context.fillRect(bg_x, row_y, col_x - bg_x, font_height);
                    }
                    bg_rgba = chr_bg_rgba;
                    bg_x = col_x;
                }

                if(fg_rgba !== chr_fg_rgba)
                {
                    if(fg_rgba !== undefined)
                    {
                        // draw opaque block of foreground color into extra row 1
                        offscreen_extra_context.fillStyle = number_as_color(fg_rgba);
                        offscreen_extra_context.fillRect(fg_x, row_extra_1_y, col_x - fg_x, font_height);
                    }
                    fg_rgba = chr_fg_rgba;
                    fg_x = col_x;
                }

                if(chr_visible)
                {
                    // copy transparent glyphs into extra row 2
                    offscreen_extra_context.drawImage(font_canvas,
                        chr * font_width, chr_font_page * font_height, font_width, font_height,
                        col_x, row_extra_2_y, font_width, font_height);
                }
            }

            // draw rightmost block of foreground color into extra row 1
            offscreen_extra_context.fillStyle = number_as_color(fg_rgba);
            offscreen_extra_context.fillRect(fg_x, row_extra_1_y, gfx_width - fg_x, font_height);

            // combine extra row 1 (colors) and 2 (glyphs) into extra row 1 (colored glyphs)
            offscreen_extra_context.globalCompositeOperation = "destination-in";
            offscreen_extra_context.drawImage(offscreen_extra_canvas,
                0, row_extra_2_y, gfx_width, font_height,
                0, row_extra_1_y, gfx_width, font_height);
            offscreen_extra_context.globalCompositeOperation = "source-over";

            // draw rightmost block of background color into offscreen_context
            offscreen_context.fillStyle = number_as_color(bg_rgba);
            offscreen_context.fillRect(bg_x, row_y, gfx_width - bg_x, font_height);

            // copy colored glyphs from extra row 1 into offscreen_context (on top of background colors)
            offscreen_context.drawImage(offscreen_extra_canvas,
                0, row_extra_1_y, gfx_width, font_height,
                0, row_y, gfx_width, font_height);
        }

        if(n_rows_rendered)
        {
            if(blink_visible && cursor_enabled && changed_rows[cursor_row])
            {
                const cursor_txt_i = (cursor_row * text_mode_width + cursor_col) * TEXT_BUF_COMPONENT_SIZE;
                const cursor_rgba = text_mode_data[cursor_txt_i + FG_COLOR_INDEX];
                offscreen_context.fillStyle = number_as_color(cursor_rgba);
                offscreen_context.fillRect(
                    cursor_col * font_width,
                    cursor_row * font_height + cursor_start,
                    font_width,
                    cursor_end - cursor_start + 1);
            }
            changed_rows.fill(0);
        }

        return n_rows_rendered;
    }

    function mark_blinking_rows_dirty()
    {
        const txt_row_size = text_mode_width * TEXT_BUF_COMPONENT_SIZE;
        for(let row_i = 0, txt_i = 0; row_i < text_mode_height; ++row_i)
        {
            if(changed_rows[row_i])
            {
                txt_i += txt_row_size;
                continue;
            }
            for(let col_i = 0; col_i < text_mode_width; ++col_i, txt_i += TEXT_BUF_COMPONENT_SIZE)
            {
                if(text_mode_data[txt_i + FLAGS_INDEX] & FLAG_BLINKING)
                {
                    changed_rows[row_i] = 1;
                    txt_i += txt_row_size - col_i * TEXT_BUF_COMPONENT_SIZE;
                    break;
                }
            }
        }
    }

    this.init = function()
    {
        // setup text mode cursor DOM element
        cursor_element.classList.add("cursor");
        cursor_element.style.position = "absolute";
        cursor_element.style.backgroundColor = "#ccc";
        cursor_element.style.width = "7px";
        cursor_element.style.display = "inline-block";

        // initialize display mode and size to 80x25 text with 9x16 font
        this.set_mode(false);
        this.set_size_text(80, 25);
        if(mode === MODE_GRAPHICAL_TEXT)
        {
            this.set_size_graphical(720, 400, 720, 400);
        }

        // initialize CSS scaling
        this.set_scale(scale_x, scale_y);

        this.timer();
    };

    this.make_screenshot = function()
    {
        const image = new Image();

        if(mode === MODE_GRAPHICAL || mode === MODE_GRAPHICAL_TEXT)
        {
            image.src = graphic_screen.toDataURL("image/png");
        }
        else
        {
            // Default 720x400, but can be [8, 16] at 640x400
            const char_size = [9, 16];

            const canvas = document.createElement("canvas");
            canvas.width = text_mode_width * char_size[0];
            canvas.height = text_mode_height * char_size[1];
            const context = canvas.getContext("2d");
            context.imageSmoothingEnabled = false;
            context.font = window.getComputedStyle(text_screen).font;
            context.textBaseline = "top";

            for(let y = 0; y < text_mode_height; y++)
            {
                for(let x = 0; x < text_mode_width; x++)
                {
                    const index = (y * text_mode_width + x) * TEXT_BUF_COMPONENT_SIZE;
                    const character = text_mode_data[index + CHARACTER_INDEX];
                    const bg_color = text_mode_data[index + BG_COLOR_INDEX];
                    const fg_color = text_mode_data[index + FG_COLOR_INDEX];

                    context.fillStyle = number_as_color(bg_color);
                    context.fillRect(x * char_size[0], y * char_size[1], char_size[0], char_size[1]);
                    context.fillStyle = number_as_color(fg_color);
                    context.fillText(charmap[character], x * char_size[0], y * char_size[1]);
                }
            }

            if(cursor_element.style.display !== "none" && cursor_row < text_mode_height && cursor_col < text_mode_width)
            {
                context.fillStyle = cursor_element.style.backgroundColor;
                context.fillRect(
                    cursor_col * char_size[0],
                    cursor_row * char_size[1] + parseInt(cursor_element.style.marginTop, 10),
                    parseInt(cursor_element.style.width, 10),
                    parseInt(cursor_element.style.height, 10)
                );
            }

            image.src = canvas.toDataURL("image/png");
        }
        return image;
    };

    this.put_char = function(row, col, chr, flags, bg_color, fg_color)
    {
        dbg_assert(row >= 0 && row < text_mode_height);
        dbg_assert(col >= 0 && col < text_mode_width);
        dbg_assert(chr >= 0 && chr < 0x100);

        const p = TEXT_BUF_COMPONENT_SIZE * (row * text_mode_width + col);

        text_mode_data[p + CHARACTER_INDEX] = chr;
        text_mode_data[p + FLAGS_INDEX] = flags;
        text_mode_data[p + BG_COLOR_INDEX] = bg_color;
        text_mode_data[p + FG_COLOR_INDEX] = fg_color;

        changed_rows[row] = 1;
    };

    this.timer = function()
    {
        timer_id = requestAnimationFrame(() => this.update_screen());
    };

    this.update_screen = function()
    {
        if(!paused)
        {
            if(mode === MODE_TEXT)
            {
                this.update_text();
            }
            else if(mode === MODE_GRAPHICAL)
            {
                this.update_graphical();
            }
            else
            {
                this.update_graphical_text();
            }
        }
        this.timer();
    };

    this.update_text = function()
    {
        for(var i = 0; i < text_mode_height; i++)
        {
            if(changed_rows[i])
            {
                this.text_update_row(i);
                changed_rows[i] = 0;
            }
        }
    };

    this.update_graphical = function()
    {
        if(needs_full_redraw && request_full_redraw)
        {
            request_full_redraw();
            needs_full_redraw = false;
        }
        this.screen_fill_buffer();
    };

    this.update_graphical_text = function()
    {
        if(offscreen_context)
        {
            // toggle cursor and blinking character visibility at a frequency of ~3.75hz
            const tm_now = performance.now();
            if(tm_now - tm_last_update > 266)
            {
                blink_visible = !blink_visible;
                if(cursor_enabled)
                {
                    changed_rows[cursor_row] = 1;
                }
                mark_blinking_rows_dirty();
                tm_last_update = tm_now;
            }
            // copy to DOM canvas only if anything new was rendered
            if(render_changed_rows())
            {
                graphic_context.drawImage(offscreen_context.canvas, 0, 0);
            }
        }
    };

    this.destroy = function()
    {
        // Restore the original 2D canvas before another VM reuses this container.
        // A canvas that has acquired a WebGL context cannot acquire a 2D context.
        if(gpu) fallback_to_canvas();
        if(timer_id)
        {
            cancelAnimationFrame(timer_id);
            timer_id = 0;
        }
    };

    this.pause = function()
    {
        paused = true;
        cursor_element.classList.remove("blinking-cursor");
    };

    this.continue = function()
    {
        paused = false;
        cursor_element.classList.add("blinking-cursor");
    };

    /**
     * Invalidates text rendering state.  This means the next set of
     * calls to set_font_bitmap, set_size_text, etc will be working
     * from a fresh slate even if the dimensions of the loaded state
     * differ from the current dimensions.
     */
    this.clear_text_state = function() {
        font_width = null;
        font_height = null;
        text_mode_width = null;
        text_mode_height = null;
        font_page_a = null;
        font_page_b = null;
    };

    this.set_mode = function(graphical)
    {
        mode = graphical ? MODE_GRAPHICAL : (options.use_graphical_text ? MODE_GRAPHICAL_TEXT : MODE_TEXT);

        if(mode === MODE_TEXT)
        {
            text_screen.style.display = "block";
            graphic_screen.style.display = "none";
        }
        else
        {
            text_screen.style.display = "none";
            graphic_screen.style.display = "block";

            if(mode === MODE_GRAPHICAL_TEXT && changed_rows)
            {
                changed_rows.fill(1);
            }
        }
    };

    this.set_font_bitmap = function(height, width_9px, width_dbl, copy_8th_col, vga_bitmap, vga_bitmap_changed)
    {
        const width = width_dbl ? 16 : (width_9px ? 9 : 8);
        if(font_height !== height || font_width !== width || font_width_9px !== width_9px ||
            font_width_dbl !== width_dbl || font_copy_8th_col !== copy_8th_col ||
            vga_bitmap_changed)
        {
            const size_changed = font_width !== width || font_height !== height;
            font_height = height;
            font_width = width;
            font_width_9px = width_9px;
            font_width_dbl = width_dbl;
            font_copy_8th_col = copy_8th_col;
            if(mode === MODE_GRAPHICAL_TEXT)
            {
                render_font_bitmap(vga_bitmap);
                changed_rows.fill(1);
                if(size_changed)
                {
                    this.set_size_graphical_text();
                }
            }
        }
    };

    this.set_font_page = function(page_a, page_b)
    {
        if(font_page_a !== page_a || font_page_b !== page_b)
        {
            font_page_a = page_a;
            font_page_b = page_b;
            changed_rows.fill(1);
        }
    };

    this.clear_screen = function()
    {
        if(gpu)
        {
            if(gpu.clear()) return;
            fallback_to_canvas();
        }
        graphic_context.fillStyle = "#000";
        graphic_context.fillRect(0, 0, graphic_screen.width, graphic_screen.height);
    };

    this.set_size_graphical_text = function()
    {
        if(!font_context)
        {
            return;
        }

        const gfx_width = font_width * text_mode_width;
        const gfx_height = font_height * text_mode_height;
        const offscreen_extra_height = font_height * 2;

        if(!offscreen_context || offscreen_context.canvas.width !== gfx_width ||
            offscreen_context.canvas.height !== gfx_height ||
            offscreen_extra_context.canvas.height !== offscreen_extra_height)
        {
            // resize offscreen canvases
            if(!offscreen_context)
            {
                const offscreen_canvas = new OffscreenCanvas(gfx_width, gfx_height);
                offscreen_context = offscreen_canvas.getContext("2d", { alpha: false });
                const offscreen_extra_canvas = new OffscreenCanvas(gfx_width, offscreen_extra_height);
                offscreen_extra_context = offscreen_extra_canvas.getContext("2d");
            }
            else
            {
                offscreen_context.canvas.width = gfx_width;
                offscreen_context.canvas.height = gfx_height;
                offscreen_extra_context.canvas.width = gfx_width;
                offscreen_extra_context.canvas.height = offscreen_extra_height;
            }

            // resize DOM canvas graphic_screen
            this.set_size_graphical(gfx_width, gfx_height, gfx_width, gfx_height);

            changed_rows.fill(1);
        }
    };

    /**
     * @param {number} cols
     * @param {number} rows
     */
    this.set_size_text = function(cols, rows)
    {
        if(cols === text_mode_width && rows === text_mode_height)
        {
            return;
        }

        changed_rows = new Int8Array(rows);
        changed_rows.fill(1);
        text_mode_data = new Int32Array(cols * rows * TEXT_BUF_COMPONENT_SIZE);

        text_mode_width = cols;
        text_mode_height = rows;

        if(mode === MODE_TEXT)
        {
            while(text_screen.childNodes.length > rows)
            {
                text_screen.removeChild(text_screen.firstChild);
            }

            while(text_screen.childNodes.length < rows)
            {
                text_screen.appendChild(document.createElement("div"));
            }

            for(var i = 0; i < rows; i++)
            {
                this.text_update_row(i);
            }

            update_scale_text();
        }
        else if(mode === MODE_GRAPHICAL_TEXT)
        {
            this.set_size_graphical_text();
        }
    };

    this.set_size_graphical = function(width, height, buffer_width, buffer_height)
    {
        if(DEBUG_SCREEN_LAYERS)
        {
            // Draw the entire buffer. Useful for debugging
            // panning / page flipping / screen splitting code for both
            // v86 developers and os developers
            width = buffer_width;
            height = buffer_height;
        }

        graphic_screen.style.display = "block";

        graphic_screen.width = width;
        graphic_screen.height = height;

        if(gpu)
        {
            if(!gpu.resize()) fallback_to_canvas();
            // Resizing reallocates the texture, so the next frame must repaint it.
            needs_full_redraw = true;
        }

        // graphic_context must be reconfigured whenever its graphic_screen is resized
        graphic_context.imageSmoothingEnabled = false;

        // add some scaling to tiny resolutions
        if(width <= 640 &&
            width * 2 < window.innerWidth * window.devicePixelRatio &&
            height * 2 < window.innerHeight * window.devicePixelRatio)
        {
            base_scale = 2;
        }
        else
        {
            base_scale = 1;
        }

        update_scale_graphic();
    };

    this.set_scale = function(s_x, s_y)
    {
        scale_x = s_x;
        scale_y = s_y;

        update_scale_text();
        update_scale_graphic();
    };

    function update_scale_text()
    {
        elem_set_scale(text_screen, scale_x, scale_y, true);
    }

    function update_scale_graphic()
    {
        elem_set_scale(graphic_screen, scale_x * base_scale, scale_y * base_scale, false);
    }

    function elem_set_scale(elem, scale_x, scale_y, use_scale)
    {
        if(!scale_x || !scale_y)
        {
            return;
        }

        elem.style.width = "";
        elem.style.height = "";

        if(use_scale)
        {
            elem.style.transform = "";
        }

        var rectangle = elem.getBoundingClientRect();

        if(use_scale)
        {
            var scale_str = "";

            scale_str += scale_x === 1 ? "" : " scaleX(" + scale_x + ")";
            scale_str += scale_y === 1 ? "" : " scaleY(" + scale_y + ")";

            elem.style.transform = scale_str;
        }
        else
        {
            // unblur non-fractional scales
            if(scale_x % 1 === 0 && scale_y % 1 === 0)
            {
                graphic_screen.style["imageRendering"] = "crisp-edges"; // firefox
                graphic_screen.style["imageRendering"] = "pixelated";
                graphic_screen.style["-ms-interpolation-mode"] = "nearest-neighbor";
            }
            else
            {
                graphic_screen.style["imageRendering"] = "";
                graphic_screen.style["-ms-interpolation-mode"] = "";
            }

            // undo fractional css-to-device pixel ratios
            var device_pixel_ratio = window.devicePixelRatio || 1;
            if(device_pixel_ratio % 1 !== 0)
            {
                scale_x /= device_pixel_ratio;
                scale_y /= device_pixel_ratio;
            }
        }

        if(scale_x !== 1)
        {
            elem.style.width = rectangle.width * scale_x + "px";
        }
        if(scale_y !== 1)
        {
            elem.style.height = rectangle.height * scale_y + "px";
        }
    }

    this.update_cursor_scanline = function(start, end, enabled)
    {
        if(start !== cursor_start || end !== cursor_end || enabled !== cursor_enabled)
        {
            if(mode === MODE_TEXT)
            {
                if(enabled)
                {
                    cursor_element.style.display = "inline";
                    cursor_element.style.height = (end - start) + "px";
                    cursor_element.style.marginTop = start + "px";
                }
                else
                {
                    cursor_element.style.display = "none";
                }
            }
            else if(mode === MODE_GRAPHICAL_TEXT)
            {
                if(cursor_row < text_mode_height)
                {
                    changed_rows[cursor_row] = 1;
                }
            }

            cursor_start = start;
            cursor_end = end;
            cursor_enabled = enabled;
        }
    };

    this.update_cursor = function(row, col)
    {
        if(row !== cursor_row || col !== cursor_col)
        {
            if(row < text_mode_height)
            {
                changed_rows[row] = 1;
            }
            if(cursor_row < text_mode_height)
            {
                changed_rows[cursor_row] = 1;
            }

            cursor_row = row;
            cursor_col = col;
        }
    };

    this.text_update_row = function(row)
    {
        var offset = TEXT_BUF_COMPONENT_SIZE * row * text_mode_width,
            row_element,
            color_element,
            fragment;

        var blinking,
            bg_color,
            fg_color,
            text;

        row_element = text_screen.childNodes[row];
        fragment = document.createElement("div");

        for(var i = 0; i < text_mode_width; )
        {
            color_element = document.createElement("span");

            blinking = text_mode_data[offset + FLAGS_INDEX] & FLAG_BLINKING;
            bg_color = text_mode_data[offset + BG_COLOR_INDEX];
            fg_color = text_mode_data[offset + FG_COLOR_INDEX];

            if(blinking)
            {
                color_element.classList.add("blink");
            }

            color_element.style.backgroundColor = number_as_color(bg_color);
            color_element.style.color = number_as_color(fg_color);

            text = "";

            // put characters of the same color in one element
            while(i < text_mode_width &&
                (text_mode_data[offset + FLAGS_INDEX] & FLAG_BLINKING) === blinking &&
                text_mode_data[offset + BG_COLOR_INDEX] === bg_color &&
                text_mode_data[offset + FG_COLOR_INDEX] === fg_color)
            {
                const chr = charmap[text_mode_data[offset + CHARACTER_INDEX]];

                text += chr;
                dbg_assert(chr);

                i++;
                offset += TEXT_BUF_COMPONENT_SIZE;

                if(row === cursor_row)
                {
                    if(i === cursor_col)
                    {
                        // next row will be cursor
                        // create new element
                        break;
                    }
                    else if(i === cursor_col + 1)
                    {
                        // found the cursor
                        cursor_element.style.backgroundColor = color_element.style.color;
                        fragment.appendChild(cursor_element);
                        break;
                    }
                }
            }

            color_element.textContent = text;
            fragment.appendChild(color_element);
        }

        row_element.parentNode.replaceChild(fragment, row_element);
    };

    this.update_buffer = function(layers)
    {
        if(DEBUG_SCREEN_LAYERS)
        {
            // For each visible layer that would've been drawn, draw a
            // rectangle to visualise the layer instead.
            graphic_context.strokeStyle = "#0F0";
            graphic_context.lineWidth = 4;
            for(const layer of layers)
            {
                graphic_context.strokeRect(
                    layer.buffer_x,
                    layer.buffer_y,
                    layer.buffer_width,
                    layer.buffer_height
                );
            }
            graphic_context.lineWidth = 1;
            return;
        }

        if(gpu)
        {
            if(gpu.update(layers)) return;
            fallback_to_canvas();
        }

        for(const layer of layers)
        {
            graphic_context.putImageData(
                layer.image_data,
                layer.screen_x - layer.buffer_x,
                layer.screen_y - layer.buffer_y,
                layer.buffer_x,
                layer.buffer_y,
                layer.buffer_width,
                layer.buffer_height
            );
        }
    };

    // XXX: duplicated in DummyScreenAdapter
    this.get_text_screen = function()
    {
        var screen = [];

        for(var i = 0; i < text_mode_height; i++)
        {
            screen.push(this.get_text_row(i));
        }

        return screen;
    };

    this.get_text_row = function(y)
    {
        const begin = y * text_mode_width * TEXT_BUF_COMPONENT_SIZE + CHARACTER_INDEX;
        const end = begin + text_mode_width * TEXT_BUF_COMPONENT_SIZE;
        let row = "";
        for(let i = begin; i < end; i += TEXT_BUF_COMPONENT_SIZE)
        {
            row += charmap[text_mode_data[i]];
        }
        return row;
    };

    this.init();
}
