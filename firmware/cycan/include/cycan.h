/*
 * CyCAN v1 board (node) side.
 *
 * The library implements the whole protocol of docs/PROTOCOL.md for one board: discovery,
 * address assignment and conflict handling, heartbeat, identify, info pages, names,
 * parameters with persistence, status scheduling, streaming, faults, ESTOP, the CTRL
 * watchdog and common commands. The port supplies a small HAL (cycan_hal_t) and the board
 * firmware an application table (cycan_app_t).
 *
 * Execution model
 * - cycan_on_frame() may be called from the CAN RX interrupt. It only filters the id and
 *   copies the frame into a single-producer / single-consumer ring (plus a latched ESTOP
 *   flag that survives a full ring). It calls no HAL or application callback.
 * - cycan_on_tx_error() may also be called from an interrupt; it only sets a flag.
 * - Everything else (cycan_poll() and every other API function) must run in one context,
 *   normally the main loop or a 1 kHz task. Every HAL and application callback is invoked
 *   from cycan_poll() or from the API function the application called, never from
 *   cycan_on_frame(). No function is reentrant with itself; callbacks must not call
 *   cycan_poll().
 * - Time is passed in as a free-running 32-bit microsecond counter (wraps every ~71 min;
 *   all comparisons are wrap safe). Call cycan_poll() at least every 1 ms; boards that
 *   stream faster than 1 kHz must poll at least as often as their stream period.
 *
 * Memory: no dynamic allocation and no globals; all state lives in cycan_node_t. The
 * application and parameter tables are const and can live in flash.
 */
#ifndef CYCAN_H
#define CYCAN_H

#include <stdbool.h>
#include <stdint.h>

#include "cycan_codec.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---- Build-time sizing ----------------------------------------------------------- */

#ifndef CYCAN_RX_QUEUE_LEN
#define CYCAN_RX_QUEUE_LEN 8u /* power of two, <= 128 */
#endif
#ifndef CYCAN_TX_QUEUE_LEN
#define CYCAN_TX_QUEUE_LEN 4u /* frames held while the controller's TX FIFO is full */
#endif
#ifndef CYCAN_STATUS_MAX
#define CYCAN_STATUS_MAX 16u /* STATUS frame numbers 0..15 */
#endif
/* Delay between answering REBOOT / ENTER_BOOTLOADER and calling the HAL, so the reply
 * leaves the controller first. */
#ifndef CYCAN_RESET_DELAY_US
#define CYCAN_RESET_DELAY_US 5000ul
#endif

/* ---- Parameters ------------------------------------------------------------------ */

/** Raw 32-bit parameter value: u32 / enum / bool use .u32, i32 uses .i32, f32 uses .f32. */
typedef union {
    uint32_t u32;
    int32_t i32;
    float f32;
} cycan_pval_t;

typedef struct cycan_node cycan_node_t;
typedef struct cycan_param cycan_param_t;

/**
 * One parameter. `flags` uses CYCAN_PF_* from cycan_catalog.h (READ_ONLY,
 * LOCKED_WHILE_ENABLED, REBOOT; ADVANCED is ignored by the board). `value` points to
 * 4-byte storage of the parameter's C type (uint32_t for u32/enum/bool, int32_t, float);
 * the library is the only writer while the node runs. `min_nonzero` != 0 means "0 or at
 * least min_nonzero in magnitude" (status periods). `on_change` (optional) runs after a
 * new value has been stored by SET, LOAD_DEFAULTS or the boot-time load.
 */
struct cycan_param {
    uint16_t pid;
    uint8_t ptype;
    uint8_t flags;
    cycan_pval_t min;
    cycan_pval_t max;
    cycan_pval_t def;
    cycan_pval_t min_nonzero;
    void *value;
    void (*on_change)(cycan_node_t *node, const cycan_param_t *p);
};

/*
 * Building the table straight from the generated catalog X-macro:
 *
 *   #define MY_FIELD(pid, name, pt, mn, mx, df, mnz, fl) CYCAN_CTYPE(pt) name;
 *   static struct { CYCAN_CYNCODER_PARAMS(MY_FIELD) } g_p;
 *   #define MY_ROW(pid, name, pt, mn, mx, df, mnz, fl) \
 *       CYCAN_PARAM_ENTRY(pid, pt, mn, mx, df, mnz, fl, &g_p.name, my_on_change),
 *   static const cycan_param_t k_params[] = { CYCAN_CYNCODER_PARAMS(MY_ROW) };
 *
 * The ptype argument may arrive either as CYCAN_PTYPE_X or already expanded to its value
 * (0u..4u); both spellings select the right union member.
 */
#define CYCAN_PV(pt, v) CYCAN_PV_##pt(v)
#define CYCAN_PV_CYCAN_PTYPE_U32(v) {.u32 = (v)}
#define CYCAN_PV_CYCAN_PTYPE_I32(v) {.i32 = (v)}
#define CYCAN_PV_CYCAN_PTYPE_F32(v) {.f32 = (v)}
#define CYCAN_PV_CYCAN_PTYPE_BOOL(v) {.u32 = (v)}
#define CYCAN_PV_CYCAN_PTYPE_ENUM(v) {.u32 = (v)}
#define CYCAN_PV_0u(v) {.u32 = (v)}
#define CYCAN_PV_1u(v) {.i32 = (v)}
#define CYCAN_PV_2u(v) {.f32 = (v)}
#define CYCAN_PV_3u(v) {.u32 = (v)}
#define CYCAN_PV_4u(v) {.u32 = (v)}

#define CYCAN_CTYPE(pt) CYCAN_CTYPE_##pt
#define CYCAN_CTYPE_CYCAN_PTYPE_U32 uint32_t
#define CYCAN_CTYPE_CYCAN_PTYPE_I32 int32_t
#define CYCAN_CTYPE_CYCAN_PTYPE_F32 float
#define CYCAN_CTYPE_CYCAN_PTYPE_BOOL uint32_t
#define CYCAN_CTYPE_CYCAN_PTYPE_ENUM uint32_t
#define CYCAN_CTYPE_0u uint32_t
#define CYCAN_CTYPE_1u int32_t
#define CYCAN_CTYPE_2u float
#define CYCAN_CTYPE_3u uint32_t
#define CYCAN_CTYPE_4u uint32_t

#define CYCAN_PARAM_ENTRY(pid, pt, mn, mx, df, mnz, fl, ptr, on_change) \
    {(pid), (pt), (fl), CYCAN_PV(pt, mn), CYCAN_PV(pt, mx), CYCAN_PV(pt, df), CYCAN_PV(pt, mnz), (ptr), (on_change)}

/* ---- HAL ------------------------------------------------------------------------- */

/** Persistent storage regions. Each is erased and rewritten as a whole. */
#define CYCAN_REGION_IDENTITY 0u /* 8 bytes: assigned NUM */
#define CYCAN_REGION_PARAMS 1u   /* cycan_params_blob_size() bytes: name + parameter values */
#define CYCAN_IDENTITY_SIZE 8u

typedef struct {
    void *ctx; /* passed back to every callback */
    /**
     * Queue one frame for transmission (29-bit id; CYCAN_FRAME_FD / _BRS in flags).
     * Return false if the controller cannot take it now; the library then retries from a
     * small queue (ENUM_RSP instead gets one randomized retry, PROTOCOL 3.2).
     */
    bool (*can_send)(void *ctx, const cycan_frame_t *f);
    /** The MCU's 96-bit unique id in INFO page byte order (read once in cycan_init). */
    void (*uid96)(void *ctx, uint8_t out[12]);
    /** Storage access. Writes come after an erase, in increasing offsets, 8-byte aligned and
     * in multiples of 8 bytes. Erased storage must read back as 0xFF. All may be NULL
     * (nothing persists, defaults are used). */
    bool (*storage_read)(void *ctx, uint8_t region, uint32_t offset, void *buf, uint32_t len);
    bool (*storage_erase)(void *ctx, uint8_t region);
    bool (*storage_write)(void *ctx, uint8_t region, uint32_t offset, const void *buf, uint32_t len);
    /** Do not return. */
    void (*reboot)(void *ctx);
    void (*enter_bootloader)(void *ctx);
    /** Identify blinking; the board's own LED logic should yield while cycan_identify_active(). */
    void (*led_set)(void *ctx, bool on);
    /** Any reasonably random 32-bit number (ADC noise, TRNG, timer jitter). May be NULL. */
    uint32_t (*random)(void *ctx);
} cycan_hal_t;

/* ---- Application ----------------------------------------------------------------- */

typedef enum {
    CYCAN_NEUTRAL_CTRL_TIMEOUT = 0, /* no CTRL within ctrl.timeout_ms */
    CYCAN_NEUTRAL_ESTOP,            /* ESTOP received (latched) */
    CYCAN_NEUTRAL_CONFLICT,         /* address conflict detected */
    CYCAN_NEUTRAL_UNASSIGNED,       /* address changed by ASSIGN_ID */
    CYCAN_NEUTRAL_RESET             /* about to reboot or enter the bootloader */
} cycan_neutral_reason_t;

typedef struct {
    /* Identity (catalog constants). */
    uint8_t model;
    uint8_t devtype;
    uint8_t hw_rev;
    uint8_t fw_major, fw_minor, fw_patch;
    uint16_t catalog_rev;
    uint8_t bootloader_ver;
    uint32_t git_hash;
    uint16_t build_day; /* days since 2026-01-01 */
    bool build_dirty;

    /** The board can send CAN-FD frames (false: classic only, whatever can.data_bitrate says). */
    bool fd_capable;
    /** Smallest stream period (catalog stream.minPeriodUs). */
    uint32_t stream_min_period_us;
    /** Number of STATUS frames (catalog statusFrames). */
    uint8_t status_count;

    const cycan_param_t *params;
    uint16_t param_count;

    /** Fills STATUS/n (8 bytes, pre-zeroed). Return false to skip this period. */
    bool (*status_fill)(cycan_node_t *node, uint8_t n, uint8_t out[8]);
    /** Current value of signal `sid` for STREAM; false if unknown (sent as NaN). */
    bool (*signal_read)(cycan_node_t *node, uint16_t sid, float *out);
    /** CTRL/index frame (only when the board is addressed and not in ESTOP/CONFLICT). */
    void (*ctrl)(cycan_node_t *node, uint8_t index, const uint8_t *data, uint8_t len);
    /**
     * SELF_TEST and model commands (0x40+). Return a CYCAN_CMDST_* status and set *result.
     * Return CYCAN_CMDST_IN_PROGRESS for long operations and finish later with
     * cycan_command_finish(). NULL: every such command is UNSUPPORTED.
     */
    uint8_t (*command)(cycan_node_t *node, uint8_t cmd, uint32_t arg, uint32_t *result);
    /** Put every actuator in its safe state now. Required for actuator boards. */
    void (*neutral)(cycan_node_t *node, cycan_neutral_reason_t reason);
    /** Optional extra validation (e.g. non-contiguous enum options); false = OUT_OF_RANGE. */
    bool (*param_validate)(cycan_node_t *node, const cycan_param_t *p, cycan_pval_t v);
} cycan_app_t;

/* ---- Node state (treat as opaque) ------------------------------------------------ */

typedef struct {
    uint32_t id;
    uint8_t len;
    uint8_t data[8];
} cycan_rx_entry_t;

struct cycan_node {
    const cycan_app_t *app;
    const cycan_hal_t *hal;
    void *user;

    cycan_uid_t uid;
    uint8_t uid96[12];
    uint8_t num;
    bool conflict;
    bool estop;
    bool enabled;
    bool unsaved;
    bool fd_active;
    uint8_t data_bitrate; /* value in effect since boot */
    char name[CYCAN_NAME_BYTES];

    uint16_t fault_active, fault_sticky, fault_warn;

    /* Indexes of common parameters in app->params, -1 when absent. */
    int16_t idx_ctrl_timeout;
    int16_t idx_status[CYCAN_STATUS_MAX];

    uint32_t now;
    uint32_t hb_next;
    uint16_t hb_phase_ms;

    bool enum_pending, enum_retried;
    uint32_t enum_due;

    bool ctrl_armed;
    uint32_t ctrl_last;

    uint32_t identify_end, identify_next;
    bool identify_on, identify_led;

    uint32_t status_next[CYCAN_STATUS_MAX];

    uint16_t stream_sid[CYCAN_STREAM_SLOTS];
    uint8_t stream_slots;
    bool stream_active;
    uint8_t stream_seq;
    uint32_t stream_period_us, stream_next, stream_keepalive;

    bool cmd_pending;
    uint8_t cmd_code;

    uint8_t reset_pending; /* 0, CYCAN_CMD_REBOOT or CYCAN_CMD_ENTER_BOOTLOADER */
    uint32_t reset_at;

    /* Interrupt-shared state. */
    cycan_rx_entry_t rxq[CYCAN_RX_QUEUE_LEN];
    volatile uint8_t rx_head, rx_tail;
    volatile uint8_t estop_rx;
    volatile uint8_t enum_tx_err;
    volatile uint16_t rx_overruns;

    cycan_frame_t txq[CYCAN_TX_QUEUE_LEN];
    uint8_t tx_head, tx_count;
    uint16_t tx_dropped;
};

typedef enum {
    CYCAN_INIT_OK = 0,
    CYCAN_INIT_STORAGE_BLANK, /* first boot: factory defaults, unassigned */
    CYCAN_INIT_STORAGE_CORRUPT, /* parameter CRC failed: defaults, PARAM_CRC warning */
    CYCAN_INIT_BAD_TABLE      /* NULL value pointer, duplicate pid or invalid default */
} cycan_init_result_t;

/* ---- API ------------------------------------------------------------------------- */

/**
 * Derives the UID values, loads defaults, then the stored NUM and parameters, and
 * schedules the first heartbeat. The node is fully usable for any result except
 * CYCAN_INIT_BAD_TABLE. Read cycan_data_bitrate() afterwards to configure the controller.
 */
cycan_init_result_t cycan_init(cycan_node_t *node, const cycan_app_t *app, const cycan_hal_t *hal, void *user,
                               uint32_t now_us);

/** RX path (interrupt safe, see the execution model above). Returns true if the frame was kept. */
bool cycan_on_frame(cycan_node_t *node, uint32_t id, const uint8_t *data, uint8_t len);
/** The controller reported that frame `id` failed to transmit (interrupt safe). */
void cycan_on_tx_error(cycan_node_t *node, uint32_t id);
/** Processes received frames and runs every timer. */
void cycan_poll(cycan_node_t *node, uint32_t now_us);

void *cycan_user(const cycan_node_t *node);
uint8_t cycan_num(const cycan_node_t *node);
const cycan_uid_t *cycan_uid(const cycan_node_t *node);
/** can.data_bitrate in effect since boot (0 classic, 1 2M, 2 5M, 3 8M). */
uint8_t cycan_data_bitrate(const cycan_node_t *node);
/** Assigned, not in conflict and not in ESTOP: CTRL frames are delivered. */
bool cycan_ctrl_allowed(const cycan_node_t *node);
bool cycan_estop_latched(const cycan_node_t *node);
bool cycan_identify_active(const cycan_node_t *node);
const char *cycan_name(const cycan_node_t *node, uint8_t *len);

/** The application reports whether an actuator is being driven (HEARTBEAT ENABLED / ACTIVE). */
void cycan_set_enabled(cycan_node_t *node, bool enabled);

typedef enum { CYCAN_FAULT_ACTIVE = 0, CYCAN_FAULT_WARN } cycan_fault_kind_t;
/** ACTIVE sets the active and the sticky bit; WARN sets the warn bit. Bits 0..15. */
void cycan_fault_set(cycan_node_t *node, uint8_t bit, cycan_fault_kind_t kind);
/** Clears the active or warn bit; sticky bits clear only with COMMAND CLEAR_FAULTS. */
void cycan_fault_clear(cycan_node_t *node, uint8_t bit, cycan_fault_kind_t kind);
void cycan_fault_get(const cycan_node_t *node, uint16_t *active, uint16_t *sticky, uint16_t *warn);

/** Finishes a command the application answered with IN_PROGRESS. */
void cycan_command_finish(cycan_node_t *node, uint8_t cmd, uint8_t status, uint32_t result);

/** Current value of a parameter (false if the pid is unknown). */
bool cycan_param_get(const cycan_node_t *node, uint16_t pid, cycan_pval_t *out);
/** Local write with the same checks as a host SET; returns a CYCAN_PST_* status. */
uint8_t cycan_param_set(cycan_node_t *node, uint16_t pid, uint8_t ptype, cycan_pval_t v);

/** Bytes needed in CYCAN_REGION_PARAMS for this application. */
uint32_t cycan_params_blob_size(const cycan_app_t *app);
/** Same as COMMAND SAVE_PARAMS; true on success. */
bool cycan_save(cycan_node_t *node);

typedef struct {
    uint16_t rx_overruns;
    uint16_t tx_dropped;
} cycan_stats_t;
void cycan_stats(const cycan_node_t *node, cycan_stats_t *out);

/* ---- Identity record (shared with the bootloader) -------------------------------- */

void cycan_identity_encode(uint8_t out[CYCAN_IDENTITY_SIZE], uint8_t num);
/** NUM stored in the record, or CYCAN_NUM_UNASSIGNED if blank / invalid. */
uint8_t cycan_identity_decode(const uint8_t in[CYCAN_IDENTITY_SIZE]);

#ifdef __cplusplus
}
#endif

#endif /* CYCAN_H */
