/*
 * CyCAN v1 bootloader side: recovery window and firmware update over CAN (PROTOCOL 9).
 *
 * Start-up (cycan_boot_init)
 * - NUM and can.data_bitrate come from the shared A/B store (cycan_store.h); the HAL's
 *   can_config() is told the bitrate before anything is sent.
 * - The installed image is checked (header + payload CRC). HEARTBEAT reports its version, or
 *   0.0.0 when there is no valid image.
 * - With a valid image and no request to stay (cfg.stay), the bootloader first listens for
 *   CYCAN_RECOVERY_WINDOW_MS (150 ms) without sending anything. A broadcast (DEVTYPE 0,
 *   NUM 0) COMMAND ENTER_BOOTLOADER with arg CYCAN_BOOT_RECOVERY_ARG keeps it in the
 *   bootloader (PROTOCOL 9.0); otherwise it calls start_app() when the window closes.
 *
 * In the bootloader it sends HEARTBEAT state = BOOTLOADER (only with an assigned NUM) and
 * answers only ENUM_REQ (BOOTLOADER flag), ASSIGN_ID, IDENTIFY, INFO_REQ pages 0..2 and
 * COMMAND REBOOT; everything else stays unanswered. FW frames must be addressed to its own
 * assigned NUM. The update machine:
 *
 *   BEGIN  -> ACK OK; nothing is erased yet                  (BAD_IMAGE if size is impossible)
 *   DATA   -> the first 64 bytes (.cyfw header) are collected in RAM and checked (magic,
 *             version, header CRC, model, hw_rev, size == 64 + payload [+ 64 signature]).
 *             A bad header -> BAD_IMAGE and the installed application stays untouched.
 *             A good one -> ACK BUSY, erase, header written, ACK OK next_offset 64.
 *             Then data is written in order; ACK OK every `window` frames (the count restarts
 *             after every ACK, BAD_OFFSET included; END's ACK closes a final partial window);
 *             out of order -> BAD_OFFSET with the expected next_offset, once per window.
 *             A frame whose length is not a valid CAN/CAN-FD length is ignored.
 *   END    -> whole-file CRC32 (BAD_CRC), payload CRC32 from the header (BAD_IMAGE), flash
 *             read-back (FLASH_ERROR) -> ACK OK, then the application is started.
 *   After END, until the application starts, every FW request gets BUSY.
 *
 * The image area holds the .cyfw file as received: header at offset 0, payload at 64. Link
 * the application to start at image base + 64 and pad up to the next VTOR-aligned address
 * before the vector table (see README, "Bootloader").
 *
 * Same execution model as cycan.h: cycan_boot_on_frame() is interrupt safe and only queues;
 * cycan_boot_poll() does all work, including the blocking flash erase/write calls. Time is
 * the same wrap-safe 32-bit microsecond counter.
 */
#ifndef CYCAN_BOOT_H
#define CYCAN_BOOT_H

#include <stdbool.h>
#include <stdint.h>

#include "cycan_codec.h"
#include "cycan_store.h"

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
    /** Called once from cycan_boot_init() with the can.data_bitrate to configure (0 classic,
     * 1 2M, 2 5M, 3 8M). May be NULL if the port reads cycan_boot_data_bitrate() itself. */
    void (*can_config)(void *ctx, uint8_t data_bitrate);
    /** Bytes available for the .cyfw file (header + payload [+ signature]). */
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
    /** The application's A/B parameter store (same callbacks as cycan_hal_t). NULL: NUM 63,
     * nothing persists, can.data_bitrate = cfg.data_bitrate_default. */
    bool (*storage_read)(void *ctx, uint8_t slot, uint32_t offset, void *buf, uint32_t len);
    bool (*storage_erase)(void *ctx, uint8_t slot);
    bool (*storage_write)(void *ctx, uint8_t slot, uint32_t offset, const void *buf, uint32_t len);
} cycan_boot_hal_t;

typedef struct {
    uint8_t model;
    uint8_t devtype;
    uint8_t hw_rev;
    uint8_t bootloader_ver;
    uint16_t catalog_rev;
    /** DATA frames per OK acknowledgement; 0 = CYCAN_FW_WINDOW_DEFAULT. */
    uint8_t window;
    /** Catalog default of can.data_bitrate: used when nothing is stored, like the application. */
    uint8_t data_bitrate_default;
    /** Stay in the bootloader (the application asked for it with ENTER_BOOTLOADER), skipping
     * the recovery window. Without a valid image the bootloader always stays. */
    bool stay;
} cycan_boot_cfg_t;

typedef enum {
    CYCAN_BOOT_IDLE = 0, /* waiting for BEGIN */
    CYCAN_BOOT_WINDOW,   /* recovery window: listening silently before starting the app */
    CYCAN_BOOT_HEADER,   /* BEGIN accepted, collecting the 64-byte header in RAM */
    CYCAN_BOOT_ERASE,    /* header valid, erase runs in this poll */
    CYCAN_BOOT_RECEIVE,  /* DATA in progress */
    CYCAN_BOOT_DONE      /* image verified, application starts shortly */
} cycan_boot_state_t;

typedef struct cycan_boot cycan_boot_t;

struct cycan_boot {
    cycan_boot_cfg_t cfg;
    const cycan_boot_hal_t *hal;
    cycan_uid_t uid;
    uint8_t uid96[12];
    uint8_t num;
    uint8_t data_bitrate;
    bool image_ok;
    uint8_t app_fw[3];

    uint32_t now;
    uint32_t hb_next;
    bool enum_pending, enum_retried;
    uint32_t enum_due;
    bool identify_on, identify_led;
    uint32_t identify_end, identify_next;
    uint32_t window_end;

    cycan_boot_state_t state;
    uint32_t size, crc_expected, crc_file, crc_payload, next_offset;
    uint8_t since_ack, bad_count;
    uint8_t header[CYCAN_CYFW_HEADER_SIZE];
    uint32_t payload_size, payload_crc;
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
uint8_t cycan_boot_num(const cycan_boot_t *b);
/** can.data_bitrate the bootloader runs with (also passed to hal->can_config). */
uint8_t cycan_boot_data_bitrate(const cycan_boot_t *b);
/**
 * Checks the image currently in flash: header (magic, version, CRC, model, hw_rev) and the
 * payload CRC. cycan_boot_init() runs it once; exposed for ports and tests.
 */
bool cycan_boot_image_valid(const cycan_boot_t *b);

#ifdef __cplusplus
}
#endif

#endif /* CYCAN_BOOT_H */
