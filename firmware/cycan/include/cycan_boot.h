/*
 * CyCAN v1 bootloader side: firmware update over CAN (PROTOCOL 9).
 *
 * The bootloader announces itself with HEARTBEAT state = BOOTLOADER (only when it has an
 * assigned NUM), answers ENUM_REQ with the BOOTLOADER flag, INFO pages 0..2, IDENTIFY and
 * COMMAND REBOOT, and runs the BEGIN / DATA / END / ACK state machine:
 *
 *   BEGIN  -> ACK BUSY, erase, ACK OK(next_offset 0)    (BAD_IMAGE if size is impossible)
 *   DATA   -> written in order; ACK OK every `window` frames; out of order -> BAD_OFFSET
 *             with the expected next_offset. The 64-byte .cyfw header is checked as soon as it
 *             is complete (magic, version, header CRC, model, hw_rev, size) -> BAD_IMAGE.
 *   END    -> whole-file CRC32 (BAD_CRC), payload CRC32 from the header (BAD_IMAGE), flash
 *             read-back (FLASH_ERROR) -> ACK OK, then the application is started.
 *
 * The image area holds the .cyfw file as received: header at offset 0, payload at 64. Link
 * the application so its vector table sits at image base + 64 (choose a base 64 bytes below
 * a VTOR-aligned address).
 *
 * Same execution model as cycan.h: cycan_boot_on_frame() is interrupt safe and only queues;
 * cycan_boot_poll() does all work, including the blocking flash erase/write calls.
 */
#ifndef CYCAN_BOOT_H
#define CYCAN_BOOT_H

#include <stdbool.h>
#include <stdint.h>

#include "cycan_codec.h"

#ifdef __cplusplus
extern "C" {
#endif

#ifndef CYCAN_BOOT_RX_QUEUE_LEN
#define CYCAN_BOOT_RX_QUEUE_LEN 4u /* power of two; FD DATA frames are 64 bytes each */
#endif
#ifndef CYCAN_BOOT_WRITE_CHUNK
#define CYCAN_BOOT_WRITE_CHUNK 64u /* flash write granularity, multiple of 8 */
#endif
#ifndef CYCAN_BOOT_START_DELAY_US
#define CYCAN_BOOT_START_DELAY_US 5000ul
#endif

typedef struct {
    void *ctx;
    bool (*can_send)(void *ctx, const cycan_frame_t *f);
    void (*uid96)(void *ctx, uint8_t out[12]);
    /** Bytes available for the .cyfw file (header + payload). */
    uint32_t image_capacity;
    /** Erase at least `size` bytes from offset 0 of the image area (may block). */
    bool (*flash_erase)(void *ctx, uint32_t size);
    /** `offset` and `len` are multiples of 8; the tail of the last block is 0xFF padded. */
    bool (*flash_write)(void *ctx, uint32_t offset, const uint8_t *data, uint32_t len);
    bool (*flash_read)(void *ctx, uint32_t offset, uint8_t *data, uint32_t len);
    /** Jump to (or reset into) the verified application. Does not return. */
    void (*start_app)(void *ctx);
    void (*led_set)(void *ctx, bool on);
    uint32_t (*random)(void *ctx);
} cycan_boot_hal_t;

typedef struct {
    uint8_t model;
    uint8_t devtype;
    uint8_t hw_rev;
    uint8_t bootloader_ver;
    uint16_t catalog_rev;
    /** NUM from the identity record (cycan_identity_decode()); 63 if none. */
    uint8_t num;
    /** DATA frames per OK acknowledgement; 0 = CYCAN_FW_WINDOW_DEFAULT. */
    uint8_t window;
} cycan_boot_cfg_t;

typedef enum {
    CYCAN_BOOT_IDLE = 0, /* waiting for BEGIN */
    CYCAN_BOOT_ERASE,    /* BEGIN accepted, erase runs in the next poll */
    CYCAN_BOOT_RECEIVE,  /* DATA in progress */
    CYCAN_BOOT_DONE      /* image verified, application starts shortly */
} cycan_boot_state_t;

typedef struct cycan_boot cycan_boot_t;

struct cycan_boot {
    cycan_boot_cfg_t cfg;
    const cycan_boot_hal_t *hal;
    cycan_uid_t uid;
    uint8_t uid96[12];
    uint8_t app_fw[3];

    uint32_t now;
    uint32_t hb_next;
    bool enum_pending, enum_retried;
    uint32_t enum_due;
    bool identify_on, identify_led;
    uint32_t identify_end, identify_next;

    cycan_boot_state_t state;
    uint32_t size, crc_expected, crc_file, crc_payload, next_offset;
    uint8_t since_ack, bad_count;
    bool header_ok;
    uint8_t header[CYCAN_CYFW_HEADER_SIZE];
    uint8_t wbuf[CYCAN_BOOT_WRITE_CHUNK];
    uint32_t wbuf_base;
    uint32_t wbuf_len;
    bool start_pending;
    uint32_t start_at;

    cycan_frame_t rxq[CYCAN_BOOT_RX_QUEUE_LEN];
    volatile uint8_t rx_head, rx_tail;
    volatile uint16_t rx_overruns;
};

void cycan_boot_init(cycan_boot_t *b, const cycan_boot_cfg_t *cfg, const cycan_boot_hal_t *hal, uint32_t now_us);
/** Interrupt safe. FD frames up to 64 bytes are kept whole. */
bool cycan_boot_on_frame(cycan_boot_t *b, uint32_t id, const uint8_t *data, uint8_t len);
void cycan_boot_poll(cycan_boot_t *b, uint32_t now_us);
cycan_boot_state_t cycan_boot_state(const cycan_boot_t *b);
/**
 * Checks the image currently in flash: header (magic, version, CRC, model, hw_rev) and the
 * payload CRC. Call at reset to decide between starting the application and staying here.
 */
bool cycan_boot_image_valid(const cycan_boot_t *b);

#ifdef __cplusplus
}
#endif

#endif /* CYCAN_BOOT_H */
