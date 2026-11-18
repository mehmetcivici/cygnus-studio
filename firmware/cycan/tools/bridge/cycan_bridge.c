/*
 * cycan-bridge: one CyCAN board (the real C library) behind a line-based stdin/stdout
 * protocol, for cross-compatibility tests against the TypeScript host. The wire format is
 * specified in tools/bridge/README.md.
 *
 * The board runs on virtual time supplied by the host (`T` lines), switches between the
 * bootloader and the application exactly like a real board (cold boot -> bootloader ->
 * recovery window -> application; REBOOT / ENTER_BOOTLOADER / FW update), keeps its
 * parameter store (A/B slots) and image flash in memory, optionally persisted to a file,
 * and can lose power at any byte of a flash write (`C`).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cycan.h"
#include "cycan_boot.h"

#define SLOT_SIZE 4096u
#define IMAGE_CAPACITY (256u * 1024u)
#define POLL_US 1000u
#define LINE_MAX_LEN 1024
#define STORE_MAGIC "CYBRSTOR"
#define STORE_VERSION 1u

/* ---- Board models ------------------------------------------------------------------- */

#define ESC_FIELD(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_CTYPE(pt) name;
static struct {
    CYCAN_ESC20A_PARAMS(ESC_FIELD)
} g_esc;
#define ESC_ROW(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_PARAM_ENTRY(pid, pt, mn, mx, df, mnz, fl, &g_esc.name, NULL),
static const cycan_param_t k_esc_params[] = {CYCAN_ESC20A_PARAMS(ESC_ROW)};

#define CYN_FIELD(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_CTYPE(pt) name;
static struct {
    CYCAN_CYNCODER_PARAMS(CYN_FIELD)
} g_cyn;
#define CYN_ROW(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_PARAM_ENTRY(pid, pt, mn, mx, df, mnz, fl, &g_cyn.name, NULL),
static const cycan_param_t k_cyn_params[] = {CYCAN_CYNCODER_PARAMS(CYN_ROW)};

/* ---- Bridge state ------------------------------------------------------------------- */

typedef enum { MODE_OFF = 0, MODE_BOOT, MODE_APP } mode_t_;

static struct {
    /* Options. */
    bool esc;
    uint8_t uid96[12];
    uint8_t hw_rev;
    const char *store_path;

    /* Persistent memory. */
    uint8_t slot[2][SLOT_SIZE];
    uint8_t image[IMAGE_CAPACITY];
    bool store_dirty, image_dirty;

    /* Power and mode. */
    mode_t_ mode;
    bool stay_in_bootloader; /* ENTER_BOOTLOADER survives the software reset */
    enum { NEXT_NONE = 0, NEXT_BOOT, NEXT_APP } next;
    long cut_budget; /* bytes of flash that may still be programmed; < 0 = no cut armed */
    bool dead;
    int send_fail;

    uint64_t now;
    cycan_node_t node;
    cycan_boot_t boot;
    cycan_app_t app;

    /* Application model state. */
    bool out_enabled;
    uint8_t out_mode;
    float out_value;
    bool cmd_running;
    uint64_t cmd_done_at;
} g;

/* ---- Output ----------------------------------------------------------------------------- */

static void print_hex(const uint8_t *d, unsigned len)
{
    unsigned i;
    if (len == 0u) {
        fputs("-", stdout);
        return;
    }
    for (i = 0; i < len; i++) printf("%02x", d[i]);
}

static void set_mode(mode_t_ m)
{
    static const char *const k_names[] = {"OFF", "BOOT", "APP"};
    g.mode = m;
    printf("M %s\n", k_names[m]);
}

static void report_output(void)
{
    printf("A %d %u %g\n", g.out_enabled ? 1 : 0, (unsigned)g.out_mode, (double)g.out_value);
}

/* ---- HAL ---------------------------------------------------------------------------- */

static bool hal_send(void *ctx, const cycan_frame_t *f)
{
    (void)ctx;
    if (g.dead) return true; /* power is gone: nothing reaches the bus */
    if (g.send_fail > 0) {
        g.send_fail--;
        return false;
    }
    printf("F %08lx ", (unsigned long)f->id);
    print_hex(f->data, f->len);
    printf(" %u %llu\n", (unsigned)f->flags, (unsigned long long)g.now);
    return true;
}

static void hal_uid(void *ctx, uint8_t out[12])
{
    (void)ctx;
    memcpy(out, g.uid96, 12);
}

/* Programs `len` bytes, or only what the armed power cut allows. */
static bool program(uint8_t *dst, const void *src, uint32_t len)
{
    uint32_t n = len;
    if (g.cut_budget >= 0 && (long)n > g.cut_budget) n = (uint32_t)g.cut_budget;
    memcpy(dst, src, n);
    if (g.cut_budget >= 0) g.cut_budget -= (long)n;
    if (n < len) {
        g.dead = true;
        return false;
    }
    return true;
}

static bool erase(uint8_t *dst, uint32_t len)
{
    if (g.cut_budget == 0) {
        memset(dst, 0xFF, len / 2u); /* torn erase */
        g.dead = true;
        return false;
    }
    memset(dst, 0xFF, len);
    return true;
}

static bool st_read(void *ctx, uint8_t slot, uint32_t off, void *buf, uint32_t len)
{
    (void)ctx;
    if (g.dead || slot > 1u || off > SLOT_SIZE || len > SLOT_SIZE - off) return false;
    memcpy(buf, g.slot[slot] + off, len);
    return true;
}

static bool st_erase(void *ctx, uint8_t slot)
{
    (void)ctx;
    if (g.dead || slot > 1u) return false;
    g.store_dirty = true;
    return erase(g.slot[slot], SLOT_SIZE);
}

static bool st_write(void *ctx, uint8_t slot, uint32_t off, const void *buf, uint32_t len)
{
    uint32_t i;
    (void)ctx;
    if (g.dead || slot > 1u || off > SLOT_SIZE || len > SLOT_SIZE - off || off % 8u != 0u || len % 8u != 0u) return false;
    for (i = 0; i < len; i++)
        if (g.slot[slot][off + i] != 0xFFu) return false; /* written twice without an erase */
    g.store_dirty = true;
    return program(g.slot[slot] + off, buf, len);
}

static bool fl_erase(void *ctx, uint32_t size)
{
    (void)ctx;
    if (g.dead || size > IMAGE_CAPACITY) return false;
    g.image_dirty = true;
    return erase(g.image, IMAGE_CAPACITY);
}

static bool fl_write(void *ctx, uint32_t off, const uint8_t *data, uint32_t len)
{
    (void)ctx;
    if (g.dead || off > IMAGE_CAPACITY || len > IMAGE_CAPACITY - off || off % 8u != 0u || len % 8u != 0u) return false;
    g.image_dirty = true;
    return program(g.image + off, data, len);
}

static bool fl_read(void *ctx, uint32_t off, uint8_t *data, uint32_t len)
{
    (void)ctx;
    if (off > IMAGE_CAPACITY || len > IMAGE_CAPACITY - off) return false;
    memcpy(data, g.image + off, len);
    return true;
}

static void hal_reboot(void *ctx)
{
    (void)ctx;
    g.stay_in_bootloader = false;
    g.next = NEXT_BOOT;
}

static void hal_enter_bootloader(void *ctx)
{
    (void)ctx;
    g.stay_in_bootloader = true;
    g.next = NEXT_BOOT;
}

static void hal_start_app(void *ctx)
{
    (void)ctx;
    g.next = NEXT_APP;
}

static uint32_t hal_random(void *ctx)
{
    static uint32_t s = 0x9E3779B9u;
    (void)ctx;
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
}

static const cycan_hal_t k_hal = {
    NULL, hal_send, hal_uid, st_read, st_erase, st_write, hal_reboot, hal_enter_bootloader, NULL, hal_random,
};

static const cycan_boot_hal_t k_boot_hal = {
    NULL,     hal_send,    hal_uid, NULL,       IMAGE_CAPACITY, fl_erase, fl_write, fl_read,
    hal_start_app, NULL,   hal_random, st_read, st_erase,       st_write,
};

/* ---- Application callbacks ---------------------------------------------------------- */

static bool app_status(cycan_node_t *n, uint8_t i, uint8_t out[8])
{
    (void)n;
    (void)i;
    (void)out;
    return true; /* all-zero STATUS frames: the host only needs their timing */
}

static bool app_signal(cycan_node_t *n, uint16_t sid, float *out)
{
    (void)n;
    if (g.esc) {
        if (sid == CYCAN_ESC20A_SID_SETPOINT) *out = g.out_value;
        else if (sid == CYCAN_ESC20A_SID_CTRL_MODE) *out = (float)g.out_mode;
        else if (sid == CYCAN_ESC20A_SID_DUTY) *out = g.out_mode == CYCAN_ESC20A_MODE_DUTY ? g.out_value : 0.0f;
        else if (sid <= 20u) *out = (float)sid;
        else return false;
        return true;
    }
    if (sid > 20u) return false;
    *out = (float)sid;
    return true;
}

static void drive_output(bool enabled, uint8_t mode, float value)
{
    if (g.out_enabled == enabled && g.out_mode == mode && g.out_value == value) return;
    g.out_enabled = enabled;
    g.out_mode = mode;
    g.out_value = value;
    report_output();
}

static cycan_ctrl_t app_ctrl(cycan_node_t *n, uint8_t index, const uint8_t *d, uint8_t len, bool armed)
{
    cycan_ctrl_set_t m;
    if (index != 0u || !cycan_dec_ctrl_set(d, len, &m) || m.mode > CYCAN_ESC20A_MODE_BRAKE || m.value != m.value)
        return CYCAN_CTRL_INVALID;
    if (m.mode == CYCAN_ESC20A_MODE_OFF && m.value == 0.0f) {
        cycan_set_enabled(n, false);
        drive_output(false, 0, 0.0f);
        return CYCAN_CTRL_NEUTRAL;
    }
    if (armed) {
        cycan_set_enabled(n, true);
        drive_output(true, m.mode, m.value);
    }
    return CYCAN_CTRL_DRIVE;
}

static uint8_t app_command(cycan_node_t *n, uint8_t cmd, uint32_t arg, uint32_t *result)
{
    (void)arg;
    *result = 0;
    if (cmd == CYCAN_CMD_SELF_TEST) return CYCAN_CMDST_OK;
    if (g.esc && cmd == CYCAN_ESC20A_CMD_MEASURE_MOTOR) {
        if (!cycan_ctrl_allowed(n)) return CYCAN_CMDST_DENIED;
        g.cmd_running = true;
        g.cmd_done_at = g.now + 500000u;
        cycan_set_enabled(n, true); /* the measurement drives the motor */
        return CYCAN_CMDST_IN_PROGRESS;
    }
    return CYCAN_CMDST_UNSUPPORTED;
}

static const uint8_t k_esc_moving[] = CYCAN_ESC20A_MOVING_CMDS;

static void app_neutral(cycan_node_t *n, cycan_neutral_reason_t why)
{
    static const char *const k_why[] = {"CTRL_TIMEOUT", "ESTOP", "CONFLICT", "UNASSIGNED", "RESET", "FAULT", "ABORT"};
    (void)n;
    g.cmd_running = false; /* a running measurement is aborted with the actuator */
    printf("N %s\n", (unsigned)why < sizeof k_why / sizeof k_why[0] ? k_why[why] : "?");
    drive_output(false, 0, 0.0f);
}

/* ---- Store file ---------------------------------------------------------------------- */

static void store_save(void)
{
    FILE *f;
    uint32_t hdr[3];
    if (g.store_path == NULL || (!g.store_dirty && !g.image_dirty)) return;
    f = fopen(g.store_path, "wb");
    if (f == NULL) {
        printf("E store-write-failed %s\n", g.store_path);
        return;
    }
    hdr[0] = STORE_VERSION;
    hdr[1] = SLOT_SIZE;
    hdr[2] = IMAGE_CAPACITY;
    if (fwrite(STORE_MAGIC, 1, 8, f) != 8 || fwrite(hdr, sizeof hdr, 1, f) != 1 || fwrite(g.slot, sizeof g.slot, 1, f) != 1 ||
        fwrite(g.image, sizeof g.image, 1, f) != 1)
        printf("E store-write-failed %s\n", g.store_path);
    fclose(f);
    g.store_dirty = g.image_dirty = false;
}

static bool store_load(void)
{
    FILE *f;
    char magic[8];
    uint32_t hdr[3];
    bool ok;
    if (g.store_path == NULL) return false;
    f = fopen(g.store_path, "rb");
    if (f == NULL) return false;
    ok = fread(magic, 1, 8, f) == 8 && memcmp(magic, STORE_MAGIC, 8) == 0 && fread(hdr, sizeof hdr, 1, f) == 1 &&
         hdr[0] == STORE_VERSION && hdr[1] == SLOT_SIZE && hdr[2] == IMAGE_CAPACITY && fread(g.slot, sizeof g.slot, 1, f) == 1 &&
         fread(g.image, sizeof g.image, 1, f) == 1;
    fclose(f);
    if (!ok) printf("E store-ignored %s\n", g.store_path);
    return ok;
}

/* A small valid image so a fresh board boots into its application. */
static void install_synthetic_image(uint8_t major, uint8_t minor, uint8_t patch)
{
    cycan_cyfw_header_t h;
    uint32_t i, size = 256u;
    memset(g.image, 0xFF, sizeof g.image);
    for (i = 0; i < size; i++) g.image[CYCAN_CYFW_HEADER_SIZE + i] = (uint8_t)(i * 31u + 7u);
    memset(&h, 0, sizeof h);
    h.model = g.app.model;
    h.hw_rev_min = g.hw_rev;
    h.hw_rev_max = g.hw_rev;
    h.fw_major = major;
    h.fw_minor = minor;
    h.fw_patch = patch;
    h.payload_size = size;
    h.payload_crc32 = cycan_crc32(g.image + CYCAN_CYFW_HEADER_SIZE, size);
    h.catalog_rev = g.app.catalog_rev;
    strcpy(h.name, "bridge-synthetic");
    cycan_cyfw_encode_header(g.image, &h);
}

/* ---- Power and mode switching ---------------------------------------------------------- */

static void start_boot(void)
{
    cycan_boot_cfg_t cfg;
    memset(&cfg, 0, sizeof cfg);
    cfg.model = g.app.model;
    cfg.devtype = g.app.devtype;
    cfg.hw_rev = g.hw_rev;
    cfg.bootloader_ver = g.app.bootloader_ver;
    cfg.catalog_rev = g.app.catalog_rev;
    cfg.data_bitrate_default = 1; /* catalog default of can.data_bitrate for both models */
    cfg.stay = g.stay_in_bootloader;
    g.stay_in_bootloader = false;
    g.out_enabled = false;
    g.out_mode = 0;
    g.out_value = 0.0f;
    g.cmd_running = false;
    set_mode(MODE_BOOT);
    cycan_boot_init(&g.boot, &cfg, &k_boot_hal, (uint32_t)g.now);
}

static void start_app(void)
{
    cycan_cyfw_header_t h;
    if (cycan_cyfw_check_header(g.image, g.app.model, g.hw_rev, &h) == CYCAN_CYFW_OK) {
        g.app.fw_major = h.fw_major;
        g.app.fw_minor = h.fw_minor;
        g.app.fw_patch = h.fw_patch;
    }
    store_save();
    set_mode(MODE_APP);
    (void)cycan_init(&g.node, &g.app, &k_hal, NULL, (uint32_t)g.now);
}

static void power_off(const char *why)
{
    if (why != NULL) printf("E %s\n", why);
    g.dead = false;
    g.cut_budget = -1;
    g.next = NEXT_NONE;
    g.stay_in_bootloader = false;
    store_save();
    set_mode(MODE_OFF);
}

/* Applies a reset / application start requested from inside a poll. */
static void after_poll(void)
{
    if (g.dead) {
        power_off("power-cut");
        return;
    }
    if (g.next == NEXT_BOOT) {
        g.next = NEXT_NONE;
        store_save();
        start_boot();
    } else if (g.next == NEXT_APP) {
        g.next = NEXT_NONE;
        start_app();
    }
}

static void poll_once(void)
{
    if (g.mode == MODE_APP) {
        cycan_poll(&g.node, (uint32_t)g.now);
        if (g.cmd_running && g.now >= g.cmd_done_at && g.mode == MODE_APP) {
            g.cmd_running = false;
            cycan_set_enabled(&g.node, false);
            cycan_command_finish(&g.node, CYCAN_ESC20A_CMD_MEASURE_MOTOR, CYCAN_CMDST_OK, 0);
        }
    } else if (g.mode == MODE_BOOT) {
        cycan_boot_poll(&g.boot, (uint32_t)g.now);
    }
    after_poll();
}

static bool ring_full(void)
{
    uint8_t next = (uint8_t)((g.node.rx_head + 1u) & (CYCAN_RX_QUEUE_LEN - 1u));
    return next == g.node.rx_tail;
}

static void deliver(uint32_t id, const uint8_t *d, uint8_t len)
{
    if (g.mode == MODE_APP) {
        /* The application polls at 1 kHz; a burst bigger than its RX ring stands in for the
         * controller's hardware FIFO, so drain the ring first instead of dropping. */
        if (ring_full()) poll_once();
        if (g.mode == MODE_APP) (void)cycan_on_frame(&g.node, id, d, len);
    } else if (g.mode == MODE_BOOT) {
        /* The bootloader pulls frames from the FIFO and polls after each one. */
        (void)cycan_boot_on_frame(&g.boot, id, d, len);
        poll_once();
    }
}

static void advance(uint64_t us)
{
    uint64_t target = g.now + us;
    if (us == 0u) {
        poll_once();
        return;
    }
    while (g.now < target) {
        uint64_t step = target - g.now < POLL_US ? target - g.now : POLL_US;
        g.now += step;
        poll_once();
    }
}

/* ---- Input ----------------------------------------------------------------------------- */

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool parse_hex(const char *s, uint8_t *out, unsigned max, unsigned *len)
{
    unsigned n = 0;
    if (strcmp(s, "-") == 0) {
        *len = 0;
        return true;
    }
    while (s[0] != '\0') {
        int hi = hexval(s[0]), lo = s[1] != '\0' ? hexval(s[1]) : -1;
        if (hi < 0 || lo < 0 || n >= max) return false;
        out[n++] = (uint8_t)(hi * 16 + lo);
        s += 2;
    }
    *len = n;
    return true;
}

static bool valid_len(unsigned len)
{
    return len <= 8u || cycan_fd_len_to_dlc((uint8_t)len) >= 0;
}

/* Returns false on Q. */
static bool handle_line(char *line)
{
    char *tok[4];
    int n = 0;
    char *p = strtok(line, " \t\r\n");
    while (p != NULL && n < 4) {
        tok[n++] = p;
        p = strtok(NULL, " \t\r\n");
    }
    if (n == 0 || tok[0][0] == '#') return true;
    switch (tok[0][0]) {
    case 'F': {
        uint8_t d[64];
        unsigned len;
        char *end;
        unsigned long id = n >= 2 ? strtoul(tok[1], &end, 16) : 0;
        if (n < 3 || *end != '\0' || id > CYCAN_ID_MASK || !parse_hex(tok[2], d, sizeof d, &len) || !valid_len(len)) {
            printf("E bad-frame\n");
            return true;
        }
        deliver((uint32_t)id, d, (uint8_t)len);
        return true;
    }
    case 'T': {
        char *end;
        unsigned long long us = n >= 2 ? strtoull(tok[1], &end, 10) : 0;
        if (n >= 2 && *end != '\0') {
            printf("E bad-time\n");
            return true;
        }
        advance(us);
        printf("T %llu\n", (unsigned long long)g.now);
        return true;
    }
    case 'S':
        printf("S %s\n", n >= 2 ? tok[1] : "");
        return true;
    case 'P':
        if (n >= 2 && tok[1][0] == '1') {
            if (g.mode == MODE_OFF) start_boot();
        } else if (g.mode != MODE_OFF) {
            power_off(NULL);
        }
        return true;
    case 'C':
        g.cut_budget = n >= 2 ? strtol(tok[1], NULL, 10) : -1;
        return true;
    case 'X':
        g.send_fail = n >= 2 ? atoi(tok[1]) : 0;
        return true;
    case 'Q':
        return false;
    default:
        printf("E unknown-command %s\n", tok[0]);
        return true;
    }
}

static void usage(void)
{
    fputs("usage: cycan-bridge [--model esc20a|cyncoder] [--uid <24 hex>] [--hw-rev <n>]\n"
          "                    [--fw <major.minor.patch>] [--no-image] [--store <file>] [--off]\n",
          stderr);
}

int main(int argc, char **argv)
{
    static char line[LINE_MAX_LEN];
    unsigned fw[3] = {1, 0, 0};
    bool no_image = false, start_on = true, loaded;
    int i;

    g.esc = true;
    g.hw_rev = 1;
    g.cut_budget = -1;
    for (i = 0; i < 12; i++) g.uid96[i] = (uint8_t)(0x5A + i * 17);
    for (i = 1; i < argc; i++) {
        const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
        unsigned len;
        if (strcmp(a, "--model") == 0 && v != NULL) {
            g.esc = strcmp(v, "cyncoder") != 0;
            i++;
        } else if (strcmp(a, "--uid") == 0 && v != NULL && parse_hex(v, g.uid96, 12, &len) && len == 12u) {
            i++;
        } else if (strcmp(a, "--hw-rev") == 0 && v != NULL) {
            g.hw_rev = (uint8_t)atoi(v);
            i++;
        } else if (strcmp(a, "--fw") == 0 && v != NULL && sscanf(v, "%u.%u.%u", &fw[0], &fw[1], &fw[2]) == 3) {
            i++;
        } else if (strcmp(a, "--store") == 0 && v != NULL) {
            g.store_path = v;
            i++;
        } else if (strcmp(a, "--no-image") == 0) {
            no_image = true;
        } else if (strcmp(a, "--off") == 0) {
            start_on = false;
        } else {
            usage();
            return 2;
        }
    }

    memset(&g.app, 0, sizeof g.app);
    if (g.esc) {
        g.app.model = CYCAN_MODEL_ESC20A;
        g.app.devtype = CYCAN_ESC20A_DEVTYPE;
        g.app.catalog_rev = CYCAN_ESC20A_CATALOG_REV;
        g.app.stream_min_period_us = CYCAN_ESC20A_STREAM_MIN_PERIOD_US;
        g.app.status_count = CYCAN_ESC20A_STATUS_FRAME_COUNT;
        g.app.params = k_esc_params;
        g.app.param_count = (uint16_t)(sizeof k_esc_params / sizeof k_esc_params[0]);
        g.app.ctrl = app_ctrl;
        g.app.neutral = app_neutral;
        g.app.moving_cmds = k_esc_moving;
        g.app.moving_cmd_count = (uint8_t)sizeof k_esc_moving;
    } else {
        g.app.model = CYCAN_MODEL_CYNCODER;
        g.app.devtype = CYCAN_CYNCODER_DEVTYPE;
        g.app.catalog_rev = CYCAN_CYNCODER_CATALOG_REV;
        g.app.stream_min_period_us = CYCAN_CYNCODER_STREAM_MIN_PERIOD_US;
        g.app.status_count = CYCAN_CYNCODER_STATUS_FRAME_COUNT;
        g.app.params = k_cyn_params;
        g.app.param_count = (uint16_t)(sizeof k_cyn_params / sizeof k_cyn_params[0]);
    }
    g.app.hw_rev = g.hw_rev;
    g.app.bootloader_ver = 1;
    g.app.fd_capable = true;
    g.app.status_fill = app_status;
    g.app.signal_read = app_signal;
    g.app.command = app_command;

    memset(g.slot, 0xFF, sizeof g.slot);
    memset(g.image, 0xFF, sizeof g.image);
    loaded = store_load();
    if (!loaded && !no_image) install_synthetic_image((uint8_t)fw[0], (uint8_t)fw[1], (uint8_t)fw[2]);
    g.image_dirty = g.store_dirty = !loaded;

    g.mode = MODE_OFF;
    if (start_on) start_boot();
    fflush(stdout);
    while (fgets(line, sizeof line, stdin) != NULL) {
        bool go = handle_line(line);
        fflush(stdout);
        if (!go) break;
        if (g.store_dirty) store_save();
    }
    g.image_dirty = g.image_dirty || g.store_dirty;
    store_save();
    return 0;
}
