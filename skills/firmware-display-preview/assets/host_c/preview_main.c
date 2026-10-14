// Stub file for host-side preview harness.
//
// Copy into your repo (e.g. tools/display_preview/main.c) and adapt:
// - Call firmware init (if needed)
// - Call render_scene() (from scene.c)
// - Dump the firmware framebuffer to framebuffer.bin
//
// Then run fb_to_png.py to convert framebuffer.bin -> preview.png.

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

void render_scene(void);

// TODO: provide an accessor for your framebuffer bytes.
// Examples:
// - framebuffer-based: export `uint8_t g_fb[]; size_t g_fb_size;`
// - immediate-mode: implement a mock backend that writes into a host buffer.
static const uint8_t *get_framebuffer(size_t *out_size_bytes) {
  (void)out_size_bytes;
  return NULL;
}

static void write_file(const char *path, const uint8_t *data, size_t size) {
  FILE *f = fopen(path, "wb");
  if (!f) {
    perror("fopen");
    exit(1);
  }
  if (fwrite(data, 1, size, f) != size) {
    perror("fwrite");
    exit(1);
  }
  fclose(f);
}

int main(int argc, char **argv) {
  const char *out_path = (argc >= 2) ? argv[1] : "framebuffer.bin";

  render_scene();

  size_t size = 0;
  const uint8_t *fb = get_framebuffer(&size);
  if (!fb || size == 0) {
    fprintf(stderr, "get_framebuffer() not implemented (fb=%p size=%zu)\\n", (const void *)fb, size);
    return 2;
  }

  write_file(out_path, fb, size);
  fprintf(stderr, "Wrote %s (%zu bytes)\\n", out_path, size);
  return 0;
}
