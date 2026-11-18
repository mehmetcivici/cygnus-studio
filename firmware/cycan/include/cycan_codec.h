/*
 * CyCAN v1 codecs: identifiers, every message payload, CRC32 and FNV-1a-64.
 *
 * Bit-for-bit identical to packages/protocol/src/core (TypeScript); both sides are checked
 * against packages/protocol/test/vectors/cycan-vectors.json. Pure functions, no state,
 * no dynamic memory. Safe to call from any context.
 *
 * Conventions (same as the TS codecs):
 * - cycan_enc_*() fills a complete frame. The (devtype, num) pair is the destination for
 *   host-to-board messages and the sender for board-to-host messages.
 * - Payloads up to 8 bytes travel as classic frames with their exact length; longer payloads
 *   become CAN-FD + BRS frames zero padded to the next valid FD length.
 * - cycan_dec_*() returns false when the payload is shorter than the message needs; longer
 *   payloads are accepted (some CAN stacks always send DLC 8). Reserved bytes are ignored.
 */
#ifndef CYCAN_CODEC_H
#define CYCAN_CODEC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cycan_catalog.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Largest payload a cycan_frame_t can hold. 64 for CAN-FD; a classic-only port may set 8
 * (STREAM then always uses one frame per slot and FW DATA is limited to 5-byte chunks). */
#ifndef CYCAN_FRAME_MAX_DATA
#define CYCAN_FRAME_MAX_DATA 64u
#endif

#define CYCAN_PROTO_MAJOR 1u
#define CYCAN_PROTO_MINOR 0u

#define CYCAN_MFR 8u
#define CYCAN_ID_MASK 0x1FFFFFFFul

#define CYCAN_NUM_BROADCAST 0u
#define CYCAN_NUM_MIN 1u
#define CYCAN_NUM_MAX 62u
#define CYCAN_NUM_UNASSIGNED 63u
#define CYCAN_DEVTYPE_BROADCAST 0u

/* API classes (bits 15..10). Even = host to board, odd = board to host. */
#define CYCAN_CLS_LEGACY_MAX 0x0Fu
#define CYCAN_CLS_CTRL 0x10u
#define CYCAN_CLS_STATUS 0x11u
#define CYCAN_CLS_SYS_REQ 0x12u
#define CYCAN_CLS_SYS_RSP 0x13u
#define CYCAN_CLS_PARAM_REQ 0x14u
#define CYCAN_CLS_PARAM_RSP 0x15u
#define CYCAN_CLS_STREAM_REQ 0x16u
#define CYCAN_CLS_STREAM_RSP 0x17u
#define CYCAN_CLS_FW_REQ 0x18u
#define CYCAN_CLS_FW_RSP 0x19u
#define CYCAN_CLS_ENUM_RSP 0x1Bu

/* SYS_REQ / SYS_RSP indexes. */
#define CYCAN_SYS_ENUM_REQ 0u
#define CYCAN_SYS_ASSIGN_ID 1u
#define CYCAN_SYS_IDENTIFY 2u
#define CYCAN_SYS_INFO_REQ 3u
#define CYCAN_SYS_NAME_SET 4u
#define CYCAN_SYS_COMMAND 5u
#define CYCAN_SYS_FAULT_REQ 6u
#define CYCAN_SYS_ESTOP 7u
#define CYCAN_SYS_HEARTBEAT 0u
#define CYCAN_SYS_INFO_RSP 3u
#define CYCAN_SYS_COMMAND_RSP 5u
#define CYCAN_SYS_FAULT_RSP 6u

#define CYCAN_PARAM_GET 0u
#define CYCAN_PARAM_SET 1u
#define CYCAN_PARAM_VALUE 0u
#define CYCAN_STREAM_CONFIG 0u
#define CYCAN_STREAM_START 1u
#define CYCAN_STREAM_STOP 2u
#define CYCAN_STREAM_DATA 0u
#define CYCAN_FW_BEGIN 0u
#define CYCAN_FW_DATA 1u
#define CYCAN_FW_END 2u
#define CYCAN_FW_ACK 0u

#define CYCAN_ENUM_FILTER_ALL 0u
#define CYCAN_ENUM_FILTER_UNASSIGNED 1u

/* HEARTBEAT state (low 4 bits of state_flags) and flag bits. */
#define CYCAN_STATE_BOOT 0u
#define CYCAN_STATE_BOOTLOADER 1u
#define CYCAN_STATE_IDLE 2u
#define CYCAN_STATE_ACTIVE 3u
#define CYCAN_STATE_FAULT 4u
#define CYCAN_STATE_ESTOP 5u
#define CYCAN_SF_UNSAVED 0x10u
#define CYCAN_SF_ENABLED 0x20u
#define CYCAN_SF_WARNING 0x40u
#define CYCAN_SF_IDENTIFY 0x80u

/* ENUM_RSP num_flags. */
#define CYCAN_EF_CONFLICT 0x40u
#define CYCAN_EF_BOOTLOADER 0x80u

#define CYCAN_CMD_MODEL_MIN 0x40u

#define CYCAN_CMDST_OK 0u
#define CYCAN_CMDST_IN_PROGRESS 1u
#define CYCAN_CMDST_UNSUPPORTED 2u
#define CYCAN_CMDST_INVALID_ARG 3u
#define CYCAN_CMDST_DENIED 4u
#define CYCAN_CMDST_FAILED 5u

#define CYCAN_PST_OK 0u
#define CYCAN_PST_UNKNOWN_PARAM 1u
#define CYCAN_PST_TYPE_MISMATCH 2u
#define CYCAN_PST_OUT_OF_RANGE 3u
#define CYCAN_PST_READ_ONLY 4u
#define CYCAN_PST_DENIED_WHILE_ENABLED 5u

#define CYCAN_FWST_OK 0u
#define CYCAN_FWST_BUSY 1u
#define CYCAN_FWST_BAD_OFFSET 2u
#define CYCAN_FWST_BAD_CRC 3u
#define CYCAN_FWST_BAD_IMAGE 4u
#define CYCAN_FWST_FLASH_ERROR 5u
#define CYCAN_FWST_WRONG_STATE 6u

#define CYCAN_INFO_DEVICE 0u
#define CYCAN_INFO_UID_LO 1u
#define CYCAN_INFO_UID_HI 2u
#define CYCAN_INFO_BUILD 3u
#define CYCAN_INFO_NAME_0 4u
#define CYCAN_INFO_NAME_2 6u
#define CYCAN_NAME_BYTES 21u

#define CYCAN_ESTOP_MAGIC_0 0xE5u
#define CYCAN_ESTOP_MAGIC_1 0x70u

#define CYCAN_DATA_BITRATE_CLASSIC 0u

#define CYCAN_STREAM_SLOTS 15u
#define CYCAN_STREAM_SID_CLEAR 0xFFFFu
#define CYCAN_FW_WINDOW_DEFAULT 16u
#define CYCAN_FW_CHUNK_CLASSIC 5u
#define CYCAN_FW_CHUNK_FD 61u

/* Timing contract (PROTOCOL 10). */
#define CYCAN_HEARTBEAT_MS 500u
#define CYCAN_HEARTBEAT_PHASE_MAX_MS 50u
#define CYCAN_STREAM_TIMEOUT_MS 2000u
#define CYCAN_CTRL_TIMEOUT_DEFAULT_MS 200u
#define CYCAN_ENUM_RETRY_MAX_MS 100u

/* ---- Frame ----------------------------------------------------------------------- */

#define CYCAN_FRAME_FD 0x01u  /* CAN-FD frame format */
#define CYCAN_FRAME_BRS 0x02u /* bit-rate switch in the data phase */

/** A 29-bit extended frame. `len` is the payload length (0..8 classic, FD lengths up to 64). */
typedef struct {
    uint32_t id;
    uint8_t len;
    uint8_t flags;
    uint8_t data[CYCAN_FRAME_MAX_DATA];
} cycan_frame_t;

/* ---- Identifier ------------------------------------------------------------------ */

#define CYCAN_ID_DEVTYPE(id) ((uint8_t)(((id) >> 24) & 0x1Fu))
#define CYCAN_ID_MFR(id) ((uint8_t)(((id) >> 16) & 0xFFu))
#define CYCAN_ID_CLASS(id) ((uint8_t)(((id) >> 10) & 0x3Fu))
#define CYCAN_ID_INDEX(id) ((uint8_t)(((id) >> 6) & 0x0Fu))
#define CYCAN_ID_NUM(id) ((uint8_t)((id) & 0x3Fu))
#define CYCAN_ID_LOW10(id) ((uint16_t)((id) & 0x3FFu))

typedef struct {
    uint8_t devtype;
    uint8_t mfr;
    uint8_t cls;
    uint8_t index;
    uint8_t num;
} cycan_id_fields_t;

/** Encodes with MFR = CYCAN_MFR. */
uint32_t cycan_id_encode(uint8_t devtype, uint8_t cls, uint8_t index, uint8_t num);
uint32_t cycan_id_encode_mfr(uint8_t devtype, uint8_t mfr, uint8_t cls, uint8_t index, uint8_t num);
void cycan_id_decode(uint32_t id, cycan_id_fields_t *out);
/** ENUM_RSP id: INDEX+NUM carry hash10 so same-number boards still differ. */
uint32_t cycan_enum_rsp_id(uint8_t devtype, uint16_t hash10);
/** Our MFR and a class outside the legacy Cyncoder v3 range. */
bool cycan_is_cycan_id(uint32_t id);
/**
 * Board acceptance rule (PROTOCOL 2.2): MFR matches, the class is a CyCAN host-to-board
 * class, and (DEVTYPE is ours and NUM is ours or 0) or (DEVTYPE 0 and NUM 0).
 */
bool cycan_accepts(uint32_t id, uint8_t devtype, uint8_t num);

/* ---- Primitives ------------------------------------------------------------------ */

uint16_t cycan_rd_u16(const uint8_t *b);
uint32_t cycan_rd_u24(const uint8_t *b);
uint32_t cycan_rd_u32(const uint8_t *b);
uint64_t cycan_rd_u48(const uint8_t *b);
float cycan_rd_f32(const uint8_t *b);
void cycan_wr_u16(uint8_t *b, uint16_t v);
void cycan_wr_u24(uint8_t *b, uint32_t v);
void cycan_wr_u32(uint8_t *b, uint32_t v);
void cycan_wr_u48(uint8_t *b, uint64_t v);
void cycan_wr_f32(uint8_t *b, float v);
uint32_t cycan_f32_bits(float v);
float cycan_bits_f32(uint32_t bits);

/** CRC-32/IEEE 802.3 (zlib). Continue a running CRC by passing the previous result (start 0). */
uint32_t cycan_crc32_update(uint32_t crc, const uint8_t *data, size_t len);
uint32_t cycan_crc32(const uint8_t *data, size_t len);

uint64_t cycan_fnv1a64(const uint8_t *data, size_t len);

/** UID derivations (PROTOCOL 3.1). */
typedef struct {
    uint64_t uid48;
    uint16_t uid16;
    uint16_t hash10;
    uint8_t enum_delay_ms; /* 0..99 */
} cycan_uid_t;

void cycan_uid_derive(const uint8_t uid96[12], cycan_uid_t *out);

/** CAN-FD DLC code (0..15) to payload length. */
uint8_t cycan_fd_dlc_to_len(uint8_t dlc);
/** Smallest DLC holding `len` bytes; -1 above 64. */
int cycan_fd_len_to_dlc(uint8_t len);
/** Next valid FD payload length; 0 above 64. */
uint8_t cycan_fd_round_up(uint8_t len);

/**
 * Sets id/len/flags for a payload already written to f->data[0..len): classic when len <= 8,
 * otherwise FD + BRS zero padded to the next FD length. Returns false if it cannot fit.
 */
bool cycan_frame_finish(cycan_frame_t *f, uint32_t id, uint8_t len);

/* ---- STATUS helpers (catalog layouts) -------------------------------------------- */

/**
 * Scales a physical value to a raw integer the way the catalog encoder does:
 * round((v - bias) / scale) (halves toward +inf, like JS Math.round), saturated to [lo, hi].
 * NaN encodes as 0.
 */
int32_t cycan_scale_round(float v, float scale, float bias, int32_t lo, int32_t hi);
/** Writes `raw` into bits [bit, bit+nbits) of a little-endian container of `size` bytes. */
void cycan_put_bits(uint8_t *d, uint8_t size, uint8_t bit, uint8_t nbits, uint32_t raw);

/* ---- SYS_REQ (host -> board) ----------------------------------------------------- */

typedef struct {
    uint8_t filter;
} cycan_enum_req_t;

typedef struct {
    uint64_t uid48;
    uint8_t new_num;
    bool persist;
} cycan_assign_id_t;

/** Two forms told apart by length: 1..6 bytes addressed, 7+ bytes UID broadcast. */
typedef struct {
    bool uid_form;
    uint64_t uid48;
    uint8_t seconds;
} cycan_identify_t;

typedef struct {
    uint8_t page;
} cycan_info_req_t;

typedef struct {
    uint8_t page;
    uint8_t bytes[7];
} cycan_name_set_t;

typedef struct {
    uint8_t cmd;
    uint32_t arg;
} cycan_command_t;

void cycan_enc_enum_req(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_enum_req_t *m);
bool cycan_dec_enum_req(const uint8_t *d, uint8_t len, cycan_enum_req_t *m);
void cycan_enc_assign_id(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_assign_id_t *m);
bool cycan_dec_assign_id(const uint8_t *d, uint8_t len, cycan_assign_id_t *m);
void cycan_enc_identify(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_identify_t *m);
bool cycan_dec_identify(const uint8_t *d, uint8_t len, cycan_identify_t *m);
void cycan_enc_info_req(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_info_req_t *m);
bool cycan_dec_info_req(const uint8_t *d, uint8_t len, cycan_info_req_t *m);
void cycan_enc_name_set(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_name_set_t *m);
bool cycan_dec_name_set(const uint8_t *d, uint8_t len, cycan_name_set_t *m);
void cycan_enc_command(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_command_t *m);
bool cycan_dec_command(const uint8_t *d, uint8_t len, cycan_command_t *m);
void cycan_enc_fault_req(cycan_frame_t *f, uint8_t devtype, uint8_t num);
void cycan_enc_estop(cycan_frame_t *f, uint8_t devtype, uint8_t num);
/** Requires the 0xE5 0x70 magic so a corrupted or foreign frame never latches ESTOP. */
bool cycan_dec_estop(const uint8_t *d, uint8_t len);

/* ---- SYS_RSP (board -> host) ----------------------------------------------------- */

typedef struct {
    uint8_t state;
    bool unsaved;
    bool enabled;
    bool warning;
    bool identify;
    uint16_t fault;
    uint16_t uid16;
    uint8_t fw_major;
    uint8_t fw_minor;
    uint8_t fw_patch;
} cycan_heartbeat_t;

/** INFO_RSP in raw form: page + 7 bytes (pages 1, 2, 4..6 and unknown pages). */
typedef struct {
    uint8_t page;
    uint8_t bytes[7];
} cycan_info_rsp_t;

/** INFO_RSP page 0. */
typedef struct {
    uint8_t model;
    uint8_t hw_rev;
    uint8_t proto_major;
    uint8_t proto_minor;
    uint16_t catalog_rev;
    uint8_t bootloader_ver;
} cycan_info_device_t;

/** INFO_RSP page 3; build_day counts days since 2026-01-01. */
typedef struct {
    uint32_t git_hash;
    uint16_t build_day;
    bool dirty;
} cycan_info_build_t;

typedef struct {
    uint8_t cmd;
    uint8_t status;
    uint32_t result;
} cycan_command_rsp_t;

typedef struct {
    uint16_t active;
    uint16_t sticky;
    uint16_t warn;
} cycan_fault_rsp_t;

typedef struct {
    uint64_t uid48;
    uint8_t num;
    bool conflict;
    bool bootloader;
    uint8_t model;
} cycan_enum_rsp_t;

void cycan_enc_heartbeat(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_heartbeat_t *m);
bool cycan_dec_heartbeat(const uint8_t *d, uint8_t len, cycan_heartbeat_t *m);
void cycan_enc_info_rsp(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_info_rsp_t *m);
bool cycan_dec_info_rsp(const uint8_t *d, uint8_t len, cycan_info_rsp_t *m);
void cycan_enc_info_device(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_info_device_t *m);
bool cycan_dec_info_device(const uint8_t *d, uint8_t len, cycan_info_device_t *m);
void cycan_enc_info_build(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_info_build_t *m);
bool cycan_dec_info_build(const uint8_t *d, uint8_t len, cycan_info_build_t *m);
void cycan_enc_command_rsp(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_command_rsp_t *m);
bool cycan_dec_command_rsp(const uint8_t *d, uint8_t len, cycan_command_rsp_t *m);
void cycan_enc_fault_rsp(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_fault_rsp_t *m);
bool cycan_dec_fault_rsp(const uint8_t *d, uint8_t len, cycan_fault_rsp_t *m);
/** Only `devtype` goes into the id; the low 10 bits carry hash10(uid48). */
void cycan_enc_enum_rsp(cycan_frame_t *f, uint8_t devtype, const cycan_enum_rsp_t *m);
bool cycan_dec_enum_rsp(const uint8_t *d, uint8_t len, cycan_enum_rsp_t *m);

/* ---- PARAM ----------------------------------------------------------------------- */

/** Values travel as raw 32-bit patterns: u32/enum/bool unsigned, i32 two's complement, f32 IEEE. */
typedef struct {
    uint16_t pid;
} cycan_param_get_t;

typedef struct {
    uint16_t pid;
    uint8_t ptype;
    uint32_t value;
} cycan_param_set_t;

typedef struct {
    uint16_t pid;
    uint8_t ptype;
    uint8_t status;
    uint32_t value;
} cycan_param_value_t;

void cycan_enc_param_get(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_param_get_t *m);
bool cycan_dec_param_get(const uint8_t *d, uint8_t len, cycan_param_get_t *m);
void cycan_enc_param_set(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_param_set_t *m);
bool cycan_dec_param_set(const uint8_t *d, uint8_t len, cycan_param_set_t *m);
void cycan_enc_param_value(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_param_value_t *m);
bool cycan_dec_param_value(const uint8_t *d, uint8_t len, cycan_param_value_t *m);

/* ---- STREAM ---------------------------------------------------------------------- */

typedef struct {
    uint8_t slot;
    uint16_t sid; /* CYCAN_STREAM_SID_CLEAR empties the slot */
} cycan_stream_config_t;

typedef struct {
    uint16_t period_100us;
} cycan_stream_start_t;

typedef struct {
    uint8_t seq;
    uint8_t first_slot;
    uint16_t t_100us;
    uint8_t count;
    float values[CYCAN_STREAM_SLOTS];
} cycan_stream_data_t;

void cycan_enc_stream_config(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_stream_config_t *m);
bool cycan_dec_stream_config(const uint8_t *d, uint8_t len, cycan_stream_config_t *m);
void cycan_enc_stream_start(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_stream_start_t *m);
bool cycan_dec_stream_start(const uint8_t *d, uint8_t len, cycan_stream_start_t *m);
void cycan_enc_stream_stop(cycan_frame_t *f, uint8_t devtype, uint8_t num);
/** False when count is 0, the slot range leaves 0..14 or the frame cannot hold it. */
bool cycan_enc_stream_data(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_stream_data_t *m);
/** count = values present (FD padding may add trailing ones; the host keeps only configured slots). */
bool cycan_dec_stream_data(const uint8_t *d, uint8_t len, cycan_stream_data_t *m);

/* ---- FW (bootloader) ------------------------------------------------------------- */

typedef struct {
    uint32_t size;  /* whole .cyfw file (header + payload) */
    uint32_t crc32; /* CRC32 of the whole file */
} cycan_fw_begin_t;

typedef struct {
    uint32_t offset; /* 24 bits */
    uint8_t len;
    const uint8_t *bytes; /* points into the frame on decode */
} cycan_fw_data_t;

typedef struct {
    uint8_t status;
    uint8_t window;
    uint32_t next_offset;
} cycan_fw_ack_t;

void cycan_enc_fw_begin(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_fw_begin_t *m);
bool cycan_dec_fw_begin(const uint8_t *d, uint8_t len, cycan_fw_begin_t *m);
/** 1..61 bytes; FD padding is part of the chunk, so only the final chunk may be short. */
bool cycan_enc_fw_data(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_fw_data_t *m);
bool cycan_dec_fw_data(const uint8_t *d, uint8_t len, cycan_fw_data_t *m);
void cycan_enc_fw_end(cycan_frame_t *f, uint8_t devtype, uint8_t num);
void cycan_enc_fw_ack(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_fw_ack_t *m);
bool cycan_dec_fw_ack(const uint8_t *d, uint8_t len, cycan_fw_ack_t *m);

/* ---- CTRL formats (which one a model uses is in its catalog `controls`) ----------- */

/** Standard CTRL/0 SET: [mode u8][flags u8][0 0][value f32]. */
typedef struct {
    uint8_t mode;
    uint8_t flags;
    float value;
} cycan_ctrl_set_t;

/** 16-channel servo: CTRL/index carries channels 4*index+1..4*index+4 as us (0 = off). */
typedef struct {
    uint8_t index;
    uint16_t pulses_us[4];
} cycan_ctrl_servo_t;

/** Debug OLED CTRL/0 TEXT: [line][col][6 ASCII]. `text` is NUL terminated. */
typedef struct {
    uint8_t line;
    uint8_t col;
    char text[7];
} cycan_ctrl_text_t;

void cycan_enc_ctrl_set(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_ctrl_set_t *m);
bool cycan_dec_ctrl_set(const uint8_t *d, uint8_t len, cycan_ctrl_set_t *m);
void cycan_enc_ctrl_servo(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_ctrl_servo_t *m);
bool cycan_dec_ctrl_servo(const uint8_t *d, uint8_t len, uint8_t index, cycan_ctrl_servo_t *m);
/** Non-printable characters become '?'. */
void cycan_enc_ctrl_text(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_ctrl_text_t *m);
bool cycan_dec_ctrl_text(const uint8_t *d, uint8_t len, cycan_ctrl_text_t *m);

/* ---- .cyfw header (PROTOCOL 9.1) ------------------------------------------------- */

#define CYCAN_CYFW_HEADER_SIZE 64u
#define CYCAN_CYFW_HEADER_VERSION 1u
#define CYCAN_CYFW_NAME_BYTES 24u

typedef struct {
    uint16_t header_ver;
    uint8_t model;
    uint8_t hw_rev_min;
    uint8_t hw_rev_max;
    uint8_t fw_major;
    uint8_t fw_minor;
    uint8_t fw_patch;
    uint32_t payload_size;
    uint32_t payload_crc32;
    uint16_t catalog_rev;
    uint32_t git_hash;
    uint16_t build_day;
    char name[CYCAN_CYFW_NAME_BYTES + 1];
    uint32_t header_crc32;
} cycan_cyfw_header_t;

typedef enum {
    CYCAN_CYFW_OK = 0,
    CYCAN_CYFW_BAD_MAGIC,
    CYCAN_CYFW_BAD_HEADER_VERSION,
    CYCAN_CYFW_BAD_HEADER_CRC,
    CYCAN_CYFW_WRONG_MODEL,
    CYCAN_CYFW_WRONG_HW_REV
} cycan_cyfw_result_t;

/** Writes a header; header_ver, header_crc32 are computed (fields in `h` ignored). */
void cycan_cyfw_encode_header(uint8_t out[CYCAN_CYFW_HEADER_SIZE], const cycan_cyfw_header_t *h);
/** Parses and checks magic, version and header CRC, then model and hw_rev against the board. */
cycan_cyfw_result_t cycan_cyfw_check_header(const uint8_t in[CYCAN_CYFW_HEADER_SIZE], uint8_t model, uint8_t hw_rev,
                                            cycan_cyfw_header_t *out);

#ifdef __cplusplus
}
#endif

#endif /* CYCAN_CODEC_H */
