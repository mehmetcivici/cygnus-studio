/*
 * Cyncoder 1.5 (model 3) application on CyCAN. Reference skeleton, not built on the host.
 * Everything model specific comes from cycan_catalog.h; the sensor driver (AS5600 over I2C)
 * is the board's own code behind the as5600_* declarations below.
 */
#include <math.h>
#include <string.h>

#include "cycan.h"
#include "cycan_port_stm32g4.h"

/* Board sensor driver (not part of this example). */
bool as5600_read(uint16_t *raw_angle, uint8_t *agc, uint8_t *status); /* status: 0 ok, 1 weak, 2 strong, 3 none */
float board_temp_c(void);

/* ---- Parameters: storage struct and table, straight from the catalog X-macro ------ */

#define CYN_FIELD(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_CTYPE(pt) name;
static struct {
    CYCAN_CYNCODER_PARAMS(CYN_FIELD)
} p;

static void on_param(cycan_node_t *node, const cycan_param_t *def);

#define CYN_ROW(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_PARAM_ENTRY(pid, pt, mn, mx, df, mnz, fl, &p.name, on_param),
static const cycan_param_t k_params[] = {CYCAN_CYNCODER_PARAMS(CYN_ROW)};

/* ---- Measurement state (updated by the 1 kHz sensor task) ------------------------ */

static struct {
    float abs_rot;   /* 0..1 or -0.5..0.5 after offset / inversion */
    float multi_rot; /* multi-turn position, mechanism side */
    float rpm;
    uint16_t raw;
    uint8_t agc, magnet;
    float temp;
    int32_t turns;
    float last_abs;
} m;

static void on_param(cycan_node_t *node, const cycan_param_t *def)
{
    (void)node;
    if (def->pid == CYCAN_CYNCODER_PID_ENC_ZERO_OFFSET_ROT || def->pid == CYCAN_CYNCODER_PID_ENC_INVERT) m.turns = 0;
}

static void sensor_update(cycan_node_t *node)
{
    uint16_t raw;
    uint8_t agc, status;
    float a, d;
    if (!as5600_read(&raw, &agc, &status)) {
        cycan_fault_set(node, CYCAN_FAULT_SENSOR, CYCAN_FAULT_ACTIVE);
        return;
    }
    cycan_fault_clear(node, CYCAN_FAULT_SENSOR, CYCAN_FAULT_ACTIVE);
    if (status == 3u) cycan_fault_set(node, CYCAN_CYNCODER_FAULT_MAGNET_MISSING, CYCAN_FAULT_ACTIVE);
    else cycan_fault_clear(node, CYCAN_CYNCODER_FAULT_MAGNET_MISSING, CYCAN_FAULT_ACTIVE);
    if (status == 1u) cycan_fault_set(node, CYCAN_CYNCODER_FAULT_MAGNET_WEAK, CYCAN_FAULT_WARN);
    else cycan_fault_clear(node, CYCAN_CYNCODER_FAULT_MAGNET_WEAK, CYCAN_FAULT_WARN);
    if (status == 2u) cycan_fault_set(node, CYCAN_CYNCODER_FAULT_MAGNET_STRONG, CYCAN_FAULT_WARN);
    else cycan_fault_clear(node, CYCAN_CYNCODER_FAULT_MAGNET_STRONG, CYCAN_FAULT_WARN);

    a = (float)raw / 4096.0f;
    if (p.ENC_INVERT) a = 1.0f - a;
    a -= p.ENC_ZERO_OFFSET_ROT;
    if (a < 0.0f) a += 1.0f;
    d = a - m.last_abs;
    if (d > 0.5f) m.turns--;
    else if (d < -0.5f) m.turns++;
    m.last_abs = a;
    m.abs_rot = (p.ENC_ABS_RANGE == 1u && a >= 0.5f) ? a - 1.0f : a;
    m.multi_rot = ((float)m.turns + a) / p.ENC_RATIO;
    m.raw = raw;
    m.agc = agc;
    m.magnet = status;
    m.temp = board_temp_c();
    /* Velocity over ENC_VEL_WINDOW_MS is left to the real driver. */
}

/* ---- Callbacks ------------------------------------------------------------------- */

/* STATUS/0: position@0 f32, velocity@4 f32
 * STATUS/1: abs.position@0 f32, raw.angle@4.0:12 u16, magnet.status@4.12:2 u16,
 *           magnet.agc@6 u8, temp@7 i8 */
static bool status_fill(cycan_node_t *node, uint8_t n, uint8_t out[8])
{
    (void)node;
    if (n == 0u) {
        cycan_wr_f32(out, m.multi_rot);
        cycan_wr_f32(out + 4, m.rpm);
        return true;
    }
    if (n == 1u) {
        cycan_wr_f32(out, m.abs_rot);
        cycan_put_bits(out + 4, 2, 0, 12, m.raw);
        cycan_put_bits(out + 4, 2, 12, 2, m.magnet);
        out[6] = m.agc;
        out[7] = (uint8_t)cycan_scale_round(m.temp, 1.0f, 0.0f, -128, 127);
        return true;
    }
    return false;
}

static bool signal_read(cycan_node_t *node, uint16_t sid, float *out)
{
    (void)node;
    switch (sid) {
    case CYCAN_CYNCODER_SID_ABS_POSITION: *out = m.abs_rot; return true;
    case CYCAN_CYNCODER_SID_POSITION: *out = m.multi_rot; return true;
    case CYCAN_CYNCODER_SID_VELOCITY: *out = m.rpm; return true;
    case CYCAN_CYNCODER_SID_MAGNET_AGC: *out = (float)m.agc; return true;
    case CYCAN_CYNCODER_SID_MAGNET_STATUS: *out = (float)m.magnet; return true;
    case CYCAN_CYNCODER_SID_RAW_ANGLE: *out = (float)m.raw; return true;
    case CYCAN_CYNCODER_SID_TEMP: *out = m.temp; return true;
    default: return false;
    }
}

static uint8_t command(cycan_node_t *node, uint8_t cmd, uint32_t arg, uint32_t *result)
{
    cycan_pval_t v;
    (void)arg;
    switch (cmd) {
    case CYCAN_CYNCODER_CMD_ZERO_HERE:
        /* Same path as a host SET, so range checks, on_change and UNSAVED all apply. */
        v.f32 = (float)m.raw / 4096.0f;
        if (p.ENC_INVERT) v.f32 = 1.0f - v.f32;
        if (v.f32 >= 1.0f) v.f32 = 0.0f;
        return cycan_param_set(node, CYCAN_CYNCODER_PID_ENC_ZERO_OFFSET_ROT, CYCAN_PTYPE_F32, v) == CYCAN_PST_OK
                   ? CYCAN_CMDST_OK
                   : CYCAN_CMDST_FAILED;
    case CYCAN_CYNCODER_CMD_RESET_TURNS:
        m.turns = 0;
        return CYCAN_CMDST_OK;
    case CYCAN_CMD_SELF_TEST: {
        uint16_t raw;
        uint8_t agc, st;
        *result = 0;
        if (!as5600_read(&raw, &agc, &st)) *result |= 1u << CYCAN_CYNCODER_SELFTEST_SENSOR_COMM;
        else if (st != 0u) *result |= 1u << CYCAN_CYNCODER_SELFTEST_MAGNET;
        return CYCAN_CMDST_OK;
    }
    default:
        return CYCAN_CMDST_UNSUPPORTED;
    }
}

static const cycan_app_t k_app = {
    CYCAN_MODEL_CYNCODER, CYCAN_CYNCODER_DEVTYPE, /* hw_rev */ 2,
    /* fw */ 1, 5, 0, CYCAN_CYNCODER_CATALOG_REV, /* bootloader_ver */ 1,
    /* git_hash, build_day, dirty: injected by the build */ 0, 0, false,
    /* fd_capable */ true, CYCAN_CYNCODER_STREAM_MIN_PERIOD_US, CYCAN_CYNCODER_STATUS_FRAME_COUNT,
    k_params, (uint16_t)(sizeof k_params / sizeof k_params[0]),
    status_fill, signal_read, /* ctrl: sensor */ NULL, command, /* neutral: nothing to stop */ NULL,
    /* param_validate: catalog enums are contiguous */ NULL,
};

/* ---- Main loop ------------------------------------------------------------------- */

static cycan_node_t g_node;

void app_main(void)
{
    uint32_t last = 0;
    (void)cycan_init(&g_node, &k_app, &g_port_hal, NULL, port_now_us());
    if (p.ENC_BOOT_POSITION == 1u) m.turns = 0;
    port_bind_node(&g_node);
    port_can_start(cycan_data_bitrate(&g_node));
    for (;;) {
        uint32_t now = port_now_us();
        if (now - last >= 1000u) { /* 1 kHz: sensor, then protocol (min stream period 1 ms) */
            last = now;
            sensor_update(&g_node);
            cycan_poll(&g_node, now);
        }
        /* Status LED logic yields to IDENTIFY blinking while cycan_identify_active(). */
    }
}
