/*
 * Random-frame fuzz of the node and the bootloader (run under ASan + UBSan by the Makefile).
 * Deterministic: `cycan_fuzz [frames] [seed]`, defaults 200000 frames, seed 1. Each round
 * starts from different storage contents (blank, random bytes, plausible headers, a valid
 * copy) and occasionally cuts the power in the middle of a storage write.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fake.h"

#define ROUNDS 20

#define ESC_FIELD(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_CTYPE(pt) name;
static struct {
    CYCAN_ESC20A_PARAMS(ESC_FIELD)
} esc_p;
#define ESC_ROW(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_PARAM_ENTRY(pid, pt, mn, mx, df, mnz, fl, &esc_p.name, NULL),
static const cycan_param_t k_params[] = {CYCAN_ESC20A_PARAMS(ESC_ROW)};

static uint32_t g_rs = 1;
static uint32_t rr(void)
{
    g_rs ^= g_rs << 13;
    g_rs ^= g_rs >> 17;
    g_rs ^= g_rs << 5;
    return g_rs;
}

static bool a_status(cycan_node_t *n, uint8_t i, uint8_t out[8])
{
    (void)n;
    out[0] = i;
    return (i & 1u) == 0u;
}

static bool a_sig(cycan_node_t *n, uint16_t sid, float *o)
{
    (void)n;
    if (sid > 20u) return false;
    *o = (float)sid;
    return true;
}

static cycan_ctrl_t a_ctrl(cycan_node_t *n, uint8_t index, const uint8_t *d, uint8_t len, bool armed)
{
    cycan_ctrl_set_t m;
    if (index != 0u || !cycan_dec_ctrl_set(d, len, &m)) return CYCAN_CTRL_INVALID;
    if (m.mode == 0u && m.value == 0.0f) return CYCAN_CTRL_NEUTRAL;
    if (armed) cycan_set_enabled(n, true);
    return CYCAN_CTRL_DRIVE;
}

static uint8_t a_cmd(cycan_node_t *n, uint8_t cmd, uint32_t arg, uint32_t *r)
{
    (void)arg;
    *r = 1;
    if (cmd == 0x41u) return CYCAN_CMDST_IN_PROGRESS;
    if (cmd == 0x42u) cycan_command_finish(n, 0x41u, 0, 0);
    if (cmd == 0x43u) cycan_fault_set(n, (uint8_t)(rr() & 15u), CYCAN_FAULT_ACTIVE);
    return CYCAN_CMDST_OK;
}

static void a_neutral(cycan_node_t *n, cycan_neutral_reason_t r)
{
    (void)r;
    cycan_set_enabled(n, false);
}

static const uint8_t k_moving[] = CYCAN_ESC20A_MOVING_CMDS;

static const cycan_app_t k_app = {
    CYCAN_MODEL_ESC20A, CYCAN_ESC20A_DEVTYPE, 3, 1, 2, 3, CYCAN_ESC20A_CATALOG_REV, 2, 0, 0, false,
    true, CYCAN_ESC20A_STREAM_MIN_PERIOD_US, CYCAN_ESC20A_STATUS_FRAME_COUNT,
    k_params, (uint16_t)(sizeof k_params / sizeof k_params[0]),
    a_status, a_sig, a_ctrl, a_cmd, a_neutral, NULL, k_moving, (uint8_t)sizeof k_moving,
};

static const uint8_t k_classes[] = {0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1B, 0x05, 0x3F};

static void seed_storage(fake_t *fk, int round)
{
    unsigned i, s;
    switch (round % 4) {
    case 1:
        for (s = 0; s < 2u; s++)
            for (i = 0; i < FAKE_REGION_SIZE; i++) fk->region[s][i] = (uint8_t)rr();
        break;
    case 2:
        /* Plausible headers with garbage behind them. */
        for (s = 0; s < 2u; s++) {
            memcpy(fk->region[s], "CYP2", 4);
            fk->region[s][8] = CYCAN_MODEL_ESC20A;
            fk->region[s][9] = 2;
            fk->region[s][10] = (uint8_t)rr();
            fk->region[s][11] = (uint8_t)(rr() & 3u);
            fk->region[s][12] = (uint8_t)rr();
        }
        break;
    case 3: {
        cycan_store_io_t io = {fk, fk->hal.storage_read, fk->hal.storage_erase, fk->hal.storage_write};
        (void)cycan_store_set_num(&io, CYCAN_MODEL_ESC20A, (uint8_t)(1u + rr() % 62u));
        break;
    }
    default:
        break;
    }
}

int main(int argc, char **argv)
{
    static fake_t fk;
    static cycan_node_t node;
    static cycan_boot_t bl;
    long frames = argc > 1 ? atol(argv[1]) : 200000L;
    long i, per_round = frames / ROUNDS;
    uint32_t now = 0xFFFFFFFFu - 500000u; /* crosses the 32-bit wrap */
    int round;
    g_rs = argc > 2 ? (uint32_t)strtoul(argv[2], NULL, 10) : 1u;
    if (g_rs == 0u) g_rs = 1u;

    for (round = 0; round < ROUNDS; round++) {
        cycan_boot_cfg_t cfg;
        fake_init(&fk, (uint8_t)round);
        seed_storage(&fk, round);
        (void)cycan_init(&node, &k_app, &fk.hal, NULL, now);
        memset(&cfg, 0, sizeof cfg);
        cfg.model = CYCAN_MODEL_ESC20A;
        cfg.devtype = CYCAN_ESC20A_DEVTYPE;
        cfg.hw_rev = 1;
        cfg.bootloader_ver = 3;
        cfg.catalog_rev = 1;
        cfg.window = (uint8_t)(rr() % 4u);
        cfg.data_bitrate_default = (uint8_t)(rr() % 5u);
        cfg.stay = (round & 1) != 0;
        cycan_boot_init(&bl, &cfg, &fk.boot_hal, now);

        for (i = 0; i < per_round; i++) {
            uint8_t d[64];
            uint8_t len = (uint8_t)(rr() % 65u);
            uint8_t dt = (uint8_t)(rr() % 3u == 0u ? 0u : ((rr() & 1u) ? CYCAN_ESC20A_DEVTYPE : 7u));
            uint8_t num = (uint8_t)(rr() % 4u == 0u ? 0u : ((rr() & 1u) ? rr() % 64u : cycan_num(&node)));
            uint8_t cls = k_classes[rr() % sizeof k_classes];
            uint32_t id;
            int k;
            for (k = 0; k < 64; k++) d[k] = (uint8_t)rr();
            if (rr() % 4u == 0u) d[0] = (uint8_t)(rr() % 9u);
            if (cls == CYCAN_CLS_SYS_REQ && rr() % 3u == 0u) {
                /* Steer ASSIGN_IDs to our UID so the number really changes. */
                uint64_t u = cycan_uid(&node)->uid48;
                for (k = 0; k < 6; k++) d[k] = (uint8_t)(u >> (8 * k));
                d[6] = (uint8_t)(rr() % 64u);
                len = 8;
            }
            if (cls == CYCAN_CLS_CTRL && rr() % 2u == 0u) {
                d[0] = (uint8_t)(rr() % 3u);
                memset(d + 4, 0, 4);
                len = 8;
            }
            id = cycan_id_encode(dt, cls, (uint8_t)(rr() % 16u), num);
            if (rr() % 50u == 0u) id = rr();
            (void)cycan_on_frame(&node, id, d, len);
            (void)cycan_boot_on_frame(&bl, id, d, len);
            if (rr() % 3u == 0u) {
                now += rr() % 3000u;
                cycan_poll(&node, now);
                cycan_boot_poll(&bl, now);
            }
            if (rr() % 100u == 0u) fk.send_fail = (int)(rr() % 6u);
            if (rr() % 400u == 0u) fk.cut_budget = (long)(rr() % 600u);
            if (fk.dead) {
                /* Power cut: back up from whatever the storage holds now. */
                fk.dead = false;
                fk.cut_budget = -1;
                (void)cycan_init(&node, &k_app, &fk.hal, NULL, now);
            }
            if (fk.nsent > FAKE_MAX_SENT - 200) fake_clear(&fk);
            if (rr() % 5000u == 0u) cycan_fault_set(&node, (uint8_t)rr(), (cycan_fault_kind_t)(rr() & 1u));
            if (rr() % 7000u == 0u) cycan_fault_clear(&node, (uint8_t)rr(), (cycan_fault_kind_t)(rr() & 1u));
        }
    }
    printf("fuzz done: %ld frames, seed %s\n", per_round * ROUNDS, argc > 2 ? argv[2] : "1");
    return 0;
}
