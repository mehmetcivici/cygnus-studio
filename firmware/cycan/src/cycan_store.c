#include "cycan_store.h"

#include <string.h>

#define MAGIC "CYP2"
#define LAYOUT_VERSION 2u
#define CHUNK 64u
#define COMMIT 8u /* magic + seq: programmed last */

static bool seq_newer(uint32_t a, uint32_t b)
{
    return (int32_t)(a - b) > 0;
}

static cycan_slot_state_t check_slot(const cycan_store_io_t *io, uint8_t slot, uint8_t model, uint8_t hdr[CYCAN_STORE_HEADER])
{
    uint8_t buf[CHUNK];
    uint32_t crc, total, off;
    uint16_t count;
    uint8_t i;
    if (!io->read(io->ctx, slot, 0, hdr, CYCAN_STORE_HEADER)) return CYCAN_SLOT_CORRUPT;
    for (i = 0; i < 4u && hdr[i] == 0xFFu; i++) {
    }
    if (i == 4u) return CYCAN_SLOT_BLANK;
    if (memcmp(hdr, MAGIC, 4) != 0 || hdr[9] != LAYOUT_VERSION) return CYCAN_SLOT_CORRUPT;
    count = cycan_rd_u16(hdr + 10);
    if (count > CYCAN_STORE_MAX_RECORDS) return CYCAN_SLOT_CORRUPT;
    crc = cycan_crc32(hdr, CYCAN_STORE_HEADER);
    total = (uint32_t)count * CYCAN_STORE_RECORD;
    for (off = 0; off < total; off += CHUNK) {
        uint32_t len = total - off < CHUNK ? total - off : CHUNK;
        if (!io->read(io->ctx, slot, CYCAN_STORE_HEADER + off, buf, len)) return CYCAN_SLOT_CORRUPT;
        crc = cycan_crc32_update(crc, buf, len);
    }
    if (!io->read(io->ctx, slot, CYCAN_STORE_HEADER + total, buf, CYCAN_STORE_TRAILER)) return CYCAN_SLOT_CORRUPT;
    if (cycan_rd_u32(buf) != crc || cycan_rd_u32(buf + 4) != ~crc) return CYCAN_SLOT_CORRUPT;
    return hdr[8] == model ? CYCAN_SLOT_VALID : CYCAN_SLOT_FOREIGN;
}

bool cycan_store_scan(const cycan_store_io_t *io, uint8_t model, cycan_store_info_t *out)
{
    uint8_t hdr[2][CYCAN_STORE_HEADER];
    uint8_t s;
    int8_t best = -1;
    memset(out, 0, sizeof *out);
    out->slot = -1;
    out->num = CYCAN_NUM_UNASSIGNED;
    if (io->read == NULL) return false;
    for (s = 0; s < 2u; s++) {
        out->state[s] = check_slot(io, s, model, hdr[s]);
        if (out->state[s] != CYCAN_SLOT_VALID) continue;
        if (best < 0 || seq_newer(cycan_rd_u32(hdr[s] + 4), cycan_rd_u32(hdr[best] + 4))) best = (int8_t)s;
    }
    if (best < 0) return false;
    out->slot = best;
    out->seq = cycan_rd_u32(hdr[best] + 4);
    out->count = cycan_rd_u16(hdr[best] + 10);
    out->num = hdr[best][12];
    if (out->num < CYCAN_NUM_MIN || out->num > CYCAN_NUM_UNASSIGNED) out->num = CYCAN_NUM_UNASSIGNED;
    memcpy(out->name, hdr[best] + 16, CYCAN_NAME_BYTES);
    return true;
}

bool cycan_store_corrupt(const cycan_store_info_t *info)
{
    return info->slot < 0 && (info->state[0] == CYCAN_SLOT_CORRUPT || info->state[1] == CYCAN_SLOT_CORRUPT);
}

bool cycan_store_record(const cycan_store_io_t *io, const cycan_store_info_t *info, uint16_t i, uint8_t rec[8])
{
    if (info->slot < 0 || i >= info->count) return false;
    return io->read(io->ctx, (uint8_t)info->slot, CYCAN_STORE_HEADER + (uint32_t)i * CYCAN_STORE_RECORD, rec,
                    CYCAN_STORE_RECORD);
}

bool cycan_store_find(const cycan_store_io_t *io, const cycan_store_info_t *info, uint16_t pid, uint8_t ptype,
                      uint32_t *value)
{
    uint8_t rec[CYCAN_STORE_RECORD];
    uint16_t i;
    for (i = 0; i < info->count; i++) {
        if (!cycan_store_record(io, info, i, rec)) return false;
        if (cycan_rd_u16(rec) == pid && rec[2] == ptype) {
            *value = cycan_rd_u32(rec + 4);
            return true;
        }
    }
    return false;
}

bool cycan_store_write(const cycan_store_io_t *io, cycan_store_info_t *cur, uint8_t model, uint8_t num,
                       const char name[CYCAN_NAME_BYTES], uint16_t count, cycan_store_rec_fn rec, void *src)
{
    uint8_t head[CYCAN_STORE_HEADER], buf[CHUNK];
    uint8_t slot = cur->slot == (int8_t)CYCAN_STORE_SLOT_A ? CYCAN_STORE_SLOT_B : CYCAN_STORE_SLOT_A;
    uint32_t seq = cur->slot >= 0 ? cur->seq + 1u : 1u, crc, off;
    uint16_t i;
    uint8_t fill = 0;
    if (io->read == NULL || io->erase == NULL || io->write == NULL || count > CYCAN_STORE_MAX_RECORDS) return false;

    memset(head, 0, sizeof head);
    memcpy(head, MAGIC, 4);
    cycan_wr_u32(head + 4, seq);
    head[8] = model;
    head[9] = LAYOUT_VERSION;
    cycan_wr_u16(head + 10, count);
    head[12] = num;
    memcpy(head + 16, name, CYCAN_NAME_BYTES);
    crc = cycan_crc32(head, CYCAN_STORE_HEADER);

    if (!io->erase(io->ctx, slot)) return false;
    if (!io->write(io->ctx, slot, COMMIT, head + COMMIT, CYCAN_STORE_HEADER - COMMIT)) return false;
    off = CYCAN_STORE_HEADER;
    for (i = 0; i < count; i++) {
        if (!rec(src, i, buf + fill)) return false;
        fill = (uint8_t)(fill + CYCAN_STORE_RECORD);
        if (fill == CHUNK || i + 1u == count) {
            crc = cycan_crc32_update(crc, buf, fill);
            if (!io->write(io->ctx, slot, off, buf, fill)) return false;
            off += fill;
            fill = 0;
        }
    }
    cycan_wr_u32(buf, crc);
    cycan_wr_u32(buf + 4, ~crc);
    if (!io->write(io->ctx, slot, off, buf, CYCAN_STORE_TRAILER)) return false;
    /* Commit: until these 8 bytes land, the slot reads as blank and the old copy wins. */
    if (!io->write(io->ctx, slot, 0, head, COMMIT)) return false;

    cur->state[slot] = CYCAN_SLOT_VALID;
    cur->slot = (int8_t)slot;
    cur->seq = seq;
    cur->num = num;
    cur->count = count;
    memcpy(cur->name, name, CYCAN_NAME_BYTES);
    return true;
}

typedef struct {
    const cycan_store_io_t *io;
    cycan_store_info_t from;
} copy_src_t;

static bool copy_rec(void *src, uint16_t i, uint8_t rec[8])
{
    copy_src_t *c = (copy_src_t *)src;
    return cycan_store_record(c->io, &c->from, i, rec);
}

bool cycan_store_set_num(const cycan_store_io_t *io, uint8_t model, uint8_t num)
{
    copy_src_t c;
    cycan_store_info_t cur;
    static const char k_no_name[CYCAN_NAME_BYTES] = {0};
    bool have = cycan_store_scan(io, model, &cur);
    c.io = io;
    c.from = cur;
    return cycan_store_write(io, &cur, model, num, have ? c.from.name : k_no_name, have ? c.from.count : 0u, copy_rec, &c);
}

uint8_t cycan_store_data_bitrate(const cycan_store_io_t *io, uint8_t model, uint8_t dflt)
{
    cycan_store_info_t info;
    uint32_t v;
    if (!cycan_store_scan(io, model, &info)) return cycan_store_corrupt(&info) ? CYCAN_DATA_BITRATE_CLASSIC : dflt;
    if (!cycan_store_find(io, &info, CYCAN_PID_CAN_DATA_BITRATE, CYCAN_PTYPE_ENUM, &v)) return dflt;
    return v <= CYCAN_DATA_BITRATE_MAX ? (uint8_t)v : CYCAN_DATA_BITRATE_CLASSIC;
}
