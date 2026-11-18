/* Node scenarios against a fake HAL. The ESC 20A and Cyncoder parameter tables are built
 * straight from the generated catalog X-macros, the way a port does it. */
#include <math.h>
#include <string.h>

#include "fake.h"
#include "test.h"

/* ---- ESC 20A test application ---------------------------------------------------- */

#define ESC_FIELD(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_CTYPE(pt) name;
static struct {
    CYCAN_ESC20A_PARAMS(ESC_FIELD)
} esc_p;

static int g_changes;
static void on_change(cycan_node_t *n, const cycan_param_t *p)
{
    (void)n;
    (void)p;
    g_changes++;
}

#define ESC_ROW(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_PARAM_ENTRY(pid, pt, mn, mx, df, mnz, fl, &esc_p.name, on_change),
static const cycan_param_t k_esc_params[] = {CYCAN_ESC20A_PARAMS(ESC_ROW)};

static struct {
    int ctrl_calls; /* applied drive commands */
    uint8_t ctrl_index;
    int neutral_cmds; /* neutral CTRL commands */
    int refused;      /* drive commands seen while not armed */
    bool driving;
    int neutral_calls;
    cycan_neutral_reason_t neutral_reason;
    int status_calls[16];
} app_log;

static bool esc_status(cycan_node_t *n, uint8_t i, uint8_t out[8])
{
    (void)n;
    app_log.status_calls[i]++;
    out[0] = i;
    out[7] = 0x5A;
    return true;
}

static bool esc_signal(cycan_node_t *n, uint16_t sid, float *out)
{
    (void)n;
    if (sid == 99u) return false;
    *out = (float)sid * 1.5f;
    return true;
}

/* CTRL/0 SET (mode, value); CTRL/1 is a second channel with the same layout, so the
 * per-index arming of the neutral-first rule can be observed. */
static cycan_ctrl_t esc_ctrl(cycan_node_t *n, uint8_t index, const uint8_t *d, uint8_t len, bool armed)
{
    cycan_ctrl_set_t m;
    if (index > 1u || !cycan_dec_ctrl_set(d, len, &m)) return CYCAN_CTRL_INVALID;
    if (m.mode == CYCAN_ESC20A_MODE_OFF && m.value == 0.0f) {
        app_log.neutral_cmds++;
        app_log.driving = false;
        cycan_set_enabled(n, false);
        return CYCAN_CTRL_NEUTRAL;
    }
    if (!armed) {
        app_log.refused++;
        return CYCAN_CTRL_DRIVE;
    }
    app_log.ctrl_calls++;
    app_log.ctrl_index = index;
    app_log.driving = true;
    cycan_set_enabled(n, true);
    return CYCAN_CTRL_DRIVE;
}

static uint8_t esc_command(cycan_node_t *n, uint8_t cmd, uint32_t arg, uint32_t *result)
{
    (void)n;
    (void)arg;
    if (cmd == CYCAN_ESC20A_CMD_SET_POSITION + 0x20u) {
        /* Raises an active fault from inside a callback (re-entrancy of neutral()). */
        cycan_fault_set(n, CYCAN_FAULT_OVERCURRENT, CYCAN_FAULT_ACTIVE);
        return CYCAN_CMDST_OK;
    }
    if (cmd == CYCAN_ESC20A_CMD_MEASURE_MOTOR || cmd == CYCAN_ESC20A_CMD_CALIBRATE_PWM) return CYCAN_CMDST_IN_PROGRESS;
    if (cmd == CYCAN_ESC20A_CMD_SET_POSITION) {
        *result = 42;
        return CYCAN_CMDST_OK;
    }
    if (cmd == CYCAN_CMD_SELF_TEST) {
        *result = 0;
        return CYCAN_CMDST_OK;
    }
    return CYCAN_CMDST_UNSUPPORTED;
}

static void esc_neutral(cycan_node_t *n, cycan_neutral_reason_t why)
{
    (void)n;
    app_log.driving = false;
    app_log.neutral_calls++;
    app_log.neutral_reason = why;
}

static bool esc_validate(cycan_node_t *n, const cycan_param_t *p, cycan_pval_t v)
{
    static const uint32_t khz[] = CYCAN_ESC20A_ENUM_MOTOR_PWM_KHZ_VALUES;
    size_t i;
    (void)n;
    if (p->pid != CYCAN_ESC20A_PID_MOTOR_PWM_KHZ) return true;
    for (i = 0; i < sizeof khz / sizeof khz[0]; i++)
        if (khz[i] == v.u32) return true;
    return false;
}

static const uint8_t k_esc_moving[] = CYCAN_ESC20A_MOVING_CMDS;

static const cycan_app_t k_esc_app = {
    CYCAN_MODEL_ESC20A, CYCAN_ESC20A_DEVTYPE, 3, 1, 2, 3, CYCAN_ESC20A_CATALOG_REV, 2, 0xDEADBEEFu, 321, true,
    true, CYCAN_ESC20A_STREAM_MIN_PERIOD_US, CYCAN_ESC20A_STATUS_FRAME_COUNT,
    k_esc_params, (uint16_t)(sizeof k_esc_params / sizeof k_esc_params[0]),
    esc_status, esc_signal, esc_ctrl, esc_command, esc_neutral, esc_validate,
    k_esc_moving, (uint8_t)sizeof k_esc_moving,
};

/* ---- Cyncoder application (sensor: no CTRL, no commands) ------------------------- */

#define CYN_FIELD(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_CTYPE(pt) name;
static struct {
    CYCAN_CYNCODER_PARAMS(CYN_FIELD)
} cyn_p;
#define CYN_ROW(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_PARAM_ENTRY(pid, pt, mn, mx, df, mnz, fl, &cyn_p.name, NULL),
static const cycan_param_t k_cyn_params[] = {CYCAN_CYNCODER_PARAMS(CYN_ROW)};

static const cycan_app_t k_cyn_app = {
    CYCAN_MODEL_CYNCODER, CYCAN_CYNCODER_DEVTYPE, 1, 1, 5, 0, CYCAN_CYNCODER_CATALOG_REV, 1, 0, 0, false,
    false, CYCAN_CYNCODER_STREAM_MIN_PERIOD_US, CYCAN_CYNCODER_STATUS_FRAME_COUNT,
    k_cyn_params, (uint16_t)(sizeof k_cyn_params / sizeof k_cyn_params[0]),
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
};

/* ---- Fixture --------------------------------------------------------------------- */

#define DT CYCAN_ESC20A_DEVTYPE

static fake_t fk;
static cycan_node_t node;
static uint32_t now;

static cycan_init_result_t boot(const cycan_app_t *app)
{
    memset(&app_log, 0, sizeof app_log);
    g_changes = 0;
    return cycan_init(&node, app, &fk.hal, NULL, now);
}

/* Blank board, then assigned NUM (persisted) unless num == 63. */
static void setup(uint8_t num)
{
    now = 1000000u;
    fake_init(&fk, 0x10);
    (void)boot(&k_esc_app);
    if (num != CYCAN_NUM_UNASSIGNED) {
        cycan_frame_t f;
        cycan_assign_id_t a;
        a.uid48 = cycan_uid(&node)->uid48;
        a.new_num = num;
        a.persist = true;
        cycan_enc_assign_id(&f, 0, 0, &a);
        to_node(&node, &f);
        run_ms(&node, &now, 1);
    }
    memset(&app_log, 0, sizeof app_log);
    fake_clear(&fk);
}

static void reboot_node(const cycan_app_t *app)
{
    now += 1000000u;
    (void)boot(app);
    fake_clear(&fk);
}

static uint8_t command(uint8_t cmd, uint32_t arg, uint32_t *result)
{
    cycan_frame_t f;
    cycan_command_t c;
    cycan_command_rsp_t r;
    const cycan_frame_t *rf;
    c.cmd = cmd;
    c.arg = arg;
    cycan_enc_command(&f, DT, cycan_num(&node), &c);
    fake_clear(&fk);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP);
    if (rf == NULL || !cycan_dec_command_rsp(rf->data, rf->len, &r) || r.cmd != cmd) return 0xFF;
    if (result != NULL) *result = r.result;
    return r.status;
}

static bool param_set(uint16_t pid, uint8_t ptype, uint32_t raw, cycan_param_value_t *out)
{
    cycan_frame_t f;
    cycan_param_set_t s;
    const cycan_frame_t *rf;
    s.pid = pid;
    s.ptype = ptype;
    s.value = raw;
    cycan_enc_param_set(&f, DT, cycan_num(&node), &s);
    fake_clear(&fk);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    rf = fake_last(&fk, CYCAN_CLS_PARAM_RSP, CYCAN_PARAM_VALUE);
    return rf != NULL && cycan_dec_param_value(rf->data, rf->len, out) && out->pid == pid;
}

static bool last_heartbeat(cycan_heartbeat_t *hb)
{
    const cycan_frame_t *f = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT);
    return f != NULL && cycan_dec_heartbeat(f->data, f->len, hb);
}

static void ctrl_frame(uint8_t index, uint8_t mode, float value)
{
    cycan_frame_t f;
    cycan_ctrl_set_t c;
    c.mode = mode;
    c.flags = 0;
    c.value = value;
    cycan_enc_ctrl_set(&f, DT, cycan_num(&node), &c);
    f.id = cycan_id_encode(DT, CYCAN_CLS_CTRL, index, cycan_num(&node));
    to_node(&node, &f);
}

static void send_ctrl(void)
{
    ctrl_frame(0, CYCAN_ESC20A_MODE_VELOCITY, 1500.0f);
}

static void send_neutral(void)
{
    ctrl_frame(0, CYCAN_ESC20A_MODE_OFF, 0.0f);
}

/* Neutral first, then drive (PROTOCOL 7). */
static void drive(void)
{
    send_neutral();
    send_ctrl();
    run_ms(&node, &now, 1);
}

static uint32_t intent(void)
{
    return CYCAN_BOOT_INTENT | cycan_uid(&node)->uid16;
}

/* ---- Tests ----------------------------------------------------------------------- */

void test_node_boot_and_enum(void)
{
    cycan_frame_t f;
    cycan_enum_req_t e;
    cycan_enum_rsp_t r;
    const cycan_frame_t *rf;
    uint32_t delay;
    now = 5000000u;
    fake_init(&fk, 0x10);
    CHECK_EQ(boot(&k_esc_app), CYCAN_INIT_STORAGE_BLANK);
    CHECK_EQ(cycan_num(&node), CYCAN_NUM_UNASSIGNED);
    CHECK_EQ(cycan_data_bitrate(&node), 1);
    /* Defaults from the catalog, and on_change ran once per parameter at boot. */
    CHECK_EQ(esc_p.CTRL_TIMEOUT_MS, 200);
    CHECK(esc_p.VEL_FILTER_HZ == 100.0f);
    CHECK_EQ(g_changes, CYCAN_ESC20A_PARAM_COUNT);

    run_ms(&node, &now, 2000);
    CHECK_EQ(fk.nsent, 0); /* unassigned: no heartbeat, status or stream */

    e.filter = CYCAN_ENUM_FILTER_ALL;
    cycan_enc_enum_req(&f, 0, 0, &e);
    to_node(&node, &f);
    delay = cycan_uid(&node)->enum_delay_ms;
    run_ms(&node, &now, delay); /* processed at +1 ms, due at +1 + delay */
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 0);
    run_ms(&node, &now, 1);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 1);
    rf = fake_find(&fk, CYCAN_CLS_ENUM_RSP, 0xFF, 0);
    CHECK(rf != NULL);
    if (rf == NULL) return;
    CHECK_EQ(rf->id, cycan_enum_rsp_id(DT, cycan_uid(&node)->hash10));
    CHECK(cycan_dec_enum_rsp(rf->data, rf->len, &r));
    CHECK_EQ(r.uid48, cycan_uid(&node)->uid48);
    CHECK_EQ(r.num, 63);
    CHECK(!r.conflict && !r.bootloader);
    CHECK_EQ(r.model, CYCAN_MODEL_ESC20A);
    run_ms(&node, &now, 300);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 1);
}

void test_node_enum_filter_and_retry(void)
{
    cycan_frame_t f;
    cycan_enum_req_t e;
    setup(4);
    e.filter = CYCAN_ENUM_FILTER_UNASSIGNED;
    cycan_enc_enum_req(&f, 0, 0, &e);
    to_node(&node, &f);
    run_ms(&node, &now, 200);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 0);

    /* TX failure: exactly one randomized retry within 0..100 ms (unassigned board, so
     * the ENUM_RSP is the only frame it sends). */
    setup(CYCAN_NUM_UNASSIGNED);
    e.filter = CYCAN_ENUM_FILTER_ALL;
    cycan_enc_enum_req(&f, 0, 0, &e);
    to_node(&node, &f);
    fk.send_fail = 1;
    run_ms(&node, &now, 1u + cycan_uid(&node)->enum_delay_ms);
    CHECK_EQ(fk.send_fail, 0);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 0);
    run_ms(&node, &now, 101);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 1);
    /* Second failure: given up. */
    fake_clear(&fk);
    to_node(&node, &f);
    run_ms(&node, &now, 1u + cycan_uid(&node)->enum_delay_ms);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 1);
    fake_clear(&fk);
    to_node(&node, &f);
    fk.send_fail = 1;
    run_ms(&node, &now, 1u + cycan_uid(&node)->enum_delay_ms);
    fk.send_fail = 1;
    run_ms(&node, &now, 101);
    run_ms(&node, &now, 200);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 0);

    /* Asynchronous TX error report after a successful hand-over: one more try, then give up. */
    to_node(&node, &f);
    run_ms(&node, &now, 1u + cycan_uid(&node)->enum_delay_ms);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 1);
    fake_clear(&fk);
    cycan_on_tx_error(&node, cycan_enum_rsp_id(DT, cycan_uid(&node)->hash10));
    run_ms(&node, &now, 101);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 1);
    cycan_on_tx_error(&node, cycan_enum_rsp_id(DT, cycan_uid(&node)->hash10));
    run_ms(&node, &now, 101);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 1);
}

void test_node_unassigned_is_silent(void)
{
    cycan_frame_t f;
    cycan_info_req_t ir;
    cycan_param_get_t pg;
    cycan_identify_t id;
    setup(CYCAN_NUM_UNASSIGNED);
    ir.page = 0;
    cycan_enc_info_req(&f, DT, 63, &ir);
    to_node(&node, &f);
    cycan_enc_info_req(&f, 0, 0, &ir);
    to_node(&node, &f);
    pg.pid = CYCAN_PID_CTRL_TIMEOUT_MS;
    cycan_enc_param_get(&f, DT, 63, &pg);
    to_node(&node, &f);
    send_ctrl();
    id.uid_form = false;
    id.uid48 = 0;
    id.seconds = 3;
    cycan_enc_identify(&f, DT, 63, &id);
    to_node(&node, &f);
    run_ms(&node, &now, 1000);
    CHECK_EQ(fk.nsent, 0);
    CHECK_EQ(app_log.ctrl_calls, 0);
    CHECK(!cycan_identify_active(&node));

    /* The UID form of IDENTIFY still works and blinks the LED. */
    id.uid_form = true;
    id.uid48 = cycan_uid(&node)->uid48;
    id.seconds = 1;
    cycan_enc_identify(&f, 0, 0, &id);
    to_node(&node, &f);
    run_ms(&node, &now, 500);
    CHECK(cycan_identify_active(&node));
    CHECK(fk.led_calls >= 4);
    run_ms(&node, &now, 600);
    CHECK(!cycan_identify_active(&node));
    CHECK(!fk.led);
    CHECK_EQ(fk.nsent, 0);
}

void test_node_assign_id(void)
{
    cycan_frame_t f;
    cycan_assign_id_t a;
    cycan_enum_rsp_t r;
    cycan_heartbeat_t hb;
    const cycan_frame_t *rf;
    setup(CYCAN_NUM_UNASSIGNED);

    a.uid48 = cycan_uid(&node)->uid48 ^ 1u;
    a.new_num = 9;
    a.persist = true;
    cycan_enc_assign_id(&f, 0, 0, &a);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK_EQ(cycan_num(&node), 63);

    a.uid48 = cycan_uid(&node)->uid48;
    a.persist = false;
    cycan_enc_assign_id(&f, 0, 0, &a);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK_EQ(cycan_num(&node), 9);
    rf = fake_find(&fk, CYCAN_CLS_ENUM_RSP, 0xFF, 0);
    CHECK(rf != NULL && cycan_dec_enum_rsp(rf->data, rf->len, &r) && r.num == 9 && !r.conflict);
    run_ms(&node, &now, 600);
    CHECK(last_heartbeat(&hb));
    CHECK_EQ(fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT)->id, cycan_id_encode(DT, CYCAN_CLS_SYS_RSP, 0, 9));
    CHECK_EQ(hb.uid16, cycan_uid(&node)->uid16);
    CHECK_EQ(hb.state, CYCAN_STATE_IDLE);
    CHECK_EQ(hb.fw_major, 1);

    /* Not persisted: back to 63 after reboot. Persisted: survives. */
    reboot_node(&k_esc_app);
    CHECK_EQ(cycan_num(&node), 63);
    a.persist = true;
    cycan_enc_assign_id(&f, 0, 0, &a);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    /* Confirmation first (within 50 ms), then the flash write. */
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 1);
    CHECK_EQ(fk.nsent_at_store, 1);
    reboot_node(&k_esc_app);
    CHECK_EQ(cycan_num(&node), 9);
}

void test_node_heartbeat_timing(void)
{
    int i, first = -1, count = 0;
    setup(3);
    for (i = 0; i < 2000; i++) {
        int before = fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT);
        run_ms(&node, &now, 1);
        if (fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT) != before) {
            if (first < 0) first = i;
            else CHECK_EQ((i - first) % 500, 0);
            count++;
        }
    }
    CHECK_EQ(count, 4);
}

void test_node_conflict(void)
{
    cycan_frame_t f;
    cycan_heartbeat_t hb;
    cycan_enum_req_t e;
    cycan_enum_rsp_t r;
    cycan_assign_id_t a;
    const cycan_frame_t *rf;
    setup(5);
    drive();
    CHECK_EQ(app_log.ctrl_calls, 1);

    /* Our own uid16 from our address is not a conflict (e.g. a looped-back frame). */
    memset(&hb, 0, sizeof hb);
    hb.state = CYCAN_STATE_IDLE;
    hb.uid16 = cycan_uid(&node)->uid16;
    cycan_enc_heartbeat(&f, DT, 5, &hb);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK(cycan_ctrl_allowed(&node));

    hb.uid16 = (uint16_t)(cycan_uid(&node)->uid16 + 1u);
    cycan_enc_heartbeat(&f, DT, 5, &hb);
    fake_clear(&fk);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK(!cycan_ctrl_allowed(&node));
    CHECK_EQ(app_log.neutral_reason, CYCAN_NEUTRAL_CONFLICT);
    /* Announced with a CONFLICT-flagged ENUM_RSP within 0..20 ms. */
    run_ms(&node, &now, 21);
    rf = fake_find(&fk, CYCAN_CLS_ENUM_RSP, 0xFF, 0);
    CHECK(rf != NULL && cycan_dec_enum_rsp(rf->data, rf->len, &r) && r.conflict && r.num == 5);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 1);
    fake_clear(&fk);
    send_ctrl();
    run_ms(&node, &now, 1500);
    CHECK_EQ(app_log.ctrl_calls, 1);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, 0xFF), 0);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_STATUS, 0xFF), 0);

    e.filter = CYCAN_ENUM_FILTER_UNASSIGNED;
    cycan_enc_enum_req(&f, 0, 0, &e);
    to_node(&node, &f);
    run_ms(&node, &now, 101);
    rf = fake_find(&fk, CYCAN_CLS_ENUM_RSP, 0xFF, 0);
    CHECK(rf != NULL && cycan_dec_enum_rsp(rf->data, rf->len, &r) && r.conflict && r.num == 5);

    /* Only an ASSIGN_ID for our uid48 ends it; the same number may be given again. */
    a.uid48 = cycan_uid(&node)->uid48 + 1u;
    a.new_num = 5;
    a.persist = false;
    cycan_enc_assign_id(&f, 0, 0, &a);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK(!cycan_ctrl_allowed(&node));
    a.uid48 = cycan_uid(&node)->uid48;
    cycan_enc_assign_id(&f, 0, 0, &a);
    fake_clear(&fk);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    rf = fake_find(&fk, CYCAN_CLS_ENUM_RSP, 0xFF, 0);
    CHECK(rf != NULL && cycan_dec_enum_rsp(rf->data, rf->len, &r) && !r.conflict && r.num == 5);
    run_ms(&node, &now, 600);
    CHECK(cycan_ctrl_allowed(&node));
    CHECK(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT) >= 1);
}

void test_node_conflict_from_enum_rsp(void)
{
    cycan_frame_t f;
    cycan_enum_rsp_t e, r;
    const cycan_frame_t *rf;
    setup(5);
    /* Another board's ENUM_RSP for a different number, or our own uid48: no conflict. */
    e.uid48 = cycan_uid(&node)->uid48 ^ 0x10000u;
    e.num = 6;
    e.conflict = false;
    e.bootloader = false;
    e.model = CYCAN_MODEL_ESC20A;
    cycan_enc_enum_rsp(&f, DT, &e);
    to_node(&node, &f);
    e.uid48 = cycan_uid(&node)->uid48;
    e.num = 5;
    cycan_enc_enum_rsp(&f, DT, &e);
    to_node(&node, &f);
    /* Same number on another device type: no conflict either. */
    e.uid48 = 0x123456789ull;
    cycan_enc_enum_rsp(&f, CYCAN_CYNCODER_DEVTYPE, &e);
    to_node(&node, &f);
    run_ms(&node, &now, 30);
    CHECK(cycan_ctrl_allowed(&node));

    cycan_enc_enum_rsp(&f, DT, &e);
    fake_clear(&fk);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK(!cycan_ctrl_allowed(&node));
    run_ms(&node, &now, 20);
    rf = fake_find(&fk, CYCAN_CLS_ENUM_RSP, 0xFF, 0);
    CHECK(rf != NULL && cycan_dec_enum_rsp(rf->data, rf->len, &r) && r.conflict && r.num == 5 && r.uid48 == cycan_uid(&node)->uid48);
    run_ms(&node, &now, 1000);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT), 0);
}

void test_node_param_statuses(void)
{
    cycan_param_value_t v;
    cycan_frame_t f;
    cycan_param_get_t g;
    cycan_heartbeat_t hb;
    const cycan_frame_t *rf;
    setup(1);

    CHECK(param_set(CYCAN_PID_CTRL_TIMEOUT_MS, CYCAN_PTYPE_U32, 250, &v));
    CHECK_EQ(v.status, CYCAN_PST_OK);
    CHECK_EQ(v.value, 250);
    CHECK_EQ(esc_p.CTRL_TIMEOUT_MS, 250);
    run_ms(&node, &now, 600);
    CHECK(last_heartbeat(&hb) && hb.unsaved);

    CHECK(param_set(0x7777, CYCAN_PTYPE_U32, 1, &v));
    CHECK_EQ(v.status, CYCAN_PST_UNKNOWN_PARAM);
    CHECK(param_set(CYCAN_PID_CTRL_TIMEOUT_MS, CYCAN_PTYPE_F32, cycan_f32_bits(1.0f), &v));
    CHECK_EQ(v.status, CYCAN_PST_TYPE_MISMATCH);
    CHECK_EQ(v.ptype, CYCAN_PTYPE_U32);
    CHECK_EQ(v.value, 250);
    CHECK(param_set(CYCAN_PID_CTRL_TIMEOUT_MS, CYCAN_PTYPE_U32, 10, &v));
    CHECK_EQ(v.status, CYCAN_PST_OUT_OF_RANGE);
    CHECK_EQ(v.value, 250); /* rejected SET answers with the old value */
    CHECK(param_set(CYCAN_PID_CAN_TERMINATION, CYCAN_PTYPE_BOOL, 1, &v));
    CHECK_EQ(v.status, CYCAN_PST_READ_ONLY);
    CHECK_EQ(v.value, 0);
    /* min_nonzero: status period 0 (off) or >= 5. */
    CHECK(param_set(CYCAN_PID_STATUS_PERIOD(1), CYCAN_PTYPE_U32, 3, &v));
    CHECK_EQ(v.status, CYCAN_PST_OUT_OF_RANGE);
    CHECK(param_set(CYCAN_PID_STATUS_PERIOD(1), CYCAN_PTYPE_U32, 0, &v));
    CHECK_EQ(v.status, CYCAN_PST_OK);
    /* Application validator for non-contiguous enum options. */
    CHECK(param_set(CYCAN_ESC20A_PID_MOTOR_PWM_KHZ, CYCAN_PTYPE_ENUM, 20, &v));
    CHECK_EQ(v.status, CYCAN_PST_OUT_OF_RANGE);
    CHECK(param_set(CYCAN_ESC20A_PID_MOTOR_PWM_KHZ, CYCAN_PTYPE_ENUM, 32, &v));
    CHECK_EQ(v.status, CYCAN_PST_OK);
    CHECK(param_set(CYCAN_ESC20A_PID_VEL_KP, CYCAN_PTYPE_F32, 0x7FC00000u, &v));
    CHECK_EQ(v.status, CYCAN_PST_OUT_OF_RANGE);
    CHECK(param_set(CYCAN_ESC20A_PID_VEL_KP, CYCAN_PTYPE_F32, cycan_f32_bits(0.25f), &v));
    CHECK_EQ(v.status, CYCAN_PST_OK);
    CHECK(esc_p.VEL_KP == 0.25f);
    CHECK(param_set(CYCAN_ESC20A_PID_MOTOR_INVERT, CYCAN_PTYPE_BOOL, 2, &v));
    CHECK_EQ(v.status, CYCAN_PST_OUT_OF_RANGE);
    /* f32 min_nonzero: motor temperature limit 0 (off) or >= 50. */
    CHECK(param_set(CYCAN_ESC20A_PID_LIMITS_MOTOR_TEMP_C, CYCAN_PTYPE_F32, cycan_f32_bits(20.0f), &v));
    CHECK_EQ(v.status, CYCAN_PST_OUT_OF_RANGE);

    /* Locked while an actuator is driven. */
    drive();
    CHECK(param_set(CYCAN_ESC20A_PID_MOTOR_POLE_PAIRS, CYCAN_PTYPE_U32, 8, &v));
    CHECK_EQ(v.status, CYCAN_PST_DENIED_WHILE_ENABLED);
    CHECK_EQ(v.value, 7);
    cycan_set_enabled(&node, false);
    CHECK(param_set(CYCAN_ESC20A_PID_MOTOR_POLE_PAIRS, CYCAN_PTYPE_U32, 8, &v));
    CHECK_EQ(v.status, CYCAN_PST_OK);

    g.pid = CYCAN_ESC20A_PID_VEL_KP;
    cycan_enc_param_get(&f, DT, 1, &g);
    fake_clear(&fk);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    rf = fake_last(&fk, CYCAN_CLS_PARAM_RSP, 0);
    CHECK(rf != NULL && cycan_dec_param_value(rf->data, rf->len, &v));
    CHECK_EQ(v.status, CYCAN_PST_OK);
    CHECK_EQ(v.ptype, CYCAN_PTYPE_F32);
    CHECK_EQ(v.value, cycan_f32_bits(0.25f));
    g.pid = 0x0999;
    cycan_enc_param_get(&f, DT, 1, &g);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    rf = fake_last(&fk, CYCAN_CLS_PARAM_RSP, 0);
    CHECK(rf != NULL && cycan_dec_param_value(rf->data, rf->len, &v) && v.status == CYCAN_PST_UNKNOWN_PARAM);
}

void test_node_save_reboot_defaults(void)
{
    cycan_param_value_t v;
    cycan_frame_t f;
    cycan_name_set_t ns;
    cycan_heartbeat_t hb;
    uint8_t len;
    setup(2);
    CHECK(param_set(CYCAN_ESC20A_PID_POS_KP, CYCAN_PTYPE_F32, cycan_f32_bits(7.5f), &v));
    CHECK(param_set(CYCAN_PID_CAN_DATA_BITRATE, CYCAN_PTYPE_ENUM, 0, &v));
    CHECK_EQ(v.status, CYCAN_PST_OK);
    CHECK_EQ(cycan_data_bitrate(&node), 1); /* reboot required */
    ns.page = 0;
    memcpy(ns.bytes, "Sol on ", 7);
    cycan_enc_name_set(&f, DT, 2, &ns);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_INFO_RSP), 1);

    CHECK_EQ(command(CYCAN_CMD_SAVE_PARAMS, 0, NULL), CYCAN_CMDST_OK);
    run_ms(&node, &now, 600);
    CHECK(last_heartbeat(&hb) && !hb.unsaved);

    reboot_node(&k_esc_app);
    CHECK(esc_p.POS_KP == 7.5f);
    CHECK_EQ(cycan_num(&node), 2);
    CHECK_EQ(cycan_data_bitrate(&node), 0);
    CHECK(memcmp(cycan_name(&node, &len), "Sol on ", 7) == 0 && len == 7);
    run_ms(&node, &now, 600);
    CHECK(last_heartbeat(&hb) && !hb.unsaved);

    CHECK_EQ(command(CYCAN_CMD_LOAD_DEFAULTS, 0, NULL), CYCAN_CMDST_OK);
    CHECK(esc_p.POS_KP == 2.0f);
    CHECK_EQ(esc_p.CAN_DATA_BITRATE, 1);
    CHECK_EQ(cycan_num(&node), 2);
    CHECK(memcmp(cycan_name(&node, NULL), "Sol on", 6) == 0);
    run_ms(&node, &now, 600);
    CHECK(last_heartbeat(&hb) && hb.unsaved);
    /* LOAD_DEFAULTS is RAM only: a reboot without SAVE restores the saved values. */
    reboot_node(&k_esc_app);
    CHECK(esc_p.POS_KP == 7.5f);

    drive();
    CHECK_EQ(command(CYCAN_CMD_LOAD_DEFAULTS, 0, NULL), CYCAN_CMDST_DENIED);

    /* The newest copy damaged: the older one is used, no fault. */
    cycan_set_enabled(&node, false);
    CHECK(param_set(CYCAN_ESC20A_PID_POS_KP, CYCAN_PTYPE_F32, cycan_f32_bits(8.5f), &v));
    CHECK_EQ(command(CYCAN_CMD_SAVE_PARAMS, 0, NULL), CYCAN_CMDST_OK);
    {
        cycan_store_io_t io = {&fk, fk.hal.storage_read, fk.hal.storage_erase, fk.hal.storage_write};
        cycan_store_info_t info;
        CHECK(cycan_store_scan(&io, CYCAN_MODEL_ESC20A, &info));
        fk.region[info.slot][CYCAN_STORE_HEADER + 4] ^= 0x01u;
    }
    reboot_node(&k_esc_app);
    CHECK(esc_p.POS_KP == 7.5f);
    CHECK_EQ(cycan_num(&node), 2);
}

void test_node_status_periods(void)
{
    cycan_param_value_t v;
    const cycan_frame_t *f;
    setup(1);
    run_ms(&node, &now, 1000);
    /* Catalog defaults (PROTOCOL 10.1): 20, 50, 100, 200, 1000 ms. */
    CHECK(fake_count(&fk, CYCAN_CLS_STATUS, 0) >= 49 && fake_count(&fk, CYCAN_CLS_STATUS, 0) <= 51);
    CHECK(fake_count(&fk, CYCAN_CLS_STATUS, 1) >= 19 && fake_count(&fk, CYCAN_CLS_STATUS, 1) <= 21);
    CHECK(fake_count(&fk, CYCAN_CLS_STATUS, 2) >= 9 && fake_count(&fk, CYCAN_CLS_STATUS, 2) <= 11);
    CHECK(fake_count(&fk, CYCAN_CLS_STATUS, 3) >= 4 && fake_count(&fk, CYCAN_CLS_STATUS, 3) <= 6);
    CHECK(fake_count(&fk, CYCAN_CLS_STATUS, 4) >= 1 && fake_count(&fk, CYCAN_CLS_STATUS, 4) <= 2);
    f = fake_find(&fk, CYCAN_CLS_STATUS, 3, 0);
    CHECK(f != NULL && f->len == 8 && f->data[0] == 3 && f->data[7] == 0x5A && f->id == cycan_id_encode(DT, CYCAN_CLS_STATUS, 3, 1));

    CHECK(param_set(CYCAN_PID_STATUS_PERIOD(0), CYCAN_PTYPE_U32, 0, &v));
    CHECK(param_set(CYCAN_PID_STATUS_PERIOD(2), CYCAN_PTYPE_U32, 5, &v));
    fake_clear(&fk);
    run_ms(&node, &now, 1000);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_STATUS, 0), 0);
    CHECK(fake_count(&fk, CYCAN_CLS_STATUS, 2) >= 199 && fake_count(&fk, CYCAN_CLS_STATUS, 2) <= 201);
}

static void stream_cfg(uint8_t num, uint8_t slot, uint16_t sid)
{
    cycan_frame_t f;
    cycan_stream_config_t c;
    c.slot = slot;
    c.sid = sid;
    cycan_enc_stream_config(&f, DT, num, &c);
    to_node(&node, &f);
}

static void stream_start(uint8_t num, uint16_t p100)
{
    cycan_frame_t f;
    cycan_stream_start_t s;
    s.period_100us = p100;
    cycan_enc_stream_start(&f, DT, num, &s);
    to_node(&node, &f);
}

void test_node_stream_fd_and_classic(void)
{
    cycan_param_value_t v;
    cycan_stream_data_t d;
    const cycan_frame_t *f;
    int i;
    setup(1);
    for (i = 0; i < 6; i++) CHECK(param_set((uint16_t)CYCAN_PID_STATUS_PERIOD(i), CYCAN_PTYPE_U32, 0, &v) || i == 5);
    stream_cfg(1, 0, 5);
    stream_cfg(1, 1, 6);
    stream_cfg(1, 2, 99); /* unknown signal: NaN */
    stream_start(1, 10);
    fake_clear(&fk);
    run_ms(&node, &now, 100);
    CHECK(fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0) >= 99);
    f = fake_find(&fk, CYCAN_CLS_STREAM_RSP, 0, 0);
    CHECK(f != NULL && (f->flags & CYCAN_FRAME_FD) != 0u && f->len == 16);
    CHECK(f != NULL && cycan_dec_stream_data(f->data, f->len, &d));
    CHECK_EQ(d.first_slot, 0);
    CHECK(d.values[0] == 7.5f && d.values[1] == 9.0f && isnan(d.values[2]));
    f = fake_find(&fk, CYCAN_CLS_STREAM_RSP, 0, 1);
    {
        cycan_stream_data_t d2;
        CHECK(f != NULL && cycan_dec_stream_data(f->data, f->len, &d2));
        CHECK_EQ((uint8_t)(d2.seq - d.seq), 1);
        CHECK_EQ((uint16_t)(d2.t_100us - d.t_100us), 10);
    }

    /* Keepalive: START every second keeps it running; 2 s of silence stops it. */
    run_ms(&node, &now, 900);
    stream_start(1, 10);
    run_ms(&node, &now, 1900);
    fake_clear(&fk);
    run_ms(&node, &now, 50);
    CHECK(fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0) >= 49);
    run_ms(&node, &now, 100);
    fake_clear(&fk);
    run_ms(&node, &now, 100);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0), 0);

    /* Below the catalog minimum (500 us) is rounded up; STOP stops at once. */
    stream_start(1, 1);
    fake_clear(&fk);
    run_ms(&node, &now, 10);
    CHECK(fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0) >= 9);
    {
        cycan_frame_t s;
        cycan_enc_stream_stop(&s, DT, 1);
        to_node(&node, &s);
    }
    run_ms(&node, &now, 1);
    fake_clear(&fk);
    run_ms(&node, &now, 10);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0), 0);

    /* Classic mode (can.data_bitrate = 0 after reboot): one frame per slot. */
    CHECK(param_set(CYCAN_PID_CAN_DATA_BITRATE, CYCAN_PTYPE_ENUM, 0, &v));
    CHECK_EQ(command(CYCAN_CMD_SAVE_PARAMS, 0, NULL), CYCAN_CMDST_OK);
    reboot_node(&k_esc_app);
    stream_cfg(1, 0, 5);
    stream_cfg(1, 1, 6);
    stream_cfg(1, 2, 7);
    stream_cfg(1, 4, 8); /* gap: slot 4 is ignored while slot 3 is empty */
    stream_start(1, 50);
    run_ms(&node, &now, 1);
    fake_clear(&fk);
    run_ms(&node, &now, 20);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0), 12);
    for (i = 0; i < 3; i++) {
        f = fake_find(&fk, CYCAN_CLS_STREAM_RSP, 0, i);
        CHECK(f != NULL && f->flags == 0u && f->len == 8 && cycan_dec_stream_data(f->data, f->len, &d));
        CHECK_EQ(d.first_slot, i);
        CHECK_EQ(d.count, 1);
        CHECK(d.values[0] == (float)(5 + i) * 1.5f);
    }
}

void test_node_ctrl_timeout(void)
{
    cycan_heartbeat_t hb;
    uint16_t warn;
    int k;
    setup(1);
    drive();
    CHECK_EQ(app_log.ctrl_calls, 1);
    CHECK_EQ(app_log.ctrl_index, 0);
    run_ms(&node, &now, 150);
    send_ctrl();
    run_ms(&node, &now, 150);
    CHECK_EQ(app_log.neutral_calls, 0);
    run_ms(&node, &now, 60);
    CHECK_EQ(app_log.neutral_calls, 1);
    CHECK_EQ(app_log.neutral_reason, CYCAN_NEUTRAL_CTRL_TIMEOUT);
    cycan_fault_get(&node, NULL, NULL, &warn);
    CHECK_EQ(warn, 1u << CYCAN_FAULT_CTRL_TIMEOUT);
    run_ms(&node, &now, 600);
    CHECK(last_heartbeat(&hb) && hb.warning && !hb.enabled && hb.state == CYCAN_STATE_IDLE);
    run_ms(&node, &now, 1000);
    CHECK_EQ(app_log.neutral_calls, 1); /* fires once per loss of control */

    /* Neutral-first after a timeout: the stale target that keeps arriving is ignored and
     * does not clear the warning. */
    send_ctrl();
    run_ms(&node, &now, 1);
    CHECK_EQ(app_log.ctrl_calls, 2);
    CHECK_EQ(app_log.refused, 1);
    cycan_fault_get(&node, NULL, NULL, &warn);
    CHECK_EQ(warn, 1u << CYCAN_FAULT_CTRL_TIMEOUT);
    drive();
    cycan_fault_get(&node, NULL, NULL, &warn);
    CHECK_EQ(warn, 0);
    for (k = 0; k < 6; k++) {
        send_ctrl();
        run_ms(&node, &now, 100);
    }
    CHECK(last_heartbeat(&hb) && !hb.warning && hb.enabled);

    /* Only valid CTRL frames feed the watchdog: empty frames every 50 ms do not keep the
     * last target alive. */
    for (k = 0; k < 10; k++) {
        cycan_frame_t f;
        (void)cycan_frame_finish(&f, cycan_id_encode(DT, CYCAN_CLS_CTRL, 0, 1), 0);
        to_node(&node, &f);
        (void)cycan_frame_finish(&f, cycan_id_encode(DT, CYCAN_CLS_CTRL, 5, 1), 8);
        memset(f.data, 0, 8);
        to_node(&node, &f);
        run_ms(&node, &now, 50);
    }
    CHECK_EQ(app_log.neutral_calls, 2);
    CHECK(!app_log.driving);
}

void test_node_neutral_first(void)
{
    cycan_frame_t f;
    cycan_heartbeat_t hb;
    int calls;
    setup(1);
    /* Power-up: a drive command alone does nothing. */
    send_ctrl();
    run_ms(&node, &now, 1);
    CHECK_EQ(app_log.ctrl_calls, 0);
    CHECK_EQ(app_log.refused, 1);
    run_ms(&node, &now, 600);
    CHECK(last_heartbeat(&hb) && !hb.enabled && hb.state == CYCAN_STATE_IDLE);
    CHECK_EQ(app_log.neutral_calls, 0); /* refused commands do not arm the watchdog either */

    /* Arming is per CTRL index. */
    drive();
    CHECK_EQ(app_log.ctrl_calls, 1);
    ctrl_frame(1, CYCAN_ESC20A_MODE_DUTY, 0.5f);
    run_ms(&node, &now, 1);
    CHECK_EQ(app_log.ctrl_calls, 1);
    ctrl_frame(1, CYCAN_ESC20A_MODE_OFF, 0.0f);
    ctrl_frame(1, CYCAN_ESC20A_MODE_DUTY, 0.5f);
    run_ms(&node, &now, 1);
    CHECK_EQ(app_log.ctrl_calls, 2);
    CHECK_EQ(app_log.ctrl_index, 1);

    /* ESTOP, then CLEAR_ESTOP: the target still flowing must not take effect again. */
    cycan_enc_estop(&f, 0, 0);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK_EQ(command(CYCAN_CMD_CLEAR_ESTOP, 0, NULL), CYCAN_CMDST_OK);
    calls = app_log.ctrl_calls;
    send_ctrl();
    run_ms(&node, &now, 1);
    CHECK_EQ(app_log.ctrl_calls, calls);
    drive();
    CHECK_EQ(app_log.ctrl_calls, calls + 1);

    /* An active fault forces neutral, blocks CTRL while it lasts, and needs a new neutral
     * after it clears. */
    cycan_fault_set(&node, CYCAN_FAULT_OVERTEMP, CYCAN_FAULT_ACTIVE);
    CHECK_EQ(app_log.neutral_reason, CYCAN_NEUTRAL_FAULT);
    CHECK(!cycan_ctrl_allowed(&node));
    calls = app_log.ctrl_calls;
    drive();
    CHECK_EQ(app_log.ctrl_calls, calls);
    run_ms(&node, &now, 600);
    CHECK(last_heartbeat(&hb) && hb.state == CYCAN_STATE_FAULT && !hb.enabled);
    cycan_fault_clear(&node, CYCAN_FAULT_OVERTEMP, CYCAN_FAULT_ACTIVE);
    send_ctrl();
    run_ms(&node, &now, 1);
    CHECK_EQ(app_log.ctrl_calls, calls);
    drive();
    CHECK_EQ(app_log.ctrl_calls, calls + 1);

    /* A fault raised from inside a callback runs neutral() once and leaves it disarmed. */
    CHECK_EQ(command(CYCAN_ESC20A_CMD_SET_POSITION + 0x20u, 0, NULL), CYCAN_CMDST_OK);
    CHECK(!cycan_ctrl_allowed(&node) && !app_log.driving);
    cycan_fault_clear(&node, CYCAN_FAULT_OVERCURRENT, CYCAN_FAULT_ACTIVE);

    /* A changed number neutralizes and disarms too. */
    drive();
    {
        cycan_assign_id_t a;
        a.uid48 = cycan_uid(&node)->uid48;
        a.new_num = 2;
        a.persist = false;
        cycan_enc_assign_id(&f, 0, 0, &a);
        to_node(&node, &f);
        run_ms(&node, &now, 1);
    }
    CHECK_EQ(app_log.neutral_reason, CYCAN_NEUTRAL_UNASSIGNED);
    calls = app_log.ctrl_calls;
    send_ctrl();
    run_ms(&node, &now, 1);
    CHECK_EQ(app_log.ctrl_calls, calls);
}

void test_node_broadcast_ctrl(void)
{
    cycan_frame_t f;
    cycan_ctrl_set_t c;
    setup(1);
    drive();
    c.mode = CYCAN_ESC20A_MODE_DUTY;
    c.flags = 0;
    c.value = 0.9f;
    /* Type broadcast (own DEVTYPE, NUM 0) and bus broadcast (DEVTYPE 0, NUM 0). */
    cycan_enc_ctrl_set(&f, DT, 0, &c);
    to_node(&node, &f);
    cycan_enc_ctrl_set(&f, 0, 0, &c);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK_EQ(app_log.ctrl_calls, 1);
    /* Neither feeds the watchdog. */
    for (int k = 0; k < 6; k++) {
        cycan_enc_ctrl_set(&f, DT, 0, &c);
        to_node(&node, &f);
        run_ms(&node, &now, 50);
    }
    CHECK_EQ(app_log.neutral_reason, CYCAN_NEUTRAL_CTRL_TIMEOUT);
    CHECK_EQ(app_log.ctrl_calls, 1);
}

static void estop_frame(void)
{
    cycan_frame_t f;
    cycan_enc_estop(&f, 0, 0);
    to_node(&node, &f);
}

static void command_frame(uint8_t cmd, uint32_t arg)
{
    cycan_frame_t f;
    cycan_command_t c;
    c.cmd = cmd;
    c.arg = arg;
    cycan_enc_command(&f, DT, cycan_num(&node), &c);
    to_node(&node, &f);
}

void test_node_estop(void)
{
    cycan_frame_t f;
    cycan_heartbeat_t hb;
    uint16_t act, warn;
    int i;
    setup(1);
    drive();
    /* Fill the RX ring: ESTOP must still latch. */
    for (i = 0; i < 20; i++) send_ctrl();
    estop_frame();
    run_ms(&node, &now, 1);
    CHECK(cycan_estop_latched(&node));
    CHECK_EQ(app_log.neutral_reason, CYCAN_NEUTRAL_ESTOP);
    {
        cycan_stats_t s;
        cycan_stats(&node, &s);
        CHECK(s.rx_overruns > 0);
    }
    /* The lost frames show as a CAN_ERR warning that clears after a quiet second. */
    cycan_fault_get(&node, NULL, NULL, &warn);
    CHECK(warn & (1u << CYCAN_FAULT_CAN_ERR));
    i = app_log.ctrl_calls;
    send_ctrl();
    run_ms(&node, &now, 600);
    CHECK_EQ(app_log.ctrl_calls, i);
    CHECK(last_heartbeat(&hb) && hb.state == CYCAN_STATE_ESTOP);
    cycan_fault_get(&node, &act, NULL, NULL);
    CHECK_EQ(act, 1u << CYCAN_FAULT_ESTOP);
    run_ms(&node, &now, 500);
    cycan_fault_get(&node, NULL, NULL, &warn);
    CHECK_EQ(warn & (1u << CYCAN_FAULT_CAN_ERR), 0);

    /* REBOOT / ENTER_BOOTLOADER are refused while latched. */
    CHECK_EQ(command(CYCAN_CMD_REBOOT, 0, NULL), CYCAN_CMDST_DENIED);
    CHECK_EQ(command(CYCAN_CMD_ENTER_BOOTLOADER, intent(), NULL), CYCAN_CMDST_DENIED);

    /* Wrong magic never latches. */
    CHECK_EQ(command(CYCAN_CMD_CLEAR_ESTOP, 0, NULL), CYCAN_CMDST_OK);
    CHECK(!cycan_estop_latched(&node));
    cycan_enc_estop(&f, 0, 0);
    f.data[1] = 0x71;
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK(!cycan_estop_latched(&node));
    drive();
    for (int k = 0; k < 6; k++) {
        send_ctrl();
        run_ms(&node, &now, 100);
    }
    CHECK_EQ(app_log.ctrl_calls, i + 7);
    CHECK(last_heartbeat(&hb) && hb.state == CYCAN_STATE_ACTIVE && hb.enabled);
}

void test_node_estop_order(void)
{
    cycan_command_rsp_t r;
    const cycan_frame_t *rf;
    setup(1);
    /* CLEAR_ESTOP then ESTOP within one poll period: the later ESTOP stays latched. */
    estop_frame();
    run_ms(&node, &now, 1);
    command_frame(CYCAN_CMD_CLEAR_ESTOP, 0);
    estop_frame();
    fake_clear(&fk);
    run_ms(&node, &now, 1);
    CHECK(cycan_estop_latched(&node));
    rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP);
    CHECK(rf != NULL && cycan_dec_command_rsp(rf->data, rf->len, &r) && r.status == CYCAN_CMDST_DENIED);

    /* ESTOP then CLEAR_ESTOP in the same poll: ESTOP wins as well (PROTOCOL 4.7). */
    CHECK_EQ(command(CYCAN_CMD_CLEAR_ESTOP, 0, NULL), CYCAN_CMDST_OK);
    estop_frame();
    command_frame(CYCAN_CMD_CLEAR_ESTOP, 0);
    run_ms(&node, &now, 1);
    CHECK(cycan_estop_latched(&node));
    /* In a later poll the clear works. */
    CHECK_EQ(command(CYCAN_CMD_CLEAR_ESTOP, 0, NULL), CYCAN_CMDST_OK);
    CHECK(!cycan_estop_latched(&node));

    /* A long command running when ESTOP arrives ends with FAILED; its late finish is dropped. */
    CHECK_EQ(command(CYCAN_ESC20A_CMD_MEASURE_MOTOR, 0, NULL), CYCAN_CMDST_IN_PROGRESS);
    fake_clear(&fk);
    estop_frame();
    run_ms(&node, &now, 1);
    rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP);
    CHECK(rf != NULL && cycan_dec_command_rsp(rf->data, rf->len, &r) && r.cmd == CYCAN_ESC20A_CMD_MEASURE_MOTOR &&
          r.status == CYCAN_CMDST_FAILED);
    fake_clear(&fk);
    cycan_command_finish(&node, CYCAN_ESC20A_CMD_MEASURE_MOTOR, CYCAN_CMDST_OK, 1);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP), 0);
    CHECK_EQ(command(CYCAN_ESC20A_CMD_SET_POSITION, 0, NULL), CYCAN_CMDST_OK); /* nothing pending */
}

static uint8_t last_command_rsp(uint8_t cmd)
{
    cycan_command_rsp_t r;
    const cycan_frame_t *rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP);
    if (rf == NULL || !cycan_dec_command_rsp(rf->data, rf->len, &r) || r.cmd != cmd) return 0xFF;
    return r.status;
}

/* PROTOCOL 4.5: a neutral CTRL cancels a running moving command with FAILED; so does any other
 * event that forces the board neutral (here the CTRL timeout). Non-moving commands are kept. */
void test_node_moving_abort(void)
{
    setup(1);
    CHECK_EQ(command(CYCAN_ESC20A_CMD_MEASURE_MOTOR, 0, NULL), CYCAN_CMDST_IN_PROGRESS);
    fake_clear(&fk);
    app_log.neutral_calls = 0;
    send_neutral();
    run_ms(&node, &now, 1);
    CHECK_EQ(last_command_rsp(CYCAN_ESC20A_CMD_MEASURE_MOTOR), CYCAN_CMDST_FAILED);
    CHECK_EQ(app_log.neutral_calls, 1);
    CHECK_EQ(app_log.neutral_reason, CYCAN_NEUTRAL_ABORT);
    /* The neutral command still arms the index: driving works right after. */
    send_ctrl();
    run_ms(&node, &now, 1);
    CHECK(node.enabled);
    send_neutral();
    run_ms(&node, &now, 1);
    /* Late finish is dropped; the next command runs. */
    fake_clear(&fk);
    cycan_command_finish(&node, CYCAN_ESC20A_CMD_MEASURE_MOTOR, CYCAN_CMDST_OK, 1);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP), 0);

    /* CTRL timeout while a moving command runs: FAILED, not a hung command. */
    CHECK_EQ(command(CYCAN_ESC20A_CMD_MEASURE_MOTOR, 0, NULL), CYCAN_CMDST_IN_PROGRESS);
    fake_clear(&fk);
    run_ms(&node, &now, 1000u);
    CHECK_EQ(last_command_rsp(CYCAN_ESC20A_CMD_MEASURE_MOTOR), CYCAN_CMDST_FAILED);
    CHECK_EQ(command(CYCAN_ESC20A_CMD_SET_POSITION, 0, NULL), CYCAN_CMDST_OK);

    /* A command outside moving_cmds is not cancelled by a neutral CTRL. */
    CHECK_EQ(command(CYCAN_ESC20A_CMD_CALIBRATE_PWM, 0, NULL), CYCAN_CMDST_IN_PROGRESS);
    fake_clear(&fk);
    send_neutral();
    run_ms(&node, &now, 1);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP), 0);
    cycan_command_finish(&node, CYCAN_ESC20A_CMD_CALIBRATE_PWM, CYCAN_CMDST_OK, 0);
    CHECK_EQ(last_command_rsp(CYCAN_ESC20A_CMD_CALIBRATE_PWM), CYCAN_CMDST_OK);
}

void test_node_commands(void)
{
    uint32_t result = 0;
    cycan_frame_t f;
    cycan_fault_rsp_t fr;
    const cycan_frame_t *rf;
    setup(1);
    CHECK_EQ(command(CYCAN_ESC20A_CMD_MEASURE_MOTOR, 0, NULL), CYCAN_CMDST_IN_PROGRESS);
    CHECK_EQ(command(CYCAN_ESC20A_CMD_MEASURE_MOTOR, 0, NULL), CYCAN_CMDST_IN_PROGRESS);
    CHECK_EQ(command(CYCAN_ESC20A_CMD_SET_POSITION, 0, NULL), CYCAN_CMDST_DENIED);
    fake_clear(&fk);
    cycan_command_finish(&node, CYCAN_ESC20A_CMD_MEASURE_MOTOR, CYCAN_CMDST_OK, 1234);
    rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP);
    {
        cycan_command_rsp_t r;
        CHECK(rf != NULL && cycan_dec_command_rsp(rf->data, rf->len, &r));
        CHECK(r.cmd == CYCAN_ESC20A_CMD_MEASURE_MOTOR && r.status == CYCAN_CMDST_OK && r.result == 1234);
    }
    CHECK_EQ(command(CYCAN_ESC20A_CMD_SET_POSITION, 0, &result), CYCAN_CMDST_OK);
    CHECK_EQ(result, 42);
    CHECK_EQ(command(CYCAN_CMD_SELF_TEST, 0, &result), CYCAN_CMDST_OK);
    CHECK_EQ(command(0x7F, 0, NULL), CYCAN_CMDST_UNSUPPORTED);

    cycan_fault_set(&node, CYCAN_FAULT_OVERTEMP, CYCAN_FAULT_ACTIVE);
    cycan_fault_clear(&node, CYCAN_FAULT_OVERTEMP, CYCAN_FAULT_ACTIVE);
    cycan_fault_set(&node, CYCAN_FAULT_UNDERVOLT, CYCAN_FAULT_ACTIVE);
    cycan_enc_fault_req(&f, DT, 1);
    fake_clear(&fk);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_FAULT_RSP);
    CHECK(rf != NULL && cycan_dec_fault_rsp(rf->data, rf->len, &fr));
    CHECK_EQ(fr.active, 1u << CYCAN_FAULT_UNDERVOLT);
    CHECK_EQ(fr.sticky, (1u << CYCAN_FAULT_UNDERVOLT) | (1u << CYCAN_FAULT_OVERTEMP));
    CHECK_EQ(command(CYCAN_CMD_CLEAR_FAULTS, 0, NULL), CYCAN_CMDST_OK);
    {
        uint16_t sticky;
        cycan_fault_get(&node, NULL, &sticky, NULL);
        CHECK_EQ(sticky, 1u << CYCAN_FAULT_UNDERVOLT);
    }

    cycan_fault_clear(&node, CYCAN_FAULT_UNDERVOLT, CYCAN_FAULT_ACTIVE);

    /* PROTOCOL 4.5: refused while driving, and nothing touches the flash. */
    drive();
    {
        int erases = fk.erases;
        CHECK_EQ(command(CYCAN_CMD_REBOOT, 0, NULL), CYCAN_CMDST_DENIED);
        CHECK_EQ(command(CYCAN_CMD_ENTER_BOOTLOADER, intent(), NULL), CYCAN_CMDST_DENIED);
        CHECK_EQ(command(CYCAN_CMD_SAVE_PARAMS, 0, NULL), CYCAN_CMDST_DENIED);
        CHECK_EQ(command(CYCAN_CMD_LOAD_DEFAULTS, 0, NULL), CYCAN_CMDST_DENIED);
        CHECK_EQ(command(CYCAN_CMD_LOAD_SAVED, 0, NULL), CYCAN_CMDST_DENIED);
        CHECK(!cycan_save(&node));
        CHECK_EQ(fk.erases, erases);
    }
    cycan_set_enabled(&node, false);

    /* ENTER_BOOTLOADER needs the intent value 0xB0070000 | uid16. */
    CHECK_EQ(command(CYCAN_CMD_ENTER_BOOTLOADER, 0, NULL), CYCAN_CMDST_INVALID_ARG);
    CHECK_EQ(command(CYCAN_CMD_ENTER_BOOTLOADER, intent() ^ 1u, NULL), CYCAN_CMDST_INVALID_ARG);
    /* Studio's recovery broadcast is for starting bootloaders: no reply, no reset. */
    {
        cycan_command_t c;
        c.cmd = CYCAN_CMD_ENTER_BOOTLOADER;
        c.arg = CYCAN_BOOT_RECOVERY_ARG;
        cycan_enc_command(&f, 0, 0, &c);
        fake_clear(&fk);
        to_node(&node, &f);
        run_ms(&node, &now, 20);
        CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP), 0);
        CHECK_EQ(fk.bootloaders, 0);
    }
    CHECK_EQ(command(CYCAN_CMD_ENTER_BOOTLOADER, intent(), NULL), CYCAN_CMDST_OK);
    CHECK_EQ(fk.bootloaders, 0);
    run_ms(&node, &now, 10);
    CHECK_EQ(fk.bootloaders, 1);
    CHECK_EQ(app_log.neutral_reason, CYCAN_NEUTRAL_RESET);
    CHECK_EQ(command(CYCAN_CMD_REBOOT, 0, NULL), CYCAN_CMDST_OK);
    run_ms(&node, &now, 10);
    CHECK_EQ(fk.reboots, 1);
}

void test_node_info_and_misc(void)
{
    cycan_frame_t f;
    cycan_info_req_t ir;
    cycan_info_device_t dev;
    cycan_info_build_t b;
    cycan_info_rsp_t raw;
    cycan_identify_t id;
    cycan_fw_ack_t ack;
    cycan_fw_begin_t fb;
    const cycan_frame_t *rf;
    uint8_t uid[12];
    setup(1);
    ir.page = 0;
    cycan_enc_info_req(&f, DT, 0, &ir); /* type broadcast */
    to_node(&node, &f);
    ir.page = 3;
    cycan_enc_info_req(&f, DT, 1, &ir);
    to_node(&node, &f);
    ir.page = 1;
    cycan_enc_info_req(&f, DT, 1, &ir);
    to_node(&node, &f);
    ir.page = 2;
    cycan_enc_info_req(&f, DT, 1, &ir);
    to_node(&node, &f);
    ir.page = 9;
    cycan_enc_info_req(&f, DT, 1, &ir);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_INFO_RSP), 4);
    rf = fake_find(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_INFO_RSP, 0);
    CHECK(rf != NULL && cycan_dec_info_device(rf->data, rf->len, &dev));
    CHECK(dev.model == CYCAN_MODEL_ESC20A && dev.hw_rev == 3 && dev.proto_major == 1 && dev.catalog_rev == 1 && dev.bootloader_ver == 2);
    rf = fake_find(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_INFO_RSP, 1);
    CHECK(rf != NULL && cycan_dec_info_build(rf->data, rf->len, &b) && b.git_hash == 0xDEADBEEFu && b.build_day == 321 && b.dirty);
    rf = fake_find(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_INFO_RSP, 2);
    CHECK(rf != NULL && cycan_dec_info_rsp(rf->data, rf->len, &raw));
    memcpy(uid, raw.bytes, 7);
    rf = fake_find(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_INFO_RSP, 3);
    CHECK(rf != NULL && cycan_dec_info_rsp(rf->data, rf->len, &raw) && raw.bytes[5] == 0 && raw.bytes[6] == 0);
    memcpy(uid + 7, raw.bytes, 5);
    CHECK(memcmp(uid, fk.uid96, 12) == 0);

    id.uid_form = false;
    id.uid48 = 0;
    id.seconds = 2;
    cycan_enc_identify(&f, DT, 1, &id);
    to_node(&node, &f);
    run_ms(&node, &now, 600);
    {
        cycan_heartbeat_t hb;
        CHECK(cycan_identify_active(&node) && last_heartbeat(&hb) && hb.identify);
    }
    id.seconds = 0;
    cycan_enc_identify(&f, DT, 1, &id);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK(!cycan_identify_active(&node));

    /* FW requests in application mode. */
    fb.size = 100;
    fb.crc32 = 0;
    cycan_enc_fw_begin(&f, DT, 1, &fb);
    fake_clear(&fk);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    rf = fake_last(&fk, CYCAN_CLS_FW_RSP, CYCAN_FW_ACK);
    CHECK(rf != NULL && cycan_dec_fw_ack(rf->data, rf->len, &ack) && ack.status == CYCAN_FWST_WRONG_STATE);

}

void test_node_tx_queue(void)
{
    cycan_stats_t s;
    cycan_frame_t f;
    cycan_info_req_t ir;
    cycan_info_rsp_t r;
    int i, first0 = -1, first3 = -1;
    setup(1);
    /* Controller busy: replies wait in the small queue, the overflow is counted. */
    fk.send_fail = 1000000;
    for (i = 0; i < 24; i++) {
        ir.page = i == 0 ? 0u : 3u;
        cycan_enc_info_req(&f, DT, 1, &ir);
        to_node(&node, &f);
        if (i == 11) run_ms(&node, &now, 1); /* the RX ring holds 15 */
    }
    run_ms(&node, &now, 1);
    cycan_stats(&node, &s);
    CHECK(s.tx_dropped >= 2);
    CHECK_EQ(s.rx_overruns, 0);
    CHECK_EQ(fk.nsent, 0);
    {
        uint16_t warn, sticky;
        cycan_fault_get(&node, NULL, &sticky, &warn);
        CHECK(warn & sticky & (1u << CYCAN_FAULT_CAN_ERR));
    }
    fk.send_fail = 0;
    run_ms(&node, &now, 1);
    /* Order preserved: page 0 leaves before the page 3 replies. */
    for (i = 0; i < fk.nsent; i++) {
        if (CYCAN_ID_CLASS(fk.sent[i].id) != CYCAN_CLS_SYS_RSP || !cycan_dec_info_rsp(fk.sent[i].data, fk.sent[i].len, &r)) continue;
        if (r.page == 0 && first0 < 0) first0 = i;
        if (r.page == 3 && first3 < 0) first3 = i;
    }
    CHECK(first0 >= 0 && first3 > first0);
}

void test_node_cyncoder_table(void)
{
    cycan_param_value_t v;
    now = 0;
    fake_init(&fk, 0x77);
    CHECK_EQ(boot(&k_cyn_app), CYCAN_INIT_STORAGE_BLANK);
    CHECK(cyn_p.ENC_RATIO == 1.0f);
    CHECK_EQ(cyn_p.STATUS_0_PERIOD_MS, 10);
    {
        cycan_frame_t f;
        cycan_assign_id_t a;
        a.uid48 = cycan_uid(&node)->uid48;
        a.new_num = 1;
        a.persist = false;
        cycan_enc_assign_id(&f, 0, 0, &a);
        to_node(&node, &f);
        run_ms(&node, &now, 1);
    }
    /* No ctrl.timeout_ms in a sensor's table. */
    {
        cycan_frame_t f;
        cycan_param_set_t s;
        const cycan_frame_t *rf;
        s.pid = CYCAN_PID_CTRL_TIMEOUT_MS;
        s.ptype = CYCAN_PTYPE_U32;
        s.value = 100;
        cycan_enc_param_set(&f, CYCAN_CYNCODER_DEVTYPE, 1, &s);
        to_node(&node, &f);
        run_ms(&node, &now, 1);
        rf = fake_last(&fk, CYCAN_CLS_PARAM_RSP, 0);
        CHECK(rf != NULL && cycan_dec_param_value(rf->data, rf->len, &v) && v.status == CYCAN_PST_UNKNOWN_PARAM);
    }
    /* No status filler: nothing is sent; no command handler: UNSUPPORTED. */
    fake_clear(&fk);
    run_ms(&node, &now, 100);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_STATUS, 0xFF), 0);
    {
        cycan_frame_t f;
        cycan_command_t c;
        cycan_command_rsp_t r;
        const cycan_frame_t *rf;
        c.cmd = CYCAN_CYNCODER_CMD_ZERO_HERE;
        c.arg = 0;
        cycan_enc_command(&f, CYCAN_CYNCODER_DEVTYPE, 1, &c);
        to_node(&node, &f);
        run_ms(&node, &now, 1);
        rf = fake_last(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP);
        CHECK(rf != NULL && cycan_dec_command_rsp(rf->data, rf->len, &r) && r.status == CYCAN_CMDST_UNSUPPORTED);
    }
    CHECK_EQ(cycan_store_slot_size(&k_cyn_app), 40u + 8u * CYCAN_CYNCODER_PARAM_COUNT + 8u);
}

void test_node_bad_table(void)
{
    static uint32_t a, b;
    static const cycan_param_t dup[] = {
        CYCAN_PARAM_ENTRY(0x100u, CYCAN_PTYPE_U32, 0u, 10u, 1u, 0u, 0u, &a, NULL),
        CYCAN_PARAM_ENTRY(0x100u, CYCAN_PTYPE_U32, 0u, 10u, 1u, 0u, 0u, &b, NULL),
    };
    static const cycan_param_t bad_def[] = {
        CYCAN_PARAM_ENTRY(0x100u, CYCAN_PTYPE_U32, 0u, 10u, 11u, 0u, 0u, &a, NULL),
    };
    cycan_app_t app = k_cyn_app;
    fake_init(&fk, 1);
    app.params = dup;
    app.param_count = 2;
    CHECK_EQ(cycan_init(&node, &app, &fk.hal, NULL, 0), CYCAN_INIT_BAD_TABLE);
    app.params = bad_def;
    app.param_count = 1;
    CHECK_EQ(cycan_init(&node, &app, &fk.hal, NULL, 0), CYCAN_INIT_BAD_TABLE);
}

/* ---- Rules added with the neutral-first / A-B store revision -------------------- */

void test_node_boot_heartbeat(void)
{
    cycan_heartbeat_t hb;
    int first = -1, i;
    setup(3); /* NUM 3 persisted */
    reboot_node(&k_esc_app);
    for (i = 0; i < 700 && fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT) < 2; i++) {
        run_ms(&node, &now, 1);
        if (first < 0 && fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT) == 1) first = i;
    }
    /* PROTOCOL 4.1: first heartbeat within 100 ms with state BOOT, then the real state. */
    CHECK(first >= 0 && first < (int)CYCAN_BOOT_HEARTBEAT_MAX_MS);
    {
        const cycan_frame_t *f = fake_find(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT, 0);
        CHECK(f != NULL && cycan_dec_heartbeat(f->data, f->len, &hb) && hb.state == CYCAN_STATE_BOOT);
    }
    CHECK(last_heartbeat(&hb) && hb.state == CYCAN_STATE_IDLE);
    CHECK(!hb.unsaved);

    /* A board assigned at run time never claims BOOT: the host already holds its data. */
    setup(CYCAN_NUM_UNASSIGNED);
    {
        cycan_frame_t f;
        cycan_assign_id_t a;
        a.uid48 = cycan_uid(&node)->uid48;
        a.new_num = 8;
        a.persist = false;
        cycan_enc_assign_id(&f, 0, 0, &a);
        to_node(&node, &f);
        run_ms(&node, &now, 100);
    }
    CHECK(last_heartbeat(&hb) && hb.state == CYCAN_STATE_IDLE);
}

void test_node_assign_while_driving(void)
{
    cycan_frame_t f;
    cycan_assign_id_t a;
    int writes;
    setup(4);
    drive();
    writes = fk.writes;
    a.uid48 = cycan_uid(&node)->uid48;
    a.new_num = 4;
    a.persist = true;
    cycan_enc_assign_id(&f, 0, 0, &a);
    fake_clear(&fk);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    /* Persistent assignment erases flash: refused while driving, without confirmation. */
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 0);
    CHECK_EQ(fk.writes, writes);
    CHECK(app_log.driving);
    /* Non-persistent to the same number is harmless and confirmed. */
    a.persist = false;
    cycan_enc_assign_id(&f, 0, 0, &a);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_ENUM_RSP, 0xFF), 1);
    CHECK(app_log.driving);
}

void test_node_load_saved_and_unsaved(void)
{
    cycan_param_value_t v;
    cycan_heartbeat_t hb;
    cycan_frame_t f;
    cycan_name_set_t ns;
    setup(2);
    run_ms(&node, &now, 600);
    CHECK(last_heartbeat(&hb) && !hb.unsaved); /* blank store: defaults are what is "saved" */

    /* UNSAVED compares with the stored copy: setting a value back clears it. */
    CHECK(param_set(CYCAN_ESC20A_PID_POS_KP, CYCAN_PTYPE_F32, cycan_f32_bits(3.0f), &v));
    CHECK(cycan_unsaved(&node));
    CHECK(param_set(CYCAN_ESC20A_PID_POS_KP, CYCAN_PTYPE_F32, cycan_f32_bits(2.0f), &v));
    CHECK(!cycan_unsaved(&node));
    CHECK_EQ(command(CYCAN_CMD_LOAD_DEFAULTS, 0, NULL), CYCAN_CMDST_OK);
    CHECK(!cycan_unsaved(&node));

    CHECK(param_set(CYCAN_ESC20A_PID_POS_KP, CYCAN_PTYPE_F32, cycan_f32_bits(3.0f), &v));
    ns.page = 1;
    memcpy(ns.bytes, "abcdefg", 7);
    cycan_enc_name_set(&f, DT, 2, &ns);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK_EQ(command(CYCAN_CMD_SAVE_PARAMS, 0, NULL), CYCAN_CMDST_OK);
    CHECK(!cycan_unsaved(&node));

    /* LOAD_SAVED drops RAM changes (values and name) and runs on_change. */
    CHECK(param_set(CYCAN_ESC20A_PID_POS_KP, CYCAN_PTYPE_F32, cycan_f32_bits(4.0f), &v));
    ns.page = 1;
    memcpy(ns.bytes, "zzzzzzz", 7);
    cycan_enc_name_set(&f, DT, 2, &ns);
    to_node(&node, &f);
    run_ms(&node, &now, 1);
    CHECK(cycan_unsaved(&node));
    g_changes = 0;
    CHECK_EQ(command(CYCAN_CMD_LOAD_SAVED, 0, NULL), CYCAN_CMDST_OK);
    CHECK(esc_p.POS_KP == 3.0f);
    CHECK(memcmp(cycan_name(&node, NULL) + 7, "abcdefg", 7) == 0);
    CHECK(!cycan_unsaved(&node));
    CHECK(g_changes >= 1);
    CHECK_EQ(cycan_num(&node), 2);

    /* With both copies destroyed LOAD_SAVED fails and leaves RAM alone. */
    memset(fk.region[0] + 8, 0, 8);
    memset(fk.region[1] + 8, 0, 8);
    CHECK_EQ(command(CYCAN_CMD_LOAD_SAVED, 0, NULL), CYCAN_CMDST_FAILED);
    CHECK(esc_p.POS_KP == 3.0f);
}

/* Saved state S1 = (NUM 4, POS_KP 7.5, name "old"), then an operation interrupted after
 * `cut` programmed bytes. Every cut must boot into S1 or into the operation's result. */
static int power_cut_run(int op, long cut, int extra_saves, long *total)
{
    cycan_param_value_t v;
    cycan_frame_t f;
    cycan_name_set_t ns;
    int i, outcome;
    setup(4);
    ns.page = 0;
    memcpy(ns.bytes, "old    ", 7);
    cycan_enc_name_set(&f, DT, 4, &ns);
    to_node(&node, &f);
    CHECK(param_set(CYCAN_ESC20A_PID_POS_KP, CYCAN_PTYPE_F32, cycan_f32_bits(7.5f), &v));
    for (i = 0; i <= extra_saves; i++) CHECK_EQ(command(CYCAN_CMD_SAVE_PARAMS, 0, NULL), CYCAN_CMDST_OK);
    CHECK(param_set(CYCAN_ESC20A_PID_POS_KP, CYCAN_PTYPE_F32, cycan_f32_bits(9.0f), &v));

    fk.programmed = 0;
    fk.cut_budget = cut;
    if (op == 0) {
        (void)cycan_save(&node);
    } else {
        cycan_assign_id_t a;
        a.uid48 = cycan_uid(&node)->uid48;
        a.new_num = 9;
        a.persist = true;
        cycan_enc_assign_id(&f, 0, 0, &a);
        to_node(&node, &f);
        run_ms(&node, &now, 1);
    }
    if (total != NULL) *total = fk.programmed;
    fk.cut_budget = -1;
    fk.dead = false;

    /* Power back on. */
    now += 1000000u;
    CHECK_EQ(boot(&k_esc_app), CYCAN_INIT_OK);
    CHECK(memcmp(cycan_name(&node, NULL), "old", 3) == 0);
    if (op == 0) {
        CHECK_EQ(cycan_num(&node), 4);
        CHECK(esc_p.POS_KP == 7.5f || esc_p.POS_KP == 9.0f);
        outcome = esc_p.POS_KP == 9.0f;
    } else {
        /* Only NUM changes; the unsaved RAM value is never persisted by ASSIGN_ID. */
        CHECK(esc_p.POS_KP == 7.5f);
        CHECK(cycan_num(&node) == 4 || cycan_num(&node) == 9);
        outcome = cycan_num(&node) == 9;
    }
    return outcome;
}

void test_node_store_power_cut(void)
{
    int op, extra;
    for (op = 0; op < 2; op++) {
        for (extra = 0; extra < 2; extra++) {
            long total = 0, cut;
            int news = 0;
            CHECK_EQ(power_cut_run(op, -1, extra, &total), 1);
            CHECK(total > 40);
            for (cut = 0; cut <= total; cut++) news += power_cut_run(op, cut, extra, NULL);
            /* Only the complete write commits (its last 8 bytes are the commit block). */
            CHECK_EQ(news, 1);
        }
    }
}

void test_node_store_both_corrupt(void)
{
    cycan_param_value_t v;
    cycan_heartbeat_t hb;
    uint16_t act;
    cycan_frame_t f;
    cycan_assign_id_t a;
    setup(6);
    CHECK(param_set(CYCAN_ESC20A_PID_MOTOR_INVERT, CYCAN_PTYPE_BOOL, 1, &v));
    CHECK_EQ(command(CYCAN_CMD_SAVE_PARAMS, 0, NULL), CYCAN_CMDST_OK);
    fk.region[0][CYCAN_STORE_HEADER + 1] ^= 0x40u;
    fk.region[1][CYCAN_STORE_HEADER + 1] ^= 0x40u;
    reboot_node(&k_esc_app);
    CHECK_EQ(boot(&k_esc_app), CYCAN_INIT_STORAGE_CORRUPT);
    /* Defaults (motor direction lost), unassigned so the old number cannot drive it. */
    CHECK_EQ(esc_p.MOTOR_INVERT, 0);
    CHECK_EQ(cycan_num(&node), CYCAN_NUM_UNASSIGNED);
    cycan_fault_get(&node, &act, NULL, NULL);
    CHECK_EQ(act, 1u << CYCAN_FAULT_PARAM_CRC);
    run_ms(&node, &now, 600);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT), 0);

    /* Once assigned it reports FAULT and refuses CTRL until the operator saves or clears. */
    a.uid48 = cycan_uid(&node)->uid48;
    a.new_num = 6;
    a.persist = false;
    cycan_enc_assign_id(&f, 0, 0, &a);
    to_node(&node, &f);
    run_ms(&node, &now, 600);
    CHECK(last_heartbeat(&hb) && hb.state == CYCAN_STATE_FAULT && hb.unsaved);
    drive();
    CHECK_EQ(app_log.ctrl_calls, 0);
    CHECK_EQ(command(CYCAN_CMD_CLEAR_FAULTS, 0, NULL), CYCAN_CMDST_OK);
    cycan_fault_get(&node, &act, NULL, NULL);
    CHECK_EQ(act, 0);
    drive();
    CHECK_EQ(app_log.ctrl_calls, 1);

    /* SAVE_PARAMS also clears it, and writes a fresh valid copy. */
    reboot_node(&k_esc_app);
    CHECK_EQ(boot(&k_esc_app), CYCAN_INIT_STORAGE_CORRUPT);
    {
        cycan_frame_t g;
        cycan_enc_assign_id(&g, 0, 0, &a);
        to_node(&node, &g);
        run_ms(&node, &now, 1);
    }
    CHECK_EQ(command(CYCAN_CMD_SAVE_PARAMS, 0, NULL), CYCAN_CMDST_OK);
    cycan_fault_get(&node, &act, NULL, NULL);
    CHECK_EQ(act, 0);
    reboot_node(&k_esc_app);
    CHECK_EQ(boot(&k_esc_app), CYCAN_INIT_OK);
}

void test_node_time_wrap(void)
{
    cycan_param_value_t v;
    const cycan_frame_t *f;
    cycan_stream_data_t d, prev;
    int i, n, hbs = 0, first = -1, last = -1;
    bool steady = true;
    now = 0xFFFFFFFFu - 1500000u; /* 1.5 s before the 32-bit wrap */
    fake_init(&fk, 0x10);
    (void)boot(&k_esc_app);
    {
        cycan_frame_t g;
        cycan_assign_id_t a;
        a.uid48 = cycan_uid(&node)->uid48;
        a.new_num = 1;
        a.persist = false;
        cycan_enc_assign_id(&g, 0, 0, &a);
        to_node(&node, &g);
        run_ms(&node, &now, 1);
    }
    for (i = 0; i < 6; i++) (void)param_set((uint16_t)CYCAN_PID_STATUS_PERIOD(i), CYCAN_PTYPE_U32, 0, &v);
    stream_cfg(1, 0, 5);
    stream_start(1, 10);
    drive();
    fake_clear(&fk);
    for (i = 0; i < 3000; i++) {
        int before = fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT);
        if (i % 100 == 0) {
            send_ctrl();
            stream_start(1, 10);
        }
        run_ms(&node, &now, 1);
        if (fake_count(&fk, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT) != before) {
            if (first >= 0 && (i - last) != 500) steady = false;
            if (first < 0) first = i;
            last = i;
            hbs++;
        }
    }
    CHECK(steady);
    CHECK(hbs >= 5);
    CHECK_EQ(app_log.neutral_calls, 0); /* the watchdog did not fire across the wrap */
    /* t_100us advances by exactly 10 per 1 ms sample, also across the wrap. */
    n = fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0);
    CHECK(n >= 2990);
    f = fake_find(&fk, CYCAN_CLS_STREAM_RSP, 0, 0);
    CHECK(f != NULL && cycan_dec_stream_data(f->data, f->len, &prev));
    for (i = 1; i < n; i++) {
        f = fake_find(&fk, CYCAN_CLS_STREAM_RSP, 0, i);
        if (f == NULL || !cycan_dec_stream_data(f->data, f->len, &d)) break;
        if ((uint16_t)(d.t_100us - prev.t_100us) != 10u) {
            CHECK_EQ((uint16_t)(d.t_100us - prev.t_100us), 10);
            break;
        }
        prev = d;
    }
    /* And the watchdog still fires after the wrap. */
    run_ms(&node, &now, 250);
    CHECK_EQ(app_log.neutral_reason, CYCAN_NEUTRAL_CTRL_TIMEOUT);
    CHECK_EQ(app_log.neutral_calls, 1);
}

void test_node_stream_classic_and_rounding(void)
{
    cycan_param_value_t v;
    cycan_stream_data_t d;
    const cycan_frame_t *f;
    int i;
    setup(1);
    for (i = 0; i < 6; i++) (void)param_set((uint16_t)CYCAN_PID_STATUS_PERIOD(i), CYCAN_PTYPE_U32, 0, &v);
    /* Rounded to the nearest multiple of the 500 us minimum: 1.2 ms -> 1 ms, 1.3 ms -> 1.5 ms. */
    stream_cfg(1, 0, 5);
    stream_start(1, 12);
    run_ms(&node, &now, 1);
    fake_clear(&fk);
    run_ms(&node, &now, 100);
    CHECK(fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0) >= 99 && fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0) <= 101);
    stream_start(1, 13);
    run_ms(&node, &now, 1);
    fake_clear(&fk);
    run_ms(&node, &now, 300);
    /* 1.5 ms polled every 1 ms: 200 samples in 300 ms. */
    CHECK(fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0) >= 199 && fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0) <= 201);

    /* Classic mode streams at most 4 slots (PROTOCOL 8). */
    CHECK(param_set(CYCAN_PID_CAN_DATA_BITRATE, CYCAN_PTYPE_ENUM, 0, &v));
    CHECK_EQ(command(CYCAN_CMD_SAVE_PARAMS, 0, NULL), CYCAN_CMDST_OK);
    reboot_node(&k_esc_app);
    for (i = 0; i < 8; i++) stream_cfg(1, (uint8_t)i, (uint16_t)(1 + i));
    stream_start(1, 100);
    run_ms(&node, &now, 1);
    fake_clear(&fk);
    run_ms(&node, &now, 100);
    CHECK_EQ(fake_count(&fk, CYCAN_CLS_STREAM_RSP, 0), 40);
    for (i = 0; i < 40; i++) {
        f = fake_find(&fk, CYCAN_CLS_STREAM_RSP, 0, i);
        CHECK(f != NULL && cycan_dec_stream_data(f->data, f->len, &d) && d.first_slot < 4u);
    }
    {
        cycan_stats_t s;
        cycan_stats(&node, &s);
        CHECK_EQ(s.tx_dropped, 0);
    }
}
