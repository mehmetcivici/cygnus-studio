#include "cycan.h"

#include <string.h>

/* Keeps the compiler from moving ring-slot writes past the index store that publishes them.
 * Cortex-M issues normal memory accesses in order, so a compiler barrier is sufficient. */
#if defined(__GNUC__)
#define CYCAN_BARRIER() __asm__ __volatile__("" ::: "memory")
#else
#define CYCAN_BARRIER() ((void)0)
#endif

#define RX_MASK ((uint8_t)(CYCAN_RX_QUEUE_LEN - 1u))
#define MS(x) ((uint32_t)((uint32_t)(x) * 1000u))
#define BIT(b) ((uint16_t)(1u << (b)))

typedef char cycan_rxq_is_power_of_2[(CYCAN_RX_QUEUE_LEN & (CYCAN_RX_QUEUE_LEN - 1u)) == 0u ? 1 : -1];
typedef char cycan_rxq_fits_u8[CYCAN_RX_QUEUE_LEN <= 128u ? 1 : -1];
typedef char cycan_txq_fits_u8[CYCAN_TX_QUEUE_LEN >= 1u && CYCAN_TX_QUEUE_LEN <= 255u ? 1 : -1];

/* Wrap-safe "t has come": valid while now and t are less than 2^31 us apart. */
static bool due(uint32_t now, uint32_t t)
{
    return (int32_t)(now - t) >= 0;
}

/* ---- Small helpers --------------------------------------------------------------- */

static bool silent(const cycan_node_t *n)
{
    return n->num == CYCAN_NUM_UNASSIGNED || n->conflict;
}

static uint32_t rnd(cycan_node_t *n)
{
    if (n->hal->random != NULL) return n->hal->random(n->hal->ctx);
    /* No entropy source: fall back on UID and time, still differs between boards. */
    return (uint32_t)n->uid.uid48 ^ (n->now * 2654435761ul);
}

/* Every event that forces the board neutral also disarms CTRL: driving resumes only after a
 * fresh neutral command (PROTOCOL 7, neutral-first rule). */
static void neutral(cycan_node_t *n, cycan_neutral_reason_t why)
{
    n->ctrl_armed = 0;
    n->ctrl_watch = false;
    n->enabled = false;
    if (n->in_neutral || n->app->neutral == NULL) return;
    n->in_neutral = true; /* neutral() may raise a fault, which would land here again */
    n->app->neutral(n, why);
    n->in_neutral = false;
}

static cycan_store_io_t store_io(const cycan_node_t *n)
{
    cycan_store_io_t io;
    io.ctx = n->hal->ctx;
    io.read = n->hal->storage_read;
    io.erase = n->hal->storage_erase;
    io.write = n->hal->storage_write;
    return io;
}

static bool has_storage(const cycan_hal_t *h)
{
    return h->storage_read != NULL && h->storage_erase != NULL && h->storage_write != NULL;
}

/* ---- Transmit -------------------------------------------------------------------- */

static void tx_flush(cycan_node_t *n)
{
    while (n->tx_count > 0u) {
        if (!n->hal->can_send(n->hal->ctx, &n->txq[n->tx_head])) return;
        n->tx_head = (uint8_t)((n->tx_head + 1u) % CYCAN_TX_QUEUE_LEN);
        n->tx_count--;
    }
}

static void send(cycan_node_t *n, const cycan_frame_t *f)
{
    if (n->tx_count == 0u && n->hal->can_send(n->hal->ctx, f)) return;
    if (n->tx_count >= CYCAN_TX_QUEUE_LEN) {
        n->tx_dropped++;
        return;
    }
    n->txq[(n->tx_head + n->tx_count) % CYCAN_TX_QUEUE_LEN] = *f;
    n->tx_count++;
}

/* ---- Parameters ------------------------------------------------------------------ */

static const cycan_param_t *find_param(const cycan_app_t *app, uint16_t pid, int16_t *index)
{
    uint16_t i;
    for (i = 0; i < app->param_count; i++) {
        if (app->params[i].pid == pid) {
            if (index != NULL) *index = (int16_t)i;
            return &app->params[i];
        }
    }
    return NULL;
}

static cycan_pval_t pval_load(const cycan_param_t *p)
{
    cycan_pval_t v;
    memcpy(&v, p->value, 4);
    return v;
}

static void pval_store(const cycan_param_t *p, cycan_pval_t v)
{
    memcpy(p->value, &v, 4);
}

static uint32_t abs_i32(int32_t v)
{
    return v < 0 ? 0u - (uint32_t)v : (uint32_t)v;
}

static bool in_range(cycan_node_t *n, const cycan_param_t *p, cycan_pval_t v)
{
    switch (p->ptype) {
    case CYCAN_PTYPE_U32:
    case CYCAN_PTYPE_ENUM:
        if (v.u32 < p->min.u32 || v.u32 > p->max.u32) return false;
        if (p->min_nonzero.u32 != 0u && v.u32 != 0u && v.u32 < p->min_nonzero.u32) return false;
        break;
    case CYCAN_PTYPE_I32:
        if (v.i32 < p->min.i32 || v.i32 > p->max.i32) return false;
        if (p->min_nonzero.i32 != 0 && v.i32 != 0 && abs_i32(v.i32) < abs_i32(p->min_nonzero.i32)) return false;
        break;
    case CYCAN_PTYPE_F32: {
        float a = v.f32 < 0.0f ? -v.f32 : v.f32;
        if (v.f32 != v.f32) return false;
        if (v.f32 < p->min.f32 || v.f32 > p->max.f32) return false;
        if (p->min_nonzero.f32 != 0.0f && v.f32 != 0.0f && a < p->min_nonzero.f32) return false;
        break;
    }
    case CYCAN_PTYPE_BOOL:
        if (v.u32 > 1u) return false;
        break;
    default:
        return false;
    }
    return n == NULL || n->app->param_validate == NULL || n->app->param_validate(n, p, v);
}

/* CRC of what SAVE_PARAMS would store (name + values); UNSAVED compares it with the copy
 * that is in the store (PROTOCOL 5: "changes not yet saved", not "SET was called"). */
static void touch(cycan_node_t *n)
{
    uint8_t b[6];
    uint16_t i;
    uint32_t crc = cycan_crc32((const uint8_t *)n->name, CYCAN_NAME_BYTES);
    for (i = 0; i < n->app->param_count; i++) {
        cycan_wr_u16(b, n->app->params[i].pid);
        cycan_wr_u32(b + 2, pval_load(&n->app->params[i]).u32);
        crc = cycan_crc32_update(crc, b, sizeof b);
    }
    n->ram_crc = crc;
}

/* Library side effects of a changed common parameter. */
static void param_changed(cycan_node_t *n, const cycan_param_t *p)
{
    if (p->pid >= CYCAN_PID_STATUS_PERIOD(0) && p->pid < CYCAN_PID_STATUS_PERIOD(CYCAN_STATUS_MAX))
        n->status_next[p->pid - CYCAN_PID_STATUS_PERIOD(0)] = n->now;
    if (p->on_change != NULL) p->on_change(n, p);
}

static uint8_t param_write(cycan_node_t *n, uint16_t pid, uint8_t ptype, cycan_pval_t v, const cycan_param_t **out)
{
    const cycan_param_t *p = find_param(n->app, pid, NULL);
    *out = p;
    if (p == NULL) return CYCAN_PST_UNKNOWN_PARAM;
    if (ptype != p->ptype) return CYCAN_PST_TYPE_MISMATCH;
    if ((p->flags & CYCAN_PF_READ_ONLY) != 0u) return CYCAN_PST_READ_ONLY;
    if ((p->flags & CYCAN_PF_LOCKED_WHILE_ENABLED) != 0u && n->enabled) return CYCAN_PST_DENIED_WHILE_ENABLED;
    if (!in_range(n, p, v)) return CYCAN_PST_OUT_OF_RANGE;
    if (pval_load(p).u32 != v.u32) {
        pval_store(p, v);
        touch(n);
        param_changed(n, p);
    }
    return CYCAN_PST_OK;
}

static void load_defaults(cycan_node_t *n, bool notify)
{
    uint16_t i;
    for (i = 0; i < n->app->param_count; i++) {
        const cycan_param_t *p = &n->app->params[i];
        if (pval_load(p).u32 != p->def.u32) {
            pval_store(p, p->def);
            if (notify) param_changed(n, p);
        }
    }
}

static uint32_t param_u32(const cycan_node_t *n, int16_t idx, uint32_t fallback)
{
    return idx < 0 ? fallback : pval_load(&n->app->params[idx]).u32;
}

/* ---- Persistence ----------------------------------------------------------------- */

uint32_t cycan_store_slot_size(const cycan_app_t *app)
{
    return CYCAN_STORE_SLOT_SIZE(app->param_count);
}

static cycan_init_result_t store_scan(const cycan_node_t *n, cycan_store_info_t *info)
{
    cycan_store_io_t io = store_io(n);
    if (!has_storage(n->hal)) {
        memset(info, 0, sizeof *info);
        info->slot = -1;
        info->num = CYCAN_NUM_UNASSIGNED;
        return CYCAN_INIT_STORAGE_BLANK;
    }
    if (cycan_store_scan(&io, n->app->model, info)) return CYCAN_INIT_OK;
    return cycan_store_corrupt(info) ? CYCAN_INIT_STORAGE_CORRUPT : CYCAN_INIT_STORAGE_BLANK;
}

/* Defaults first, then the stored records: records the table no longer has, or whose type or
 * range no longer fits it, keep their default, so a firmware update never loads an invalid
 * value. Read-only values describe the hardware and always come from the table. The copy's
 * CRC was checked by the scan, so a torn write is never half applied. */
static void apply_store(cycan_node_t *n, const cycan_store_info_t *info)
{
    cycan_store_io_t io = store_io(n);
    uint8_t rec[CYCAN_STORE_RECORD];
    uint16_t i;
    for (i = 0; i < n->app->param_count; i++) pval_store(&n->app->params[i], n->app->params[i].def);
    memset(n->name, 0, sizeof n->name);
    if (info->slot < 0) return;
    memcpy(n->name, info->name, CYCAN_NAME_BYTES);
    for (i = 0; i < info->count; i++) {
        const cycan_param_t *p;
        cycan_pval_t v;
        if (!cycan_store_record(&io, info, i, rec)) break;
        p = find_param(n->app, cycan_rd_u16(rec), NULL);
        v.u32 = cycan_rd_u32(rec + 4);
        if (p == NULL || p->ptype != rec[2] || (p->flags & CYCAN_PF_READ_ONLY) != 0u || !in_range(n, p, v)) continue;
        pval_store(p, v);
    }
}

static bool ram_rec(void *src, uint16_t i, uint8_t rec[8])
{
    const cycan_node_t *n = (const cycan_node_t *)src;
    const cycan_param_t *p = &n->app->params[i];
    cycan_wr_u16(rec, p->pid);
    rec[2] = p->ptype;
    rec[3] = 0;
    cycan_wr_u32(rec + 4, pval_load(p).u32);
    return true;
}

bool cycan_save(cycan_node_t *n)
{
    cycan_store_io_t io = store_io(n);
    cycan_store_info_t cur;
    if (!has_storage(n->hal) || n->enabled) return false;
    (void)cycan_store_scan(&io, n->app->model, &cur);
    /* The stored NUM, not the RAM one: a non-persistent ASSIGN_ID stays non-persistent. */
    if (!cycan_store_write(&io, &cur, n->app->model, n->stored_num, n->name, n->app->param_count, ram_rec, n)) return false;
    n->saved_crc = n->ram_crc;
    cycan_fault_clear(n, CYCAN_FAULT_PARAM_CRC, CYCAN_FAULT_ACTIVE);
    return true;
}

static uint8_t load_saved(cycan_node_t *n)
{
    cycan_store_info_t info;
    uint16_t i;
    if (store_scan(n, &info) == CYCAN_INIT_STORAGE_CORRUPT) return CYCAN_CMDST_FAILED;
    apply_store(n, &info);
    for (i = 0; i < n->app->param_count; i++) param_changed(n, &n->app->params[i]);
    touch(n);
    n->saved_crc = n->ram_crc;
    return CYCAN_CMDST_OK;
}

/* ---- Outgoing messages ----------------------------------------------------------- */

/* `ack` = confirmation of ASSIGN_ID: it must leave within 50 ms (PROTOCOL 3.3), so it uses
 * the ordinary TX queue instead of the randomized discovery back-off. */
static void send_enum_rsp(cycan_node_t *n, bool ack)
{
    cycan_frame_t f;
    cycan_enum_rsp_t m;
    m.uid48 = n->uid.uid48;
    m.num = n->num;
    m.conflict = n->conflict;
    m.bootloader = false;
    m.model = n->app->model;
    cycan_enc_enum_rsp(&f, n->app->devtype, &m);
    if (ack) {
        send(n, &f);
        return;
    }
    n->enum_pending = false;
    if (!n->hal->can_send(n->hal->ctx, &f) && !n->enum_retried) {
        /* Same-delay boards collide; back off randomly once instead of queueing (PROTOCOL 3.2). */
        n->enum_retried = true;
        n->enum_pending = true;
        n->enum_due = n->now + MS(rnd(n) % (CYCAN_ENUM_RETRY_MAX_MS + 1u));
    }
}

static uint8_t state_of(const cycan_node_t *n)
{
    if (n->boot_heartbeat) return CYCAN_STATE_BOOT;
    if (n->estop) return CYCAN_STATE_ESTOP;
    if (n->fault_active != 0u) return CYCAN_STATE_FAULT;
    return n->enabled ? CYCAN_STATE_ACTIVE : CYCAN_STATE_IDLE;
}

static void send_heartbeat(cycan_node_t *n)
{
    cycan_frame_t f;
    cycan_heartbeat_t m;
    m.state = state_of(n);
    m.unsaved = cycan_unsaved(n);
    m.enabled = n->enabled;
    m.warning = n->fault_warn != 0u;
    m.identify = n->identify_on;
    m.fault = n->fault_active;
    m.uid16 = n->uid.uid16;
    m.fw_major = n->app->fw_major;
    m.fw_minor = n->app->fw_minor;
    m.fw_patch = n->app->fw_patch;
    cycan_enc_heartbeat(&f, n->app->devtype, n->num, &m);
    send(n, &f);
    n->boot_heartbeat = false;
}

static void send_command_rsp(cycan_node_t *n, uint8_t cmd, uint8_t status, uint32_t result)
{
    cycan_frame_t f;
    cycan_command_rsp_t m;
    m.cmd = cmd;
    m.status = status;
    m.result = result;
    cycan_enc_command_rsp(&f, n->app->devtype, n->num, &m);
    send(n, &f);
}

static void send_param_value(cycan_node_t *n, uint16_t pid, const cycan_param_t *p, uint8_t ptype, uint8_t status)
{
    cycan_frame_t f;
    cycan_param_value_t m;
    m.pid = pid;
    m.ptype = p != NULL ? p->ptype : ptype;
    m.status = status;
    m.value = p != NULL ? pval_load(p).u32 : 0u;
    cycan_enc_param_value(&f, n->app->devtype, n->num, &m);
    send(n, &f);
}

static void send_info(cycan_node_t *n, uint8_t page)
{
    cycan_frame_t f;
    const cycan_app_t *a = n->app;
    if (page == CYCAN_INFO_DEVICE) {
        cycan_info_device_t m;
        m.model = a->model;
        m.hw_rev = a->hw_rev;
        m.proto_major = CYCAN_PROTO_MAJOR;
        m.proto_minor = CYCAN_PROTO_MINOR;
        m.catalog_rev = a->catalog_rev;
        m.bootloader_ver = a->bootloader_ver;
        cycan_enc_info_device(&f, a->devtype, n->num, &m);
    } else if (page == CYCAN_INFO_BUILD) {
        cycan_info_build_t m;
        m.git_hash = a->git_hash;
        m.build_day = a->build_day;
        m.dirty = a->build_dirty;
        cycan_enc_info_build(&f, a->devtype, n->num, &m);
    } else {
        cycan_info_rsp_t m;
        memset(&m, 0, sizeof m);
        m.page = page;
        if (page == CYCAN_INFO_UID_LO) memcpy(m.bytes, n->uid96, 7);
        else if (page == CYCAN_INFO_UID_HI) memcpy(m.bytes, n->uid96 + 7, 5);
        else if (page >= CYCAN_INFO_NAME_0 && page <= CYCAN_INFO_NAME_2) memcpy(m.bytes, n->name + 7u * (page - CYCAN_INFO_NAME_0), 7);
        else return; /* unknown page: no answer */
        cycan_enc_info_rsp(&f, a->devtype, n->num, &m);
    }
    send(n, &f);
}

static void send_fault_rsp(cycan_node_t *n)
{
    cycan_frame_t f;
    cycan_fault_rsp_t m;
    m.active = n->fault_active;
    m.sticky = n->fault_sticky;
    m.warn = n->fault_warn;
    cycan_enc_fault_rsp(&f, n->app->devtype, n->num, &m);
    send(n, &f);
}

/* ---- Request handlers ------------------------------------------------------------ */

static void identify(cycan_node_t *n, uint8_t seconds)
{
    if (seconds == 0u) {
        if (n->identify_on && n->hal->led_set != NULL) n->hal->led_set(n->hal->ctx, false);
        n->identify_on = false;
        return;
    }
    n->identify_on = true;
    n->identify_end = n->now + MS(1000u * seconds);
    n->identify_next = n->now;
    n->identify_led = false;
}

static void latch_estop(cycan_node_t *n)
{
    /* PROTOCOL 4.5: a long command running when ESTOP arrives ends with FAILED. The
     * application aborts it in neutral(ESTOP); a later cycan_command_finish() is ignored. */
    if (n->cmd_pending) {
        n->cmd_pending = false;
        if (!silent(n)) send_command_rsp(n, n->cmd_code, CYCAN_CMDST_FAILED, 0);
    }
    if (n->estop) return;
    n->estop = true;
    cycan_fault_set(n, CYCAN_FAULT_ESTOP, CYCAN_FAULT_ACTIVE);
    neutral(n, CYCAN_NEUTRAL_ESTOP);
}

/* ESTOPs counted by the RX interrupt but not latched yet. */
static void check_estop(cycan_node_t *n)
{
    uint8_t seq = n->estop_seq;
    if (seq == n->estop_seen) return;
    n->estop_seen = seq;
    n->estop_this_turn = true;
    latch_estop(n);
}

/* PROTOCOL 3.4: announce the conflict with a CONFLICT-flagged ENUM_RSP after 0..20 ms so the
 * other holder of this address goes silent too; all of them wait for ASSIGN_ID. */
static void enter_conflict(cycan_node_t *n)
{
    if (n->conflict) return;
    n->conflict = true;
    n->stream_active = false;
    neutral(n, CYCAN_NEUTRAL_CONFLICT);
    n->enum_pending = true;
    n->enum_retried = false;
    n->enum_due = n->now + MS(rnd(n) % (CYCAN_CONFLICT_ANNOUNCE_MAX_MS + 1u));
}

static void on_assign(cycan_node_t *n, const cycan_assign_id_t *m)
{
    uint8_t old = n->num;
    bool was_silent = silent(n);
    if (m->uid48 != n->uid.uid48 || m->new_num < CYCAN_NUM_MIN || m->new_num > CYCAN_NUM_UNASSIGNED) return;
    /* A persistent assignment erases flash, which stalls the CPU (and a motor's commutation)
     * on single-bank parts: refused while driving, without confirmation, so the host's
     * retries run out and it reports the failure. */
    if (m->persist && n->enabled) return;
    n->num = m->new_num;
    /* A silent board is already neutral (CONFLICT did that); an active one changing its
     * address loses its controller, so it stops driving and streaming. */
    if (!was_silent && old != n->num) {
        n->stream_active = false;
        neutral(n, CYCAN_NEUTRAL_UNASSIGNED);
    }
    n->conflict = false;
    n->enum_pending = false;
    n->boot_heartbeat = false;
    send_enum_rsp(n, true);
    /* Persist after the confirmation is on its way: the flash erase may block for tens of ms. */
    if (m->persist && has_storage(n->hal)) {
        cycan_store_io_t io = store_io(n);
        if (cycan_store_set_num(&io, n->app->model, n->num)) n->stored_num = n->num;
    }
    n->hb_next = n->now + MS(n->hb_phase_ms);
}

static uint8_t reset_command(cycan_node_t *n, const cycan_command_t *m)
{
    if (n->enabled || n->estop) return CYCAN_CMDST_DENIED;
    if (m->cmd == CYCAN_CMD_ENTER_BOOTLOADER && m->arg != (CYCAN_BOOT_INTENT | n->uid.uid16)) return CYCAN_CMDST_INVALID_ARG;
    if ((m->cmd == CYCAN_CMD_REBOOT ? n->hal->reboot : n->hal->enter_bootloader) == NULL) return CYCAN_CMDST_UNSUPPORTED;
    n->reset_pending = m->cmd;
    n->reset_at = n->now + CYCAN_RESET_DELAY_US;
    return CYCAN_CMDST_OK;
}

static void on_command(cycan_node_t *n, const cycan_command_t *m, bool broadcast, uint8_t estop_seq)
{
    uint32_t result = 0;
    uint8_t st;
    switch (m->cmd) {
    case CYCAN_CMD_ENTER_BOOTLOADER:
        /* Studio's recovery broadcast (PROTOCOL 9.0) is meant for bootloaders that are
         * starting up; running applications ignore it without a reply. */
        if (broadcast && m->arg == CYCAN_BOOT_RECOVERY_ARG) return;
        st = reset_command(n, m);
        break;
    case CYCAN_CMD_REBOOT:
        st = reset_command(n, m);
        break;
    case CYCAN_CMD_SAVE_PARAMS:
        st = n->enabled ? CYCAN_CMDST_DENIED : cycan_save(n) ? CYCAN_CMDST_OK : CYCAN_CMDST_FAILED;
        break;
    case CYCAN_CMD_LOAD_DEFAULTS:
        if (n->enabled) {
            st = CYCAN_CMDST_DENIED;
        } else {
            load_defaults(n, true);
            touch(n);
            st = CYCAN_CMDST_OK;
        }
        break;
    case CYCAN_CMD_LOAD_SAVED:
        st = n->enabled ? CYCAN_CMDST_DENIED : load_saved(n);
        break;
    case CYCAN_CMD_CLEAR_FAULTS:
        /* PARAM_CRC is latched by the library, not a live condition: clearing faults is the
         * operator's acknowledgement that the defaults are in use. */
        cycan_fault_clear(n, CYCAN_FAULT_PARAM_CRC, CYCAN_FAULT_ACTIVE);
        n->fault_sticky = n->fault_active;
        st = CYCAN_CMDST_OK;
        break;
    case CYCAN_CMD_CLEAR_ESTOP:
        /* PROTOCOL 4.7: an ESTOP latched in this poll, or one that arrived after this
         * CLEAR_ESTOP was queued, wins. */
        if (n->estop_this_turn || estop_seq != n->estop_seen) {
            st = CYCAN_CMDST_DENIED;
        } else {
            if (n->estop) {
                n->estop = false;
                cycan_fault_clear(n, CYCAN_FAULT_ESTOP, CYCAN_FAULT_ACTIVE);
                n->ctrl_armed = 0; /* the target that was flowing before ESTOP must not resume */
            }
            st = CYCAN_CMDST_OK;
        }
        break;
    default:
        if (n->cmd_pending) {
            /* A repeat of the running command (host retry after a lost reply) gets the
             * progress answer again; anything else waits for it to finish. */
            st = m->cmd == n->cmd_code ? CYCAN_CMDST_IN_PROGRESS : CYCAN_CMDST_DENIED;
        } else if (n->app->command == NULL) {
            st = CYCAN_CMDST_UNSUPPORTED;
        } else {
            st = n->app->command(n, m->cmd, m->arg, &result);
            if (st == CYCAN_CMDST_IN_PROGRESS) {
                n->cmd_pending = true;
                n->cmd_code = m->cmd;
                result = 0;
            }
        }
        break;
    }
    send_command_rsp(n, m->cmd, st, result);
}

static void stream_recount(cycan_node_t *n)
{
    uint8_t k = 0;
    while (k < CYCAN_STREAM_SLOTS && n->stream_sid[k] != CYCAN_STREAM_SID_CLEAR) k++;
    n->stream_slots = k;
}

/* PROTOCOL 8: unsupported periods round to the nearest supported one, i.e. the nearest
 * multiple of the catalog's minimum period. */
static uint32_t stream_period(const cycan_node_t *n, uint16_t period_100us)
{
    uint32_t step = n->app->stream_min_period_us > 100u ? n->app->stream_min_period_us : 100u;
    uint32_t p = (uint32_t)period_100us * 100u;
    if (p <= step) return step;
    return (p + step / 2u) / step * step;
}

static void on_stream(cycan_node_t *n, uint8_t index, const uint8_t *d, uint8_t len)
{
    if (index == CYCAN_STREAM_CONFIG) {
        cycan_stream_config_t m;
        if (!cycan_dec_stream_config(d, len, &m) || m.slot >= CYCAN_STREAM_SLOTS) return;
        n->stream_sid[m.slot] = m.sid;
        stream_recount(n);
    } else if (index == CYCAN_STREAM_START) {
        cycan_stream_start_t m;
        uint32_t period;
        if (!cycan_dec_stream_start(d, len, &m)) return;
        period = stream_period(n, m.period_100us);
        if (!n->stream_active || period != n->stream_period_us) {
            n->stream_active = true;
            n->stream_period_us = period;
            n->stream_next = n->now;
        }
        n->stream_keepalive = n->now;
    } else if (index == CYCAN_STREAM_STOP) {
        n->stream_active = false;
    }
}

static void on_fw(cycan_node_t *n)
{
    cycan_frame_t f;
    cycan_fw_ack_t m;
    m.status = CYCAN_FWST_WRONG_STATE;
    m.window = 0;
    m.next_offset = 0;
    cycan_enc_fw_ack(&f, n->app->devtype, n->num, &m);
    send(n, &f);
}

static void on_ctrl(cycan_node_t *n, uint32_t id, uint8_t index, const uint8_t *d, uint8_t len)
{
    uint16_t bit = BIT(index);
    bool armed;
    cycan_ctrl_t r;
    /* PROTOCOL 7: CTRL is addressed to one board; both broadcast forms are ignored. */
    if (CYCAN_ID_NUM(id) == CYCAN_NUM_BROADCAST || CYCAN_ID_DEVTYPE(id) == CYCAN_DEVTYPE_BROADCAST) return;
    if (n->app->ctrl == NULL || !cycan_ctrl_allowed(n)) return;
    armed = (n->ctrl_armed & bit) != 0u;
    r = n->app->ctrl(n, index, d, len, armed);
    /* Only valid frames feed the watchdog: garbage at our address must not keep a stale
     * target alive. A drive command before the neutral one is ignored altogether. */
    if (r == CYCAN_CTRL_INVALID || (r == CYCAN_CTRL_DRIVE && !armed)) return;
    if (!cycan_ctrl_allowed(n)) return; /* the callback raised a fault */
    if (r == CYCAN_CTRL_NEUTRAL) n->ctrl_armed |= bit;
    n->ctrl_watch = true;
    n->ctrl_last = n->now;
    cycan_fault_clear(n, CYCAN_FAULT_CTRL_TIMEOUT, CYCAN_FAULT_WARN);
}

static void on_sys(cycan_node_t *n, uint32_t id, uint8_t index, const uint8_t *d, uint8_t len, uint8_t estop_seq)
{
    switch (index) {
    case CYCAN_SYS_ENUM_REQ: {
        cycan_enum_req_t m;
        if (!cycan_dec_enum_req(d, len, &m)) return;
        if (m.filter == CYCAN_ENUM_FILTER_UNASSIGNED && !silent(n)) return;
        if (!n->enum_pending) {
            n->enum_pending = true;
            n->enum_retried = false;
            n->enum_due = n->now + MS(n->uid.enum_delay_ms);
        }
        return;
    }
    case CYCAN_SYS_ASSIGN_ID: {
        cycan_assign_id_t m;
        if (cycan_dec_assign_id(d, len, &m)) on_assign(n, &m);
        return;
    }
    case CYCAN_SYS_IDENTIFY: {
        cycan_identify_t m;
        if (!cycan_dec_identify(d, len, &m)) return;
        if (m.uid_form ? m.uid48 == n->uid.uid48 : !silent(n)) identify(n, m.seconds);
        return;
    }
    default:
        break;
    }
    if (silent(n)) return;
    switch (index) {
    case CYCAN_SYS_INFO_REQ: {
        cycan_info_req_t m;
        if (cycan_dec_info_req(d, len, &m)) send_info(n, m.page);
        break;
    }
    case CYCAN_SYS_NAME_SET: {
        cycan_name_set_t m;
        if (!cycan_dec_name_set(d, len, &m) || m.page > 2u) return;
        memcpy(n->name + 7u * m.page, m.bytes, 7);
        touch(n);
        send_info(n, (uint8_t)(CYCAN_INFO_NAME_0 + m.page));
        break;
    }
    case CYCAN_SYS_COMMAND: {
        cycan_command_t m;
        if (cycan_dec_command(d, len, &m)) on_command(n, &m, CYCAN_ID_NUM(id) == CYCAN_NUM_BROADCAST, estop_seq);
        break;
    }
    case CYCAN_SYS_FAULT_REQ:
        send_fault_rsp(n);
        break;
    default:
        break;
    }
}

static void on_param(cycan_node_t *n, uint8_t index, const uint8_t *d, uint8_t len)
{
    if (index == CYCAN_PARAM_GET) {
        cycan_param_get_t m;
        const cycan_param_t *p;
        if (!cycan_dec_param_get(d, len, &m)) return;
        p = find_param(n->app, m.pid, NULL);
        send_param_value(n, m.pid, p, 0, (uint8_t)(p != NULL ? CYCAN_PST_OK : CYCAN_PST_UNKNOWN_PARAM));
    } else if (index == CYCAN_PARAM_SET) {
        cycan_param_set_t m;
        const cycan_param_t *p;
        cycan_pval_t v;
        uint8_t st;
        if (!cycan_dec_param_set(d, len, &m)) return;
        v.u32 = m.value;
        st = param_write(n, m.pid, m.ptype, v, &p);
        send_param_value(n, m.pid, p, m.ptype, st);
    }
}

static void handle(cycan_node_t *n, const cycan_rx_entry_t *e)
{
    uint32_t id = e->id;
    uint8_t cls = CYCAN_ID_CLASS(id), index = CYCAN_ID_INDEX(id);

    if (cls == CYCAN_CLS_ENUM_RSP) {
        cycan_enum_rsp_t er;
        if (CYCAN_ID_DEVTYPE(id) == n->app->devtype && !silent(n) && cycan_dec_enum_rsp(e->data, e->len, &er) &&
            er.num == n->num && er.uid48 != n->uid.uid48)
            enter_conflict(n);
        return;
    }
    if (cls == CYCAN_CLS_SYS_RSP) {
        cycan_heartbeat_t hb;
        if (index == CYCAN_SYS_HEARTBEAT && CYCAN_ID_DEVTYPE(id) == n->app->devtype && CYCAN_ID_NUM(id) == n->num &&
            !silent(n) && cycan_dec_heartbeat(e->data, e->len, &hb) && hb.uid16 != n->uid.uid16)
            enter_conflict(n);
        return;
    }
    /* Re-check: NUM may have changed since the RX interrupt accepted the frame. */
    if (!cycan_accepts(id, n->app->devtype, n->num)) return;
    if (cls == CYCAN_CLS_SYS_REQ) {
        on_sys(n, id, index, e->data, e->len, e->estop_seq);
        return;
    }
    if (silent(n)) return;
    switch (cls) {
    case CYCAN_CLS_CTRL:
        on_ctrl(n, id, index, e->data, e->len);
        break;
    case CYCAN_CLS_PARAM_REQ:
        on_param(n, index, e->data, e->len);
        break;
    case CYCAN_CLS_STREAM_REQ:
        on_stream(n, index, e->data, e->len);
        break;
    case CYCAN_CLS_FW_REQ:
        on_fw(n);
        break;
    default:
        break;
    }
}

/* ---- Periodic work --------------------------------------------------------------- */

static void run_status(cycan_node_t *n)
{
    uint8_t i;
    for (i = 0; i < n->app->status_count && i < CYCAN_STATUS_MAX; i++) {
        uint32_t period = MS(param_u32(n, n->idx_status[i], 0));
        cycan_frame_t f;
        if (period == 0u || !due(n->now, n->status_next[i])) continue;
        n->status_next[i] += period;
        if (due(n->now, n->status_next[i])) n->status_next[i] = n->now + period;
        memset(f.data, 0, 8);
        if (n->app->status_fill == NULL || !n->app->status_fill(n, i, f.data)) continue;
        (void)cycan_frame_finish(&f, cycan_id_encode(n->app->devtype, CYCAN_CLS_STATUS, i, n->num), 8);
        send(n, &f);
    }
}

static void run_stream(cycan_node_t *n)
{
    cycan_stream_data_t m;
    cycan_frame_t f;
    uint8_t i, slots;
    if (!n->stream_active) return;
    if ((n->now - n->stream_keepalive) > MS(CYCAN_STREAM_TIMEOUT_MS)) {
        n->stream_active = false;
        return;
    }
    /* Classic mode sends a frame per slot; more than 4 would not fit the bus (PROTOCOL 8). */
    slots = n->stream_slots;
    if (!n->fd_active && slots > CYCAN_STREAM_CLASSIC_MAX_SLOTS) slots = CYCAN_STREAM_CLASSIC_MAX_SLOTS;
    if (slots == 0u || !due(n->now, n->stream_next)) return;
    n->stream_next += n->stream_period_us;
    if (due(n->now, n->stream_next)) n->stream_next = n->now + n->stream_period_us;

    for (i = 0; i < slots; i++) {
        if (n->app->signal_read == NULL || !n->app->signal_read(n, n->stream_sid[i], &m.values[i]))
            m.values[i] = cycan_bits_f32(0x7FC00000ul);
    }
    m.seq = n->stream_seq++;
    m.t_100us = n->t100;
    if (n->fd_active) {
        m.first_slot = 0;
        m.count = slots;
        if (cycan_enc_stream_data(&f, n->app->devtype, n->num, &m)) send(n, &f);
        return;
    }
    for (i = 0; i < slots; i++) {
        cycan_stream_data_t one;
        one.seq = m.seq;
        one.t_100us = m.t_100us;
        one.first_slot = i;
        one.count = 1;
        one.values[0] = m.values[i];
        if (cycan_enc_stream_data(&f, n->app->devtype, n->num, &one)) send(n, &f);
    }
}

static void run_identify(cycan_node_t *n)
{
    if (!n->identify_on) return;
    if (due(n->now, n->identify_end)) {
        identify(n, 0);
        return;
    }
    if (due(n->now, n->identify_next)) {
        n->identify_led = !n->identify_led;
        n->identify_next = n->now + MS(100);
        if (n->hal->led_set != NULL) n->hal->led_set(n->hal->ctx, n->identify_led);
    }
}

/* Lost frames are otherwise invisible to the host: show them as a CAN_ERR warning (sticky
 * too, so a brief loss is still visible in FAULT_RSP). */
static void check_losses(cycan_node_t *n)
{
    uint16_t ov = n->rx_overruns;
    if (ov != n->seen_overruns || n->tx_dropped != n->seen_dropped) {
        n->seen_overruns = ov;
        n->seen_dropped = n->tx_dropped;
        cycan_fault_set(n, CYCAN_FAULT_CAN_ERR, CYCAN_FAULT_WARN);
        n->fault_sticky |= BIT(CYCAN_FAULT_CAN_ERR);
        n->can_err_held = true;
        n->can_err_until = n->now + MS(CYCAN_CAN_ERR_HOLD_MS);
    } else if (n->can_err_held && due(n->now, n->can_err_until)) {
        n->can_err_held = false;
        cycan_fault_clear(n, CYCAN_FAULT_CAN_ERR, CYCAN_FAULT_WARN);
    }
}

/* t_100us from its own accumulator: (uint16_t)(now / 100) would jump at the 32-bit wrap,
 * because 2^32 / 100 is not a multiple of 65536. */
static void advance_time(cycan_node_t *n, uint32_t now_us)
{
    uint32_t d = now_us - n->now;
    uint32_t r = d % 100u + n->t100_rem;
    n->t100 = (uint16_t)(n->t100 + (uint16_t)(d / 100u) + (uint16_t)(r / 100u));
    n->t100_rem = (uint8_t)(r % 100u);
    n->now = now_us;
}

/* ---- Public API ------------------------------------------------------------------ */

cycan_init_result_t cycan_init(cycan_node_t *n, const cycan_app_t *app, const cycan_hal_t *hal, void *user, uint32_t now_us)
{
    cycan_init_result_t res;
    cycan_store_info_t info;
    uint16_t i, j;
    int16_t idx;

    memset(n, 0, sizeof *n);
    n->app = app;
    n->hal = hal;
    n->user = user;
    n->now = now_us;
    n->num = CYCAN_NUM_UNASSIGNED;
    n->stored_num = CYCAN_NUM_UNASSIGNED;
    if (hal->uid96 != NULL) hal->uid96(hal->ctx, n->uid96);
    cycan_uid_derive(n->uid96, &n->uid);
    /* Spread heartbeats of boards powered up together (PROTOCOL 4.1: 0..50 ms phase). */
    n->hb_phase_ms = (uint16_t)(n->uid.uid16 % (CYCAN_HEARTBEAT_PHASE_MAX_MS + 1u));
    for (i = 0; i < CYCAN_STREAM_SLOTS; i++) n->stream_sid[i] = CYCAN_STREAM_SID_CLEAR;

    for (i = 0; i < app->param_count; i++) {
        const cycan_param_t *p = &app->params[i];
        if (p->value == NULL || !in_range(NULL, p, p->def)) return CYCAN_INIT_BAD_TABLE;
        for (j = 0; j < i; j++)
            if (app->params[j].pid == p->pid) return CYCAN_INIT_BAD_TABLE;
    }
    n->idx_ctrl_timeout = find_param(app, CYCAN_PID_CTRL_TIMEOUT_MS, &idx) != NULL ? idx : -1;
    for (i = 0; i < CYCAN_STATUS_MAX; i++)
        n->idx_status[i] = find_param(app, (uint16_t)CYCAN_PID_STATUS_PERIOD(i), &idx) != NULL ? idx : -1;

    res = store_scan(n, &info);
    apply_store(n, &info);
    n->num = n->stored_num = info.num;
    touch(n);
    n->saved_crc = n->ram_crc;
    if (res == CYCAN_INIT_STORAGE_CORRUPT) {
        /* Neither copy survived: settings are back to defaults, which may be wrong for this
         * machine (motor direction, limits). The board comes up unassigned so it cannot be
         * driven under its old number, and in FAULT until SAVE_PARAMS or CLEAR_FAULTS. */
        n->fault_active |= BIT(CYCAN_FAULT_PARAM_CRC);
        n->fault_sticky |= BIT(CYCAN_FAULT_PARAM_CRC);
        n->saved_crc = ~n->ram_crc;
    }

    /* can.data_bitrate is reboot-required: the value loaded now stays in effect. */
    n->data_bitrate = (uint8_t)(find_param(app, CYCAN_PID_CAN_DATA_BITRATE, &idx) != NULL ? param_u32(n, idx, 0) : 0u);
    n->fd_active = app->fd_capable && n->data_bitrate != CYCAN_DATA_BITRATE_CLASSIC && CYCAN_FRAME_MAX_DATA >= 64u;
    /* PROTOCOL 4.1: the first heartbeat after power-up says BOOT, within 100 ms. */
    n->boot_heartbeat = !silent(n);
    n->hb_next = now_us + MS(n->hb_phase_ms);
    for (i = 0; i < CYCAN_STATUS_MAX; i++) n->status_next[i] = now_us;
    for (i = 0; i < app->param_count; i++)
        if (app->params[i].on_change != NULL) app->params[i].on_change(n, &app->params[i]);
    return res;
}

bool cycan_on_frame(cycan_node_t *n, uint32_t id, const uint8_t *data, uint8_t len)
{
    uint8_t head, next, cls;
    cycan_rx_entry_t *e;
    if (!cycan_is_cycan_id(id)) return false;
    cls = CYCAN_ID_CLASS(id);
    if (cls == CYCAN_CLS_SYS_RSP) {
        /* Other boards' heartbeats from our own address: conflict detection input. */
        if (CYCAN_ID_INDEX(id) != CYCAN_SYS_HEARTBEAT || CYCAN_ID_DEVTYPE(id) != n->app->devtype || CYCAN_ID_NUM(id) != n->num)
            return false;
    } else if (cls == CYCAN_CLS_ENUM_RSP) {
        /* ENUM_RSP ids carry hash10, not NUM: the NUM check needs the payload (in poll). */
        if (CYCAN_ID_DEVTYPE(id) != n->app->devtype || len < 8u || (data[6] & 0x3Fu) != n->num) return false;
    } else if (!cycan_accepts(id, n->app->devtype, n->num)) {
        return false;
    } else if (cls == CYCAN_CLS_SYS_REQ && CYCAN_ID_INDEX(id) == CYCAN_SYS_ESTOP) {
        /* Counted outside the ring so a full queue can never swallow it; the count also
         * orders it against CLEAR_ESTOP frames already in the ring. */
        if (!cycan_dec_estop(data, len)) return false;
        n->estop_seq = (uint8_t)(n->estop_seq + 1u);
        return true;
    }
    head = n->rx_head;
    next = (uint8_t)((head + 1u) & RX_MASK);
    if (next == n->rx_tail) {
        n->rx_overruns++;
        return false;
    }
    e = &n->rxq[head];
    e->id = id;
    e->estop_seq = n->estop_seq;
    /* Node-bound messages fit in 8 bytes; a longer (FD) frame is only answered, not parsed. */
    e->len = len > 8u ? 8u : len;
    memcpy(e->data, data, e->len);
    CYCAN_BARRIER();
    n->rx_head = next;
    return true;
}

void cycan_on_tx_error(cycan_node_t *n, uint32_t id)
{
    if (id == cycan_enum_rsp_id(n->app->devtype, n->uid.hash10)) n->enum_tx_err = 1;
}

void cycan_poll(cycan_node_t *n, uint32_t now_us)
{
    advance_time(n, now_us);
    tx_flush(n);

    n->estop_this_turn = false;
    check_estop(n);
    if (n->enum_tx_err) {
        n->enum_tx_err = 0;
        if (!n->enum_retried && !n->enum_pending) {
            n->enum_retried = true;
            n->enum_pending = true;
            n->enum_due = n->now + MS(rnd(n) % (CYCAN_ENUM_RETRY_MAX_MS + 1u));
        }
    }
    while (n->rx_tail != n->rx_head) {
        cycan_rx_entry_t e = n->rxq[n->rx_tail];
        CYCAN_BARRIER();
        n->rx_tail = (uint8_t)((n->rx_tail + 1u) & RX_MASK);
        handle(n, &e);
    }
    check_estop(n); /* one that arrived while the ring was processed */

    if (n->ctrl_watch) {
        uint32_t timeout = MS(param_u32(n, n->idx_ctrl_timeout, CYCAN_CTRL_TIMEOUT_DEFAULT_MS));
        if ((n->now - n->ctrl_last) > timeout) {
            cycan_fault_set(n, CYCAN_FAULT_CTRL_TIMEOUT, CYCAN_FAULT_WARN);
            neutral(n, CYCAN_NEUTRAL_CTRL_TIMEOUT);
        }
    }
    if (n->enum_pending && due(n->now, n->enum_due)) send_enum_rsp(n, false);
    check_losses(n);

    if (!silent(n)) {
        if (due(n->now, n->hb_next)) {
            send_heartbeat(n);
            n->hb_next += MS(CYCAN_HEARTBEAT_MS);
            if (due(n->now, n->hb_next)) n->hb_next = n->now + MS(CYCAN_HEARTBEAT_MS);
        }
        run_status(n);
        run_stream(n);
    }
    run_identify(n);

    if (n->reset_pending != 0u && due(n->now, n->reset_at) && n->tx_count == 0u) {
        uint8_t what = n->reset_pending;
        n->reset_pending = 0;
        neutral(n, CYCAN_NEUTRAL_RESET);
        if (what == CYCAN_CMD_REBOOT) n->hal->reboot(n->hal->ctx);
        else n->hal->enter_bootloader(n->hal->ctx);
    }
}

void *cycan_user(const cycan_node_t *n)
{
    return n->user;
}

uint8_t cycan_num(const cycan_node_t *n)
{
    return n->num;
}

const cycan_uid_t *cycan_uid(const cycan_node_t *n)
{
    return &n->uid;
}

uint8_t cycan_data_bitrate(const cycan_node_t *n)
{
    return n->data_bitrate;
}

bool cycan_ctrl_allowed(const cycan_node_t *n)
{
    return !silent(n) && !n->estop && n->fault_active == 0u;
}

bool cycan_estop_latched(const cycan_node_t *n)
{
    return n->estop;
}

bool cycan_identify_active(const cycan_node_t *n)
{
    return n->identify_on;
}

bool cycan_unsaved(const cycan_node_t *n)
{
    return n->ram_crc != n->saved_crc;
}

const char *cycan_name(const cycan_node_t *n, uint8_t *len)
{
    uint8_t k = 0;
    while (k < CYCAN_NAME_BYTES && n->name[k] != '\0') k++;
    if (len != NULL) *len = k;
    return n->name;
}

void cycan_set_enabled(cycan_node_t *n, bool enabled)
{
    n->enabled = enabled && cycan_ctrl_allowed(n);
}

void cycan_fault_set(cycan_node_t *n, uint8_t bit, cycan_fault_kind_t kind)
{
    uint16_t m = BIT(bit & 15u);
    bool fresh;
    if (kind == CYCAN_FAULT_WARN) {
        n->fault_warn |= m;
        return;
    }
    fresh = (n->fault_active & m) == 0u;
    n->fault_active |= m;
    n->fault_sticky |= m;
    /* ESTOP has its own neutral reason (latch_estop). */
    if (fresh && (bit & 15u) != CYCAN_FAULT_ESTOP) neutral(n, CYCAN_NEUTRAL_FAULT);
}

void cycan_fault_clear(cycan_node_t *n, uint8_t bit, cycan_fault_kind_t kind)
{
    uint16_t m = (uint16_t)~BIT(bit & 15u);
    if (kind == CYCAN_FAULT_WARN) n->fault_warn &= m;
    else n->fault_active &= m;
}

void cycan_fault_get(const cycan_node_t *n, uint16_t *active, uint16_t *sticky, uint16_t *warn)
{
    if (active != NULL) *active = n->fault_active;
    if (sticky != NULL) *sticky = n->fault_sticky;
    if (warn != NULL) *warn = n->fault_warn;
}

void cycan_command_finish(cycan_node_t *n, uint8_t cmd, uint8_t status, uint32_t result)
{
    if (!n->cmd_pending || cmd != n->cmd_code) return;
    n->cmd_pending = false;
    if (!silent(n)) send_command_rsp(n, cmd, status, result);
}

bool cycan_param_get(const cycan_node_t *n, uint16_t pid, cycan_pval_t *out)
{
    const cycan_param_t *p = find_param(n->app, pid, NULL);
    if (p == NULL) return false;
    *out = pval_load(p);
    return true;
}

uint8_t cycan_param_set(cycan_node_t *n, uint16_t pid, uint8_t ptype, cycan_pval_t v)
{
    const cycan_param_t *p;
    return param_write(n, pid, ptype, v, &p);
}

void cycan_stats(const cycan_node_t *n, cycan_stats_t *out)
{
    out->rx_overruns = n->rx_overruns;
    out->tx_dropped = n->tx_dropped;
}
