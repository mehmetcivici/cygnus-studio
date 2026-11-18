/*
 * CyCAN persistent store: two slots (A/B) holding the board's NUM, name and parameter
 * values. Shared by the node (cycan.h) and the bootloader (cycan_boot.h).
 *
 * Power-loss safety
 * - A write always goes to the slot that does NOT hold the newest valid copy, so the newest
 *   copy survives an interrupted erase or write untouched.
 * - Each copy carries a sequence number and a CRC32 over everything before the trailer.
 * - The first 8 bytes (magic + sequence) are programmed last: an interrupted write leaves
 *   them erased, so the slot reads as blank rather than corrupt.
 * - Reading picks the valid copy with the newest sequence number (wrap safe).
 * Result: a power cut at any byte of a save leaves either the old or the new set on the
 * next boot, never the defaults.
 *
 * Slot layout (little-endian, version 2):
 *   0  "CYP2"
 *   4  seq u32
 *   8  model u8, version u8 (2), count u16
 *   12 num u8, 0, 0, 0
 *   16 name 21 bytes, 0 0 0
 *   40 count records: pid u16, ptype u8, 0, value u32
 *   40 + 8 * count: crc32 u32, ~crc32 u32 (over bytes 0 .. 40 + 8 * count)
 *
 * Storage contract (both slots): erase sets the whole slot to 0xFF; writes are 8-byte
 * aligned, multiples of 8 bytes, each byte at most once after an erase, in any order.
 */
#ifndef CYCAN_STORE_H
#define CYCAN_STORE_H

#include <stdbool.h>
#include <stdint.h>

#include "cycan_codec.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CYCAN_STORE_SLOT_A 0u
#define CYCAN_STORE_SLOT_B 1u
#define CYCAN_STORE_HEADER 40u
#define CYCAN_STORE_RECORD 8u
#define CYCAN_STORE_TRAILER 8u
#define CYCAN_STORE_MAX_RECORDS 1024u

/** Bytes a slot needs for `count` parameter records. */
#define CYCAN_STORE_SLOT_SIZE(count) (CYCAN_STORE_HEADER + CYCAN_STORE_RECORD * (uint32_t)(count) + CYCAN_STORE_TRAILER)

typedef struct {
    void *ctx;
    bool (*read)(void *ctx, uint8_t slot, uint32_t offset, void *buf, uint32_t len);
    bool (*erase)(void *ctx, uint8_t slot);
    bool (*write)(void *ctx, uint8_t slot, uint32_t offset, const void *buf, uint32_t len);
} cycan_store_io_t;

typedef enum {
    CYCAN_SLOT_BLANK = 0, /* erased, or a write that never reached its commit block */
    CYCAN_SLOT_VALID,
    CYCAN_SLOT_FOREIGN, /* valid, but written by another model: ignored */
    CYCAN_SLOT_CORRUPT
} cycan_slot_state_t;

typedef struct {
    cycan_slot_state_t state[2];
    int8_t slot;    /* newest valid slot, -1 if none */
    uint32_t seq;   /* its sequence number */
    uint8_t num;    /* stored NUM (CYCAN_NUM_UNASSIGNED if none) */
    uint16_t count; /* records in that slot */
    char name[CYCAN_NAME_BYTES];
} cycan_store_info_t;

/** Checks both slots; true if a valid copy for `model` exists (then `out` describes it). */
bool cycan_store_scan(const cycan_store_io_t *io, uint8_t model, cycan_store_info_t *out);
/** No valid copy, and at least one slot is neither blank nor foreign. */
bool cycan_store_corrupt(const cycan_store_info_t *info);
/** Reads record `i` (8 bytes) of the newest copy. */
bool cycan_store_record(const cycan_store_io_t *io, const cycan_store_info_t *info, uint16_t i, uint8_t rec[8]);
/** Value of `pid` with type `ptype` in the newest copy; false if absent. */
bool cycan_store_find(const cycan_store_io_t *io, const cycan_store_info_t *info, uint16_t pid, uint8_t ptype,
                      uint32_t *value);

/** Source of the records being written: fills record `i` of `count`. */
typedef bool (*cycan_store_rec_fn)(void *src, uint16_t i, uint8_t rec[8]);

/**
 * Writes a new copy into the older slot (see `cur`, from cycan_store_scan) with sequence
 * cur->seq + 1. On success `cur` is updated to describe the new copy.
 */
bool cycan_store_write(const cycan_store_io_t *io, cycan_store_info_t *cur, uint8_t model, uint8_t num,
                       const char name[CYCAN_NAME_BYTES], uint16_t count, cycan_store_rec_fn rec, void *src);

/** Persists a new NUM, keeping the stored name and parameters (none if nothing is stored). */
bool cycan_store_set_num(const cycan_store_io_t *io, uint8_t model, uint8_t num);

/**
 * can.data_bitrate the bootloader should use: the stored value; `dflt` (the catalog default
 * the application also uses) when nothing is stored; classic (0) when the store is corrupt
 * or the stored value is out of range.
 */
uint8_t cycan_store_data_bitrate(const cycan_store_io_t *io, uint8_t model, uint8_t dflt);

#ifdef __cplusplus
}
#endif

#endif /* CYCAN_STORE_H */
