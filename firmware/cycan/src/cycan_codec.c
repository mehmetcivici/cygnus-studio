#include "cycan_codec.h"

#include <string.h>

/* ---- Identifier ------------------------------------------------------------------ */

uint32_t cycan_id_encode_mfr(uint8_t devtype, uint8_t mfr, uint8_t cls, uint8_t index, uint8_t num)
{
    return ((uint32_t)(devtype & 0x1Fu) << 24) | ((uint32_t)mfr << 16) | ((uint32_t)(cls & 0x3Fu) << 10) |
           ((uint32_t)(index & 0x0Fu) << 6) | (uint32_t)(num & 0x3Fu);
}

uint32_t cycan_id_encode(uint8_t devtype, uint8_t cls, uint8_t index, uint8_t num)
{
    return cycan_id_encode_mfr(devtype, CYCAN_MFR, cls, index, num);
}

void cycan_id_decode(uint32_t id, cycan_id_fields_t *out)
{
    out->devtype = CYCAN_ID_DEVTYPE(id);
    out->mfr = CYCAN_ID_MFR(id);
    out->cls = CYCAN_ID_CLASS(id);
    out->index = CYCAN_ID_INDEX(id);
    out->num = CYCAN_ID_NUM(id);
}

uint32_t cycan_enum_rsp_id(uint8_t devtype, uint16_t hash10)
{
    return cycan_id_encode(devtype, CYCAN_CLS_ENUM_RSP, (uint8_t)((hash10 >> 6) & 0x0Fu), (uint8_t)(hash10 & 0x3Fu));
}

bool cycan_is_cycan_id(uint32_t id)
{
    return id <= CYCAN_ID_MASK && CYCAN_ID_MFR(id) == CYCAN_MFR && CYCAN_ID_CLASS(id) > CYCAN_CLS_LEGACY_MAX;
}

bool cycan_accepts(uint32_t id, uint8_t devtype, uint8_t num)
{
    uint8_t cls, dt, n;
    if (!cycan_is_cycan_id(id)) return false;
    cls = CYCAN_ID_CLASS(id);
    if ((cls & 1u) != 0u) return false;
    dt = CYCAN_ID_DEVTYPE(id);
    n = CYCAN_ID_NUM(id);
    if (dt == devtype) return n == num || n == CYCAN_NUM_BROADCAST;
    return dt == CYCAN_DEVTYPE_BROADCAST && n == CYCAN_NUM_BROADCAST;
}

/* ---- Primitives ------------------------------------------------------------------ */

uint16_t cycan_rd_u16(const uint8_t *b)
{
    return (uint16_t)(b[0] | (b[1] << 8));
}

uint32_t cycan_rd_u24(const uint8_t *b)
{
    return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16);
}

uint32_t cycan_rd_u32(const uint8_t *b)
{
    return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
}

uint64_t cycan_rd_u48(const uint8_t *b)
{
    return (uint64_t)cycan_rd_u32(b) | ((uint64_t)cycan_rd_u16(b + 4) << 32);
}

uint32_t cycan_f32_bits(float v)
{
    uint32_t u;
    memcpy(&u, &v, 4);
    return u;
}

float cycan_bits_f32(uint32_t bits)
{
    float v;
    memcpy(&v, &bits, 4);
    return v;
}

float cycan_rd_f32(const uint8_t *b)
{
    return cycan_bits_f32(cycan_rd_u32(b));
}

void cycan_wr_u16(uint8_t *b, uint16_t v)
{
    b[0] = (uint8_t)v;
    b[1] = (uint8_t)(v >> 8);
}

void cycan_wr_u24(uint8_t *b, uint32_t v)
{
    b[0] = (uint8_t)v;
    b[1] = (uint8_t)(v >> 8);
    b[2] = (uint8_t)(v >> 16);
}

void cycan_wr_u32(uint8_t *b, uint32_t v)
{
    b[0] = (uint8_t)v;
    b[1] = (uint8_t)(v >> 8);
    b[2] = (uint8_t)(v >> 16);
    b[3] = (uint8_t)(v >> 24);
}

void cycan_wr_u48(uint8_t *b, uint64_t v)
{
    cycan_wr_u32(b, (uint32_t)v);
    cycan_wr_u16(b + 4, (uint16_t)(v >> 32));
}

void cycan_wr_f32(uint8_t *b, float v)
{
    cycan_wr_u32(b, cycan_f32_bits(v));
}

/* Bitwise CRC: 1 KB of table is not worth it for the few hundred bytes a board hashes per
 * second; the bootloader hashes the image once and is not time critical either. */
uint32_t cycan_crc32_update(uint32_t crc, const uint8_t *data, size_t len)
{
    uint32_t c = ~crc;
    size_t i;
    int k;
    for (i = 0; i < len; i++) {
        c ^= data[i];
        for (k = 0; k < 8; k++) c = (c & 1u) ? 0xEDB88320ul ^ (c >> 1) : c >> 1;
    }
    return ~c;
}

uint32_t cycan_crc32(const uint8_t *data, size_t len)
{
    return cycan_crc32_update(0, data, len);
}

uint64_t cycan_fnv1a64(const uint8_t *data, size_t len)
{
    uint64_t h = 0xCBF29CE484222325ull;
    size_t i;
    for (i = 0; i < len; i++) {
        h ^= data[i];
        h *= 0x100000001B3ull;
    }
    return h;
}

void cycan_uid_derive(const uint8_t uid96[12], cycan_uid_t *out)
{
    uint64_t u = cycan_fnv1a64(uid96, 12) & 0xFFFFFFFFFFFFull;
    out->uid48 = u;
    out->uid16 = (uint16_t)(u & 0xFFFFu);
    out->hash10 = (uint16_t)((u >> 16) & 0x3FFu);
    out->enum_delay_ms = (uint8_t)((u >> 26) % 100u);
}

static const uint8_t k_dlc_len[16] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64};

uint8_t cycan_fd_dlc_to_len(uint8_t dlc)
{
    return k_dlc_len[dlc & 15u];
}

int cycan_fd_len_to_dlc(uint8_t len)
{
    int d;
    for (d = 0; d < 16; d++)
        if (k_dlc_len[d] >= len) return d;
    return -1;
}

uint8_t cycan_fd_round_up(uint8_t len)
{
    int d = cycan_fd_len_to_dlc(len);
    return d < 0 ? 0 : k_dlc_len[d];
}

bool cycan_frame_finish(cycan_frame_t *f, uint32_t id, uint8_t len)
{
    uint8_t padded;
    f->id = id;
    if (len <= 8u) {
        f->len = len;
        f->flags = 0;
        return true;
    }
    padded = cycan_fd_round_up(len);
    if (padded == 0u || padded > CYCAN_FRAME_MAX_DATA) return false;
    memset(f->data + len, 0, (size_t)(padded - len));
    f->len = padded;
    f->flags = CYCAN_FRAME_FD | CYCAN_FRAME_BRS;
    return true;
}

/* ---- STATUS helpers -------------------------------------------------------------- */

int32_t cycan_scale_round(float v, float scale, float bias, int32_t lo, int32_t hi)
{
    float x;
    int32_t r;
    float frac;
    if (v != v) return 0;
    x = (v - bias) / (scale == 0.0f ? 1.0f : scale);
    /* Saturate before the cast: converting an out-of-range float is undefined behaviour. */
    if (x >= (float)hi) return hi;
    if (x <= (float)lo) return lo;
    r = (int32_t)x;
    frac = x - (float)r;
    if (frac >= 0.5f) r++;
    else if (frac < -0.5f) r--;
    if (r > hi) r = hi;
    if (r < lo) r = lo;
    return r;
}

void cycan_put_bits(uint8_t *d, uint8_t size, uint8_t bit, uint8_t nbits, uint32_t raw)
{
    uint32_t c = 0, mask;
    uint8_t i;
    for (i = 0; i < size; i++) c |= (uint32_t)d[i] << (8u * i);
    mask = (nbits >= 32u ? 0xFFFFFFFFu : (((uint32_t)1u << nbits) - 1u)) << bit;
    c = (c & ~mask) | ((raw << bit) & mask);
    for (i = 0; i < size; i++) d[i] = (uint8_t)(c >> (8u * i));
}

/* ---- Message helpers ------------------------------------------------------------- */

static void finish8(cycan_frame_t *f, uint8_t devtype, uint8_t num, uint8_t cls, uint8_t index, uint8_t len)
{
    (void)cycan_frame_finish(f, cycan_id_encode(devtype, cls, index, num), len);
}

static void clear(cycan_frame_t *f, uint8_t len)
{
    memset(f->data, 0, len);
}

/* ---- SYS_REQ --------------------------------------------------------------------- */

void cycan_enc_enum_req(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_enum_req_t *m)
{
    f->data[0] = m->filter;
    finish8(f, devtype, num, CYCAN_CLS_SYS_REQ, CYCAN_SYS_ENUM_REQ, 1);
}

bool cycan_dec_enum_req(const uint8_t *d, uint8_t len, cycan_enum_req_t *m)
{
    if (len < 1u) return false;
    m->filter = d[0];
    return true;
}

void cycan_enc_assign_id(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_assign_id_t *m)
{
    cycan_wr_u48(f->data, m->uid48);
    f->data[6] = m->new_num & 0x3Fu;
    f->data[7] = m->persist ? 1u : 0u;
    finish8(f, devtype, num, CYCAN_CLS_SYS_REQ, CYCAN_SYS_ASSIGN_ID, 8);
}

bool cycan_dec_assign_id(const uint8_t *d, uint8_t len, cycan_assign_id_t *m)
{
    if (len < 8u) return false;
    m->uid48 = cycan_rd_u48(d);
    m->new_num = d[6];
    m->persist = (d[7] & 1u) != 0u;
    return true;
}

void cycan_enc_identify(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_identify_t *m)
{
    if (m->uid_form) {
        cycan_wr_u48(f->data, m->uid48);
        f->data[6] = m->seconds;
        finish8(f, devtype, num, CYCAN_CLS_SYS_REQ, CYCAN_SYS_IDENTIFY, 7);
    } else {
        f->data[0] = m->seconds;
        finish8(f, devtype, num, CYCAN_CLS_SYS_REQ, CYCAN_SYS_IDENTIFY, 1);
    }
}

bool cycan_dec_identify(const uint8_t *d, uint8_t len, cycan_identify_t *m)
{
    if (len >= 7u) {
        m->uid_form = true;
        m->uid48 = cycan_rd_u48(d);
        m->seconds = d[6];
        return true;
    }
    if (len < 1u) return false;
    m->uid_form = false;
    m->uid48 = 0;
    m->seconds = d[0];
    return true;
}

void cycan_enc_info_req(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_info_req_t *m)
{
    f->data[0] = m->page;
    finish8(f, devtype, num, CYCAN_CLS_SYS_REQ, CYCAN_SYS_INFO_REQ, 1);
}

bool cycan_dec_info_req(const uint8_t *d, uint8_t len, cycan_info_req_t *m)
{
    if (len < 1u) return false;
    m->page = d[0];
    return true;
}

void cycan_enc_name_set(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_name_set_t *m)
{
    f->data[0] = m->page;
    memcpy(f->data + 1, m->bytes, 7);
    finish8(f, devtype, num, CYCAN_CLS_SYS_REQ, CYCAN_SYS_NAME_SET, 8);
}

bool cycan_dec_name_set(const uint8_t *d, uint8_t len, cycan_name_set_t *m)
{
    if (len < 8u) return false;
    m->page = d[0];
    memcpy(m->bytes, d + 1, 7);
    return true;
}

void cycan_enc_command(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_command_t *m)
{
    clear(f, 8);
    f->data[0] = m->cmd;
    cycan_wr_u32(f->data + 1, m->arg);
    finish8(f, devtype, num, CYCAN_CLS_SYS_REQ, CYCAN_SYS_COMMAND, 8);
}

bool cycan_dec_command(const uint8_t *d, uint8_t len, cycan_command_t *m)
{
    if (len < 5u) return false;
    m->cmd = d[0];
    m->arg = cycan_rd_u32(d + 1);
    return true;
}

void cycan_enc_fault_req(cycan_frame_t *f, uint8_t devtype, uint8_t num)
{
    finish8(f, devtype, num, CYCAN_CLS_SYS_REQ, CYCAN_SYS_FAULT_REQ, 0);
}

void cycan_enc_estop(cycan_frame_t *f, uint8_t devtype, uint8_t num)
{
    f->data[0] = CYCAN_ESTOP_MAGIC_0;
    f->data[1] = CYCAN_ESTOP_MAGIC_1;
    finish8(f, devtype, num, CYCAN_CLS_SYS_REQ, CYCAN_SYS_ESTOP, 2);
}

bool cycan_dec_estop(const uint8_t *d, uint8_t len)
{
    return len >= 2u && d[0] == CYCAN_ESTOP_MAGIC_0 && d[1] == CYCAN_ESTOP_MAGIC_1;
}

/* ---- SYS_RSP --------------------------------------------------------------------- */

void cycan_enc_heartbeat(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_heartbeat_t *m)
{
    f->data[0] = (uint8_t)((m->state & 0x0Fu) | (m->unsaved ? CYCAN_SF_UNSAVED : 0u) | (m->enabled ? CYCAN_SF_ENABLED : 0u) |
                           (m->warning ? CYCAN_SF_WARNING : 0u) | (m->identify ? CYCAN_SF_IDENTIFY : 0u));
    cycan_wr_u16(f->data + 1, m->fault);
    cycan_wr_u16(f->data + 3, m->uid16);
    f->data[5] = m->fw_major;
    f->data[6] = m->fw_minor;
    f->data[7] = m->fw_patch;
    finish8(f, devtype, num, CYCAN_CLS_SYS_RSP, CYCAN_SYS_HEARTBEAT, 8);
}

bool cycan_dec_heartbeat(const uint8_t *d, uint8_t len, cycan_heartbeat_t *m)
{
    if (len < 8u) return false;
    m->state = d[0] & 0x0Fu;
    m->unsaved = (d[0] & CYCAN_SF_UNSAVED) != 0u;
    m->enabled = (d[0] & CYCAN_SF_ENABLED) != 0u;
    m->warning = (d[0] & CYCAN_SF_WARNING) != 0u;
    m->identify = (d[0] & CYCAN_SF_IDENTIFY) != 0u;
    m->fault = cycan_rd_u16(d + 1);
    m->uid16 = cycan_rd_u16(d + 3);
    m->fw_major = d[5];
    m->fw_minor = d[6];
    m->fw_patch = d[7];
    return true;
}

void cycan_enc_info_rsp(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_info_rsp_t *m)
{
    f->data[0] = m->page;
    memcpy(f->data + 1, m->bytes, 7);
    finish8(f, devtype, num, CYCAN_CLS_SYS_RSP, CYCAN_SYS_INFO_RSP, 8);
}

bool cycan_dec_info_rsp(const uint8_t *d, uint8_t len, cycan_info_rsp_t *m)
{
    if (len < 8u) return false;
    m->page = d[0];
    memcpy(m->bytes, d + 1, 7);
    return true;
}

void cycan_enc_info_device(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_info_device_t *m)
{
    f->data[0] = CYCAN_INFO_DEVICE;
    f->data[1] = m->model;
    f->data[2] = m->hw_rev;
    f->data[3] = m->proto_major;
    f->data[4] = m->proto_minor;
    cycan_wr_u16(f->data + 5, m->catalog_rev);
    f->data[7] = m->bootloader_ver;
    finish8(f, devtype, num, CYCAN_CLS_SYS_RSP, CYCAN_SYS_INFO_RSP, 8);
}

bool cycan_dec_info_device(const uint8_t *d, uint8_t len, cycan_info_device_t *m)
{
    if (len < 8u || d[0] != CYCAN_INFO_DEVICE) return false;
    m->model = d[1];
    m->hw_rev = d[2];
    m->proto_major = d[3];
    m->proto_minor = d[4];
    m->catalog_rev = cycan_rd_u16(d + 5);
    m->bootloader_ver = d[7];
    return true;
}

void cycan_enc_info_build(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_info_build_t *m)
{
    f->data[0] = CYCAN_INFO_BUILD;
    cycan_wr_u32(f->data + 1, m->git_hash);
    cycan_wr_u16(f->data + 5, m->build_day);
    f->data[7] = m->dirty ? 1u : 0u;
    finish8(f, devtype, num, CYCAN_CLS_SYS_RSP, CYCAN_SYS_INFO_RSP, 8);
}

bool cycan_dec_info_build(const uint8_t *d, uint8_t len, cycan_info_build_t *m)
{
    if (len < 8u || d[0] != CYCAN_INFO_BUILD) return false;
    m->git_hash = cycan_rd_u32(d + 1);
    m->build_day = cycan_rd_u16(d + 5);
    m->dirty = d[7] != 0u;
    return true;
}

void cycan_enc_command_rsp(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_command_rsp_t *m)
{
    clear(f, 8);
    f->data[0] = m->cmd;
    f->data[1] = m->status;
    cycan_wr_u32(f->data + 2, m->result);
    finish8(f, devtype, num, CYCAN_CLS_SYS_RSP, CYCAN_SYS_COMMAND_RSP, 8);
}

bool cycan_dec_command_rsp(const uint8_t *d, uint8_t len, cycan_command_rsp_t *m)
{
    if (len < 6u) return false;
    m->cmd = d[0];
    m->status = d[1];
    m->result = cycan_rd_u32(d + 2);
    return true;
}

void cycan_enc_fault_rsp(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_fault_rsp_t *m)
{
    clear(f, 8);
    cycan_wr_u16(f->data, m->active);
    cycan_wr_u16(f->data + 2, m->sticky);
    cycan_wr_u16(f->data + 4, m->warn);
    finish8(f, devtype, num, CYCAN_CLS_SYS_RSP, CYCAN_SYS_FAULT_RSP, 8);
}

bool cycan_dec_fault_rsp(const uint8_t *d, uint8_t len, cycan_fault_rsp_t *m)
{
    if (len < 6u) return false;
    m->active = cycan_rd_u16(d);
    m->sticky = cycan_rd_u16(d + 2);
    m->warn = cycan_rd_u16(d + 4);
    return true;
}

void cycan_enc_enum_rsp(cycan_frame_t *f, uint8_t devtype, const cycan_enum_rsp_t *m)
{
    uint16_t h10 = (uint16_t)((m->uid48 >> 16) & 0x3FFu);
    cycan_wr_u48(f->data, m->uid48);
    f->data[6] = (uint8_t)((m->num & 0x3Fu) | (m->conflict ? CYCAN_EF_CONFLICT : 0u) | (m->bootloader ? CYCAN_EF_BOOTLOADER : 0u));
    f->data[7] = m->model;
    (void)cycan_frame_finish(f, cycan_enum_rsp_id(devtype, h10), 8);
}

bool cycan_dec_enum_rsp(const uint8_t *d, uint8_t len, cycan_enum_rsp_t *m)
{
    if (len < 8u) return false;
    m->uid48 = cycan_rd_u48(d);
    m->num = d[6] & 0x3Fu;
    m->conflict = (d[6] & CYCAN_EF_CONFLICT) != 0u;
    m->bootloader = (d[6] & CYCAN_EF_BOOTLOADER) != 0u;
    m->model = d[7];
    return true;
}

/* ---- PARAM ----------------------------------------------------------------------- */

void cycan_enc_param_get(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_param_get_t *m)
{
    cycan_wr_u16(f->data, m->pid);
    finish8(f, devtype, num, CYCAN_CLS_PARAM_REQ, CYCAN_PARAM_GET, 2);
}

bool cycan_dec_param_get(const uint8_t *d, uint8_t len, cycan_param_get_t *m)
{
    if (len < 2u) return false;
    m->pid = cycan_rd_u16(d);
    return true;
}

void cycan_enc_param_set(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_param_set_t *m)
{
    cycan_wr_u16(f->data, m->pid);
    f->data[2] = m->ptype;
    f->data[3] = 0;
    cycan_wr_u32(f->data + 4, m->value);
    finish8(f, devtype, num, CYCAN_CLS_PARAM_REQ, CYCAN_PARAM_SET, 8);
}

bool cycan_dec_param_set(const uint8_t *d, uint8_t len, cycan_param_set_t *m)
{
    if (len < 8u) return false;
    m->pid = cycan_rd_u16(d);
    m->ptype = d[2];
    m->value = cycan_rd_u32(d + 4);
    return true;
}

void cycan_enc_param_value(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_param_value_t *m)
{
    cycan_wr_u16(f->data, m->pid);
    f->data[2] = m->ptype;
    f->data[3] = m->status;
    cycan_wr_u32(f->data + 4, m->value);
    finish8(f, devtype, num, CYCAN_CLS_PARAM_RSP, CYCAN_PARAM_VALUE, 8);
}

bool cycan_dec_param_value(const uint8_t *d, uint8_t len, cycan_param_value_t *m)
{
    if (len < 8u) return false;
    m->pid = cycan_rd_u16(d);
    m->ptype = d[2];
    m->status = d[3];
    m->value = cycan_rd_u32(d + 4);
    return true;
}

/* ---- STREAM ---------------------------------------------------------------------- */

void cycan_enc_stream_config(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_stream_config_t *m)
{
    f->data[0] = m->slot;
    cycan_wr_u16(f->data + 1, m->sid);
    finish8(f, devtype, num, CYCAN_CLS_STREAM_REQ, CYCAN_STREAM_CONFIG, 3);
}

bool cycan_dec_stream_config(const uint8_t *d, uint8_t len, cycan_stream_config_t *m)
{
    if (len < 3u) return false;
    m->slot = d[0];
    m->sid = cycan_rd_u16(d + 1);
    return true;
}

void cycan_enc_stream_start(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_stream_start_t *m)
{
    clear(f, 4);
    cycan_wr_u16(f->data, m->period_100us);
    finish8(f, devtype, num, CYCAN_CLS_STREAM_REQ, CYCAN_STREAM_START, 4);
}

bool cycan_dec_stream_start(const uint8_t *d, uint8_t len, cycan_stream_start_t *m)
{
    if (len < 2u) return false;
    m->period_100us = cycan_rd_u16(d);
    return true;
}

void cycan_enc_stream_stop(cycan_frame_t *f, uint8_t devtype, uint8_t num)
{
    finish8(f, devtype, num, CYCAN_CLS_STREAM_REQ, CYCAN_STREAM_STOP, 0);
}

bool cycan_enc_stream_data(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_stream_data_t *m)
{
    uint8_t i, len;
    if (m->count < 1u || (unsigned)m->first_slot + m->count > CYCAN_STREAM_SLOTS) return false;
    len = (uint8_t)(4u + 4u * m->count);
    if (cycan_fd_round_up(len) > CYCAN_FRAME_MAX_DATA) return false;
    f->data[0] = m->seq;
    f->data[1] = m->first_slot;
    cycan_wr_u16(f->data + 2, m->t_100us);
    for (i = 0; i < m->count; i++) cycan_wr_f32(f->data + 4 + 4u * i, m->values[i]);
    return cycan_frame_finish(f, cycan_id_encode(devtype, CYCAN_CLS_STREAM_RSP, CYCAN_STREAM_DATA, num), len);
}

bool cycan_dec_stream_data(const uint8_t *d, uint8_t len, cycan_stream_data_t *m)
{
    uint8_t i, k;
    if (len < 8u || d[1] >= CYCAN_STREAM_SLOTS) return false;
    k = (uint8_t)((len - 4u) / 4u);
    if (k > CYCAN_STREAM_SLOTS - d[1]) k = (uint8_t)(CYCAN_STREAM_SLOTS - d[1]);
    m->seq = d[0];
    m->first_slot = d[1];
    m->t_100us = cycan_rd_u16(d + 2);
    m->count = k;
    for (i = 0; i < k; i++) m->values[i] = cycan_rd_f32(d + 4 + 4u * i);
    return true;
}

/* ---- FW -------------------------------------------------------------------------- */

void cycan_enc_fw_begin(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_fw_begin_t *m)
{
    cycan_wr_u32(f->data, m->size);
    cycan_wr_u32(f->data + 4, m->crc32);
    finish8(f, devtype, num, CYCAN_CLS_FW_REQ, CYCAN_FW_BEGIN, 8);
}

bool cycan_dec_fw_begin(const uint8_t *d, uint8_t len, cycan_fw_begin_t *m)
{
    if (len < 8u) return false;
    m->size = cycan_rd_u32(d);
    m->crc32 = cycan_rd_u32(d + 4);
    return true;
}

bool cycan_enc_fw_data(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_fw_data_t *m)
{
    uint8_t len;
    if (m->len < 1u || m->len > CYCAN_FW_CHUNK_FD || m->offset > 0xFFFFFFul) return false;
    len = (uint8_t)(3u + m->len);
    if (cycan_fd_round_up(len) > CYCAN_FRAME_MAX_DATA) return false;
    cycan_wr_u24(f->data, m->offset);
    memmove(f->data + 3, m->bytes, m->len);
    return cycan_frame_finish(f, cycan_id_encode(devtype, CYCAN_CLS_FW_REQ, CYCAN_FW_DATA, num), len);
}

bool cycan_dec_fw_data(const uint8_t *d, uint8_t len, cycan_fw_data_t *m)
{
    if (len < 4u) return false;
    m->offset = cycan_rd_u24(d);
    m->len = (uint8_t)(len - 3u);
    m->bytes = d + 3;
    return true;
}

void cycan_enc_fw_end(cycan_frame_t *f, uint8_t devtype, uint8_t num)
{
    finish8(f, devtype, num, CYCAN_CLS_FW_REQ, CYCAN_FW_END, 0);
}

void cycan_enc_fw_ack(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_fw_ack_t *m)
{
    clear(f, 8);
    f->data[0] = m->status;
    f->data[1] = m->window;
    cycan_wr_u32(f->data + 2, m->next_offset);
    finish8(f, devtype, num, CYCAN_CLS_FW_RSP, CYCAN_FW_ACK, 8);
}

bool cycan_dec_fw_ack(const uint8_t *d, uint8_t len, cycan_fw_ack_t *m)
{
    if (len < 6u) return false;
    m->status = d[0];
    m->window = d[1];
    m->next_offset = cycan_rd_u32(d + 2);
    return true;
}

/* ---- CTRL ------------------------------------------------------------------------ */

void cycan_enc_ctrl_set(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_ctrl_set_t *m)
{
    clear(f, 8);
    f->data[0] = m->mode;
    f->data[1] = m->flags;
    cycan_wr_f32(f->data + 4, m->value);
    finish8(f, devtype, num, CYCAN_CLS_CTRL, 0, 8);
}

bool cycan_dec_ctrl_set(const uint8_t *d, uint8_t len, cycan_ctrl_set_t *m)
{
    if (len < 8u) return false;
    m->mode = d[0];
    m->flags = d[1];
    m->value = cycan_rd_f32(d + 4);
    return true;
}

void cycan_enc_ctrl_servo(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_ctrl_servo_t *m)
{
    uint8_t i;
    for (i = 0; i < 4u; i++) cycan_wr_u16(f->data + 2u * i, m->pulses_us[i]);
    finish8(f, devtype, num, CYCAN_CLS_CTRL, m->index, 8);
}

bool cycan_dec_ctrl_servo(const uint8_t *d, uint8_t len, uint8_t index, cycan_ctrl_servo_t *m)
{
    uint8_t i;
    if (len < 8u) return false;
    m->index = index;
    for (i = 0; i < 4u; i++) m->pulses_us[i] = cycan_rd_u16(d + 2u * i);
    return true;
}

static void put_ascii(uint8_t *out, const char *s, uint8_t n)
{
    uint8_t i;
    bool end = false;
    for (i = 0; i < n; i++) {
        uint8_t c = end ? 0u : (uint8_t)s[i];
        if (c == 0u) {
            end = true;
            out[i] = 0;
        } else {
            out[i] = (c >= 0x20u && c < 0x7Fu) ? c : (uint8_t)'?';
        }
    }
}

static void get_ascii(char *out, const uint8_t *in, uint8_t n)
{
    uint8_t i;
    for (i = 0; i < n && in[i] != 0u; i++) out[i] = (char)in[i];
    out[i] = '\0';
}

void cycan_enc_ctrl_text(cycan_frame_t *f, uint8_t devtype, uint8_t num, const cycan_ctrl_text_t *m)
{
    f->data[0] = m->line;
    f->data[1] = m->col;
    put_ascii(f->data + 2, m->text, 6);
    finish8(f, devtype, num, CYCAN_CLS_CTRL, 0, 8);
}

bool cycan_dec_ctrl_text(const uint8_t *d, uint8_t len, cycan_ctrl_text_t *m)
{
    if (len < 2u) return false;
    m->line = d[0];
    m->col = d[1];
    get_ascii(m->text, d + 2, (uint8_t)(len > 8u ? 6u : len - 2u));
    return true;
}

/* ---- .cyfw ----------------------------------------------------------------------- */

void cycan_cyfw_encode_header(uint8_t out[CYCAN_CYFW_HEADER_SIZE], const cycan_cyfw_header_t *h)
{
    memset(out, 0, CYCAN_CYFW_HEADER_SIZE);
    memcpy(out, "CYFW", 4);
    cycan_wr_u16(out + 4, CYCAN_CYFW_HEADER_VERSION);
    out[6] = h->model;
    out[7] = h->hw_rev_min;
    out[8] = h->hw_rev_max;
    out[9] = h->fw_major;
    out[10] = h->fw_minor;
    out[11] = h->fw_patch;
    cycan_wr_u32(out + 12, h->payload_size);
    cycan_wr_u32(out + 16, h->payload_crc32);
    cycan_wr_u16(out + 20, h->catalog_rev);
    cycan_wr_u32(out + 24, h->git_hash);
    cycan_wr_u16(out + 28, h->build_day);
    put_ascii(out + 32, h->name, CYCAN_CYFW_NAME_BYTES);
    cycan_wr_u32(out + 60, cycan_crc32(out, 60));
}

cycan_cyfw_result_t cycan_cyfw_check_header(const uint8_t in[CYCAN_CYFW_HEADER_SIZE], uint8_t model, uint8_t hw_rev,
                                            cycan_cyfw_header_t *out)
{
    cycan_cyfw_header_t h;
    if (memcmp(in, "CYFW", 4) != 0) return CYCAN_CYFW_BAD_MAGIC;
    h.header_ver = cycan_rd_u16(in + 4);
    h.model = in[6];
    h.hw_rev_min = in[7];
    h.hw_rev_max = in[8];
    h.fw_major = in[9];
    h.fw_minor = in[10];
    h.fw_patch = in[11];
    h.payload_size = cycan_rd_u32(in + 12);
    h.payload_crc32 = cycan_rd_u32(in + 16);
    h.catalog_rev = cycan_rd_u16(in + 20);
    h.git_hash = cycan_rd_u32(in + 24);
    h.build_day = cycan_rd_u16(in + 28);
    get_ascii(h.name, in + 32, CYCAN_CYFW_NAME_BYTES);
    h.header_crc32 = cycan_rd_u32(in + 60);
    if (out != NULL) *out = h;
    if (h.header_ver != CYCAN_CYFW_HEADER_VERSION) return CYCAN_CYFW_BAD_HEADER_VERSION;
    if (cycan_crc32(in, 60) != h.header_crc32) return CYCAN_CYFW_BAD_HEADER_CRC;
    if (h.model != model) return CYCAN_CYFW_WRONG_MODEL;
    if (hw_rev < h.hw_rev_min || hw_rev > h.hw_rev_max) return CYCAN_CYFW_WRONG_HW_REV;
    return CYCAN_CYFW_OK;
}
